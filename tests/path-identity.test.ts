import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,symlinkSync,linkSync,existsSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DmnStore} from '../src/store.ts';
import {createBackup} from '../src/backup.ts';
import {DshRootRuntime,type ClientPort} from '../src/dsh-runtime.ts';

test('P5-H1 dangling DB link is rejected before target or coordination artifacts are created',t=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-dangling-')),target=join(dir,'target.sqlite'),link=join(dir,'alias.sqlite');let store:DmnStore|undefined;
 try{
  try{symlinkSync(target,link,'file');}catch(error){if(process.platform!=='win32'||(error as NodeJS.ErrnoException).code!=='EPERM')throw error;symlinkSync(target,link,'junction');t.diagnostic('Native file symlink creation is EPERM; native dangling junction exercises the same lstat guard. File symlink creation itself is NOT_RUN.');}
  assert.throws(()=>{store=new DmnStore(link);},{code:'FORBIDDEN'});assert.equal(existsSync(target),false);assert.equal(existsSync(link+'.clients'),false);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});

test('P5-H1 hard-linked DB aliases cannot bypass a live client',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-hardlink-')),database=join(dir,'db.sqlite'),alias=join(dir,'alias.sqlite');const store=new DmnStore(database);let other:DmnStore|undefined;
 try{linkSync(database,alias);assert.throws(()=>{other=new DmnStore(alias);},{code:'FORBIDDEN'});await assert.rejects(createBackup(alias,join(dir,'backup')),{code:'FORBIDDEN'});}
 finally{other?.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('P5-H1 parent junction uses one database identity, registration and physical Runtime location',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dmn-junction-')),physical=join(dir,'data'),alias=join(dir,'alias');mkdirSync(physical);symlinkSync(physical,alias,process.platform==='win32'?'junction':'dir');
 let store:DmnStore|undefined;
 try{
  store=new DmnStore(join(alias,'db.sqlite'));assert.equal(store.path,realpathSync(join(physical,'db.sqlite')));assert.equal(store.runtimeRoot,store.path+'.runtime');
  await assert.rejects(createBackup(join(physical,'db.sqlite'),join(dir,'backup')),{code:'CONFLICT'});
  let home='';const port:ClientPort={async initialize(){throw Error('stop before inference');},async resumeSession(){},async prompt(){return'';},async request(){},subscribe(){throw Error('unused');},async close(){}};
  const runtime=new DshRootRuntime({root:join(alias,'db.sqlite.runtime'),workspace:process.cwd()},options=>{home=options!.dshHome!;return port;});
  await assert.rejects(runtime.run({node:{id:'deepseek',provider:'deepseek-official',model:'deepseek-flash',sessionId:'fixed-root',personaRef:'templates/personas/deepseek-node.md',memoryNamespace:'memory:deepseek',allowedTools:[]},topicId:'topic',turnId:'turn',prompt:'{}',resume:false,limits:{maxInputTokens:32768,maxOutputTokens:1024,maxEstimatedCost:.25,inputTokensPerTurn:32768,outputTokensPerTurn:1024,estimatedCostPerTurn:.25,turnTimeoutMs:1000}},()=>{}));
  assert.equal(home,join(physical,'db.sqlite.runtime','deepseek'));
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
