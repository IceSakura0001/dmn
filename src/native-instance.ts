import{existsSync,lstatSync,readFileSync,openSync,closeSync,writeFileSync,unlinkSync}from'node:fs';
import{createHash,randomBytes,randomUUID,timingSafeEqual}from'node:crypto';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{z}from'zod';
import{databasePath}from'./maintenance.ts';
import{fail}from'./errors.ts';
const descriptorSchema=z.strictObject({protocol:z.literal(1),pid:z.number().int().positive(),instanceId:z.string().regex(/^[a-f0-9]{32}$/),bootId:z.string().uuid(),address:z.string().min(1).max(512),token:z.string().regex(/^[a-f0-9]{64}$/)});
export type NativeDescriptor=z.output<typeof descriptorSchema>;
export function instanceFiles(database:string){const path=databasePath(database);return{database:path,owner:path+'.native.owner',endpoint:path+'.native.endpoint',instanceId:createHash('sha256').update(path).digest('hex').slice(0,32)};}
function readFile(path:string){if(lstatSync(path).isSymbolicLink())fail('FORBIDDEN','Instance metadata links are forbidden.');try{return JSON.parse(readFileSync(path,'utf8'));}catch{fail('CONFLICT','Instance metadata is unreadable.');}}
export function nativeOwnership(database:string){const files=instanceFiles(database);if(!existsSync(files.owner))return;const value=readFile(files.owner);if(value.instanceId!==files.instanceId||!Number.isSafeInteger(value.pid)||value.pid<1)fail('CONFLICT','Instance owner identity is invalid.');return value as{pid:number;bootId:string;instanceId:string};}
export function assertSchedulingOwner(database:string){if(database===':memory:')return;const owner=nativeOwnership(database);if(owner&&owner.pid!==process.pid)fail('CONFLICT','A native service owns scheduling; use its client interface.');}
export function readNativeDescriptor(database:string){const files=instanceFiles(database),owner=nativeOwnership(database);if(!owner)return;
 if(!existsSync(files.endpoint))fail('CONFLICT','Native service is starting, stale or unavailable.');const p=descriptorSchema.safeParse(readFile(files.endpoint));if(!p.success||p.data.instanceId!==files.instanceId||p.data.bootId!==owner.bootId||p.data.pid!==owner.pid)fail('CONFLICT','Native discovery does not match its owner.');return p.data;}
export function acquireNativeInstance(database:string){const files=instanceFiles(database);let fd:number;try{fd=openSync(files.owner,'wx',0o600);}catch{fail('CONFLICT','Native instance ownership exists; inspect before restarting.');}
 const bootId=randomUUID();writeFileSync(fd,JSON.stringify({pid:process.pid,bootId,instanceId:files.instanceId}));closeSync(fd);
 const descriptor:NativeDescriptor={protocol:1,pid:process.pid,bootId,instanceId:files.instanceId,token:randomBytes(32).toString('hex'),address:process.platform==='win32'?`\\\\.\\pipe\\dmn-${files.instanceId}-${bootId}`:join(tmpdir(),`dmn-${bootId}.sock`)};
 return{files,descriptor,publish(){writeFileSync(files.endpoint,JSON.stringify(descriptor),{flag:'wx',mode:0o600});},release(){
  if(existsSync(files.owner)&&readFile(files.owner).bootId===bootId){if(existsSync(files.endpoint)&&readFile(files.endpoint).bootId===bootId)unlinkSync(files.endpoint);unlinkSync(files.owner);}
 }};
}
export function matchesSecret(actual:unknown,expected:string){return typeof actual==='string'&&/^[a-f0-9]{64}$/.test(actual)&&actual.length===expected.length&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected));}
