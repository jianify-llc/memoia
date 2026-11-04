import { spawnSync } from 'node:child_process';
import { chmodSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const zero = '0'.repeat(40);
function run(cmd:string, args:string[], options: {capture?:boolean, env?:NodeJS.ProcessEnv} = {}) {
  const r = spawnSync(cmd,args,{cwd:root,env:options.env ?? process.env,encoding:'utf8',stdio: options.capture ? 'pipe' : 'inherit',timeout: 1_230_000});
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.error?.message ?? r.stderr ?? r.status}`);
  return r.stdout?.trim() ?? '';
}
const git = (...args:string[]) => run('git',args,{capture:true});
function clean() { if (git('status','--porcelain')) throw new Error('Test push requires a clean worktree'); return git('rev-parse','HEAD'); }
function check(input:string) {
  for (const line of input.trim().split('\n').filter(Boolean)) {
    const fields = line.trim().split(/\s+/); if (fields.length !== 4) throw new Error('Invalid push input');
    const [,sha,dest,base] = fields; if (dest !== 'refs/heads/test') continue;
    if (![sha,base].every(x => /^[a-f0-9]{40}$/.test(x)) || sha === zero || clean() !== sha) throw new Error('Invalid Test candidate');
    if (process.env.JIANIFY_TEST_LOCAL_CI_PROOF !== `${sha}:${base}`) throw new Error('Run scripts/test-push.ts push');
    if (base !== zero) git('merge-base','--is-ancestor',base,sha);
  }
}
try {
  const action=process.argv[2];
  if (action === 'check') check(readFileSync(0,'utf8'));
  else if (action === 'install') {
    const config=spawnSync('git',['config','--get','core.hooksPath'],{cwd:root,encoding:'utf8'});
    if (![0,1].includes(config.status ?? -1)) throw new Error('Cannot read hooksPath');
    const current=config.stdout.trim(); if (current && current !== '.githooks') throw new Error('Existing hook manager; integrate manually');
    const hooks=resolve(root,git('rev-parse','--git-path','hooks'));
    if (!current && existsSync(hooks) && readdirSync(hooks).some(x=>!x.endsWith('.sample'))) throw new Error('Existing hooks; integrate manually');
    chmodSync(resolve(root,'.githooks/pre-push'),0o755); git('config','--local','core.hooksPath','.githooks');
  } else if (action === 'push') {
    if (git('config','--get','core.hooksPath') !== '.githooks') throw new Error('Install hook first');
    const sha=clean(); const remote=git('ls-remote','origin','refs/heads/test'); const base=remote ? remote.split(/\s+/)[0] : zero;
    if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid remote Test SHA');
    if (base !== zero) { git('fetch','--no-tags','origin','test'); git('merge-base','--is-ancestor',base,sha); }
    run('src/worker/node_modules/.bin/tsx',['scripts/verify.ts','full']);
    if (clean() !== sha) throw new Error('Candidate changed during verification');
    run('git',['push','origin','HEAD:refs/heads/test'],{env:{...process.env,JIANIFY_TEST_LOCAL_CI_PROOF:`${sha}:${base}`}});
  } else throw new Error('Usage: test-push.ts install|push|check');
} catch(error) { console.error(error); process.exitCode=1; }
