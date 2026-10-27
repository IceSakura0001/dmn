import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TopicRunner } from '../src/runner.ts';
import { setup } from './fixtures.ts';
const limits={maxInputTokens:100000,maxOutputTokens:10000,maxEstimatedCost:2,inputTokensPerTurn:8000,outputTokensPerTurn:512,estimatedCostPerTurn:0.1,turnTimeoutMs:5000};
test('P2 local controls pause/resume/close and show queue metadata without exposing input or memories',()=>{
  const f=setup();const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
  function run(command:string,...args:string[]){return spawnSync(process.execPath,['--import','tsx',cli,command,f.path,...args],{encoding:'utf8'});}
  try{
    new TopicRunner(f.store,f.gateway,{async run(){throw Error('must not run');}},()=>new Date('2026-10-26T00:00:00Z')).authorize(f.topic.id,limits);
    // CLI uses the real wall clock; keep the fixture authorization future-dated.
    const deadline=new Date(Date.now()+60000).toISOString();f.store.run('UPDATE topics SET deadline_at=?',deadline);f.store.run('UPDATE node_budgets SET deadline_at=?',deadline);
    f.a.send({topicId:f.topic.id,to:'b',content:'PRIVATE_INPUT_NOT_FOR_STATUS'});
    assert.equal(run('topic',f.topic.id,'pause').status,0);
    const status=run('topic',f.topic.id,'status');assert.equal(JSON.parse(status.stdout).state,'paused');assert.doesNotMatch(status.stdout,/PRIVATE_INPUT/);
    assert.equal(run('topic',f.topic.id,'resume').status,0);
    const queue=run('queue');assert.equal(queue.status,0);assert.doesNotMatch(queue.stdout,/PRIVATE_INPUT/);
    assert.equal(run('topic',f.topic.id,'close').status,0);
    assert.equal(run('topic',f.topic.id,'resume').status,1);
  }finally{f.cleanup();}
});
