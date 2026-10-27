import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem';
import { resolve } from 'node:path';

test('P3 installed official skill provider discovers project Git-root catalog and loads current instruction bodies',async()=>{
  const controller=new AbortController();
  const provider=new FileSystemSkillProvider(new Context(),{signal:controller.signal,invalidate(){}},{watch:false,dshHome:resolve('.dmn/skill-test-empty'),agentsHome:resolve('.dmn/skill-test-empty')});
  try{
    const observation=await provider.list({cwd:resolve('src')});
    const catalog=Array.isArray(observation)?observation:observation.candidates;
    for(const name of ['dmn-architecture','dmn-messaging','dmn-memory','dmn-testing','dmn-operator']){
      const entry=catalog.find(x=>x.name===name)!;assert(entry);assert.equal(entry.source,'project-dsh');
      const loaded=await provider.get(entry,{cwd:resolve('src')});assert(loaded?.content.length);
      if(name==='dmn-operator')assert(loaded.content.includes('desktop-user'));
    }
  }finally{controller.abort();await provider.dispose();}
});
