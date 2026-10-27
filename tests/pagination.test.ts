import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OperatorService} from '../src/operator.ts';
import {fixtureNodes,setup} from './fixtures.ts';
import {spawnSync} from 'node:child_process';

test('P5 message cursor is topic-bound, stable against new rows and returns complete ordered pages',()=>{
 const f=setup();try{
  for(let i=0;i<5;i++)f.a.send({to:'b',topicId:f.topic.id,content:'row '+i,idempotencyKey:'p'+i});
  const service=new OperatorService(f.store,{nodes:fixtureNodes},{async run(){throw Error('read must not infer');}});
  const first=service.messages({topicId:f.topic.id,limit:2,order:'desc'});assert.equal(first.messages.length,2);assert.equal((first.messages[0] as any).content,'row 4');assert(first.page.nextCursor);
  f.b.send({to:'a',topicId:f.topic.id,content:'new after snapshot'});
  const second=service.messages({topicId:f.topic.id,limit:2,order:'desc',cursor:first.page.nextCursor});
  const third=service.messages({topicId:f.topic.id,limit:2,order:'desc',cursor:second.page.nextCursor!});
  assert.deepEqual([...first.messages,...second.messages,...third.messages].map((m:any)=>m.content),['row 4','row 3','row 2','row 1','row 0']);assert.equal(third.page.nextCursor,null);
  assert.equal((service.messages({topicId:f.topic.id,order:'desc'}).messages[0] as any).content,'new after snapshot');
  const other=f.gateway.createTopic('u',{title:'Other',initialPrompt:'test',participants:['a','b'],maxModelTurns:2,maxTurnsPerNode:1,deadlineAt:'2026-10-26T00:15:00Z'});
  assert.throws(()=>service.messages({topicId:other.id,cursor:first.page.nextCursor}),{code:'VALIDATION'});
  for(const bad of [{limit:0},{limit:101},{cursor:'../private'},{from:'b'},{order:'SQL'}])assert.throws(()=>service.messages({topicId:f.topic.id,...bad}),{code:'VALIDATION'});
  assert(!JSON.stringify(first).includes('input_snapshot'));
 }finally{f.cleanup();}
});

test('P5 query snapshots stay consistent while a separate WAL writer commits',()=>{
 const f=setup();try{
  const title=f.store.one<{title:string}>('SELECT title FROM topics')!.title;
  f.store.readSnapshot(()=>{
   assert.equal(f.store.one<{title:string}>('SELECT title FROM topics')!.title,title);
   const result=spawnSync(process.execPath,['--input-type=module','-e',"import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[1]);d.prepare('UPDATE topics SET title=?').run('writer committed');d.close();",f.path],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
   assert.equal(f.store.one<{title:string}>('SELECT title FROM topics')!.title,title);
  });
  assert.equal(f.store.one<{title:string}>('SELECT title FROM topics')!.title,'writer committed');
 }finally{f.cleanup();}
});
