import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryManager } from '../src/memory.ts';
import { setup } from './fixtures.ts';

test('small retrieval holdout: English and Chinese queries find expected own memory without mixing owners', () => {
  const f = setup();
  try {
    const source = f.a.send({ topicId: f.topic.id, to: 'b', content: 'Evidence for the synthetic retrieval corpus.' });
    const manager = new MemoryManager(f.store);
    const a = manager.bindNode('a'); const b = manager.bindNode('b');
    const corpus = [
      { content: 'WAL checkpoint recovery needs durable receipts.', queries: ['checkpoint','recovery'] },
      { content: '消费者幂等去重记录需要与副作用原子提交。', queries: ['幂等','原子提交'] },
      { content: '未知模型结果先进入对账队列，不能盲目重试。', queries: ['对账','盲目重试'] },
      { content: 'My subjective view: the reviewer prefers careful evidence.', queries: ['reviewer','subjective'] },
    ];
    let hits = 0;
    for (const [n, item] of corpus.entries()) {
      const value = { kind: n === 3 ? 'relationship' : 'semantic', content: item.content, subjective: n === 3,
        confidence: 0.9, importance: 0.8, sourceMessageIds: [source.messageId] };
      const own = a.propose(value);
      b.propose({ ...value, content: `B private perspective ${n}` });
      for (const query of item.queries) {
        assert.equal(a.search({ query })[0]?.id, own.memoryId, query); hits++;
        assert.equal(b.search({ query }).some(m => m.id === own.memoryId), false);
      }
    }
    assert.equal(hits, 8);
  } finally { f.cleanup(); }
});
