import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {readYaml} from '../src/contracts.ts';
import {DmnStore} from '../src/store.ts';
import {OperatorService} from '../src/operator.ts';
import {DshRootRuntime} from '../src/dsh-runtime.ts';
test('P4 live direct replies from both fixed roots (2 calls, no peer discussion)',async()=>{
 assert(process.env.DEEPSEEK_API_KEY,'Configure DEEPSEEK_API_KEY securely before this explicit billable test');
 const dir=resolve('.dmn',`p4-live-${Date.now()}`);mkdirSync(dir,{recursive:true});const database=resolve(dir,'db.sqlite');
 const store=new DmnStore(database);
 const evidence:{verifiedAt:string;result:string;topicId?:string;runtime:string}={verifiedAt:new Date().toISOString(),result:'FAIL',runtime:'real DSH / DeepSeek; evidence retained locally'};
 try{
 const service=new OperatorService(store,readYaml('config/nodes.deepseek.yaml'),new DshRootRuntime({root:database+'.runtime',workspace:process.cwd()}));
 const request=JSON.parse(readFileSync('config/topic.p2.json','utf8'));
 request.topic.maxModelTurns=2;request.topic.maxTurnsPerNode=1;request.topic.durationMinutes=5;
 request.limits.maxAttempts=1;request.limits.nodeLimits={};request.limits.maxInputTokens=65536;request.limits.maxOutputTokens=2048;request.limits.maxEstimatedCost=.5;
 const {topicId}=service.start({...request,mode:'direct',idempotencyKey:'p4-live'});evidence.topicId=topicId;
 for(const node of service.list() as {id:string}[]){
 service.send({topicId,to:node.id,content:'请仅用 reply_user JSON 回复用户一句简短问候，不向其他节点发送消息。',idempotencyKey:node.id});await service.drain();
 const view=service.messages({topicId});assert(view.userReplies.some(r=>r.sender===node.id),'Expected a completed, structured reply; inspect retained queue and runtime evidence');
 }
 assert.equal(service.messages({topicId}).userReplies.length,2);
 assert.equal(store.one<{n:number}>('SELECT count(*) n FROM messages')!.n,0);
 assert.equal(service.get({topicId}).state,'paused');evidence.result='PASS';
 }finally{writeFileSync(resolve(dir,'result.json'),JSON.stringify(evidence,null,2));store.close();}
});
