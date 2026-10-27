import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';

test('P3 real MCP stdio handshake, tool discovery, safe reads and strict operator arguments',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'dmn-mcp-'));
  const client=new Client({name:'dmn-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/mcp-stdio.ts',resolve('.'),join(dir,'db.sqlite')],cwd:resolve('.'),stderr:'pipe'});
  try{
    await client.connect(transport);
    const list=await client.listTools();assert.equal(list.tools.length,9);
    const schema=list.tools.find(t=>t.name==='start_topic')!.inputSchema;
    assert(JSON.stringify(schema.properties?.limits).includes('inputTokensPerTurn'),'Budget fields must be discoverable by the Desktop model');
    assert(!JSON.stringify(list).includes('ownerNodeId'));
    const nodes=await client.callTool({name:'list_nodes',arguments:{}});assert(!nodes.isError);
    assert(JSON.stringify(nodes).includes('deepseek-v4-pro'));
    const empty=await client.callTool({name:'list_topics',arguments:{}});assert(JSON.stringify(empty).includes('[]'));
    const forged=await client.callTool({name:'send_message',arguments:{topicId:'fake',to:'reviewer',content:'x',idempotencyKey:'x',from:'deepseek'}});
    assert.equal(forged.isError,true);
    const missing=await client.callTool({name:'get_topic',arguments:{topicId:'fake'}});assert.equal(missing.isError,true);
    assert(!JSON.stringify(missing).includes(dir));
  }finally{await client.close();rmSync(dir,{recursive:true,force:true});}
});
