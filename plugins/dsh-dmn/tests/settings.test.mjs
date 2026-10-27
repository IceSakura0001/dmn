import assert from'node:assert/strict';import{test}from'node:test';import{mkdtempSync,rmSync,readFileSync}from'node:fs';import{join}from'node:path';import{tmpdir}from'node:os';
import{NativeSettings}from'../settings.mjs';
import{createSettingsRoute,validateBoundModels}from'../settings-route.mjs';import{DatabaseSync}from'node:sqlite';
test('N4 settings reject secrets/relative paths/stale writes and retain a nonsecret previous version',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-settings-'));try{const settings=new NativeSettings(dir);const initial=settings.read();assert.equal(initial.revision,1);assert(!JSON.stringify(initial).includes('apiKey":'));
 assert.throws(()=>settings.save({...initial,apiKey:'not-a-real-key'}),/VALIDATION/);assert.throws(()=>settings.save({...initial,database:'relative.sqlite'}),/VALIDATION/);
 const next=settings.save({...initial,credentialRef:'CUSTOM_PROVIDER_KEY'});assert.equal(next.revision,2);assert.throws(()=>settings.save(initial),/CONFLICT/);assert.equal(JSON.parse(readFileSync(settings.path+'.previous','utf8')).revision,1);
 const reopened=new NativeSettings(dir);assert.deepEqual(reopened.read(),next);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('N4 credential values use the official credential service and never enter files or responses',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-settings-route-'));try{const store=new NativeSettings(dir),calls=[],credentials={async describe(){return{configured:calls.length>0};},async set(...args){calls.push(args);}};
 const handler=createSettingsRoute({store,credentials,async change(next){store.save(next);}}),initial=store.read(),secret='FAKE_TEST_CREDENTIAL_VALUE';
 const response=await handler(new Request('http://host/settings',{method:'POST',headers:{'content-type':'application/json','x-dmn-settings':'1'},body:JSON.stringify({settings:initial,credentialValue:secret})}));assert.equal(response.status,200);assert.deepEqual(calls,[[initial.credentialRef,secret]]);assert(!(await response.text()).includes(secret));assert(!readFileSync(store.path,'utf8').includes(secret));
 const bound=join(dir,'bound.sqlite'),db=new DatabaseSync(bound);db.exec("CREATE TABLE model_nodes(node_id TEXT,model_id TEXT);INSERT INTO model_nodes VALUES('deepseek','deepseek-flash')");db.close();assert.throws(()=>validateBoundModels({...initial,database:bound,models:['deepseek-v4-pro','deepseek-v4-pro']}),/IMMUTABLE_NODE_ROUTE/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
