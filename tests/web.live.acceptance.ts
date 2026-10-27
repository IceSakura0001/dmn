// Explicit paid acceptance: browser -> HTTP -> queue -> SDK -> two real roots.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {DmnStore} from '../src/store.ts';
import {readYaml} from '../src/contracts.ts';
import {OperatorService} from '../src/operator.ts';
import {DshRootRuntime} from '../src/dsh-runtime.ts';
import {startWeb} from '../src/web.ts';
import {browserPath} from './browser-path.ts';

test('P4 live browser: four targeted turns, two fixed roots, resume and budget stop',{timeout:240000},async()=>{
 assert(process.env.DEEPSEEK_API_KEY,'Explicit paid test requires DEEPSEEK_API_KEY');
 const dir=resolve('.dmn',`p4-web-live-${Date.now()}`);mkdirSync(dir,{recursive:true});
 const database=resolve(dir,'db.sqlite'),store=new DmnStore(database);
 const sdk=new DshRootRuntime({root:database+'.runtime',workspace:process.cwd()});
 const calls:{node:string;session:string;resume:boolean;incomingTo:string;privateOwners:string[]}[]=[];
 const service=new OperatorService(store,readYaml('config/nodes.deepseek.yaml'),{async run(input,receipt){
  const envelope=JSON.parse(input.prompt);
  calls.push({node:input.node.id,session:input.node.sessionId,resume:input.resume,incomingTo:envelope.incoming.to,privateOwners:envelope.privateMemories.map((m:{ownerNodeId:string})=>m.ownerNodeId)});
  return sdk.run(input,receipt);
 }});
 const app=await startWeb(service,0);let browser;const errors:string[]=[];
 const evidence:Record<string,unknown>={result:'FAIL',verifiedAt:new Date().toISOString(),maxCalls:4,maxInputTokens:131072,maxOutputTokens:4096,maxEstimatedCost:1};
 try{
  browser=await chromium.launch({executablePath:browserPath(),headless:true});
  const page=await browser.newPage({viewport:{width:1360,height:1050}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.port}`);await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='已连接');assert.equal(calls.length,0);
  await page.fill('#title','真实双节点定向验收');await page.fill('#prompt','请用中文简短回答用户问题，使用 reply_user JSON。不要向其他节点发送。');
  await page.fill('#turns','4');await page.fill('#perNode','2');await page.locator('#create button').click();
  await page.waitForFunction(()=>document.querySelector('#notice')?.textContent==='话题已持久化。');assert.equal(calls.length,0);
  const topicId=await page.evaluate(()=>localStorage.getItem('dmn-topic')!);evidence.topicId=topicId;
  for(const [index,node]of ['deepseek','reviewer','deepseek','reviewer'].entries()){
   await page.selectOption('#recipient',node);await page.fill('#content',`这是第${index+1}条独立输入，请只用一句中文说明持久消息的价值。`);await page.locator('#send button').click();
   await page.waitForFunction(()=>document.querySelector('#notice')?.textContent==='输入已入队，尚不代表模型完成。');
   await page.waitForFunction(expected=>document.querySelectorAll('#timeline article').length>=expected,(index+1)*2,{timeout:60000});
   const view=service.messages({topicId});assert.equal(view.userReplies.length,index+1);assert.equal(view.userReplies.at(-1)?.sender,node);
   assert.equal(view.operatorMessages.at(-1)?.recipient,node);assert.equal(view.userReplies.at(-1)?.replyTo,view.operatorMessages.at(-1)?.id);
   assert.equal(calls.length,index+1);assert.equal(store.one<{n:number}>('SELECT count(*) n FROM messages')!.n,0);
  }
  assert.deepEqual(calls.map(c=>[c.node,c.resume]),[['deepseek',false],['reviewer',false],['deepseek',true],['reviewer',true]]);
  assert.equal(new Set(calls.map(c=>c.session)).size,2);assert(calls.every(c=>c.incomingTo===c.node));
  assert.equal(service.get({topicId}).state,'paused');assert.equal(service.get({topicId}).pauseReason,'TOTAL_TURNS');
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('#timeline article').length===8);assert.equal(calls.length,4);
  await page.fill('#content','预算耗尽后不得追加调用');await page.locator('#send button').click();await page.waitForFunction(()=>document.querySelector('#notice')?.textContent?.includes('TOPIC_STOPPED'));assert.equal(calls.length,4);
  const response=await page.request.get(`http://127.0.0.1:${app.port}/api/topic?topicId=${topicId}`);const publicText=await response.text();assert(!publicText.includes('input_snapshot'));assert(!publicText.includes('privateMemories'));assert(!publicText.includes(process.env.DEEPSEEK_API_KEY!));
  await page.screenshot({path:resolve(dir,'browser.png'),fullPage:true});assert.deepEqual(errors,[]);
  evidence.result='PASS';evidence.browser=browser.version();evidence.calls=calls;evidence.topic=service.get({topicId});
  evidence.turns=store.all('SELECT node_id,sdk_session_id,status,sdk_receipt_id,event_offset,usage_json FROM model_turns ORDER BY rowid');
  evidence.checks=['actual rendered reply linked to real input','only targeted node invoked','two fixed roots resumed','zero peer messages','reload no inference','hard four-call stop','no private prompt or SDK history in HTTP'];
 }finally{evidence.calls=calls;evidence.pageErrors=errors;writeFileSync(resolve(dir,'result.json'),JSON.stringify(evidence,null,2));await browser?.close();await app.close();store.close();}
});
