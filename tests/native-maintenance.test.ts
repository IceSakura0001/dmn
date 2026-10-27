import assert from'node:assert/strict';import{test}from'node:test';import{mkdtempSync,rmSync,existsSync,writeFileSync,mkdirSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{spawnSync}from'node:child_process';
import{DmnStore}from'../src/store.ts';import{performNativeMaintenance}from'../src/native-maintenance.ts';import{instanceFiles}from'../src/native-instance.ts';
test('N3 stopped native backup/verify/restore preserves existing pair, rejects paths and active clients',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-native-maint-')),db=join(dir,'q.sqlite');let s:DmnStore|undefined=new DmnStore(db);const instanceId=instanceFiles(db).instanceId;
 try{await assert.rejects(performNativeMaintenance(db,{operation:'backup',params:{}}),{code:'CONFLICT'});s.close();s=undefined;
 await assert.rejects(performNativeMaintenance(db,{operation:'backup',params:{destination:'other'}}),{code:'VALIDATION'});
 const backup=await performNativeMaintenance(db,{operation:'backup',params:{}});assert(backup.backupId);assert(!JSON.stringify(backup).includes(dir));
 const checked=await performNativeMaintenance(db,{operation:'verify',params:{backupId:backup.backupId}});assert.equal(checked.verified,true);
 s=new DmnStore(db);s.run("INSERT INTO events(event_type,created_at) VALUES('after.snapshot',?)",new Date().toISOString());s.close();s=undefined;
 await assert.rejects(performNativeMaintenance(db,{operation:'restore',params:{backupId:backup.backupId,confirmInstanceId:'wrong'}}),{code:'FORBIDDEN'});
 const restored=await performNativeMaintenance(db,{operation:'restore',params:{backupId:backup.backupId,confirmInstanceId:instanceId}});assert.equal(restored.inferenceStarted,false);assert(restored.previousPairPreserved);assert(!existsSync(db+'.restore-incomplete'));
 s=new DmnStore(db);assert.equal(s.one<{n:number}>("SELECT count(*) n FROM events WHERE event_type='after.snapshot'")!.n,0);
 }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
test('N3 explicit stale owner retirement refuses busy roots and rolls metadata back on audit failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-retire-')),db=join(dir,'q.sqlite'),files=instanceFiles(db);let s:DmnStore|undefined=new DmnStore(db);s.close();s=undefined;
 const deadPid=spawnSync(process.execPath,['-e','']).pid;const request={operation:'retire',params:{confirmInstanceId:files.instanceId,confirmOwnerPid:deadPid,reason:'Confirmed stopped acceptance child'}};
 try{writeFileSync(files.owner,JSON.stringify({instanceId:files.instanceId,pid:deadPid,bootId:'fixture'}));mkdirSync(db+'.runtime');writeFileSync(join(db+'.runtime','runtime.lock'),'retained');await assert.rejects(performNativeMaintenance(db,request),{code:'CONFLICT'});assert(existsSync(files.owner));rmSync(join(db+'.runtime','runtime.lock'));
 s=new DmnStore(db);s.run("CREATE TRIGGER stop_retirement BEFORE INSERT ON events WHEN NEW.event_type='operator.native_owner_retired' BEGIN SELECT RAISE(ABORT,'audit failure'); END");s.close();s=undefined;await assert.rejects(performNativeMaintenance(db,request));assert(existsSync(files.owner));
 s=new DmnStore(db);s.run('DROP TRIGGER stop_retirement');s.close();s=undefined;const result=await performNativeMaintenance(db,request);assert.equal(result.inferenceStarted,false);assert(!existsSync(files.owner));s=new DmnStore(db);const event=s.one<{payload_json:string}>("SELECT payload_json FROM events WHERE event_type='operator.native_owner_retired'")!;assert.equal(JSON.parse(event.payload_json).operator,'desktop-user');
 }finally{s?.close();rmSync(dir,{recursive:true,force:true});}
});
