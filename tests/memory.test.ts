import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MemoryManager } from '../src/memory.ts';
import { DmnStore } from '../src/store.ts';
import { setup } from './fixtures.ts';

function memoryFixture() {
  const f = setup();
  const source = f.a.send({ to: 'b', topicId: f.topic.id, content: '持久化队列使用幂等键去重，事务失败后必须回滚。Durable queue rollback.' });
  const manager = new MemoryManager(f.store, () => new Date('2026-10-26T00:00:00Z'));
  const a = manager.bindNode('a'); const b = manager.bindNode('b');
  const candidate = { kind: 'semantic', content: '持久化队列的幂等键与投递必须原子提交。Durable queue rollback.',
    claimKey: 'queue-atomicity', subjective: false, confidence: 0.9, importance: 0.8, sourceMessageIds: [source.messageId] };
  return { ...f, manager, ma: a, mb: b, source, candidate };
}

test('C01/C02: owner is server-bound; every read/write/query is private and identity spoofing fails', () => {
  const f = memoryFixture();
  try {
    const own = f.ma.propose(f.candidate); assert.equal(own.status, 'accepted');
    const id = own.memoryId!;
    assert.equal(f.ma.get(id).ownerNodeId, 'a');
    assert.equal(f.mb.search({ query: '持久化队列' }).length, 0);
    assert.equal(f.mb.list({}).length, 0);
    for (const operation of [() => f.mb.get(id), () => f.mb.history(id), () => f.mb.sources(id),
      () => f.mb.delete({ memoryId: id, expectedVersion: 1, reason: 'attack' }),
      () => f.mb.archive({ memoryId: id, expectedVersion: 1, reason: 'attack' }),
      () => f.mb.revise({ memoryId: id, expectedVersion: 1, ...f.candidate, reason: 'attack' }),
      () => f.mb.propose({ ...f.candidate, ownerNodeId: 'a' }),
      () => f.mb.search({ query: 'queue', ownerNodeId: 'a' }), () => f.mb.list({ ownerNodeId: 'a' }),
    ]) assert.throws(operation, { code: 'FORBIDDEN' });
    assert.equal(f.ma.get(id).content, f.candidate.content);
  } finally { f.cleanup(); }
});

test('C01: shared evidence can produce separate subjective relationship records without changing another identity', () => {
  const f = memoryFixture();
  try {
    const a = f.ma.propose({ ...f.candidate, kind: 'relationship', subjective: true, content: '我认为 B 重视谨慎验证。' });
    const b = f.mb.propose({ ...f.candidate, kind: 'relationship', subjective: true, content: '我认为 A 重视事务一致性。' });
    assert.notEqual(a.memoryId, b.memoryId);
    assert.equal(f.ma.get(a.memoryId!).subjective, true);
    assert.equal(f.mb.get(b.memoryId!).ownerNodeId, 'b');
    assert.throws(() => f.mb.get(a.memoryId!), { code: 'FORBIDDEN' });
    assert.equal(f.ma.propose({ ...f.candidate, kind: 'relationship', subjective: false }).status, 'rejected');
  } finally { f.cleanup(); }
});

test('C03: missing/hidden sources, low confidence/value, extra authority and credential-like content are rejected', () => {
  const f = memoryFixture();
  try {
    for (const change of [{ sourceMessageIds: [] }, { kind: 'identity' }, { admin: true }, { content: 'API_KEY=super-secret-credential-material' }]) {
      assert.throws(() => f.ma.propose({ ...f.candidate, ...change }));
    }
    for (const change of [{ confidence: 0.2 }, { importance: 0.1 }]) assert.equal(f.ma.propose({ ...f.candidate, ...change }).status, 'rejected');
    const topic = f.gateway.createTopic('human', { title: 'hidden', initialPrompt: 'hidden', participants: ['b','c'], maxModelTurns: 2, maxTurnsPerNode: 1, deadlineAt: '2026-10-26T00:01:00Z' });
    const hidden = f.b.send({ topicId: topic.id, to: 'c', content: 'hidden evidence' });
    assert.throws(() => f.ma.propose({ ...f.candidate, sourceMessageIds: [hidden.messageId] }), { code: 'FORBIDDEN' });
    assert.throws(() => f.ma.propose({ ...f.candidate, sourceMessageIds: ['nonexistent'] }), { code: 'FORBIDDEN' });
    assert.equal(f.ma.list({}).length, 0);
  } finally { f.cleanup(); }
});

test('idempotency: normalized duplicates return the same private record, never replace confidence or evidence', () => {
  const f = memoryFixture();
  try {
    const first = f.ma.propose(f.candidate);
    const duplicate = f.ma.propose({ ...f.candidate, content: `  ${f.candidate.content.toUpperCase()}  `, confidence: 0.75 });
    assert.equal(duplicate.status, 'duplicate'); assert.equal(duplicate.memoryId, first.memoryId);
    assert.equal(f.ma.list({}).length, 1); assert.equal(f.ma.get(first.memoryId!).confidence, 0.9);
  } finally { f.cleanup(); }
});

test('C04: keyed conflicts stay pending; explicit versioned resolution retains metadata and provenance history', () => {
  const f = memoryFixture();
  try {
    const first = f.ma.propose(f.candidate);
    const conflict = f.ma.propose({ ...f.candidate, content: '修订观点：队列需要独立对账流程。', confidence: 0.85 });
    assert.equal(conflict.status, 'conflict'); assert.ok(conflict.candidateId);
    assert.equal(f.ma.get(first.memoryId!).content, f.candidate.content);
    assert.equal(f.mb.listCandidates({}).length, 0);
    assert.throws(() => f.mb.resolveConflict({ candidateId: conflict.candidateId, expectedVersion: 1, reason: 'attack' }), { code: 'FORBIDDEN' });
    const revised = f.ma.resolveConflict({ candidateId: conflict.candidateId, expectedVersion: 1, reason: 'reviewed new evidence' });
    assert.equal(revised.version, 2); assert.match(revised.content, /独立对账/);
    const history = f.ma.history(first.memoryId!);
    assert.equal(history.length, 1); assert.equal(history[0]?.prior.content, f.candidate.content);
    assert.equal(history[0]?.next.confidence, 0.85);
    assert.deepEqual(history[0]?.next.sourceMessageIds, [f.source.messageId]);
    assert.throws(() => f.ma.revise({ ...f.candidate, memoryId: first.memoryId, expectedVersion: 1, reason: 'stale' }), { code: 'CONFLICT' });
  } finally { f.cleanup(); }
});

test('C05: identity can only be manually managed by the host, and ordinary node revision/deletion fails', () => {
  const f = memoryFixture();
  try {
    const identity = f.manager.setIdentity('a', { content: '我偏好简洁回答，但始终遵守宿主安全边界。', reason: 'human reviewed' });
    assert.equal(identity.kind, 'identity'); assert.equal(identity.confidence, 1);
    assert.equal(f.ma.list({ kind: 'identity' }).length, 1);
    assert.throws(() => f.ma.delete({ memoryId: identity.id, expectedVersion: identity.version, reason: 'override' }), { code: 'FORBIDDEN' });
    assert.throws(() => f.ma.revise({ ...f.candidate, memoryId: identity.id, expectedVersion: identity.version, reason: 'override' }), { code: 'FORBIDDEN' });
    assert.equal(Object.hasOwn(f.ma, 'setIdentity'), false);
  } finally { f.cleanup(); }
});

test('host identity updates and deletion require explicit versions and retain private review history', () => {
  const f = memoryFixture();
  try {
    const first = f.manager.setIdentity('a', { content: 'Original human preference', reason: 'manual' });
    assert.throws(() => f.manager.setIdentity('a', { content: 'Changed human preference', reason: 'manual' }), { code: 'CONFLICT' });
    const second = f.manager.setIdentity('a', { content: 'Changed human preference', reason: 'reviewed', expectedVersion: 1 });
    assert.equal(second.version, 2);
    assert.equal(f.ma.history(first.id)[0]?.next.content, second.content);
    f.manager.deleteIdentity('a', { memoryId: first.id, expectedVersion: 2, reason: 'manual removal' });
    assert.equal(f.ma.list({ kind: 'identity' }).length, 0);
    assert.equal(f.ma.history(first.id).length, 2);
  } finally { f.cleanup(); }
});

test('C06: persisted memories and indexes survive restart without granting another owner access', () => {
  const f = memoryFixture();
  try {
    const first = f.ma.propose(f.candidate); f.store.close();
    const reopened = new DmnStore(f.path);
    try {
      const manager = new MemoryManager(reopened);
      assert.equal(manager.bindNode('a').search({ query: 'rollback' })[0]?.id, first.memoryId);
      assert.equal(manager.bindNode('b').search({ query: 'rollback' }).length, 0);
      assert.throws(() => manager.bindNode('b').get(first.memoryId!), { code: 'FORBIDDEN' });
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('C07: logical deletion removes retrieval and direct reads, preserving owner-only revision and content-free audit', () => {
  const f = memoryFixture();
  try {
    const first = f.ma.propose(f.candidate);
    f.ma.delete({ memoryId: first.memoryId, expectedVersion: 1, reason: 'forget from retrieval' });
    assert.equal(f.ma.search({ query: '持久化队列' }).length, 0);
    assert.equal(f.ma.list({}).length, 0);
    assert.throws(() => f.ma.get(first.memoryId!), { code: 'FORBIDDEN' });
    assert.equal(f.ma.history(first.memoryId!).length, 1);
    assert.equal(f.ma.propose(f.candidate).reason, 'ARCHIVED');
    const events = f.store.all("SELECT payload_json FROM events WHERE event_type LIKE 'memory.%'");
    assert.doesNotMatch(JSON.stringify(events), /Durable|持久化|forget from retrieval/);
  } finally { f.cleanup(); }
});

test('FTS5 evaluation: Chinese substrings, two-character fallback, English, source filtering and bounded results', () => {
  const f = memoryFixture();
  try {
    const main = f.ma.propose(f.candidate);
    f.ma.propose({ ...f.candidate, claimKey: 'other', content: '关系记忆保留主观观点。', kind: 'episodic' });
    for (const query of ['持久化队列','幂等','rollback','DURABLE']) {
      const result = f.ma.search({ query, limit: 3 });
      assert.equal(result[0]?.id, main.memoryId, query);
      assert.equal(result[0]?.confidence, 0.9);
      assert.deepEqual(f.ma.sources(main.memoryId!).map(s => s.id), [f.source.messageId]);
    }
    assert.equal(f.ma.list({ sourceMessageId: f.source.messageId }).length, 2);
    for (const limit of [0,1,2,9,100]) assert.throws(() => f.ma.search({ query: 'queue', limit }), { code: 'VALIDATION' });
    for (const query of ['" OR * --', 'owner_node_id:b', 'NEAR(', '%_']) assert.equal(f.mb.search({ query }).length, 0);
    for (let n = 0; n < 10; n++) f.ma.propose({ ...f.candidate, claimKey: `bounded-${n}`, content: `Durable queue bounded sample ${n}` });
    assert.equal(f.ma.search({ query: 'Durable queue', limit: 8 }).length, 8);
  } finally { f.cleanup(); }
});

test('memory write, FTS update and audit are atomic under injected storage failures', () => {
  const f = memoryFixture(); const fault = new DatabaseSync(f.path);
  try {
    fault.exec("CREATE TRIGGER fail_memory_audit BEFORE INSERT ON events WHEN new.event_type LIKE 'memory.%' BEGIN SELECT RAISE(ABORT, 'fault'); END");
    assert.throws(() => f.ma.propose(f.candidate), { code: 'STORAGE' });
    assert.equal(f.ma.search({ query: 'rollback' }).length, 0);
    assert.equal(f.ma.list({}).length, 0);
    fault.exec('DROP TRIGGER fail_memory_audit');
    const first = f.ma.propose(f.candidate);
    f.ma.revise({ ...f.candidate, content: 'FTS changed text only', memoryId: first.memoryId, expectedVersion: 1, reason: 'test' });
    assert.equal(f.ma.search({ query: 'rollback' }).length, 0);
    assert.equal(f.ma.search({ query: 'changed' })[0]?.id, first.memoryId);
  } finally { fault.close(); f.cleanup(); }
});
