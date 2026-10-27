import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseNodes, parsePolicy, parseMessage, readYaml } from '../src/contracts.ts';
import { fixtureNodes, policy } from './fixtures.ts';

test('A01: message schema rejects missing fields, empty content, privileged types and extra fields', () => {
  const valid = { id: 'm1', topicId: 't1', from: 'a', to: 'b', type: 'chat', content: 'hello', createdAt: '2026-10-26T00:00:00.000Z' };
  assert.deepEqual(parseMessage(valid), valid);
  for (const change of [{ topicId: undefined }, { content: '' }, { type: 'system' }, { admin: true }, { createdAt: 'tomorrow' }]) {
    assert.throws(() => parseMessage({ ...valid, ...change }), { code: 'VALIDATION' });
  }
});

test('node config is strict, with unique IDs, root sessions, namespaces and restricted tools', () => {
  assert.equal(parseNodes({ nodes: fixtureNodes }).length, 3);
  for (const change of [{ id: 'a' }, { sessionId: 'session-a' }, { memoryNamespace: 'memory:a' }, { allowedTools: ['shell'] }, { apiKey: 'must-not-be-logged' }, { personaRef: '../secret' }]) {
    assert.throws(() => parseNodes({ nodes: [fixtureNodes[0], { ...fixtureNodes[1], ...change }] }), { code: 'VALIDATION' });
  }
  assert.throws(() => parseNodes({ nodes: [{ ...fixtureNodes[0], model: 'REPLACE_WITH_MODEL' }] }), { code: 'VALIDATION' });
});

test('policy refuses unbounded runs, unsafe permission flags and unknown fields', () => {
  assert.deepEqual(parsePolicy(policy), policy);
  for (const change of [{ maxInputTokens: undefined }, { maxOutputTokens: 0 }, { maxEstimatedCost: Infinity }, { maxConcurrentTurnsPerNode: 2 }, { autoStartNewTopics: true }]) {
    assert.throws(() => parsePolicy({ ...policy, topicDefaults: { ...policy.topicDefaults, ...change } }), { code: 'VALIDATION' });
  }
  assert.throws(() => parsePolicy({ ...policy, security: { ...policy.security, allowCrossNodePrivateMemoryAccess: true } }), { code: 'VALIDATION' });
});

test('example YAML remains a template and cannot enable real automatic execution', () => {
  assert.throws(() => parseNodes(readYaml(fileURLToPath(new URL('../config/nodes.example.yaml', import.meta.url)))), { code: 'VALIDATION' });
  assert.throws(() => parsePolicy(readYaml(fileURLToPath(new URL('../config/policy.example.yaml', import.meta.url)))), { code: 'VALIDATION' });
});
