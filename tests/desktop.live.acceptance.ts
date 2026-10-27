import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('live P3: real MCP starts fixed roots, accepts human input and retains pause/resume/close history across reconnect',{timeout:180000},async()=>{
  assert(process.env.DEEPSEEK_API_KEY);
  const dir=resolve('.dmn',`live-p3-${randomUUID()}`);mkdirSync(dir,{recursive:true});const database=join(dir,'queue.sqlite');
  const connect=async()=>{const c=new Client({name:'p3-acceptance',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/mcp-stdio.ts',resolve('.'),database],cwd:resolve('.'),env:Object.fromEntries(Object.entries(process.env).filter((x):x is [string,string]=>typeof x[1]==='string')),stderr:'pipe'}));return c;};
  let client=await connect();
  const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return JSON.parse((r.content as {type:string;text:string}[])[0]!.text);};
  const wait=async(topicId:string,turns:number)=>{const deadline=Date.now()+90000;while(Date.now()<deadline){const state=await call('get_topic',{topicId});if(state.state==='waiting'&&state.usedTurns>=turns)return state;if(state.state==='paused')throw Error('Unexpected budget or runtime stop');await new Promise(r=>setTimeout(r,500));}throw Error('Topic did not reach confirmed idle');};
  try{
    const request=JSON.parse(readFileSync('config/topic.p2.json','utf8'));request.idempotencyKey='p3-live-start';
    request.topic.initialPrompt='这是严格的接口验收。如果 incoming 为 null，仅返回 {"action":"silent"}。如果 incoming.type 为 operator，返回 {"action":"send","to":"reviewer","content":"P3_OPERATOR_RECEIVED"}。否则仅返回 {"action":"silent"}。不要记忆候选，不要附加任何其他字符。';
    const {topicId}=await call('start_topic',request);assert.equal((await call('start_topic',request)).topicId,topicId);
    await wait(topicId,1);await call('pause_topic',{topicId});assert.equal((await call('get_topic',{topicId})).state,'paused');
    await call('resume_topic',{topicId});
    const input={topicId,to:'deepseek',content:'请在本次已授权的 discussion 中向 reviewer 发送 P3_OPERATOR_RECEIVED，不直接回复用户。',idempotencyKey:'p3-input'};
    const accepted=await call('send_message',input);assert.equal((await call('send_message',input)).messageId,accepted.messageId);
    const state=await wait(topicId,3);assert.equal(state.usedTurns,3);
    const messages=await call('get_messages',{topicId});assert.equal(messages.operatorMessages.length,1);assert.equal(messages.operatorMessages[0].sender,'desktop-user');
    assert.equal(messages.messages.length,1);assert.equal(messages.messages[0].content,'P3_OPERATOR_RECEIVED');
    await call('close_topic',{topicId});await client.close();client=await connect();assert.equal((await call('get_topic',{topicId})).state,'closed');
    const db=new DatabaseSync(database,{readOnly:true});
    try{
      const turns=db.prepare('SELECT node_id,sdk_session_id,status,sdk_receipt_id FROM model_turns ORDER BY rowid').all();assert.equal(turns.length,3);assert(turns.every(t=>t.status==='completed'&&t.sdk_receipt_id));
      const evidence={verifiedAt:new Date().toISOString(),topicId,state:'closed',turns,modelMessages:messages.messages.length,operatorMessages:1,checks:['stdio handshake','idempotent startup','pause','resume without quota reset','trusted operator input','two fixed SDK roots','closed topic after reconnect','no startup inference']};
      writeFileSync(join(dir,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({evidence:join(dir,'evidence.json')}));
    }finally{db.close();}
  }finally{await client.close();}
});
