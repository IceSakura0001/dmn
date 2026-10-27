import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chromium} from 'playwright-core';
import {mkdtempSync,rmSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DmnStore} from '../src/store.ts';
import {OperatorService} from '../src/operator.ts';
import {startWeb} from '../src/web.ts';
import {fixtureNodes} from './fixtures.ts';
import {browserPath} from './browser-path.ts';
import {DmnGateway} from '../src/gateway.ts';
test('P4 real Chromium: direct A/B chat, safe text, refresh, pause/resume/close',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-browser-'));const store=new DmnStore(join(dir,'db.sqlite'));const calls:string[]=[];
 const service=new OperatorService(store,{nodes:fixtureNodes.slice(0,2)},{async run(input,receipt){calls.push(input.node.id);receipt('receipt');const envelope=JSON.parse(input.prompt);return{sessionId:input.node.sessionId,text:JSON.stringify(envelope.mode==='discussion'?{action:'send',to:input.node.id==='a'?'b':'a',content:'节点讨论记录'}:{action:'reply_user',content:`${input.node.id}: <img src=x onerror=alert(1)>`})};}});
 const app=await startWeb(service,0);
 let browser;
 try{
 browser=await chromium.launch({executablePath:browserPath(),headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{if(!sessionStorage.getItem('stale-tested')){localStorage.setItem('dmn-topic','missing-old-database-topic');sessionStorage.setItem('stale-tested','1');}});
 await page.goto(`http://127.0.0.1:${app.port}`);await page.waitForFunction(()=>document.getElementById('connection')?.textContent==='已连接');
 await page.waitForFunction(()=>localStorage.getItem('dmn-topic')==='');assert.equal(calls.length,0);
 await page.locator('#title').fill('双节点浏览器验收');await page.locator('#prompt').fill('仅定向回复用户');await page.locator('#create button').click();
 await page.waitForFunction(()=>document.getElementById('notice')?.textContent==='话题已持久化。');assert.equal(calls.length,0);
 for(const id of ['a','b']){
 if(id==='a')await page.route('**/api/send',async route=>{await route.fetch();await route.abort();},{times:1});
 await page.selectOption('#recipient',id);await page.fill('#content','发给 '+id);await page.locator('#send button').click();
 if(id==='a'){await page.waitForFunction(()=>document.getElementById('notice')?.textContent?.includes('操作未确认'));await page.reload();await page.waitForFunction(()=>document.getElementById('connection')?.textContent==='已连接');await page.selectOption('#recipient',id);await page.fill('#content','发给 '+id);await page.locator('#send button').click();}
 await page.waitForFunction(()=>document.getElementById('notice')?.textContent==='输入已入队，尚不代表模型完成。');await page.locator('#refresh').click();
 await page.waitForFunction(id=>document.getElementById('timeline')?.textContent?.includes(id+': <img'),id);
 }
 await page.selectOption('#timelineNode','a');await page.waitForFunction(()=>!document.getElementById('timeline')?.textContent?.includes('b: <img'));
 assert(await page.locator('#timeline').textContent().then(t=>t?.includes('a: <img')));await page.selectOption('#timelineNode','');await page.waitForFunction(()=>document.getElementById('timeline')?.textContent?.includes('b: <img'));
 assert.deepEqual(calls,['a','b']);assert.equal(await page.locator('#timeline img').count(),0);
 await page.reload();await page.waitForFunction(()=>document.getElementById('timeline')?.textContent?.includes('b: <img'));assert.equal(calls.length,2);
 await page.route('**/api/pause',async route=>{await page.route('**/api/state',r=>r.abort(),{times:1});await route.continue();},{times:1});
 await page.locator('[data-action=pause]').click();await page.waitForFunction(()=>document.getElementById('notice')?.textContent?.includes('操作已确认，状态刷新失败'));
 await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('topicState')?.textContent?.includes('暂停'));assert.equal(calls.length,2);
 await page.locator('[data-action=resume]').click();await page.waitForFunction(()=>document.getElementById('topicState')?.textContent?.includes('等待输入'));
 await page.locator('[data-action=close]').click();await page.waitForFunction(()=>document.getElementById('topicState')?.textContent?.includes('已结束'));
 await page.fill('#content','closed');await page.locator('#send button').click();await page.waitForFunction(()=>document.getElementById('notice')?.textContent?.includes('TOPIC_STOPPED'));assert.equal(calls.length,2);
 assert((await page.locator('#notice').textContent())?.includes('请求被拒绝'));
 await page.selectOption('#mode','discussion');await page.fill('#title','节点间讨论验收');await page.fill('#prompt','明确授权两节点在四次调用内讨论');await page.fill('#turns','4');await page.fill('#perNode','2');await page.locator('#create button').click();
 await page.waitForFunction(()=>document.querySelectorAll('#timeline article').length===3);
 assert.equal(calls.length,6);const discussion=service.listTopics()[0] as {id:string};
 assert(service.messages({topicId:discussion.id}).messages.every((m:any)=>m.state==='handled'));
 assert((await page.locator('#timeline').textContent())?.includes('a → b'));assert((await page.locator('#timeline').textContent())?.includes('b → a'));
 assert((await page.locator('#timeline').textContent())?.includes('已处理'));
 assert.deepEqual(errors,[]);mkdirSync('.dmn/evidence',{recursive:true});await page.screenshot({path:'.dmn/evidence/p4-browser.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'.dmn/evidence/p4-browser-mobile.png',fullPage:true});
 writeFileSync('.dmn/evidence/p4-browser.json',JSON.stringify({verifiedAt:new Date().toISOString(),browser:browser.version(),result:'PASS',runtime:'simulated; no model API',calls,checks:['A/B targeted replies','no inference on create/load','safe text rendering','refresh persistence','pause/resume/close','closed send rejected','stale selection cleared','acknowledged write/read failure distinguished','peer directions and delivery states'],pageErrors:errors},null,2));
 }catch(error){console.error(JSON.stringify({calls,topics:service.listTopics(),turns:store.all('SELECT node_id,status FROM model_turns')}));throw error;}
 finally{await browser?.close();await app.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('P4 browser distinguishes silent, decline, failed and unknown from a user reply',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-browser-outcomes-')),store=new DmnStore(join(dir,'db.sqlite'));
 let calls=0;const service=new OperatorService(store,{nodes:fixtureNodes.slice(0,2)},{async run(input,receipt){
  calls++;receipt('receipt');const action=JSON.parse(input.prompt).incoming.content;
  if(action==='unknown')throw Error('injected interruption after receipt');
  return{sessionId:input.node.sessionId,text:action==='failed'?'invalid json':JSON.stringify({action})};
 }});
 const app=await startWeb(service,0);let browser;
 try{
  browser=await chromium.launch({executablePath:browserPath(),headless:true});const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${app.port}`);await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='已连接');
  await page.fill('#title','完成状态不是正式回复');await page.fill('#prompt','逐项故障注入');await page.locator('#create button').click();
  await page.waitForFunction(()=>document.querySelector('#notice')?.textContent==='话题已持久化。');
  for(const [node,action,label]of [['a','silent','静默'],['b','decline','拒绝'],['a','failed','失败 / 取消'],['b','unknown','结果未知，待对账']]){
   await page.selectOption('#recipient',node!);await page.fill('#content',action!);await page.locator('#send button').click();
   await page.waitForFunction(()=>document.querySelector('#notice')?.textContent==='输入已入队，尚不代表模型完成。');await page.locator('#refresh').click();
   await page.waitForFunction(label=>document.querySelector('#timeline article:last-child')?.textContent?.includes(label!),label);
  }
  assert.equal(calls,4);assert(!(await page.locator('#timeline').textContent())?.includes('节点 → 用户'));
  assert((await page.locator('#topicState').textContent())?.includes('未知 1'));
  assert((await page.locator('#nodes').textContent())?.includes('异常隔离'));
  await page.reload();await page.waitForFunction(()=>document.querySelector('#timeline')?.textContent?.includes('结果未知，待对账'));assert.equal(calls,4);
 }finally{await browser?.close();await app.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('P5 browser pages older messages, returns to live data and reads metrics without inference',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-browser-pages-')),store=new DmnStore(join(dir,'db.sqlite'));let calls=0;
 const service=new OperatorService(store,{nodes:fixtureNodes.slice(0,2)},{async run(){calls++;throw Error('read must not infer');}});
 const request=JSON.parse(readFileSync('config/topic.p2.json','utf8'));request.startNode='a';request.topic.participants=['a','b'];delete request.limits.nodeLimits;
 const {topicId}=service.start({...request,idempotencyKey:'page'}),gateway=new DmnGateway(store);
 const send=(i:number)=>gateway.bindNode(i%2?'b':'a').send({topicId,to:i%2?'a':'b',content:'P5_HISTORY_'+i});
 for(let i=0;i<51;i++)send(i);
 store.run("UPDATE messages SET created_at='2026-10-27T00:00:00.000Z' WHERE topic_id=?",topicId);
 const app=await startWeb(service,0);let browser;
 try{
  browser=await chromium.launch({executablePath:browserPath(),headless:true});const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${app.port}`);await page.waitForFunction(()=>document.querySelector('#connection')?.textContent==='已连接');
  await page.selectOption('#topics',topicId);await page.waitForFunction(()=>document.querySelectorAll('#timeline article').length===50);
  assert((await page.locator('#timeline').textContent())?.includes('P5_HISTORY_50'));assert((await page.locator('#metrics').textContent())?.includes('实际输入/输出 Token'));
  assert.equal(await page.locator('#timeline article:first-child p').textContent(),'P5_HISTORY_1');assert.equal(await page.locator('#timeline article:last-child p').textContent(),'P5_HISTORY_50');
  let release!:()=>void,started!:()=>void;const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);
  await page.route('**/api/topic?*',async route=>{const response=await route.fetch();started();await held;await route.fulfill({response});},{times:1});
  await page.evaluate('window.__dmnOldRefresh=refresh(); void 0');await ready;
  await page.locator('#older').click();await page.waitForFunction(()=>document.querySelectorAll('#timeline article').length===1);assert((await page.locator('#timeline').textContent())?.includes('P5_HISTORY_0'));
  release();await page.evaluate('window.__dmnOldRefresh');assert.equal(await page.locator('#timeline article').count(),1);
  send(51);await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#timeline')?.textContent?.includes('P5_HISTORY_51'));
  assert.equal(await page.locator('#newer').isDisabled(),true);await page.locator('#older').click();await page.waitForFunction(()=>document.querySelectorAll('#timeline article').length===2);
  await page.locator('#newer').click();await page.waitForFunction(()=>document.querySelector('#pageInfo')?.textContent==='最新记录');assert.equal(calls,0);
  mkdirSync('.dmn/evidence',{recursive:true});await page.screenshot({path:'.dmn/evidence/p5-browser.png',fullPage:true});
 }finally{await browser?.close();await app.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
