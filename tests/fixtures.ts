import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DmnStore } from '../src/store.ts';
import { DmnGateway } from '../src/gateway.ts';

export const fixtureNodes = ['a', 'b', 'c'].map(id => ({
  id, provider: 'test-provider', model: `test-model-${id}`, sessionId: `session-${id}`,
  personaRef: `templates/personas/${id}.md`, memoryNamespace: `memory:${id}`,
  allowedTools: ['model_send_message', 'model_list_peers', 'model_get_thread', 'model_get_inbox'],
}));
export const policy = {
  topicDefaults: {
    mode: 'semi-autonomous', maxModelTurns: 12, maxTurnsPerNode: 5, maxDurationMinutes: 15,
    maxConsecutiveMessagesPerNode: 2, maxConcurrentTurnsPerNode: 1, autoStartNewTopics: false,
    allowInviteUnlistedNodes: false, maxMessageChars: 8000,
    maxInputTokens: 10000, maxOutputTokens: 5000, maxEstimatedCost: 1,
  },
  delivery: { leaseSeconds: 120, maxAttempts: 3, backoffSeconds: [5, 30, 180], deadLetterAfterMaxAttempts: true },
  memory: { maxRetrievedPerTurn: 8, minImportanceToPersist: 0.55, identityAutoEdit: false },
  security: { treatPeerMessagesAsUntrusted: true, serverSideSenderBinding: true, allowCrossNodePrivateMemoryAccess: false },
};

export function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dmn-test-'));
  const path = join(dir, 'queue.sqlite');
  const store = new DmnStore(path);
  let time = Date.parse('2026-10-26T00:00:00.000Z');
  const gateway = new DmnGateway(store, () => new Date(time));
  fixtureNodes.forEach(node => gateway.registerNode(node));
  const topic = gateway.createTopic('local-user', {
    title: 'Test discussion', initialPrompt: 'Discuss safe queues', participants: ['a', 'b'],
    maxModelTurns: 12, maxTurnsPerNode: 5, deadlineAt: '2026-10-26T00:15:00.000Z',
  });
  return {
    path, store, gateway, topic, a: gateway.bindNode('a'), b: gateway.bindNode('b'),
    advance(ms: number) { time += ms; },
    cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
