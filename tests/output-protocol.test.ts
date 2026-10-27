import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeModelOutput } from '../src/model-output.ts';
import { setup } from './fixtures.ts';
import { TopicRunner } from '../src/runner.ts';
import { TopicManager } from '../src/topic-manager.ts';
import { DatabaseSync } from 'node:sqlite';

const malformed = [
  '{"action":"send","to":"a","content":"hello"}}',
  '{"action":"send","to":"a","content":"hello"}\n{"kind":"semantic","content":"second object"}',
  '```json\n{"action":"silent"}\n```',
  '{"action":"silent"}<DSML>suffix</DSML>',
];

test('output decoder accepts one strict envelope and never repairs braces, multiple objects, fences or suffixes',()=>{
  assert.deepEqual(decodeModelOutput('{"action":"silent"}'),{success:true,data:{action:'silent',memories:[]}});
  for(const text of malformed)assert.deepEqual(decodeModelOutput(text),{success:false,reason:'invalid_json'});
  for(const text of ['null','[]','{"action":"send","from":"admin","to":"a","content":"hello"}'])assert.deepEqual(decodeModelOutput(text),{success:false,reason:'invalid_envelope'});
});

test('format diagnostics remain idempotent when a crash window requires reconciliation of a confirmed invalid result',async()=>{
  const f=setup(),fault=new DatabaseSync(f.path);let calls=0,time=Date.parse('2026-10-26T00:00:00Z');
  const runtime={async run(input:{node:{sessionId:string}},receipt:(id:string)=>void){calls++;receipt('receipt');return {sessionId:input.node.sessionId,text:'{"action":"silent"}}'};}};
  try{
    const runner=new TopicRunner(f.store,f.gateway,runtime,()=>new Date(time));
    runner.authorize(f.topic.id,{maxInputTokens:10000,maxOutputTokens:5000,maxEstimatedCost:1,inputTokensPerTurn:1000,outputTokensPerTurn:500,estimatedCostPerTurn:0.1,turnTimeoutMs:5000});
    f.a.send({topicId:f.topic.id,to:'b',content:'input'});
    fault.exec("CREATE TRIGGER lose_failure BEFORE UPDATE ON deliveries WHEN new.status='dead_letter' BEGIN SELECT RAISE(ABORT,'crash after diagnostic'); END");
    await assert.rejects(runner.drain(),{code:'STORAGE'});fault.exec('DROP TRIGGER lose_failure');
    time+=40000;
    const recovered=new TopicRunner(f.store,f.gateway,runtime,()=>new Date(time));await recovered.drain();
    const turn=f.store.one<{turn_id:string;status:string}>('SELECT turn_id,status FROM model_turns')!;assert.equal(turn.status,'unknown');
    assert.equal((await recovered.reconcile(turn.turn_id)).state,'failed');
    assert.equal((await recovered.reconcile(turn.turn_id)).applied,false);
    assert.equal(new TopicManager(f.store).get(f.topic.id).outputErrors.invalidJson,1);
    assert.equal(calls,1);assert.equal(f.store.one<{n:number}>('SELECT count(*) n FROM dead_letters')!.n,1);
  }finally{fault.close();f.cleanup();}
});

test('confirmed invalid output is checkpointed then dead-lettered once, without retry or private text in public audit',async()=>{
  for(const text of [...malformed,'{"action":"silent","ownerNodeId":"foreign"}']){
    const f=setup();let calls=0;
    try{
      const runner=new TopicRunner(f.store,f.gateway,{async run(input,receipt){calls++;receipt('confirmed');return {sessionId:input.node.sessionId,text};}},()=>new Date('2026-10-26T00:00:00Z'));
      runner.authorize(f.topic.id,{maxInputTokens:10000,maxOutputTokens:5000,maxEstimatedCost:1,inputTokensPerTurn:1000,outputTokensPerTurn:500,estimatedCostPerTurn:0.1,turnTimeoutMs:5000});
      f.a.send({topicId:f.topic.id,to:'b',content:'input'});await runner.drain();await runner.drain();
      const turn=f.store.one<{turn_id:string;status:string}>('SELECT turn_id,status FROM model_turns')!;
      assert.equal(turn.status,'failed');assert.equal(calls,1);
      assert.equal(f.store.one<{n:number}>('SELECT count(*) n FROM runtime_results')!.n,1);
      assert.equal(f.store.one<{n:number}>('SELECT count(*) n FROM dead_letters')!.n,1);
      assert.equal(f.store.one<{n:number}>('SELECT count(*) n FROM node_locks')!.n,0);
      assert.deepEqual(await runner.reconcile(turn.turn_id),{state:'failed',applied:false});
      const audit=f.gateway.getAudit(f.topic.id);
      assert(audit.some(x=>x.eventType===(text.includes('ownerNodeId')?'turn.output_invalid_envelope':'turn.output_invalid_json')));
      assert(!JSON.stringify(audit).includes(text));
      const status=new TopicManager(f.store).get(f.topic.id);
      assert.equal(status.outcomes.failed,1);assert.equal(status.outcomes.unknown,0);assert.equal(status.deadLetters,1);
      assert.deepEqual(status.outputErrors,text.includes('ownerNodeId')?{invalidJson:0,invalidEnvelope:1}:{invalidJson:1,invalidEnvelope:0});
      assert(!JSON.stringify(status).includes(text));
      const other=f.gateway.createTopic('human',{title:'Other',initialPrompt:'Other',participants:['a','b'],maxModelTurns:2,maxTurnsPerNode:1,deadlineAt:'2026-10-26T00:15:00.000Z'});
      assert.equal(new TopicManager(f.store).get(other.id).outcomes.failed,0);
    }finally{f.cleanup();}
  }
});
