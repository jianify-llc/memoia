import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyArtifact } from '../../deploy/artifact.js';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
test('artifact identity binds source, stage, config and every bundle file',()=>{
  const dir=mkdtempSync(resolve(tmpdir(),'memoia-artifact-test-'));
  try {
    mkdirSync(resolve(dir,'bundle'));writeFileSync(resolve(dir,'bundle/index.js'),'bundle');writeFileSync(resolve(dir,'config.json'),'config');
    const source='a'.repeat(40), raw=JSON.stringify({source,stage:'online',wrangler:'4.155.0',config:digest('config'),files:{'index.js':digest('bundle')}})+'\n';
    writeFileSync(resolve(dir,'manifest.json'),raw);
    assert.equal(verifyArtifact(dir,digest(raw),source,'online',resolve(dir,'config.json')),resolve(dir,'bundle/index.js'));
    assert.throws(()=>verifyArtifact(dir,digest(raw),'b'.repeat(40),'online',resolve(dir,'config.json')));
    assert.throws(()=>verifyArtifact(dir,digest(raw),source,'test',resolve(dir,'config.json')));
    writeFileSync(resolve(dir,'bundle/index.js'),'tampered');
    assert.throws(()=>verifyArtifact(dir,digest(raw),source,'online',resolve(dir,'config.json')),/altered/);
    writeFileSync(resolve(dir,'manifest.json'),raw+' ');
    assert.throws(()=>verifyArtifact(dir,digest(raw),source,'online',resolve(dir,'config.json')),/digest mismatch/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
