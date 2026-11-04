import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
const root=resolve(import.meta.dirname,'..'), worker=resolve(root,'src/worker');
const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
function entries(dir:string):Record<string,string> {
  const files:Record<string,string>={};
  function walk(path:string,prefix='') { for(const name of readdirSync(path).sort()) { const relative=prefix?`${prefix}/${name}`:name;const full=join(path,name);const stat=lstatSync(full); if(stat.isSymbolicLink()) throw new Error('Artifact symlinks forbidden');if(stat.isDirectory()) walk(full,relative);else if(stat.isFile()) files[relative]=sha(readFileSync(full)); else throw new Error('Invalid artifact file'); } }
  walk(dir); return files;
}
export function verifyArtifact(directory:string, digest:string, source:string, stage:string, configPath=resolve(worker,'wrangler.jsonc')) {
  if (!/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{40}$/.test(source)) throw new Error('Invalid artifact identity');
  const manifestRaw=readFileSync(resolve(directory,'manifest.json'));
  if(sha(manifestRaw)!==digest) throw new Error('Artifact manifest digest mismatch');
  const manifest=JSON.parse(manifestRaw.toString());
  if(manifest.source!==source || manifest.stage!==stage || manifest.wrangler!=='4.155.0' || manifest.config!==sha(readFileSync(configPath))) throw new Error('Artifact source, configuration or stage mismatch');
  const actual=entries(resolve(directory,'bundle'));
  if(!actual['index.js'] || JSON.stringify(actual)!==JSON.stringify(manifest.files)) throw new Error('Artifact files missing or altered');
  return resolve(directory,'bundle/index.js');
}
function build(directory:string, stage:string, source:string) {
  if (!['test','online'].includes(stage) || !/^[a-f0-9]{40}$/.test(source)) throw new Error('Invalid build identity');
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
  if(git.status!==0 || git.stdout.trim()!==source) throw new Error('Build source is not checked-out HEAD');
  const status=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'});
  if(status.status!==0 || status.stdout.trim()) throw new Error('Build requires a clean source tree');
  const configPath=resolve(worker,'wrangler.jsonc');
  const config=JSON.parse(readFileSync(configPath,'utf8'));if(!config.env?.[stage])throw new Error('Missing stage configuration');
  mkdirSync(directory,{recursive:false});mkdirSync(resolve(directory,'bundle'));
  const env:NodeJS.ProcessEnv={CI:'true',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',WRANGLER_SEND_METRICS:'false'};
  for(const key of ['PATH','HOME','TMPDIR','TMP','TEMP','SystemRoot'])if(process.env[key])env[key]=process.env[key];
  const envDir=mkdtempSync(resolve(tmpdir(),'memoia-build-env-'));const emptyEnv=resolve(envDir,'empty.env');writeFileSync(emptyEnv,'',{mode:0o600});
  try {
  const cli=resolve(worker,'node_modules/.bin/wrangler');const ver=spawnSync(cli,['--version','--env-file',emptyEnv],{cwd:worker,env,encoding:'utf8',timeout:30000});
  if(ver.status!==0 || ver.stdout.trim()!=='4.155.0')throw new Error('Wrangler 4.155.0 required');
  const result=spawnSync(cli,['deploy','--dry-run','--no-x-provision','--env',stage,'--env-file',emptyEnv,'--outdir',resolve(directory,'bundle')],{cwd:worker,env,stdio:'inherit',timeout:600000});
  if(result.status!==0)throw new Error('Worker bundle failed');
  const files=entries(resolve(directory,'bundle'));if(!files['index.js'])throw new Error('Worker bundle missing entry');
  const manifest=JSON.stringify({source,stage,wrangler:'4.155.0',config:sha(readFileSync(configPath)),files})+'\n';
  writeFileSync(resolve(directory,'manifest.json'),manifest,{mode:0o600});
  console.log(`Artifact manifest SHA256: ${sha(manifest)}`);
  } finally { rmSync(envDir,{recursive:true,force:true}); }
}
if(process.argv[1] && resolve(process.argv[1])===resolve(import.meta.dirname,'artifact.ts')) {
  try {if(process.argv.length!==6 || process.argv[2]!=='build')throw new Error('Usage: artifact.ts build STAGE SOURCE_SHA DIRECTORY');build(resolve(process.argv[5]),process.argv[3],process.argv[4]);} catch(error){console.error(error);process.exitCode=1;}
}
