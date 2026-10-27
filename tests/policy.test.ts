import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TopicManager } from '../src/topic-manager.ts';
import { TopicRunner, RuntimeNotSubmittedError, type RootRuntime } from '../src/runner.ts';
import { setup } from './fixtures.ts';

const limits = { maxInputTokens: 100000, maxOutputTokens: 10000, maxEstimatedCost: 2,
  inputTokensPerTurn: 8000, outputTokensPerTurn: 512, estimatedCostPerTurn: 0.1, turnTimeoutMs: 5000,
  maxAttempts: 3, backoffSeconds: [5,30], maxConsecutiveMessagesPerNode: 2 };

test('P2 D05/D06/D07: pause/resume is explicit, closed is terminal, and resume never resets quotas', async () => {
  const f = setup(); let calls = 0;
  try {
    const runtime: RootRuntime = { async run(input, receipt) { calls++; receipt('r'); return { text: '{"action":"silent"}', sessionId: input.node.sessionId }; } };
    const now = () => new Date('2026-10-26T00:00:00Z');
    const manager = new TopicManager(f.store, now);
    const runner = new TopicRunner(f.store, f.gateway, runtime, now);
    runner.authorize(f.topic.id, limits);
    f.a.send({ to: 'b', topicId: f.topic.id, content: 'one' });
    manager.pause(f.topic.id); await runner.drain(); assert.equal(calls, 0);
    assert.equal(f.store.one<{status:string}>("SELECT status FROM model_nodes WHERE node_id='b'")?.status,'cooling');
    manager.resume(f.topic.id); await runner.drain(); assert.equal(calls, 1);
    assert.equal(manager.get(f.topic.id).state, 'waiting');
    f.store.run('UPDATE topics SET used_model_turns=max_model_turns');
    manager.pause(f.topic.id);
    assert.throws(() => manager.resume(f.topic.id), { code: 'BUDGET_EXHAUSTED' });
    manager.close(f.topic.id);
    assert.throws(() => manager.resume(f.topic.id), { code: 'TOPIC_STOPPED' });
    assert.throws(() => f.a.send({ to: 'b', topicId: f.topic.id, content: 'closed' }), { code: 'TOPIC_STOPPED' });
  } finally { f.cleanup(); }
});

test('P2 one-way burst limit cannot be raised by a message payload and resets only after a peer send',()=>{
  const f=setup();
  try{
    new TopicRunner(f.store,f.gateway,{async run(){throw Error('must not call');}},()=>new Date('2026-10-26T00:00:00Z')).authorize(f.topic.id,limits);
    f.a.send({topicId:f.topic.id,to:'b',content:'first'});f.a.send({topicId:f.topic.id,to:'b',content:'second'});
    assert.throws(()=>f.a.send({topicId:f.topic.id,to:'b',content:'third'}),{code:'FORBIDDEN'});
    assert.throws(()=>f.a.send({topicId:f.topic.id,to:'b',content:'override',maxConsecutiveMessagesPerNode:100}),{code:'VALIDATION'});
    f.b.send({topicId:f.topic.id,to:'a',content:'peer reply'});f.a.send({topicId:f.topic.id,to:'b',content:'allowed again'});
  }finally{f.cleanup();}
});

test('P2 E03: confirmed not-submitted failures retry with persisted backoff, then dead-letter at maxAttempts', async () => {
  const f = setup(); let calls = 0; let time = Date.parse('2026-10-26T00:00:00Z');
  try {
    const runtime: RootRuntime = { async run() { calls++; throw new RuntimeNotSubmittedError(); } };
    const runner = new TopicRunner(f.store, f.gateway, runtime, () => new Date(time));
    runner.authorize(f.topic.id, limits);
    const message = f.a.send({ to: 'b', topicId: f.topic.id, content: 'startup failure' });
    await runner.drain(); assert.equal(calls, 1);
    assert.equal(f.store.one<{ status: string }>('SELECT status FROM deliveries')?.status, 'retry');
    await runner.drain(); assert.equal(calls, 1);
    time += 5000; await runner.drain(); assert.equal(calls, 2);
    time += 29999; await runner.drain(); assert.equal(calls, 2);
    time++; await runner.drain(); await runner.drain(); assert.equal(calls, 3);
    assert.equal(f.store.one<{ status: string }>('SELECT status FROM deliveries')?.status, 'dead_letter');
    assert.equal(f.store.one<{ attempts: number }>('SELECT attempts FROM deliveries')?.attempts, 3);
    assert.equal(f.store.one<{ n: number }>('SELECT count(*) AS n FROM delivery_attempts')?.n, 3);
    assert.equal(f.store.one<{ n: number }>('SELECT count(*) AS n FROM dead_letters WHERE message_id=?', message.messageId)?.n, 1);
    assert.equal(f.store.one<{ used_model_turns: number }>('SELECT used_model_turns FROM topics')?.used_model_turns, 3);
  } finally { f.cleanup(); }
});

test('P2 seed attempts also use finite retries without creating a second logical bootstrap', async () => {
  const f = setup(); let calls = 0; let time = Date.parse('2026-10-26T00:00:00Z');
  try {
    const runtime: RootRuntime = { async run(input, receipt) {
      calls++; if (calls < 2) throw new RuntimeNotSubmittedError();
      receipt('r'); return { text: '{"action":"silent"}', sessionId: input.node.sessionId };
    } };
    const runner = new TopicRunner(f.store, f.gateway, runtime, () => new Date(time));
    runner.authorize(f.topic.id, limits); runner.seed(f.topic.id, 'a');
    await runner.drain(); time += 5000; await runner.drain(); runner.seed(f.topic.id, 'a'); await runner.drain();
    assert.equal(calls, 2);
    assert.equal(f.store.one<{ n: number }>('SELECT count(*) AS n FROM model_turns WHERE input_message_id IS NULL')?.n, 2);
    assert.equal(f.store.one<{ n: number }>("SELECT count(*) AS n FROM model_turns WHERE status='completed'")?.n, 1);
  } finally { f.cleanup(); }
});

test('P2 per-node input/output/cost/time quotas stop before inference and survive repeated pumps', async () => {
  for (const nodeLimit of [{ maxInputTokens: 1 }, { maxOutputTokens: 1 }, { maxEstimatedCost: 0.01 }, { deadlineAt: '2026-10-26T00:00:00Z' }]) {
    const f = setup(); let calls = 0;
    try {
      const runtime: RootRuntime = { async run(input) { calls++; return { text: '{"action":"silent"}', sessionId: input.node.sessionId }; } };
      const runner = new TopicRunner(f.store, f.gateway, runtime, () => new Date('2026-10-26T00:00:01Z'));
      runner.authorize(f.topic.id, { ...limits, nodeLimits: { b: nodeLimit } });
      f.a.send({ to: 'b', topicId: f.topic.id, content: 'bounded' });
      await runner.drain(); await runner.drain(); assert.equal(calls, 0);
      assert.equal(f.store.one<{ status: string }>('SELECT status FROM topics')?.status, 'paused');
    } finally { f.cleanup(); }
  }
});

test('P2 expired idle topics pause without model polling; close cancels pending deliveries', async () => {
  const f = setup(); let calls = 0;
  try {
    const manager = new TopicManager(f.store, () => new Date('2026-10-26T00:16:00Z'));
    const runner = new TopicRunner(f.store, f.gateway, { async run() { calls++; throw Error('must not call'); } }, () => new Date('2026-10-26T00:16:00Z'));
    runner.authorize(f.topic.id, limits);
    f.a.send({ to: 'b', topicId: f.topic.id, content: 'pending' });
    await runner.drain(); assert.equal(manager.get(f.topic.id).state, 'paused'); assert.equal(calls, 0);
    manager.close(f.topic.id);
    assert.equal(f.store.one<{ status: string }>('SELECT status FROM deliveries')?.status, 'cancelled');
  } finally { f.cleanup(); }
});

test('P2 pause/resume fences an already running suggestion even if topic is active again before completion', async () => {
  const f = setup();
  try {
    const now = () => new Date('2026-10-26T00:00:00Z'); const manager = new TopicManager(f.store, now);
    const runtime: RootRuntime = { async run(input, receipt) {
      receipt('r'); manager.pause(f.topic.id); manager.resume(f.topic.id);
      return { text: '{"action":"send","to":"a","content":"revoked old activity"}', sessionId: input.node.sessionId };
    } };
    const runner = new TopicRunner(f.store, f.gateway, runtime, now);
    runner.authorize(f.topic.id, limits); f.a.send({ to: 'b', topicId: f.topic.id, content: 'one' });
    await runner.drain(); assert.equal(f.a.getInbox().length, 0);
    assert.equal(f.store.one<{ status: string }>('SELECT status FROM model_turns')?.status, 'completed');
  } finally { f.cleanup(); }
});

test('P2 only a trusted typed pre-submit error is retryable; arbitrary failures and receipts stay unknown', async () => {
  const f = setup(); let calls = 0;
  try {
    const runner = new TopicRunner(f.store, f.gateway, { async run(_input, receipt) { calls++; receipt('r'); throw new RuntimeNotSubmittedError(); } }, () => new Date('2026-10-26T00:00:00Z'));
    runner.authorize(f.topic.id, limits); f.a.send({ to: 'b', topicId: f.topic.id, content: 'one' });
    await runner.drain(); await runner.drain(); assert.equal(calls, 1);
    assert.equal(f.store.one<{ status: string }>('SELECT status FROM deliveries')?.status, 'unknown');
  } finally { f.cleanup(); }
});

test('P2 a delayed retry keeps same-node FIFO; a later message cannot bypass its backoff',async()=>{
  const f=setup();let time=Date.parse('2026-10-26T00:00:00Z');const seen:string[]=[];
  try{
    const runtime:RootRuntime={async run(input,receipt){seen.push(JSON.parse(input.prompt).incoming.content);if(seen.length===1)throw new RuntimeNotSubmittedError();receipt(`r-${seen.length}`);return{text:'{"action":"silent"}',sessionId:input.node.sessionId};}};
    const runner=new TopicRunner(f.store,f.gateway,runtime,()=>new Date(time));runner.authorize(f.topic.id,limits);
    f.a.send({topicId:f.topic.id,to:'b',content:'first'});f.a.send({topicId:f.topic.id,to:'b',content:'second'});
    await runner.drain();assert.deepEqual(seen,['first']);
    time+=5000;await runner.drain();assert.deepEqual(seen,['first','first','second']);
  }finally{f.cleanup();}
});
