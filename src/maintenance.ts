import {openSync,closeSync,mkdirSync,writeFileSync,readdirSync,readFileSync,unlinkSync,existsSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname,basename,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail} from './errors.ts';

function entry(path:string){
 try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;fail('STORAGE','Unable to inspect the instance path.');}
}
/** Physical identity even before creation; lstat also sees dangling links. */
export function instancePath(path:string,kind:'database'|'runtime'){
 const absolute=resolve(path),leaf=entry(absolute);
 if(leaf?.isSymbolicLink())fail('FORBIDDEN','Instance leaf links are not supported.');
 if(leaf&&((kind==='database'&&(!leaf.isFile()||leaf.nlink>1))||(kind==='runtime'&&!leaf.isDirectory())))fail('FORBIDDEN','Instance path must have one unambiguous physical identity.');
 if(leaf)return realpathSync(absolute);
 const suffix=[basename(absolute)];let parent=dirname(absolute);
 while(!entry(parent)){suffix.unshift(basename(parent));const next=dirname(parent);if(next===parent)fail('STORAGE','Instance parent cannot be resolved.');parent=next;}
 try{return join(realpathSync(parent),...suffix);}catch{fail('FORBIDDEN','A dangling or unreadable parent cannot identify an instance.');}
}
export const databasePath=(path:string)=>instancePath(path,'database');
/** Cooperating stores and offline tools serialize entry through the same barrier. */
export function acquireMaintenance(path:string){
 const marker=databasePath(path)+'.maintenance.lock';let fd:number;
 try{fd=openSync(marker,'wx');}catch{fail('CONFLICT','Database maintenance is active or needs manual inspection.');}
 return()=>{closeSync(fd);unlinkSync(marker);};
}
export function registerClient(path:string){
 if(path===':memory:')return()=>{};
 const canonical=databasePath(path),release=acquireMaintenance(canonical);
 try{
  if(existsSync(canonical+'.restore-incomplete'))fail('CONFLICT','An incomplete restore requires manual inspection.');
  const dir=canonical+'.clients';if(existsSync(dir)&&lstatSync(dir).isSymbolicLink())fail('FORBIDDEN','Client registration links are forbidden.');mkdirSync(dir,{recursive:true});
  const file=join(dir,randomUUID()+'.json');writeFileSync(file,JSON.stringify({pid:process.pid}),{flag:'wx'});
  return()=>{if(existsSync(file))unlinkSync(file);};
 }finally{release();}
}
/** Only obsolete host registrations may be reaped. Never removes SDK runtime.lock. */
export function requireNoClients(path:string){
 const dir=databasePath(path)+'.clients';if(!existsSync(dir))return;
 if(lstatSync(dir).isSymbolicLink())fail('CONFLICT','Client registration links require manual inspection.');
 for(const name of readdirSync(dir)){
  const file=join(dir,name);let pid:number;
  try{if(lstatSync(file).isSymbolicLink())throw Error();pid=JSON.parse(readFileSync(file,'utf8')).pid;if(!Number.isSafeInteger(pid)||pid<1)throw Error();}
  catch{fail('CONFLICT','Unrecognized client registration requires manual inspection.');}
  try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH'){unlinkSync(file);continue;}}
  fail('CONFLICT','Stop all database clients before backup or restore.');
 }
}
