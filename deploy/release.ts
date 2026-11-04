import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyArtifact } from './artifact.js';

const worker = resolve(import.meta.dirname, '../src/worker');
const wrangler = resolve(worker, 'node_modules/.bin/wrangler');
function consumerOwner(consumer: {script?: unknown, script_name?: unknown}): string {
  if (consumer.script !== undefined && consumer.script_name !== undefined && consumer.script !== consumer.script_name) throw new Error('Queue consumer owner fields conflict');
  const owner = consumer.script ?? consumer.script_name;
  if (typeof owner !== 'string' || !owner) throw new Error('Queue consumer owner is missing or invalid');
  return owner;
}
export async function release(options: {args?: string[], configPath?: string, apiBase?: string, wranglerEnv?: NodeJS.ProcessEnv, wranglerCwd?:string, now?:()=>number} = {}) {
  const envDirectory=mkdtempSync(resolve(tmpdir(),'memoia-release-env-'));
  const emptyEnv=resolve(envDirectory,'empty.env');
  writeFileSync(emptyEnv,'',{mode:0o600});
  try {
  const now=options.now ?? Date.now;
  const deadline = now() + 15 * 60_000;
  const remaining = () => { const ms = deadline - now(); if (ms <= 0) throw new Error('Release deadline exceeded; inspect remote state'); return ms; };
  const argsInput = options.args ?? process.argv.slice(2);
  const stage = argsInput[1];
  const action = argsInput[0];
  if (!['deploy','rollback'].includes(action) || !['test','online'].includes(stage)) throw new Error('Usage: release.ts deploy test | deploy online ARTIFACT MANIFEST_SHA256 SOURCE_SHA | rollback test|online VERSION_ID');
  const env:NodeJS.ProcessEnv = { CI:'true', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false', CLOUDFLARE_API_TOKEN:process.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID:process.env.CLOUDFLARE_ACCOUNT_ID };
  for (const key of ['PATH','HOME','TMPDIR','TMP','TEMP','SystemRoot']) if (process.env[key]) env[key]=process.env[key];
  Object.assign(env, options.wranglerEnv);
  const version = spawnSync(wrangler,['--version','--env-file',emptyEnv],{cwd:options.wranglerCwd ?? worker,encoding:'utf8',env,timeout:Math.min(30_000,remaining())});
  if (version.status !== 0 || version.stdout.trim() !== '4.155.0') throw new Error('Wrangler 4.155.0 required');
  const config = JSON.parse(readFileSync(options.configPath ?? resolve(worker,'wrangler.jsonc'),'utf8'));
  const selected = config.env?.[stage];
  const expected = stage === 'test' ? 'luvel-memoia-test' : 'memoia-online';
  if (selected?.name !== expected) throw new Error('Missing or incorrect environment Worker identity');
  if (config.workers_dev !== false || config.preview_urls !== false || selected.workers_dev === true || selected.preview_urls === true) throw new Error('Public workers.dev and preview URLs must be disabled');
  let bundleEntry: string | undefined;
  if (action === 'deploy' && stage === 'online') {
    const [directory,digest,source] = argsInput.slice(2);
    if (!directory || !digest || !source) throw new Error('Online deployment requires artifact directory, manifest SHA256 and source SHA');
    const git = spawnSync('git',['rev-parse','HEAD'],{cwd:resolve(worker,'../..'),encoding:'utf8',timeout:30000});
    if (git.status !== 0 || git.stdout.trim() !== source) throw new Error('Artifact source differs from checked-out HEAD');
    bundleEntry = verifyArtifact(resolve(directory),digest,source,stage,options.configPath);
  }
  if (action === 'rollback' && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(argsInput[2] ?? '')) throw new Error('Explicit Worker version UUID required');
  {
    if (config.routes?.length || selected.routes?.length || config.route || selected.route) throw new Error('Routes are maintained outside deployment');
    const hyperdrives = selected.hyperdrive;
    if (!Array.isArray(hyperdrives) || hyperdrives.length !== 1 || hyperdrives[0].binding !== 'HYPERDRIVE' || !/^[a-f0-9]{32}$/.test(hyperdrives[0].id ?? '')) throw new Error('An existing environment Hyperdrive ID is required');
    if (action === 'deploy' && (!Array.isArray(selected.secrets?.required) || !['ACCESS_TOKEN','OPENAI_API_KEY'].every(name => selected.secrets.required.includes(name)))) throw new Error('Required Worker secrets must be declared');
    if (!['MEMOIA_WRITES_ENABLED','MAINTENANCE_ENABLED'].every(name => typeof selected.vars?.[name] === 'string')) throw new Error('Worker enablement values must be declared');
  }
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account || !/^[a-f0-9]{32}$/.test(account)) throw new Error('Environment-specific Cloudflare credentials required');
  async function get(path:string) {
    const response = await fetch(`${options.apiBase ?? 'https://api.cloudflare.com/client/v4'}/accounts/${account}${path}`, {headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(Math.min(30_000,remaining()))});
    if (!response.ok) throw new Error(`Cloudflare GET ${path} failed (${response.status})`);
    const body:any = await response.json();
    if (!body.success || !body.result) throw new Error(`Cloudflare GET ${path} returned invalid result`);
    return body.result;
  }
  const workerPath = `/workers/scripts/${encodeURIComponent(expected)}`;
  async function checkVersionBindings(versionId:string) {
    const uploadedVersion = await get(`${workerPath}/versions/${versionId}`);
    if (uploadedVersion.id !== versionId || !Array.isArray(uploadedVersion.resources?.bindings)) throw new Error('Uploaded version identity or bindings missing');
    const bindings = uploadedVersion.resources.bindings;
    const requireBinding = (name:string, type:string, key:string, value:unknown) => {
      const matches = bindings.filter((item:any) => item.name === name);
      if (matches.length !== 1 || matches[0].type !== type || matches[0][key] !== value) throw new Error(`Uploaded version binding mismatch: ${name}`);
    };
    requireBinding('HYPERDRIVE','hyperdrive','id',selected.hyperdrive[0].id);
    requireBinding('MAINTENANCE_QUEUE','queue','queue_name',selected.queues.producers[0].queue);
    for (const name of ['MEMOIA_WRITES_ENABLED','MAINTENANCE_ENABLED']) {
      if (action === 'deploy') requireBinding(name,'plain_text','text',selected.vars[name]);
      else {
        const matches = bindings.filter((item:any) => item.name === name);
        if (matches.length !== 1 || matches[0].type !== 'plain_text' || !['true','false'].includes(matches[0].text)) throw new Error(`Uploaded version binding mismatch: ${name}`);
      }
    }
  }
  const settings = await get(`${workerPath}/settings`);
  const subdomain = await get(`${workerPath}/subdomain`);
  if (subdomain.enabled !== false || subdomain.previews_enabled !== false) throw new Error('Remote public Worker or previews are enabled or unknown');
  let queueId: string | undefined;
  let queueSnapshot: string | undefined;
  let cronSnapshot: string | undefined;
  {
    const id = selected.hyperdrive[0].id;
    const binding = settings.bindings?.find((item:any) => item.name === 'HYPERDRIVE' && item.type === 'hyperdrive');
    if (!binding || binding.id !== id) throw new Error('Remote Hyperdrive binding differs or is missing');
    const hyperdrive = await get(`/hyperdrive/configs/${id}`);
    if (hyperdrive.id !== id) throw new Error('Hyperdrive identity mismatch');
    if (hyperdrive.caching?.disabled !== true) throw new Error('Hyperdrive caching must be disabled');
    if (action === 'deploy') {
      const secrets = await get(`${workerPath}/secrets`);
      if (!Array.isArray(secrets) || !['ACCESS_TOKEN','OPENAI_API_KEY'].every(name => secrets.filter((secret:any) => secret.name === name && secret.type === 'secret_text').length === 1)) throw new Error('Required Worker secrets are missing or have incorrect type');
    }
    const declarations = selected.queues?.consumers ?? [];
    if (declarations.length !== 1) throw new Error('Exactly one existing consumer declaration required');
    const declaration = declarations[0];
    const producers = selected.queues?.producers ?? [];
    if (producers.length !== 1 || producers[0].binding !== 'MAINTENANCE_QUEUE' || producers[0].queue !== declaration.queue) throw new Error('Queue producer and consumer configuration differs');
    if (!settings.bindings?.some((item:any) => item.name === 'MAINTENANCE_QUEUE' && item.type === 'queue' && item.queue_name === declaration.queue)) throw new Error('Remote queue binding differs or is missing');
    const matches = await get(`/queues?name=${encodeURIComponent(declaration.queue)}`);
    if (!Array.isArray(matches) || matches.length !== 1 || matches[0].queue_name !== declaration.queue || !matches[0].queue_id) throw new Error('Queue identity missing or ambiguous');
    const queue = await get(`/queues/${encodeURIComponent(matches[0].queue_id)}`);
    if (queue.queue_name !== declaration.queue || queue.queue_id !== matches[0].queue_id || !Array.isArray(queue.consumers) || queue.consumers_total_count !== queue.consumers.length) throw new Error('Queue identity or complete consumer list could not be verified');
    const consumers = queue.consumers.filter((c:any) => c.type === 'worker' && consumerOwner(c) === expected);
    const consumer = consumers[0];
    if (queue.consumers.length !== 1 || consumers.length !== 1 || consumer.settings?.batch_size !== declaration.max_batch_size || consumer.settings?.max_concurrency !== declaration.max_concurrency || consumer.settings?.max_retries !== declaration.max_retries || (consumer.settings?.max_wait_time_ms ?? 5000) !== (declaration.max_batch_timeout ?? 5) * 1000 || (consumer.settings?.retry_delay ?? 0) !== (declaration.retry_delay ?? 0) || (consumer.dead_letter_queue || null) !== (declaration.dead_letter_queue || null)) throw new Error('Queue consumer owner or settings differ');
    queueId = queue.queue_id;
    queueSnapshot = JSON.stringify({id: consumer.consumer_id, owner: expected, type: consumer.type, settings: consumer.settings, deadLetter: consumer.dead_letter_queue || null});
    const schedules = await get(`${workerPath}/schedules`);
    if (!Array.isArray(schedules.schedules)) throw new Error('Cron schedule response is invalid');
    const actual = schedules.schedules.map((s:any) => s.cron).sort();
    const desired = [...(selected.triggers?.crons ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(desired)) throw new Error('Cron schedules differ');
    cronSnapshot = JSON.stringify(actual);
  }
  let expectedVersion = argsInput[2];
  async function run(args:string[], childEnv:NodeJS.ProcessEnv) {
    const timeLeft = remaining();
    await new Promise<void>((ok, fail) => {
      const child = spawn(wrangler,[...args,'--env-file',emptyEnv],{cwd:options.wranglerCwd ?? worker,env:childEnv,stdio:'inherit',detached:process.platform !== 'win32'});
      let interrupted = false;
      const stop = () => { interrupted=true; if (child.pid) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid,'SIGTERM'); } catch {} const pid=child.pid; setTimeout(()=>{try {process.kill(process.platform === 'win32' ? pid : -pid,'SIGKILL');} catch {}},5000).unref(); } };
      const timer=setTimeout(stop,timeLeft);
      process.once('SIGINT',stop); process.once('SIGTERM',stop);
      const finish = () => {clearTimeout(timer);process.off('SIGINT',stop);process.off('SIGTERM',stop);};
      child.once('error',error=>{finish();fail(error);});
      child.once('close',(code,signal)=>{finish();if(code===0 && !interrupted) ok(); else fail(new Error(`Wrangler failed (${code ?? signal}); inspect actual remote state`));});
    });
  }
  if (action === 'deploy') {
    const directory = mkdtempSync(resolve(tmpdir(), 'memoia-release-'));
    try {
      const output = resolve(directory, 'output.jsonl');
      await run(['versions','upload',...(bundleEntry ? [bundleEntry,'--no-bundle'] : []),'--env',stage,'--no-x-provision',...(options.configPath ? ['--config',options.configPath] : [])],{...env,WRANGLER_OUTPUT_FILE_PATH:output});
      const entries = readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const uploaded = entries.filter(item => item.type === 'version-upload' && item.worker_name === expected);
      if (uploaded.length !== 1 || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(uploaded[0].version_id)) throw new Error('Uploaded version identity missing or ambiguous');
      expectedVersion = uploaded[0].version_id;
      await checkVersionBindings(expectedVersion);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  }
  else await checkVersionBindings(expectedVersion);
  const args = action === 'deploy' ? ['versions','deploy',`${expectedVersion}@100`,'--env',stage,'--yes'] : ['rollback',expectedVersion,'--env',stage,'--yes'];
  await run([...args,...(options.configPath ? ['--config',options.configPath] : [])],env);
  const deployments = await get(`${workerPath}/deployments`);
  const versions = deployments.deployments?.[0]?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0].version_id !== expectedVersion || versions[0].percentage !== 100) throw new Error('Active version differs or is unknown; inspect remote state');
  await checkVersionBindings(expectedVersion);
  const after = await get(`${workerPath}/subdomain`);
  if (after.enabled !== false || after.previews_enabled !== false) throw new Error('Public entry protection changed or could not be verified; inspect remote state');
  if (queueId) {
    const queue = await get(`/queues/${encodeURIComponent(queueId)}`);
    if (queue.queue_id !== queueId || !Array.isArray(queue.consumers) || queue.consumers_total_count !== 1 || queue.consumers.length !== 1) throw new Error('Queue consumer state changed or is unknown');
    const consumer = queue.consumers[0];
    if (JSON.stringify({id: consumer.consumer_id, owner: consumer.type === 'worker' ? consumerOwner(consumer) : null, type: consumer.type, settings: consumer.settings, deadLetter: consumer.dead_letter_queue || null}) !== queueSnapshot) throw new Error('Queue consumer changed during publication');
    const schedules = await get(`${workerPath}/schedules`);
    if (!Array.isArray(schedules.schedules) || JSON.stringify(schedules.schedules.map((s:any)=>s.cron).sort()) !== cronSnapshot) throw new Error('Cron schedules changed during publication');
  }
  console.log(`Active Worker version verified: ${expectedVersion}; business acceptance remains separate.`);
  } finally { rmSync(envDirectory,{recursive:true,force:true}); }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, 'release.ts')) release().catch(error => { console.error(error); process.exitCode=1; });
