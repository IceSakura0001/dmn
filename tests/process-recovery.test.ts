import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DmnStore} from '../src/store.ts';
import {DshRootRuntime} from '../src/dsh-runtime.ts';
import {RecoveryManager} from '../src/operations.ts';
import {createBackup} from '../src/backup.ts';
test('P5 abrupt process loss retains root marker; expiry quarantines and neither drop nor backup can bypass it',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-crash-')),database=join(dir,'queue.sqlite');let store:DmnStore|undefined;
 try{
  const result=spawnSync(process.execPath,['--import','tsx','tests/helpers/crash-after-receipt.ts',database],{encoding:'utf8'});assert.equal(result.status,23,result.stderr);
  store=new DmnStore(database);const recovery=new RecoveryManager(store,new DshRootRuntime({root:database+'.runtime',workspace:process.cwd()}),()=>new Date('2099-01-01T00:00:00Z'));
  assert.equal(recovery.quarantineExpired().quarantined,1);const turn=store.one<{turn_id:string}>('SELECT turn_id FROM model_turns')!.turn_id;
  const proof=await recovery.inspect({turnId:turn});assert.equal(proof.proof.state,'unknown');assert.equal((proof.proof as {reason:string}).reason,'RUNTIME_HOME_BUSY');
  assert.equal((await recovery.drop({turnId:turn,confirmTurnId:turn,reason:'must stay blocked'})).state,'unknown');store.close();store=undefined;
  await assert.rejects(createBackup(database,join(dir,'backup')),{code:'CONFLICT'});assert(existsSync(database+'.runtime/a/runtime.lock'));
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
