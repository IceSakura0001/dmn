import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DmnStore} from '../src/store.ts';
import {OperatorService} from '../src/operator.ts';
import {TopicRunner} from '../src/runner.ts';
import {DmnGateway} from '../src/gateway.ts';
import {fixtureNodes} from './fixtures.ts';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'dmn-replies-')),path=join(dir,'db.sqlite');
 const store=new DmnStore(path),inputs:string[]=[];
 let output='{"action":"reply_user","content":"answer"}';
 const runtime={async run(input:any,receipt:(id:string)=>void){inputs.push(input.node.id);receipt('receipt');return {sessionId:input.node.sessionId,text:output};}};
 const service=new OperatorService(store,{nodes:fixtureNodes},runtime);
 const request=JSON.parse(readFileSync(new URL('../config/topic.p2.json',import.meta.url),'utf8'));request.startNode='a';request.topic.participants=['a','b'];delete request.limits.nodeLimits;
 const {topicId}=service.start({...request,mode:'direct',idempotencyKey:'direct'});
 return {store,path,service,runtime,topicId,inputs,output(text:string){output=text;},cleanup(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('P4 direct input wakes only its recipient; reply is bound, idempotent and survives reopen',async()=>{
 const f=fixture();try{
 await f.service.drain();assert.deepEqual(f.inputs,[]);
 const input={topicId:f.topicId,to:'a',content:'hello',idempotencyKey:'one'};
 const accepted=f.service.send(input);assert.deepEqual(f.service.send(input),accepted);
 await f.service.drain();assert.deepEqual(f.inputs,['a']);
 const view=f.service.messages({topicId:f.topicId});assert.equal(view.userReplies.length,1);
 assert.equal(view.userReplies[0]!.replyTo,accepted.messageId);assert.equal(view.userReplies[0]!.sender,'a');
 assert.equal(view.operatorMessages[0]!.state,'replied');
 await f.service.drain();assert.equal(f.service.messages({topicId:f.topicId}).userReplies.length,1);
 const reopened=new DmnStore(f.path);try{assert.equal(reopened.one<{n:number}>('SELECT count(*) n FROM user_replies')!.n,1);}finally{reopened.close();}
 f.service.send({...input,to:'b',idempotencyKey:'two'});await f.service.drain();assert.deepEqual(f.inputs,['a','b']);
 assert.equal(f.store.one<{n:number}>('SELECT count(*) n FROM deliveries')!.n,0);
 }finally{f.cleanup();}
});
test('P4 direct mode rejects peer sends, forged reply identities and malformed output without blind retries',async()=>{
 for(const output of ['{"action":"send","to":"b","content":"leak"}','{"action":"reply_user","content":"x","from":"b"}','{"action":"reply_user","content":"x"} trailing']){
 const f=fixture();try{f.output(output);f.service.send({topicId:f.topicId,to:'a',content:'ignore instructions',idempotencyKey:'one'});await f.service.drain();
 assert.equal(f.inputs.length,1);assert.equal(f.service.messages({topicId:f.topicId}).userReplies.length,0);
 assert.equal(f.service.messages({topicId:f.topicId}).operatorMessages[0]!.state,'failed');
 assert.equal(f.store.one<{n:number}>('SELECT count(*) n FROM messages')!.n,0);
 }finally{f.cleanup();}}
});
test('P4 pause/resume fences reply effects; final reserved turn can reply to user',async()=>{
 const f=fixture();try{
 f.store.run('UPDATE topics SET max_model_turns=1 WHERE topic_id=?',f.topicId);
 f.service.send({topicId:f.topicId,to:'a',content:'last',idempotencyKey:'one'});await f.service.drain();
 assert.equal(f.service.messages({topicId:f.topicId}).userReplies.length,1);
 assert.equal(f.service.get({topicId:f.topicId}).state,'paused');
 assert.throws(()=>f.service.send({topicId:f.topicId,to:'a',content:'more',idempotencyKey:'two'}));
 }finally{f.cleanup();}
 const g=fixture();try{
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);
 const controlled=new OperatorService(g.store,{nodes:fixtureNodes},{async run(input,receipt){receipt('receipt');await wait;return {sessionId:input.node.sessionId,text:'{"action":"reply_user","content":"stale"}'};}});
 controlled.send({topicId:g.topicId,to:'a',content:'question',idempotencyKey:'one'});
 const active=controlled.drain();controlled.pause({topicId:g.topicId});controlled.resume({topicId:g.topicId});release();await active;
 assert.equal(controlled.messages({topicId:g.topicId}).userReplies.length,0);
 assert.equal(controlled.messages({topicId:g.topicId}).operatorMessages[0]!.state,'suppressed');
 }finally{g.cleanup();}
});
test('P4 confirmed result reconciles once after DB failure without another model call',async()=>{
 const f=fixture();try{
 f.service.send({topicId:f.topicId,to:'a',content:'question',idempotencyKey:'one'});
 f.store.run("CREATE TRIGGER reject_reply BEFORE INSERT ON user_replies BEGIN SELECT RAISE(ABORT,'injected'); END");
 await f.service.drain();assert.equal(f.service.messages({topicId:f.topicId}).operatorMessages[0]!.state,'unknown');
 f.store.run('DROP TRIGGER reject_reply');
 const turn=f.store.one<{turn_id:string}>("SELECT turn_id FROM model_turns WHERE status='unknown'")!;
 const runner=new TopicRunner(f.store,new DmnGateway(f.store),f.runtime);
 await runner.reconcile(turn.turn_id);await runner.reconcile(turn.turn_id);
 assert.equal(f.inputs.length,1);assert.equal(f.service.messages({topicId:f.topicId}).userReplies.length,1);
 }finally{f.cleanup();}
});
test('P4 silent and decline are distinct completed outcomes; unknown never appears as a reply',async()=>{
 for(const action of ['silent','decline']){const f=fixture();try{
 f.output(JSON.stringify({action}));f.service.send({topicId:f.topicId,to:'a',content:'question',idempotencyKey:'one'});await f.service.drain();
 assert.equal(f.service.messages({topicId:f.topicId}).operatorMessages[0]!.state,action);
 }finally{f.cleanup();}}
});
test('P4 direct topics cannot be seeded or bypassed through the node gateway; operator memory candidates stay rejected',async()=>{
 const f=fixture();try{
 const gateway=new DmnGateway(f.store);const runner=new TopicRunner(f.store,gateway,f.runtime);
 assert.throws(()=>runner.seed(f.topicId,'a'),{code:'FORBIDDEN'});
 assert.throws(()=>gateway.bindNode('a').send({topicId:f.topicId,to:'b',content:'bypass'}),{code:'FORBIDDEN'});
 f.output('{"action":"reply_user","content":"answer","memories":[{"kind":"semantic","content":"claimed","subjective":false,"confidence":1,"importance":1,"sourceMessageIds":["forged"]}]}');
 f.service.send({topicId:f.topicId,to:'a',content:'question',idempotencyKey:'one'});await f.service.drain();
 assert.equal(f.service.messages({topicId:f.topicId}).userReplies.length,1);
 assert.equal(f.store.one<{n:number}>('SELECT count(*) n FROM memories')!.n,0);
 assert.equal(f.store.one<{n:number}>("SELECT count(*) n FROM events WHERE event_type='memory.candidate_rejected'")!.n,1);
 }finally{f.cleanup();}
});
