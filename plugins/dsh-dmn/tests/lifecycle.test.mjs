import assert from'node:assert/strict';
import{test}from'node:test';
import{mkdtempSync,rmSync,existsSync}from'node:fs';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{createServiceManager}from'../service-manager.mjs';
test('N1 real child handshake, reuse, borrowed disconnect and owned graceful stop without inference',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-host-')),database=join(dir,'db.sqlite'),one=createServiceManager({database,nodePath:process.execPath}),two=createServiceManager({database,nodePath:process.execPath});
 try{const [a,b]=await Promise.all([one.request('state'),one.request('state')]);assert.equal(a.pid,b.pid);assert.equal(a.modelCalls,0);assert.equal(a.credentialConfigured,false);assert(one.owned);await assert.rejects(one.request('start',{},'f'.repeat(32)),/INSTANCE_CHANGED/);assert.equal((await one.request('state')).modelCalls,0);
 const borrowed=await two.request('state');assert.equal(borrowed.pid,a.pid);assert(!two.owned);await two.close();assert.equal((await one.request('state')).pid,a.pid);
 await one.close();for(let i=0;i<100&&existsSync(database+'.native.owner');i++)await new Promise(r=>setTimeout(r,20));assert(!existsSync(database+'.native.owner'));
 }finally{await two.close();await one.close();rmSync(dir,{recursive:true,force:true});}
});
test('N3 Host maintenance stops its child, backs up and restores without an inference wake',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-host-maint-')),database=join(dir,'db.sqlite'),manager=createServiceManager({database,nodePath:process.execPath});
 try{const first=await manager.request('state');const result=await manager.manage('backup',{});assert(result.backupId);assert(!existsSync(database+'.native.owner'));
 assert.equal((await manager.manage('verify',{backupId:result.backupId})).verified,true);
 const restored=await manager.manage('restore',{backupId:result.backupId,confirmInstanceId:first.instanceId});assert(restored.previousPairPreserved);const state=await manager.request('state');assert.equal(state.modelCalls,0);assert.equal(state.instanceId,first.instanceId);
 }finally{await manager.close();rmSync(dir,{recursive:true,force:true});}
});
