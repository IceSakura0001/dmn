// Explicit, isolated API acceptance. Never included in npm test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DmnStore } from '../src/store.ts';
import { DmnGateway } from '../src/gateway.ts';
import { DshRootRuntime } from '../src/dsh-runtime.ts';
import { TopicRunner,RuntimeNotSubmittedError,type RootRuntime } from '../src/runner.ts';
import { parseNodes,readYaml } from '../src/contracts.ts';
const limits={maxInputTokens:98304,maxOutputTokens:3072,maxEstimatedCost:0.75,inputTokensPerTurn:32768,outputTokensPerTurn:1024,estimatedCostPerTurn:0.25,turnTimeoutMs:60000,maxAttempts:2,backoffSeconds:[0.05]};
function fixture(label:string){
  assert.ok(process.env.DEEPSEEK_API_KEY,'Explicit live test requires DEEPSEEK_API_KEY');
  const dir=join('.dmn',`${label}-${randomUUID()}`);mkdirSync(dir,{recursive:true});const database=join(dir,'queue.sqlite');
  const store=new DmnStore(database);const gateway=new DmnGateway(store);parseNodes(readYaml('config/nodes.deepseek.yaml')).forEach(n=>gateway.registerNode(n));
  const sdk=new DshRootRuntime({root:join(dir,'runtime'),workspace:process.cwd()});
  return{dir,database,store,gateway,sdk};
}
test('live P2: durable SDK result reconciles after DB checkpoint loss without resubmitting a model prompt',{timeout:120000},async()=>{
  const f=fixture('live-p2-reconcile');const fault=new DatabaseSync(f.database);let calls=0;let confirmedContent:string|undefined;
  try{
    const topic=f.gateway.createTopic('live-test-user',{title:'One recovery proof',initialPrompt:'只返回一个严格 JSON：{"action":"send","to":"deepseek","content":"RECONCILED_ONCE"}。不要提交记忆，也不要附加标签。',participants:['deepseek','reviewer'],maxModelTurns:3,maxTurnsPerNode:2,deadlineAt:new Date(Date.now()+90000).toISOString()});
    const runtime:RootRuntime={async run(input,receipt){calls++;const result=await f.sdk.run(input,receipt);const output=JSON.parse(result.text);assert.equal(output.action,'send');assert.equal(output.to,'deepseek');confirmedContent=output.content;return result;},inspect:(input,receipt)=>f.sdk.inspect(input,receipt)};
    const runner=new TopicRunner(f.store,f.gateway,runtime);runner.authorize(topic.id,limits);
    f.gateway.bindNode('deepseek').send({topicId:topic.id,to:'reviewer',content:'请按照话题要求发送 RECONCILED_ONCE。'});
    fault.exec("CREATE TRIGGER lose_checkpoint BEFORE INSERT ON runtime_results BEGIN SELECT RAISE(ABORT,'checkpoint write lost'); END");
    await runner.drain();
    const turn=f.store.one<{turn_id:string;status:string;sdk_receipt_id:string}>('SELECT turn_id,status,sdk_receipt_id FROM model_turns')!;
    assert.equal(turn.status,'unknown');assert.equal(calls,1);assert.ok(turn.sdk_receipt_id);
    assert.equal(f.store.one<{n:number}>('SELECT count(*) AS n FROM runtime_results')?.n,0);
    fault.exec('DROP TRIGGER lose_checkpoint');
    const result=await runner.reconcile(turn.turn_id);assert.equal(result.state,'completed');
    assert.equal((await runner.reconcile(turn.turn_id)).applied,false);assert.equal(calls,1);
    const replies=f.gateway.bindNode('deepseek').getThread(topic.id).filter(m=>m.from==='reviewer');
    // Reconciliation must restore exactly the confirmed SDK output, even when the model paraphrases the requested marker.
    assert.equal(replies.length,1);assert.ok(confirmedContent);assert.equal(replies[0]?.content,confirmedContent);
    const evidence={verifiedAt:new Date().toISOString(),topicId:topic.id,calls,result,turns:f.store.all('SELECT turn_id,node_id,status,sdk_receipt_id,event_offset FROM model_turns'),attempts:f.store.all('SELECT * FROM delivery_attempts'),messageCount:f.store.one('SELECT count(*) AS n FROM messages'),method:'version-4 SDK log proof, no cached result'};
    writeFileSync(join(f.dir,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({evidence:join(f.dir,'evidence.json'),calls,replies:replies.length}));
  }finally{fault.close();f.store.close();}
});
test('live P2: bounded retry after injected pre-submit failure consumes two reservations and only one SDK call',{timeout:120000},async()=>{
  const f=fixture('live-p2-retry');let attempts=0;let modelCalls=0;
  try{
    const topic=f.gateway.createTopic('live-test-user',{title:'Bounded startup retry',initialPrompt:'仅返回 {"action":"silent"}，不要记忆候选或其他文本。',participants:['deepseek','reviewer'],maxModelTurns:2,maxTurnsPerNode:2,deadlineAt:new Date(Date.now()+90000).toISOString()});
    const runtime:RootRuntime={async run(input,receipt){attempts++;if(attempts===1)throw new RuntimeNotSubmittedError();modelCalls++;return f.sdk.run(input,receipt);}};
    const runner=new TopicRunner(f.store,f.gateway,runtime);runner.authorize(topic.id,limits);
    f.gateway.bindNode('deepseek').send({topicId:topic.id,to:'reviewer',content:'仅返回严格 JSON {"action":"silent"}。'});
    await runner.runUntilIdle();await runner.drain();
    assert.equal(attempts,2);assert.equal(modelCalls,1);assert.equal(f.store.one<{status:string}>('SELECT status FROM topics')?.status,'paused');
    assert.equal(f.store.one<{n:number}>("SELECT count(*) AS n FROM deliveries WHERE status='handled'")?.n,1);
    assert.equal(f.store.one<{used_model_turns:number}>('SELECT used_model_turns FROM topics')?.used_model_turns,2);
    const evidence={verifiedAt:new Date().toISOString(),topicId:topic.id,attempts,modelCalls,topic:f.store.one('SELECT status,used_model_turns FROM topics'),history:f.store.all('SELECT * FROM delivery_attempts'),quotas:f.store.all('SELECT * FROM node_budgets')};
    writeFileSync(join(f.dir,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({evidence:join(f.dir,'evidence.json'),attempts,modelCalls}));
  }finally{f.store.close();}
});
