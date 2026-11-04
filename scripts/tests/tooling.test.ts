import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const tsx=resolve(root,'src/worker/node_modules/.bin/tsx');
const env={PATH:process.env.PATH, HOME:process.env.HOME, CI:'true', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'};
function run(file:string,args:string[],input?:string) { return spawnSync(tsx,[file,...args],{cwd:root,env,input,encoding:'utf8',timeout:15_000}); }
test('Test branch deletion is rejected',()=>{
  const r=run('scripts/test-push.ts',['check'],`(delete) ${'0'.repeat(40)} refs/heads/test ${'a'.repeat(40)}\n`);
  assert.notEqual(r.status,0);
});
test('unrelated branch push passes the hook',()=>{
  const r=run('scripts/test-push.ts',['check'],`refs/heads/x ${'a'.repeat(40)} refs/heads/x ${'0'.repeat(40)}\n`);
  assert.equal(r.status,0,r.stderr);
});
test('Test deployment fails closed without credentials',()=>{
  const r=run('deploy/release.ts',['deploy','test']);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/consumer|Hyperdrive|credentials/);
});
test('rollback requires an explicit version UUID',()=>{
  const r=run('deploy/release.ts',['rollback','test','invalid']);
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/version UUID/);
});
