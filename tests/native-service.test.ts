import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {randomUUID} from 'node:crypto';
import {startNativeService} from '../src/native-service.ts';
import {nativeRequest,requestDescriptor} from '../src/native-client.ts';
import {instanceFiles,assertSchedulingOwner} from '../src/native-instance.ts';
import {fixtureNodes} from './fixtures.ts';
const delay=()=>new Promise(r=>setTimeout(r,20));
function fixture(){const dir=mkdtempSync(join(tmpdir(),'dmn-native-')),db=join(dir,'q.sqlite');const request=JSON.parse(readFileSync(new URL('../config/topic.p2.json',import.meta.url),'utf8'));request.startNode='a';request.topic.participants=['a','b'];delete request.limits.nodeLimits;return{dir,db,request:{...request,mode:'direct',idempotencyKey:'start'},cleanup(){rmSync(dir,{recursive:true,force:true});}};}
test('N1 discovery/authentication/read/reconnect do not infer; one owner and no secret in state',async()=>{
 const f=fixture();let calls=0;const app=await startNativeService(f.db,{nodes:fixtureNodes},{async run(i){calls++;return{sessionId:i.node.sessionId,text:'{"action":"silent"}'};}});
 try{const state=await nativeRequest(f.db,'state');assert.equal(state.modelCalls,0);assert.equal(calls,0);assert.equal(state.pid,process.pid);assert(!JSON.stringify(state).includes(app.descriptor.token));
 await assert.rejects(startNativeService(f.db,{nodes:fixtureNodes},{async run(){throw Error();}}),{code:'CONFLICT'});
 await assert.rejects(requestDescriptor({...app.descriptor,token:'0'.repeat(64)},'state'),{code:'FORBIDDEN'});
 await assert.rejects(nativeRequest(f.db,'state',{database:'other'}),{code:'VALIDATION'});
 await assert.rejects(nativeRequest(f.db,'__stop'),{code:'FORBIDDEN'});
 const first=await nativeRequest(f.db,'start',f.request);assert.deepEqual(await nativeRequest(f.db,'start',f.request),first);await delay();assert.equal(calls,0);
 assert.equal((await nativeRequest(f.db,'state')).pid,state.pid);
 }finally{await app.stop();assert(!existsSync(instanceFiles(f.db).owner));f.cleanup();}
});
test('N1 stop drains current activity and leaves later work queued; start never replays it',async()=>{
 const f=fixture();let calls=0,release!:()=>void;const hold=new Promise<void>(r=>release=r);
 const runtime={async run(i:any){calls++;await hold;return{sessionId:i.node.sessionId,text:'{"action":"silent"}'};}};
 const app=await startNativeService(f.db,{nodes:fixtureNodes},runtime);
 try{const {topicId}=await nativeRequest(f.db,'start',f.request);const message={topicId,to:'a',content:'中文正文',idempotencyKey:'m1'};
 const accepted=await nativeRequest(f.db,'send',message);assert.deepEqual(await nativeRequest(f.db,'send',message),accepted);
 for(let i=0;i<100&&calls===0;i++)await delay();assert.equal(calls,1);
 await nativeRequest(f.db,'send',{...message,idempotencyKey:'m2'});const stopping=app.stop();await assert.rejects(nativeRequest(f.db,'send',{...message,idempotencyKey:'m3'}),{code:'CONFLICT'});release();await stopping;assert.equal(calls,1);
 const restarted=await startNativeService(f.db,{nodes:fixtureNodes},runtime);try{await delay();assert.equal(calls,1);assert.equal((await nativeRequest(f.db,'state')).modelCalls,1);}finally{await restarted.stop();}
 }finally{release?.();await app.stop();f.cleanup();}
});
test('N1 stale ownership fails closed and another process cannot schedule',()=>{const f=fixture();try{const files=instanceFiles(f.db);writeFileSync(files.owner,JSON.stringify({instanceId:files.instanceId,pid:process.pid+10000,bootId:'stale'}));assert.throws(()=>assertSchedulingOwner(f.db),{code:'CONFLICT'});assert(existsSync(files.owner));}finally{f.cleanup();}});
test('N1 lost response retains durable request identity without automatic write replay',async()=>{const f=fixture();const app=await startNativeService(f.db,{nodes:fixtureNodes},{async run(){throw Error('unexpected');}});try{
 await new Promise<void>((resolve,reject)=>{const socket=createConnection(app.descriptor.address);socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify({protocol:1,id:randomUUID(),token:app.descriptor.token,method:'start',params:f.request})+'\n',()=>{socket.destroy();resolve();}));});
 await delay();const retry=await nativeRequest(f.db,'start',f.request);assert.equal((await nativeRequest(f.db,'topics')).length,1);assert.equal((await nativeRequest(f.db,'state')).modelCalls,0);assert(retry.topicId);
 }finally{await app.stop();f.cleanup();}});
test('N3 recovery requires owning Host capability, exact approval and bound audit identity',async()=>{
 const f=fixture();let release!:()=>void;const hold=new Promise<void>(r=>release=r);let calls=0;
 const app=await startNativeService(f.db,{nodes:fixtureNodes},{async run(i,receipt){calls++;receipt('accepted');await hold;throw Error('injected unknown');},async inspect(){return{state:'unknown',reason:'INJECTED_QUIESCENT',quiescent:true};}});
 try{const {topicId}=await nativeRequest(f.db,'start',f.request);await nativeRequest(f.db,'send',{topicId,to:'a',content:'private-input-not-in-diagnostics',idempotencyKey:'unknown'});for(let i=0;i<100&&!calls;i++)await delay();
 await assert.rejects(nativeRequest(f.db,'recover',{},app.ownerToken),{code:'CONFLICT'});release();let queue;for(let i=0;i<100;i++){queue=await nativeRequest(f.db,'queue');if(queue.pending[0]?.status==='unknown')break;await delay();}const turnId=queue.pending[0].turnId;assert(!JSON.stringify(queue).includes('private-input'));
 await assert.rejects(nativeRequest(f.db,'drop',{turnId,confirmTurnId:turnId,reason:'test'}),{code:'FORBIDDEN'});
 await assert.rejects(nativeRequest(f.db,'drop',{turnId,confirmTurnId:'wrong',reason:'test'},app.ownerToken),{code:'VALIDATION'});
 assert.equal((await nativeRequest(f.db,'proof',{turnId})).proof.quiescent,true);
 assert.equal((await nativeRequest(f.db,'drop',{turnId,confirmTurnId:turnId,reason:'explicit acceptance abandonment'},app.ownerToken)).state,'failed');assert.equal(calls,1);
 }finally{release();await app.stop();f.cleanup();}
});
