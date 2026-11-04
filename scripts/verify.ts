import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const worker = resolve(root, 'src/worker');
const sdk = resolve(root, 'sdks/typescript');
const mcp = resolve(root, 'src/mcp');
const env: NodeJS.ProcessEnv = { CI: 'true', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' };
for (const key of ['PATH', 'HOME', 'PNPM_HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
let child: ReturnType<typeof spawn> | undefined;
let cancelled = false;
const container = `memoia-verify-${randomUUID()}`;
const redisContainer = `memoia-verify-redis-${randomUUID()}`;
function cancel() {
  cancelled = true;
  if (!child?.pid) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch {}
  const pid = child.pid;
  setTimeout(() => { try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch {} }, 5000).unref();
}
const timer = setTimeout(cancel, 20 * 60_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, cancel);
async function run(cmd: string, args: string[], cwd = root, extra: NodeJS.ProcessEnv = {}) {
  if (cancelled) throw new Error('Verification cancelled or timed out');
  console.log(`> ${cmd} ${args.join(' ')}`);
  await new Promise<void>((ok, fail) => {
    child = spawn(cmd, args, { cwd, env: {...env, ...extra}, stdio: 'inherit', detached: process.platform !== 'win32' });
    child.once('error', fail);
    child.once('exit', (code, signal) => code === 0 && !cancelled ? ok() : fail(new Error(`${cmd} failed (${code ?? signal})`)));
  });
}
async function main() {
  if (process.argv.slice(2).join(' ') !== 'full') throw new Error('Usage: verify.ts full');
  await run(resolve(worker, 'node_modules/.bin/tsc'), ['--noEmit', '-p', 'scripts/tsconfig.json']);
  await run(resolve(worker, 'node_modules/.bin/tsx'), ['--test', 'scripts/tests/tooling.test.ts']);
  await run(resolve(worker, 'node_modules/.bin/tsx'), ['--test', 'scripts/tests/artifact.test.ts']);
  await run(resolve(worker, 'node_modules/.bin/tsx'), ['--test', 'scripts/tests/wrangler-capture.test.ts']);
  await run(resolve(worker, 'node_modules/.bin/tsx'), ['--test', 'scripts/tests/release-chain.test.ts']);
  const pgTools = process.env.MEMOIA_TEST_PG_TOOLS || (() => {
    const found = spawnSync('which', ['pg_dump'], {env, encoding:'utf8', timeout:10000});
    if (found.status !== 0 || !found.stdout.trim()) throw new Error('pg_dump required; set MEMOIA_TEST_PG_TOOLS');
    return dirname(found.stdout.trim());
  })();
  for (const binary of ['pg_dump','pg_restore']) {
    const result=spawnSync(resolve(pgTools,binary),['--version'],{env,stdio:'ignore',timeout:10000});
    if (result.status !== 0) throw new Error(`${binary} missing from MEMOIA_TEST_PG_TOOLS`);
  }
  await run('docker', ['run', '-d', '--rm', '--name', container, '-e', 'POSTGRES_USER=memoia_local', '-e', 'POSTGRES_PASSWORD=memoia_local', '-e', 'POSTGRES_DB=worker_verify', '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg17']);
  await run('docker', ['run', '-d', '--rm', '--name', redisContainer, '-p', '127.0.0.1::6379', 'redis:7.4']);
  let ready = false;
  for (let i = 0; i < 60 && !cancelled; i++) {
    if (spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'memoia_local', '-d', 'worker_verify'], {env, stdio:'ignore',timeout:10000}).status === 0) { ready = true; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!ready) throw new Error('Isolated PostgreSQL did not become ready');
  const portOutput = spawnSync('docker', ['port', container, '5432/tcp'], {env, encoding:'utf8',timeout:10000});
  const port = /127\.0\.0\.1:(\d+)/.exec(portOutput.stdout)?.[1];
  if (portOutput.status !== 0 || !port) throw new Error('Cannot determine isolated PostgreSQL port');
  let redisReady = false;
  for (let i=0; i<30 && !cancelled; i++) {
    if (spawnSync('docker',['exec',redisContainer,'redis-cli','ping'],{env,stdio:'ignore',timeout:10000}).status === 0) { redisReady=true; break; }
    await new Promise(r=>setTimeout(r,1000));
  }
  if (!redisReady) throw new Error('Isolated Redis did not become ready');
  const redisPortOutput=spawnSync('docker',['port',redisContainer,'6379/tcp'],{env,encoding:'utf8',timeout:10000});
  const redisPort=/127\.0\.0\.1:(\d+)/.exec(redisPortOutput.stdout)?.[1];
  if (redisPortOutput.status !== 0 || !redisPort) throw new Error('Cannot determine isolated Redis port');
  const url = `postgresql://memoia_local:memoia_local@127.0.0.1:${port}/worker_verify`;
  const source = `postgresql://memoia_local:memoia_local@127.0.0.1:${port}/migration_source`;
  const db = { MEMOIA_TEST_DATABASE_URL: url, MEMOIA_HTTP_TEST_DB: url, MEMOIA_TEST_ADMIN_DATABASE_URL: url, MEMOIA_TEST_MIGRATION_SOURCE_URL: source, MEMOIA_TEST_PG_TOOLS: pgTools, MEMOIA_TEST_REDIS_URL: `redis://127.0.0.1:${redisPort}` };
  await run('pnpm', ['exec','tsx','scripts/migrate.ts','init','--target',url], worker);
  await run('docker', ['exec',container,'createdb','-U','memoia_local','migration_source']);
  await run('pnpm', ['exec','tsx','scripts/migrate.ts','init','--target',source], worker);
  await run('sh', ['-c', 'docker exec -i "$1" psql -v ON_ERROR_STOP=1 -U memoia_local -d migration_source < tests/migration-source.sql', 'sh', container], worker);
  await run('pnpm', ['check'], worker, db);
  await run('pnpm', ['test'], worker, db);
  await run('pnpm', ['build'], worker);
  await run('pnpm', ['check:generated'], sdk);
  await run('pnpm', ['test'], sdk);
  await run('pnpm', ['check'], mcp);
  await run('pnpm', ['test'], mcp);
}
async function execute() { try { await main(); } catch (error) { console.error(error); process.exitCode = 1; } finally {
  clearTimeout(timer);
  if (child?.pid && cancelled && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  for (const name of [container, redisContainer]) {
    const cleanup = spawnSync('docker', ['rm', '-f', name], {env, stdio:'ignore',timeout:10000});
    if (cleanup.error) { console.error('Container cleanup failed', cleanup.error); process.exitCode = 1; }
    else if (cleanup.status !== 0 && spawnSync('docker', ['inspect', name], {env, stdio:'ignore',timeout:10000}).status !== 1) { console.error('Container cleanup failed or unknown'); process.exitCode = 1; }
  }
} }
void execute();
