import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TopicRunner,type RootRuntime} from '../src/runner.ts';
import {RecoveryManager,readMetrics} from '../src/operations.ts';
import {setup} from './fixtures.ts';
const limits={maxInputTokens:100000,maxOutputTokens:10000,maxEstimatedCost:2,inputTokensPerTurn:8000,outputTokensPerTurn:512,estimatedCostPerTurn:.1,turnTimeoutMs:5000};

test('P5 read-only evidence omits private text; controlled drop needs confirmation, quiescence and one audited effect',async()=>{
 const f=setup();let calls=0;const clock=()=>new Date('2026-10-26T00:00:00Z');
 try{
  const runtime:RootRuntime={async run(_,receipt){calls++;receipt('r');throw Error('private error');},async inspect(){return{state:'unknown',reason:'NO_TERMINAL',quiescent:true};}};
  const runner=new TopicRunner(f.store,f.gateway,runtime,clock);runner.authorize(f.topic.id,limits);f.a.send({to:'b',topicId:f.topic.id,content:'PRIVATE_OPERATOR_TEXT'});await runner.drain();
  const turn=f.store.one<{turn_id:string}>('SELECT turn_id FROM model_turns')!.turn_id;
  const manager=new RecoveryManager(f.store,runtime,clock);const evidence=await manager.inspect({turnId:turn});
  assert.equal(evidence.proof.state,'unknown');assert(!JSON.stringify(evidence).includes('PRIVATE_OPERATOR_TEXT'));
  await assert.rejects(manager.drop({turnId:turn,confirmTurnId:'wrong',reason:'reviewed'}),{code:'VALIDATION'});
  await assert.rejects(manager.drop({turnId:turn,confirmTurnId:turn,reason:'reviewed',from:'system'}),{code:'VALIDATION'});
  f.store.run("CREATE TRIGGER fail_operator_audit BEFORE INSERT ON events WHEN new.event_type='operator.turn_dropped' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
  await assert.rejects(manager.drop({turnId:turn,confirmTurnId:turn,reason:'cannot lose audit'}),{code:'STORAGE'});
  assert.equal(f.store.one<{status:string}>('SELECT status FROM model_turns')!.status,'unknown');f.store.run('DROP TRIGGER fail_operator_audit');
  assert.equal((await manager.drop({turnId:turn,confirmTurnId:turn,reason:'SDK stopped; no complete result'})).state,'failed');
  await manager.drop({turnId:turn,confirmTurnId:turn,reason:'repeat'});assert.equal(calls,1);
  assert.equal(f.store.one<{n:number}>("SELECT count(*) n FROM events WHERE event_type='operator.turn_dropped'")!.n,1);
  assert.equal(f.store.one<{used_model_turns:number}>('SELECT used_model_turns FROM topics')!.used_model_turns,1);
  const metrics=readMetrics(f.store,{},clock);assert.equal(metrics.turns.failed,1);assert.equal(metrics.tokens.withoutUsage,1);assert.equal(metrics.tokens.actualInput,0);assert.equal(metrics.reserved.inputTokens,8000);assert(!JSON.stringify(metrics).includes('PRIVATE_OPERATOR_TEXT'));
 }finally{f.cleanup();}
});

test('P5 actual tokens count durable SDK checkpoints even when business effects are still unknown',async()=>{
 const f=setup();try{
  const runtime:RootRuntime={async run(input,receipt){receipt('r');return{sessionId:input.node.sessionId,text:'{"action":"send","to":"a","content":"reply"}',usage:{inputTokens:11,outputTokens:7}};}};
  const runner=new TopicRunner(f.store,f.gateway,runtime,()=>new Date('2026-10-26T00:00:00Z'));runner.authorize(f.topic.id,limits);f.a.send({to:'b',topicId:f.topic.id,content:'input'});
  f.store.run("CREATE TRIGGER fail_effect BEFORE INSERT ON messages WHEN new.from_node='b' BEGIN SELECT RAISE(ABORT,'fault'); END");await runner.drain();
  const metrics=readMetrics(f.store);assert.equal(metrics.turns.unknown,1);assert.equal(metrics.tokens.actualInput,11);assert.equal(metrics.tokens.actualOutput,7);assert.equal(metrics.tokens.withoutUsage,0);
 }finally{f.cleanup();}
});

test('P5 expired leases quarantine once and never replay; busy SDK cannot be dropped',async()=>{
 const f=setup();let calls=0;
 try{
  const runtime:RootRuntime={async run(){calls++;throw Error('lost');},async inspect(){return{state:'unknown',reason:'BUSY',quiescent:false};}};
  const runner=new TopicRunner(f.store,f.gateway,runtime,()=>new Date('2026-10-26T00:00:00Z'));runner.authorize(f.topic.id,limits);runner.seed(f.topic.id,'a');await runner.drain();
  const turn=f.store.one<{turn_id:string}>('SELECT turn_id FROM model_turns')!.turn_id;
  f.store.run("UPDATE model_turns SET status='running'");f.store.run("UPDATE node_locks SET state='running',lease_until='2026-10-25T00:00:00Z'");
  const manager=new RecoveryManager(f.store,runtime,()=>new Date('2026-10-26T00:01:00Z'));
  assert.equal(manager.quarantineExpired().quarantined,1);assert.equal(manager.quarantineExpired().quarantined,0);
  assert.equal((await manager.drop({turnId:turn,confirmTurnId:turn,reason:'must not override busy'})).state,'unknown');assert.equal(calls,1);
  assert.equal(f.store.one<{state:string}>('SELECT state FROM node_locks')!.state,'quarantined');
 }finally{f.cleanup();}
});
