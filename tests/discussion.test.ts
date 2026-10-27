import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDiscussion } from '../src/discussion.ts';
import { DmnStore } from '../src/store.ts';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureNodes } from './fixtures.ts';

test('host discussion start validates, atomically registers/authorizes/seeds, and returns bounded result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmn-discussion-'));
  const store = new DmnStore(join(dir, 'test.sqlite'));
  const request = JSON.parse(readFileSync(new URL('../config/topic.p0.json', import.meta.url), 'utf8'));
  request.startNode = 'a'; request.topic.participants = ['a','b'];
  try {
    const runtime = { async run(input: { node: { sessionId: string } }, receipt: (id: string) => void) { receipt('receipt'); return { text: '{"action":"silent"}', sessionId: input.node.sessionId }; } };
    await assert.rejects(startDiscussion(store, { nodes: fixtureNodes }, { ...request, admin: true }, runtime), { code: 'VALIDATION' });
    assert.equal(store.one<{ n: number }>('SELECT count(*) AS n FROM topics')?.n, 0);
    const result = await startDiscussion(store, { nodes: fixtureNodes }, request, runtime);
    assert.equal(result.completedTurns, 1); assert.equal(result.state, 'waiting');
    assert.equal(result.unknownTurns, 0); assert.equal(result.messages, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
