import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

test('locked Wrangler version upload uses the loopback API and does not update consumers or schedules', {timeout:60000}, async () => {
  const worker=resolve(import.meta.dirname,'../../src/worker');
  const directory=await mkdtemp(resolve(tmpdir(),'memoia-wrangler-test-'));
  const requests:string[]=[]; let upload=false; let metadata:any; let uploadBody=Buffer.alloc(0);
  const server=createServer(async (req,res)=>{
    const path=new URL(req.url!, 'http://localhost').pathname; const method=req.method!; requests.push(`${method} ${path}`);
    let result:any;
    if (path === '/accounts/fixture/workers/services/fixture-worker') result={default_environment:{environment:'production',script:{tag:'fixture',last_deployed_from:'wrangler'}}};
    else if (path === '/accounts/fixture/workers/workers/fixture-worker') result={subdomain:{enabled:false,previews_enabled:false}};
    else if (path === '/accounts/fixture/workers/subdomain') result={subdomain:'fixture'};
    else if (path === '/accounts/fixture/queues') result=[{queue_id:'fixture-queue-id',queue_name:'fixture-queue'}];
    else if (path === '/accounts/fixture/workers/scripts/fixture-worker/settings') result={bindings:[],compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat']};
    else if (path === '/accounts/fixture/workers/scripts/fixture-worker/secrets') result=[];
    else if (path === '/accounts/fixture/workers/scripts/fixture-worker/versions' && method === 'POST') {upload=true; const chunks:Buffer[]=[]; for await (const chunk of req) chunks.push(chunk); uploadBody=Buffer.concat(chunks); const form=await new Response(uploadBody,{headers:{'content-type':req.headers['content-type']!}}).formData(); metadata=JSON.parse(String(form.get('metadata'))); result={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',etag:'fixture',deployment_id:'fixture',available_on_subdomain:false,metadata:{has_preview:false},startup_time_ms:1,resources:{script:{etag:'fixture'}}};}
    else {res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({success:false,errors:[{code:10000,message:'Unexpected fixture request'}]}));return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({success:true,result,errors:[],messages:[]}));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const port=(server.address() as any).port;
    const config=resolve(directory,'wrangler.json');
    const emptyEnv=resolve(directory,'empty.env');await writeFile(emptyEnv,'',{mode:0o600});
    await writeFile(config,JSON.stringify({name:'fixture-worker',main:resolve(worker,'src/index.ts'),compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,rules:[{type:'Text',globs:['**/*.md'],fallthrough:true}],hyperdrive:[{binding:'HYPERDRIVE',id:'a'.repeat(32)}],queues:{producers:[{binding:'MAINTENANCE_QUEUE',queue:'fixture-queue'}],consumers:[{queue:'fixture-queue',max_batch_size:1,max_concurrency:4,max_retries:3}]},triggers:{crons:['* * * * *']}}));
    const outputPath=resolve(directory,'output.jsonl');
    const env={PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_HIDE_BANNER:'true',WRANGLER_OUTPUT_FILE_PATH:outputPath,CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',CLOUDFLARE_API_TOKEN:'fixture-token',CLOUDFLARE_ACCOUNT_ID:'fixture',CLOUDFLARE_API_BASE_URL:`http://127.0.0.1:${port}`};
    const run=(args:string[])=>new Promise<{code:number|null,output:string}>((ok,fail)=>{const p=spawn(resolve(worker,'node_modules/.bin/wrangler'),args,{cwd:worker,env});let output='';p.stdout.on('data',x=>output+=x);p.stderr.on('data',x=>output+=x);p.on('error',fail);p.on('close',code=>ok({code,output}));});
    const bundle=resolve(directory,'bundle');
    const build=await run(['deploy','--dry-run','--config',config,'--no-x-provision','--env-file',emptyEnv,'--outdir',bundle]);assert.equal(build.code,0,build.output);
    const result=await run(['versions','upload',resolve(bundle,'index.js'),'--no-bundle','--config',config,'--no-x-provision','--env-file',emptyEnv]);
    assert.equal(result.code,0,`${requests.join('\n')}\n${result.output}`);
    assert.ok(upload,'missing version upload');
    assert.ok(uploadBody.includes(await readFile(resolve(bundle,'index.js'))),'upload differs from the approved bundle');
    for (const file of await readdir(bundle)) if (file.endsWith('.md') && file !== 'README.md') assert.ok(uploadBody.includes(await readFile(resolve(bundle,file))),`upload differs from approved module ${file}`);
    assert.ok(metadata.bindings.some((b:any)=>b.name==='HYPERDRIVE' && b.id==='a'.repeat(32)));
    const entries=(await readFile(outputPath,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(entries.some((entry:any)=>entry.type==='version-upload' && entry.worker_name==='fixture-worker' && entry.version_id==='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'));
    assert.deepEqual(requests.filter(x=>/^(POST|PUT|PATCH|DELETE) /.test(x)),['POST /accounts/fixture/workers/scripts/fixture-worker/versions']);
    assert.ok(!requests.some(x=>/^(POST|PUT|PATCH|DELETE) .*\/(consumers|schedules)(\/|$)/.test(x)),requests.join('\n'));
  } finally {server.close();await rm(directory,{recursive:true,force:true});}
});
