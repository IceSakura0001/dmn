import{z}from'zod';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{existsSync,readdirSync,lstatSync,renameSync}from'node:fs';import{DatabaseSync}from'node:sqlite';import{acquireMaintenance,requireNoClients}from'./maintenance.ts';
import{createBackup,verifyBackup,restoreBackup}from'./backup.ts';import{instanceFiles,nativeOwnership,readNativeDescriptor}from'./native-instance.ts';import{fail}from'./errors.ts';
const id=z.string().uuid();const command=z.discriminatedUnion('operation',[
 z.strictObject({operation:z.literal('backup'),params:z.strictObject({})}),
 z.strictObject({operation:z.literal('verify'),params:z.strictObject({backupId:id})}),
 z.strictObject({operation:z.literal('restore'),params:z.strictObject({backupId:id,confirmInstanceId:z.string().regex(/^[a-z0-9]{1,64}$/)})}),
 z.strictObject({operation:z.literal('retire'),params:z.strictObject({confirmInstanceId:z.string(),confirmOwnerPid:z.number().int().positive(),reason:z.string().trim().min(1).max(500)})})
]);
/** Trusted one-shot Host worker. Renderer supplies IDs, never filesystem paths. */
export async function performNativeMaintenance(database:string,input:unknown):Promise<Record<string,any>>{
 const checked=command.safeParse(input);if(!checked.success)fail('VALIDATION','Invalid native maintenance request.');const x=checked.data,files=instanceFiles(database);
 if(x.operation==='retire')return retireOwner(database,x.params);
 if(nativeOwnership(database))fail('CONFLICT','Stop the owning native service before maintenance.');
 const backupId=x.operation==='backup'?randomUUID():x.params.backupId,bundle=join(files.database+'.backups',backupId);
 if(x.operation==='backup'){const r=await createBackup(files.database,bundle);return{created:true,backupId,instanceId:files.instanceId,schemaVersion:r.schemaVersion,files:r.files,inferenceStarted:false};}
 if(x.operation==='verify'){const r=await verifyBackup(bundle);if(r.database!==files.database)fail('FORBIDDEN','Backup belongs to another instance.');return{verified:true,backupId,instanceId:files.instanceId,schemaVersion:r.schemaVersion,files:r.files};}
 if(x.params.confirmInstanceId!==files.instanceId)fail('FORBIDDEN','Confirm the exact instance before restoring.');
 const r=await restoreBackup(bundle,files.database,{preserveExisting:true});return{restored:true,backupId,instanceId:files.instanceId,schemaVersion:r.schemaVersion,previousPairPreserved:r.previousPairPreserved,inferenceStarted:false};
}
function retireOwner(database:string,approval:{confirmInstanceId:string;confirmOwnerPid:number;reason:string}){
 const files=instanceFiles(database),release=acquireMaintenance(database);let db:DatabaseSync|undefined;const moved:[string,string][]=[];
 try{const owner=nativeOwnership(database);if(!owner||owner.instanceId!==approval.confirmInstanceId||owner.pid!==approval.confirmOwnerPid)fail('FORBIDDEN','Confirm the exact stale owner.');
  let dead=false;try{process.kill(owner.pid,0);}catch(error){dead=(error as NodeJS.ErrnoException).code==='ESRCH';}if(!dead)fail('CONFLICT','Old owner is present or cannot be proved absent.');requireNoClients(database);if(existsSync(files.endpoint))readNativeDescriptor(database);
  let visited=0;function walk(path:string,depth:number){if(!existsSync(path))return;if(depth>32||++visited>100000)fail('CONFLICT','Runtime inspection bound exceeded.');const stat=lstatSync(path);if(stat.isSymbolicLink())fail('CONFLICT','Runtime links require manual inspection.');if(stat.isDirectory())for(const name of readdirSync(path))walk(join(path,name),depth+1);else if(path.endsWith('runtime.lock'))fail('CONFLICT','Runtime marker blocks owner retirement.');}walk(files.database+'.runtime',0);
  db=new DatabaseSync(files.database);db.exec('BEGIN IMMEDIATE');const suffix='.retired-'+randomUUID();
  for(const path of [files.endpoint,files.owner])if(existsSync(path)){if(lstatSync(path).isSymbolicLink())fail('FORBIDDEN','Discovery links are forbidden.');renameSync(path,path+suffix);moved.push([path,path+suffix]);}
  db.prepare('INSERT INTO events(event_type,payload_json,created_at) VALUES(?,?,?)').run('operator.native_owner_retired',JSON.stringify({operator:'desktop-user',pid:owner.pid,bootId:owner.bootId,reason:approval.reason}),new Date().toISOString());db.exec('COMMIT');
  return{retired:true,instanceId:files.instanceId,previousOwnerPid:owner.pid,unknownTurnsReplayed:false,inferenceStarted:false};
 }catch(error){try{db?.exec('ROLLBACK');}catch{}for(const [old,archived]of moved.reverse())if(existsSync(archived)&&!existsSync(old))renameSync(archived,old);throw error;}finally{db?.close();release();}
}
