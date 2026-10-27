// Explicit, bounded, synthetic endurance. No SDK process and no model API calls.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {DmnStore} from '../src/store.ts';
import {OperatorService} from '../src/operator.ts';
import {RecoveryManager,readMetrics} from '../src/operations.ts';
import {RuntimeNotSubmittedError,type RootRuntime} from '../src/runner.ts';
import {createBackup,verifyBackup} from '../src/backup.ts';
import {fixtureNodes} from './fixtures.ts';
import {createHash} from 'node:crypto';

test('P5 bounded synthetic endurance: 250 topics, 1000 completed inputs, faults and stopped backups',{timeout:420000},async()=>{
 const started=Date.now(),dir=resolve('.dmn',`p5-soak-${started}`);mkdirSync(dir,{recursive:true});const database=join(dir,'queue.sqlite');
 let store=new DmnStore(database),calls=0,preFailures=0,reconciled=0,backups=0,maxRss=0,injectPre=false;
 const sources=['src/store.ts','src/maintenance.ts','src/backup.ts','src/runner.ts','src/operations.ts','src/message-pages.ts','src/operator.ts'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}));
 const rssStart=process.memoryUsage().rss;const evidence:Record<string,unknown>={result:'FAIL',durationTargetMs:300000,topics:250,plannedCompletedInputs:1000,runtime:'synthetic; zero model API calls',sources};
 const runtime:RootRuntime={async run(input,receipt){if(injectPre){injectPre=false;preFailures++;throw new RuntimeNotSubmittedError();}calls++;receipt('receipt-'+calls);return{sessionId:input.node.sessionId,text:'{"action":"reply_user","content":"bounded reply"}',usage:{inputTokens:3,outputTokens:2}};}};
 let service=new OperatorService(store,{nodes:fixtureNodes.slice(0,2)},runtime);
 try{
  const template=JSON.parse(readFileSync('config/topic.p2.json','utf8'));template.startNode='a';template.topic.participants=['a','b'];template.topic.maxModelTurns=5;template.topic.maxTurnsPerNode=3;delete template.limits.nodeLimits;
  template.limits.backoffSeconds=[.01];template.limits.maxInputTokens=5*32768;template.limits.maxOutputTokens=5*768;template.limits.maxEstimatedCost=1.25;
  for(let i=0;i<250;i++){
   const {topicId}=service.start({...template,mode:'direct',idempotencyKey:'topic-'+i});
   if(i%20===0)injectPre=true;
   if(i%10===0)store.run("CREATE TRIGGER commit_fault BEFORE INSERT ON user_replies BEGIN SELECT RAISE(ABORT,'soak fault'); END");
   for(let j=0;j<4;j++){
    const request={topicId,to:j%2?'b':'a',content:'bounded synthetic input '+j,idempotencyKey:'input-'+j};
    const accepted=service.send(request);assert.deepEqual(service.send(request),accepted);await service.drain();
    if(j===0&&i%20===0){store.run("UPDATE model_turns SET ready_at=? WHERE topic_id=? AND status='queued'",new Date(0).toISOString(),topicId);await service.drain();}
    if(j===0&&i%10===0){store.run('DROP TRIGGER commit_fault');const turn=store.one<{turn_id:string}>("SELECT turn_id FROM model_turns WHERE topic_id=? AND status='unknown'",topicId)!;assert(turn);assert.equal((await new RecoveryManager(store,runtime).reconcile({turnId:turn.turn_id})).state,'completed');reconciled++;}
   }
   assert.equal(service.messages({topicId}).userReplies.length,4);service.close({topicId});
   if((i+1)%50===0){store.close();const bundle=join(dir,'backup-'+i);await createBackup(database,bundle);await verifyBackup(bundle);backups++;store=new DmnStore(database);service=new OperatorService(store,{nodes:fixtureNodes.slice(0,2)},runtime);}
   maxRss=Math.max(maxRss,process.memoryUsage().rss);
   const due=started+(i+1)*1200;if(Date.now()<due)await new Promise(r=>setTimeout(r,due-Date.now()));
  }
  assert.equal(calls,1000);assert.equal(reconciled,25);assert.equal(preFailures,13);assert.equal(backups,5);
  assert.equal(store.one<{n:number}>('SELECT count(*) n FROM user_replies')!.n,1000);assert.equal(store.one<{n:number}>('SELECT count(*) n FROM node_locks')!.n,0);
  assert.equal(store.one<{integrity_check:string}>('PRAGMA integrity_check')!.integrity_check,'ok');assert.equal(store.all('PRAGMA foreign_key_check').length,0);
  evidence.result='PASS';evidence.metrics=readMetrics(store);evidence.maxRssGrowthBytes=maxRss-rssStart;
 }finally{evidence.elapsedMs=Date.now()-started;evidence.modelCallbacks=calls;evidence.preSubmitFailures=preFailures;evidence.reconciled=reconciled;evidence.backups=backups;writeFileSync(join(dir,'result.json'),JSON.stringify(evidence,null,2));store.close();}
});
