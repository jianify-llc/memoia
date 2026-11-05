import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

for (const scenario of ['success','documented-consumer-owner','conflicting-consumer-owner','missing-consumer-owner','consumer-owner-drift','online-artifact','tampered-artifact','expired-before-upload','missing-consumer','consumer-drift','cron-drift','wrong-hyperdrive','hyperdrive-cache-enabled','missing-secret','wrong-secret-type','wrong-version-binding','wrong-version-var','public-entry','preview-entry','configured-public-route','wrong-active-version','rollback-success','rollback-wrong-hyperdrive','rollback-wrong-queue','rollback-missing-config']) test(`release chain: ${scenario}`,{timeout:60000},async()=>{
  const root=resolve(import.meta.dirname,'../..'), worker=resolve(root,'src/worker'), dir=await mkdtemp(resolve(tmpdir(),'memoia-chain-'));
  const online=scenario==='online-artifact' || scenario==='tampered-artifact', stage=online?'online':'test';
  const rollback=scenario.startsWith('rollback-');
  const account='a'.repeat(32), hyper='b'.repeat(32), name=online?'memoia-online':'luvel-memoia-test', version='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const base=`/accounts/${account}`, script=`${base}/workers/scripts/${name}`; let writes:string[]=[]; let active='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; const calls:string[]=[]; let leaked=false;
  const consumer={consumer_id:'consumer',...(scenario==='missing-consumer-owner'?{}:scenario==='documented-consumer-owner'?{script_name:name}:{script:name}),...(scenario==='conflicting-consumer-owner'?{script_name:'other-worker'}:{}),type:'worker',settings:{batch_size:1,max_concurrency:scenario==='consumer-drift'?2:4,max_retries:3,max_wait_time_ms:5000,retry_delay:0}};
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url!,'http://localhost').pathname, method=req.method!;calls.push(`${method} ${path}`);if(method!=='GET')writes.push(`${method} ${path}`);let result:any;
    if(path===`${script}/settings`)result={bindings:[{name:'HYPERDRIVE',type:'hyperdrive',id:scenario==='wrong-hyperdrive'?'c'.repeat(32):hyper},{name:'MAINTENANCE_QUEUE',type:'queue',queue_name:'fixture-queue'}],compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat']};
    else if(path===`${script}/subdomain`)result={enabled:scenario==='public-entry',previews_enabled:scenario==='preview-entry'};
    else if(path===`${base}/hyperdrive/configs/${hyper}`)result={id:hyper,caching:{disabled:scenario!=='hyperdrive-cache-enabled'}};
    else if(path===`${base}/queues`)result=[{queue_id:'queue-id',queue_name:'fixture-queue'}];
    else if(path===`${base}/queues/queue-id`)result={queue_id:'queue-id',queue_name:'fixture-queue',consumers:scenario==='missing-consumer'?[]:[scenario==='consumer-owner-drift' && active===version?{...consumer,script:'other-worker'}:consumer],consumers_total_count:scenario==='missing-consumer'?0:1};
    else if(path===`${script}/schedules`)result={schedules:[{cron:scenario==='cron-drift'?'*/5 * * * *':'* * * * *'}]};
    else if(path===`${base}/workers/services/${name}`)result={default_environment:{environment:'production',script:{tag:'fixture',last_deployed_from:'wrangler'}}};
    else if(path===`${script}/secrets`)result=[{name:'ACCESS_TOKEN',type:'secret_text'},...(scenario==='missing-secret'?[]:[{name:'OPENAI_API_KEY',type:scenario==='wrong-secret-type'?'plain_text':'secret_text'}])];
    else if(path===`${script}/versions` && method==='POST'){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);leaked=Buffer.concat(chunks).includes(Buffer.from('fixture-unrelated-secret'));result={id:version,etag:'fixture',metadata:{has_preview:false},startup_time_ms:1,resources:{script:{etag:'fixture'}}};}
    else if(path===`${script}/versions` && method==='GET')result={items:[{id:version,metadata:{created_on:'2026-01-01T00:00:00Z'},annotations:{}}]};
    else if(path.startsWith(`${script}/versions/`))result={id:path.split('/').pop(),metadata:{created_on:'2026-01-01T00:00:00Z'},annotations:{},resources:{bindings:[{name:'HYPERDRIVE',type:'hyperdrive',id:['wrong-version-binding','rollback-wrong-hyperdrive'].includes(scenario)?'c'.repeat(32):hyper},{name:'MAINTENANCE_QUEUE',type:'queue',queue_name:scenario==='rollback-wrong-queue'?'other-queue':'fixture-queue'},{name:'MEMOIA_WRITES_ENABLED',type:'plain_text',text:scenario==='wrong-version-var'||rollback?'true':'false'},{name:'MAINTENANCE_ENABLED',type:'plain_text',text:'false'}],script_runtime:{containers:[]}}};
    else if(path===`${script}/deployments` && method==='GET')result={deployments:[{id:'deployment',versions:[{version_id:active,percentage:100}]}]};
    else if(path===`${script}/deployments` && method==='POST'){for await(const _ of req){} if(scenario!=='wrong-active-version') active=version;result={id:'deployment',versions:[{version_id:version,percentage:100}]};}
    else {res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({success:false,errors:[{code:10000,message:'unexpected fixture request'}]}));return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({success:true,result,errors:[],messages:[]}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try{
    const origin=`http://127.0.0.1:${(server.address() as any).port}`;const config=resolve(dir,'wrangler.json');
    const configText=JSON.stringify({main:resolve(worker,'src/index.ts'),...(scenario==='configured-public-route'?{routes:[{pattern:'memoia.example.com/*',zone_name:'example.com'}]}:{}),compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,rules:[{type:'Text',globs:['**/*.md'],fallthrough:true}],env:{[stage]:{name,secrets:{required:['ACCESS_TOKEN','OPENAI_API_KEY']},vars:{MEMOIA_WRITES_ENABLED:'false',MAINTENANCE_ENABLED:'false'},...(scenario==='rollback-missing-config'?{}:{hyperdrive:[{binding:'HYPERDRIVE',id:hyper}]}),queues:{producers:[{binding:'MAINTENANCE_QUEUE',queue:'fixture-queue'}],consumers:[{queue:'fixture-queue',max_batch_size:1,max_concurrency:4,max_retries:3}]},triggers:{crons:['* * * * *']}}}});await writeFile(config,configText);
    let releaseArgs=rollback?['rollback',stage,version]:['deploy',stage];
    if(online){
      const artifact=resolve(dir,'artifact'),bundle=resolve(artifact,'bundle'),empty=resolve(dir,'empty.env');await mkdir(artifact);await writeFile(empty,'',{mode:0o600});
      const built=spawnSync(resolve(worker,'node_modules/.bin/wrangler'),['deploy','--dry-run','--env','online','--config',config,'--outdir',bundle,'--no-x-provision','--env-file',empty],{cwd:worker,env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:'true'},encoding:'utf8',timeout:30000});assert.equal(built.status,0,built.stderr);
      const hash=(x:Buffer|string)=>createHash('sha256').update(x).digest('hex');const files:Record<string,string>={};for(const file of (await readdir(bundle)).sort())files[file]=hash(await readFile(resolve(bundle,file)));
      const source=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim();const manifest=JSON.stringify({source,stage,wrangler:'4.155.0',config:hash(configText),files})+'\n';await writeFile(resolve(artifact,'manifest.json'),manifest);
      releaseArgs=['deploy',stage,artifact,hash(manifest),source];if(scenario==='tampered-artifact')await writeFile(resolve(bundle,'index.js'),'tampered');
    }
    const sentinel=resolve(dir,'unexpected-output.jsonl');await writeFile(resolve(dir,'.env'),`WRANGLER_OUTPUT_FILE_PATH=${sentinel}\n`);
    const fakeClock=scenario==='expired-before-upload'?'let n=0; const now=()=>++n<=9?0:900001;':'const now=Date.now;';
    const wrapper=resolve(dir,'runner.ts');await writeFile(wrapper,`import {release} from ${JSON.stringify(resolve(root,'deploy/release.ts'))}; ${fakeClock} release({now,args:${JSON.stringify(releaseArgs)},configPath:${JSON.stringify(config)},wranglerCwd:${JSON.stringify(dir)},apiBase:${JSON.stringify(origin)},wranglerEnv:{CLOUDFLARE_API_BASE_URL:${JSON.stringify(origin)},WRANGLER_SEND_METRICS:'false',WRANGLER_HIDE_BANNER:'true'}}).catch(e=>{console.error(e);process.exitCode=1});`);
    const env={PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',CLOUDFLARE_API_TOKEN:'fixture-token',CLOUDFLARE_ACCOUNT_ID:account,UNRELATED_SECRET:'fixture-unrelated-secret'};
    const result=await new Promise<{code:number|null,output:string}>((ok,fail)=>{const p=spawn(resolve(worker,'node_modules/.bin/tsx'),[wrapper],{cwd:root,env});let output='';p.stdout.on('data',x=>output+=x);p.stderr.on('data',x=>output+=x);p.on('error',fail);p.on('close',code=>ok({code,output}));});
    if(scenario==='success' || scenario==='documented-consumer-owner' || scenario==='online-artifact') {assert.equal(result.code,0,`${calls.join('\n')}\n${result.output}`);assert.equal(active,version);assert.equal(leaked,false);await assert.rejects(access(sentinel));assert.deepEqual(writes,[`POST ${script}/versions`,`POST ${script}/deployments`]);}
    else if(scenario==='rollback-success') {assert.equal(result.code,0,`${calls.join('\n')}\n${result.output}`);assert.equal(active,version);assert.deepEqual(writes,[`POST ${script}/deployments`]);}
    else if(scenario==='wrong-active-version') {assert.notEqual(result.code,0);assert.match(result.output,/Active version differs/);assert.equal(writes.length,2);}
    else if(scenario==='consumer-owner-drift') {assert.notEqual(result.code,0);assert.match(result.output,/Queue consumer changed during publication/);assert.equal(writes.length,2);}
    else if(scenario==='wrong-version-binding' || scenario==='wrong-version-var') {assert.notEqual(result.code,0);assert.match(result.output,/Uploaded version binding mismatch/);assert.deepEqual(writes,[`POST ${script}/versions`]);}
    else {assert.notEqual(result.code,0);assert.deepEqual(writes,[]);if(scenario==='expired-before-upload')assert.match(result.output,/deadline exceeded/);}
  }finally{server.close();await rm(dir,{recursive:true,force:true});}
});
