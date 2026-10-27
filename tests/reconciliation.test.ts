import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TopicRunner, type RootRuntime } from '../src/runner.ts';
import { setup } from './fixtures.ts';
const limits = { maxInputTokens: 100000,maxOutputTokens:10000,maxEstimatedCost:2,inputTokensPerTurn:8000,outputTokensPerTurn:512,estimatedCostPerTurn:0.1,turnTimeoutMs:5000 };

test('P2 completed result checkpoint recovers a failed business transaction without calling the model again', async () => {
  const f = setup(); const fault = new DatabaseSync(f.path); let calls = 0;
  const now = () => new Date('2026-10-26T00:00:00Z');
  try {
    const runtime: RootRuntime = { async run(input, receipt) { calls++; receipt('receipt'); return { text:'{"action":"send","to":"a","content":"recovered response"}',sessionId:input.node.sessionId }; } };
    fault.exec("CREATE TRIGGER fail_message BEFORE INSERT ON messages WHEN new.from_node='b' BEGIN SELECT RAISE(ABORT,'crash window'); END");
    const runner = new TopicRunner(f.store,f.gateway,runtime,now); runner.authorize(f.topic.id,limits);
    f.a.send({ topicId:f.topic.id,to:'b',content:'recover' }); await runner.drain();
    const turnId = f.store.one<{ turn_id:string }>('SELECT turn_id FROM model_turns')!.turn_id;
    assert.equal(f.store.one<{ status:string }>('SELECT status FROM model_turns')?.status,'unknown');
    assert.equal(f.store.one<{ n:number }>('SELECT count(*) AS n FROM runtime_results')?.n,1);
    fault.exec('DROP TRIGGER fail_message');
    const recovered = new TopicRunner(f.store,f.gateway,runtime,now);
    assert.equal((await recovered.reconcile(turnId)).state,'completed');
    assert.equal((await recovered.reconcile(turnId)).applied,false);
    assert.equal(calls,1); assert.equal(f.a.getInbox().length,1);
    assert.equal(f.store.one<{ n:number }>('SELECT count(*) AS n FROM node_locks')?.n,0);
  } finally { fault.close(); f.cleanup(); }
});

test('P2 uncached SDK evidence is inspected, identity checked and applied once without resubmission', async () => {
  const f = setup(); let calls = 0; let inspections = 0;
  try {
    const runtime: RootRuntime = { async run(_input,receipt) { calls++; receipt('receipt'); throw Error('lost acknowledgement'); },
      async inspect(input) { inspections++; return { state:'completed',receiptId:'receipt',result:{ sessionId:input.node.sessionId,text:'{"action":"send","to":"a","content":"durable reply"}' } }; } };
    const runner = new TopicRunner(f.store,f.gateway,runtime,() => new Date('2026-10-26T00:00:00Z'));
    runner.authorize(f.topic.id,limits); f.a.send({ topicId:f.topic.id,to:'b',content:'recover' }); await runner.drain();
    const turnId = f.store.one<{ turn_id:string }>('SELECT turn_id FROM model_turns')!.turn_id;
    assert.equal((await runner.reconcile(turnId)).state,'completed');
    assert.equal(calls,1); assert.equal(inspections,1); assert.equal(f.a.getInbox().length,1);
  } finally { f.cleanup(); }
});

test('P2 unknown/busy evidence remains quarantined and cannot be forced into retry by a drop request', async () => {
  const f = setup();
  try {
    const runtime: RootRuntime = { async run() { throw Error('unknown'); },async inspect() { return { state:'unknown',reason:'BUSY',quiescent:false }; } };
    const runner = new TopicRunner(f.store,f.gateway,runtime,() => new Date('2026-10-26T00:00:00Z'));
    runner.authorize(f.topic.id,limits); f.a.send({ topicId:f.topic.id,to:'b',content:'recover' }); await runner.drain();
    const turnId = f.store.one<{ turn_id:string }>('SELECT turn_id FROM model_turns')!.turn_id;
    assert.equal((await runner.reconcile(turnId,'drop')).state,'unknown');
    assert.equal(f.store.one<{ state:string }>('SELECT state FROM node_locks')?.state,'quarantined');
  } finally { f.cleanup(); }
});

test('P2 explicit drop needs confirmed quiescence and produces a durable dead letter', async () => {
  const f = setup();
  try {
    const runtime: RootRuntime = { async run() { throw Error('unknown'); },async inspect() { return { state:'unknown',reason:'NO_TERMINAL',quiescent:true }; } };
    const runner = new TopicRunner(f.store,f.gateway,runtime,() => new Date('2026-10-26T00:00:00Z'));
    runner.authorize(f.topic.id,limits); f.a.send({ topicId:f.topic.id,to:'b',content:'recover' }); await runner.drain();
    const turnId = f.store.one<{ turn_id:string }>('SELECT turn_id FROM model_turns')!.turn_id;
    assert.equal((await runner.reconcile(turnId,'drop')).state,'failed');
    assert.equal(f.store.one<{ n:number }>('SELECT count(*) AS n FROM dead_letters')?.n,1);
    assert.equal(f.store.one<{ n:number }>('SELECT count(*) AS n FROM node_locks')?.n,0);
  } finally { f.cleanup(); }
});
