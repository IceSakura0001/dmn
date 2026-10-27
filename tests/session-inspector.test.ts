import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectSession } from '../src/session-inspector.ts';
import { fixtureNodes } from './fixtures.ts';
import type { RuntimeInput } from '../src/runner.ts';
const limits = { maxInputTokens:100000,maxOutputTokens:10000,maxEstimatedCost:2,inputTokensPerTurn:32768,outputTokensPerTurn:512,estimatedCostPerTurn:0.25,turnTimeoutMs:5000 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(),'dmn-inspect-')); const nodeRoot=join(root,'a'); const cwd=join(nodeRoot,'workspace');
  const path=join(nodeRoot,'sessions','project','root'); mkdirSync(path,{recursive:true}); mkdirSync(cwd,{recursive:true});
  const prompt=JSON.stringify({ dmnTurnId:'dmn-turn',nodeId:'a',incoming:null });
  const input: RuntimeInput={ node:fixtureNodes[0] as RuntimeInput['node'],turnId:'dmn-turn',topicId:'topic',prompt,resume:false,limits };
  const data=[
    { type:'session',version:4,id:'session-a',createdAt:1,cwd,isSeeded:false,delegationDepth:0 },
    { type:'agent/inbox/spliced',seq:0,time:1,data:{ target:'next-turn',start:0,inserted:[{ id:'sdk-receipt',role:'user',source:{kind:'user'},content:[{type:'text',text:prompt}] }] } },
    { type:'turn/start',seq:1,time:1,data:{turn:1} },
    { type:'step/start',seq:2,time:1,data:{turn:1,step:1} },
    { type:'user/message',seq:2,time:1,data:{ id:'sdk-receipt',role:'user',source:{kind:'user'},content:[{type:'text',text:prompt}] } },
    { type:'request/header',seq:3,time:1,data:{header:{config:{provider:'test-provider',model:'test-model-a'},tools:[]}} },
    { type:'assistant/message',seq:4,time:1,data:{ turn:1,step:1,message:{content:[{type:'text',text:'{"action":"silent"}'}]},usage:{inputTokens:30,cacheReadTokens:10,outputTokens:4} } },
    { type:'turn/end',seq:5,time:1,data:{turn:1,reason:{kind:'completed'}} },
  ];
  const log=join(path,'session.v4.jsonl');
  return { root,nodeRoot,input,data,log,write(rows:any[]=data,suffix='\n'){writeFileSync(log,rows.map((x,n)=>JSON.stringify(n===0?x:{...x,seq:n-1})).join('\n')+suffix);},cleanup(){rmSync(root,{recursive:true,force:true});} };
}
test('P2 read-only inspector matches native receipt, exact host prompt/turn and completed root without SDK calls', async () => {
  const f=fixture();
  try {
    f.write(); const result=await inspectSession(f.root,f.input,'sdk-receipt');
    assert.equal(result.state,'completed');
    if(result.state==='completed'){assert.equal(result.result.text,'{"action":"silent"}');assert.equal(result.result.usage?.inputTokens,40);}
    assert.equal((await inspectSession(f.root,f.input,null)).state,'completed');
  } finally{f.cleanup();}
});
test('P2 log inspector refuses occupied homes, missing receipt and mixed identities',async()=>{
  const f=fixture();
  try{
    f.write();writeFileSync(join(f.nodeRoot,'runtime.lock'),'occupied');
    const busy=await inspectSession(f.root,f.input,'sdk-receipt');assert.equal(busy.state,'unknown');if(busy.state==='unknown')assert.equal(busy.quiescent,false);
    rmSync(join(f.nodeRoot,'runtime.lock'));
    assert.equal((await inspectSession(f.root,f.input,'wrong-receipt')).state,'unknown');
    assert.equal((await inspectSession(f.root,{...f.input,node:{...f.input.node,sessionId:'other-root'}},'sdk-receipt')).state,'unknown');
  }finally{f.cleanup();}
});
test('P2 log inspector fails closed on torn tails, missing terminal, future generations and native tools',async()=>{
  const f=fixture();
  try{
    f.write(f.data,'');assert.equal((await inspectSession(f.root,f.input,null)).state,'unknown');
    f.write(f.data.slice(0,-1));assert.equal((await inspectSession(f.root,f.input,null)).state,'unknown');
    f.write(f.data.map(r=>r.type==='request/header'?{...r,data:{header:{config:{provider:'test-provider',model:'test-model-a'},tools:[{name:'shell'}]}}}:r));
    assert.equal((await inspectSession(f.root,f.input,null)).state,'unknown');
    f.write();writeFileSync(join(f.log,'..','session.v5.jsonl'),'{}\n');
    assert.equal((await inspectSession(f.root,f.input,null)).state,'unknown');
  }finally{f.cleanup();}
});

test('P2 ambiguous user steering before the matched input cannot be attributed to the DMN turn',async()=>{
  const f=fixture();
  try{
    const mixed=[...f.data];mixed.splice(3,0,{type:'user/message',seq:2,time:1,data:{id:'different-input',role:'user',source:{kind:'user'},content:[{type:'text',text:'another prompt'}]}} as typeof mixed[number]);
    f.write(mixed);assert.equal((await inspectSession(f.root,f.input,'sdk-receipt')).state,'unknown');
  }finally{f.cleanup();}
});
