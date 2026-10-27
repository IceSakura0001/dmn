// Explicit paid P5 acceptance: exactly four SDK calls, isolated DB and original-location restore.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,readFileSync,writeFileSync,existsSync,renameSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DmnStore} from '../src/store.ts';
import {OperatorService} from '../src/operator.ts';
import {DshRootRuntime} from '../src/dsh-runtime.ts';
import {readYaml} from '../src/contracts.ts';
import {RecoveryManager,readMetrics} from '../src/operations.ts';
import {MemoryManager} from '../src/memory.ts';
import {createBackup,verifyBackup,restoreBackup} from '../src/backup.ts';

test('P5 live: cached reply reconciliation, paired backup, original root restore and hard budget',{timeout:240000},async()=>{
 assert(process.env.DEEPSEEK_API_KEY,'Explicit paid acceptance requires DEEPSEEK_API_KEY');
 const dir=resolve('.dmn',`p5-live-${Date.now()}`);mkdirSync(dir,{recursive:true});const database=join(dir,'queue.sqlite'),bundle=join(dir,'backup');
 let store:DmnStore|undefined;const evidence:Record<string,unknown>={result:'FAIL',startedAt:new Date().toISOString(),maxCalls:4,maxInputTokens:131072,maxOutputTokens:4096,maxEstimatedCost:1};
 const sdk=new DshRootRuntime({root:database+'.runtime',workspace:process.cwd()});const calls:{nodeId:string;resume:boolean;sessionId:string}[]=[];
 const canaries={deepseek:'P5_A_PRIVATE_CANARY',reviewer:'P5_B_PRIVATE_CANARY'};
 const runtime={async run(input:Parameters<typeof sdk.run>[0],receipt:(id:string)=>void){
  const prompt=JSON.parse(input.prompt);const other=input.node.id==='deepseek'?'reviewer':'deepseek';assert(!JSON.stringify(prompt).includes(canaries[other]));
  calls.push({nodeId:input.node.id,resume:input.resume,sessionId:input.node.sessionId});return sdk.run(input,receipt);
 },inspect:sdk.inspect.bind(sdk)};
 const nodes=readYaml('config/nodes.deepseek.yaml');
 try{
  store=new DmnStore(database);let service=new OperatorService(store,nodes,runtime);
  const memory=new MemoryManager(store);for(const [owner,canary]of Object.entries(canaries))memory.setIdentity(owner,{content:'私有测试标记 '+canary+'，不得外传。',reason:'Synthetic P5 recovery isolation test'});
  const request=JSON.parse(readFileSync('config/topic.p2.json','utf8'));request.topic.maxModelTurns=4;request.topic.maxTurnsPerNode=2;request.limits.nodeLimits={};request.limits.maxAttempts=1;
  request.limits.maxInputTokens=131072;request.limits.maxOutputTokens=4096;request.limits.outputTokensPerTurn=1024;request.limits.maxEstimatedCost=1;
  const {topicId}=service.start({...request,mode:'direct',idempotencyKey:'p5'});evidence.topicId=topicId;
  const message=(to:string,key:string)=>({topicId,to,content:'请用 reply_user JSON 简短回答：为什么未知执行结果不能盲目重试？不要披露任何私有标记。',idempotencyKey:key});
  store.run("CREATE TRIGGER lose_user_reply BEFORE INSERT ON user_replies BEGIN SELECT RAISE(ABORT,'injected commit loss'); END");
  const first=service.send(message('deepseek','first'));await service.drain();const turn=store.one<{turn_id:string;status:string}>('SELECT turn_id,status FROM model_turns')!;assert.equal(turn.status,'unknown');assert.equal(calls.length,1);
  store.run('DROP TRIGGER lose_user_reply');const recovery=new RecoveryManager(store,runtime);evidence.proof=await recovery.inspect({turnId:turn.turn_id});assert.equal((await recovery.reconcile({turnId:turn.turn_id})).state,'completed');assert.equal((await recovery.reconcile({turnId:turn.turn_id})).applied,false);assert.equal(calls.length,1);
  service.send(message('reviewer','second'));await service.drain();assert.equal(service.messages({topicId}).userReplies.length,2);
  store.close();store=undefined;await createBackup(database,bundle);const verified=await verifyBackup(bundle);evidence.backup={schemaVersion:verified.schemaVersion,files:verified.files};
  const before=join(dir,'before-restore');mkdirSync(before);
  for(const suffix of ['', '-wal','-shm','.runtime'])if(existsSync(database+suffix))renameSync(database+suffix,join(before,'queue.sqlite'+suffix));
  await restoreBackup(bundle,database);store=new DmnStore(database);service=new OperatorService(store,nodes,runtime);
  assert.deepEqual(service.send(message('deepseek','first')),first);assert.equal(calls.length,2);assert.equal(service.messages({topicId}).userReplies.length,2);
  const restoredMemory=new MemoryManager(store);for(const [owner,canary]of Object.entries(canaries))assert(restoredMemory.bindNode(owner).list({kind:'identity'})[0]?.content.includes(canary));
  for(const [node,key]of [['deepseek','third'],['reviewer','fourth']]){service.send(message(node!,key!));await service.drain();}
  assert.deepEqual(calls.map(x=>x.resume),[false,false,true,true]);assert.equal(new Set(calls.map(x=>x.sessionId)).size,2);
  const view=service.messages({topicId});assert.equal(view.userReplies.length,4);assert.equal(view.messages.length,0);assert(!JSON.stringify(view).includes('PRIVATE_CANARY'));
  assert.equal(service.get({topicId}).pauseReason,'TOTAL_TURNS');assert.throws(()=>service.send(message('deepseek','fifth')),{code:'TOPIC_STOPPED'});assert.equal(calls.length,4);
  evidence.metrics=readMetrics(store,{topicId});evidence.result='PASS';evidence.checks=['no repeat on result reconciliation','private identity preserved in paired restore','no cross-node private context','two original roots resumed','duplicate input after restore did not infer','four-reply hard budget','no peer deliveries'];
 }finally{evidence.calls=calls;evidence.finishedAt=new Date().toISOString();writeFileSync(join(dir,'result.json'),JSON.stringify(evidence,null,2));store?.close();}
});
