import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup } from './fixtures.ts';

test('local memory CLI can create, retrieve, trace, revise and delete only the selected node records', () => {
  const f = setup(); const dir = mkdtempSync(join(tmpdir(), 'dmn-memory-cli-'));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  function run(owner: string, action: string, payload: unknown) {
    const request = join(dir, 'request.json'); writeFileSync(request, JSON.stringify(payload));
    const result = spawnSync(process.execPath, ['--import','tsx',cli,'memory',f.path,owner,action,request], { encoding: 'utf8' });
    const stream = (result.status === 0 ? result.stdout : result.stderr).split('\n').find(line => line.startsWith('{') || line.startsWith('['));
    return { status: result.status, value: stream ? JSON.parse(stream) : null };
  }
  try {
    const source = f.a.send({ to: 'b', topicId: f.topic.id, content: 'durable receipts' });
    const candidate = { kind: 'semantic', content: 'CLI rollback memory', confidence: 0.9, importance: 0.8, subjective: false, sourceMessageIds: [source.messageId] };
    const created = run('a','propose',candidate); assert.equal(created.status, 0);
    const memoryId = created.value.memoryId;
    assert.equal(run('a','search',{ query: 'rollback' }).value[0].id, memoryId);
    assert.equal(run('a','sources',{ memoryId }).value[0].id, source.messageId);
    assert.equal(run('b','get',{ memoryId }).value.code, 'FORBIDDEN');
    const revised = run('a','revise',{ ...candidate, content: 'CLI revised checkpoint memory', memoryId, expectedVersion: 1, reason: 'reviewed' });
    assert.equal(revised.value.version, 2);
    assert.equal(run('a','history',{ memoryId }).value.length, 1);
    assert.equal(run('a','delete',{ memoryId, expectedVersion: 2, reason: 'hide from retrieval' }).value.deleted, true);
    assert.deepEqual(run('a','search',{ query: 'checkpoint' }).value, []);
    assert.equal(run('a','identity',{ content: 'Human reviewed concise style.', reason: 'manual preference' }).value.kind, 'identity');
  } finally { f.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});
