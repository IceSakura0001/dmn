import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startWeb} from '../src/web.ts';
import {DmnStore} from '../src/store.ts';
import {OperatorService} from '../src/operator.ts';
import {fixtureNodes} from './fixtures.ts';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('P4 local web protects writes and exposes only public state; direct reply through HTTP',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-web-'));const store=new DmnStore(join(dir,'db.sqlite'));let calls=0;
 const service=new OperatorService(store,{nodes:fixtureNodes},{async run(input,receipt){calls++;receipt('receipt');return{sessionId:input.node.sessionId,text:'{"action":"reply_user","content":"<script>not executed</script>"}'};}});
 const app=await startWeb(service,0);const base=`http://127.0.0.1:${app.port}`;
 try{
 const page=await fetch(base);assert.equal(page.status,200);assert(page.headers.get('content-security-policy')?.includes("default-src 'self'"));
 const state=await (await fetch(base+'/api/state')).json();assert.equal(calls,0);assert.equal(state.nodes.length,3);
 const request=JSON.parse(readFileSync(new URL('../config/topic.p2.json',import.meta.url),'utf8'));request.startNode='a';request.topic.participants=['a','b'];delete request.limits.nodeLimits;
 const body=JSON.stringify({...request,mode:'direct',idempotencyKey:'one'});
 assert.equal((await fetch(base+'/api/start',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body})).status,403);
 const headers={'content-type':'application/json','x-dmn-token':state.csrfToken,origin:base};
 const created=await (await fetch(base+'/api/start',{method:'POST',headers,body})).json();assert(created.topicId);
 assert.equal(calls,0);
 const sent=await fetch(base+'/api/send',{method:'POST',headers,body:JSON.stringify({topicId:created.topicId,to:'b',content:'hello',idempotencyKey:'message'})});assert.equal(sent.status,200);
 await service.drain();
 const view=await(await fetch(base+'/api/topic?topicId='+created.topicId)).json();assert.equal(view.messages.userReplies[0].sender,'b');assert.equal(calls,1);
 assert(!JSON.stringify(view).includes('input_snapshot'));assert(!JSON.stringify(view).includes('privateMemories'));
 const metrics=await(await fetch(base+'/api/metrics?topicId='+created.topicId)).json();assert.equal(metrics.turns.completed,1);assert.equal(calls,1);
 assert.equal((await fetch(base+'/api/metrics?owner=b')).status,400);assert.equal((await fetch(base+'/api/metrics?topicId=')).status,400);
 assert.equal((await fetch(base+'/api/topic?topicId='+created.topicId+'&owner=b')).status,400);
 assert.equal((await fetch(base+'/api/pause',{method:'POST',headers,body:JSON.stringify({topicId:created.topicId,from:'admin'})})).status,400);
 assert.equal((await fetch(base+'/api/send',{method:'POST',headers,body:'x'.repeat(70000)})).status,413);
 }finally{await app.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
