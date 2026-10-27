import{StringDecoder}from'node:string_decoder';
import{createConnection}from'node:net';
import{randomUUID}from'node:crypto';
import{readNativeDescriptor,type NativeDescriptor}from'./native-instance.ts';
import{DmnError,fail,type ErrorCode}from'./errors.ts';
export async function nativeRequest(database:string,method:string,params:unknown={},ownerToken?:string){const descriptor=readNativeDescriptor(database);if(!descriptor)fail('NOT_FOUND','Native service is not running.');return requestDescriptor(descriptor,method,params,ownerToken);}
export function requestDescriptor(descriptor:NativeDescriptor,method:string,params:unknown={},ownerToken?:string):Promise<any>{
 return new Promise((resolve,reject)=>{const decoder=new StringDecoder('utf8'),id=randomUUID();let bytes=0,buffer='',settled=false;const socket=createConnection(descriptor.address);
  const finish=(error?:Error,value?:unknown)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(value);};
  socket.setTimeout(15000,()=>finish(new DmnError('CONFLICT','Native response is unconfirmed; inspect before retrying writes.')));
  socket.once('error',()=>finish(new DmnError('CONFLICT','Native connection failed; execution may be unconfirmed.')));
  socket.once('connect',()=>{const request=JSON.stringify({protocol:1,id,token:descriptor.token,method,params,...(ownerToken?{ownerToken}:{})});if(Buffer.byteLength(request)>65536){finish(new DmnError('VALIDATION','Native request is too large.'));return;}socket.write(request+'\n');});
  socket.on('data',chunk=>{bytes+=chunk.length;if(bytes>10*1024*1024){finish(new DmnError('STORAGE','Native response exceeded its bound.'));return;}buffer+=decoder.write(chunk);if(!buffer.includes('\n'))return;
   try{const response=JSON.parse(buffer.split('\n')[0]!);if(response.id!==id)throw Error();if(response.ok)finish(undefined,response.result);else finish(new DmnError(response.error?.code as ErrorCode??'STORAGE','Native operation refused: '+String(response.error?.code??'STORAGE')));}catch{finish(new DmnError('STORAGE','Native response protocol failed.'));}
  });socket.once('end',()=>{if(!settled)finish(new DmnError('CONFLICT','Native reply was lost; do not blindly repeat a write.'));});
 });
}
export function nativeOperator(database:string){const call=(method:string)=>(params:unknown={})=>nativeRequest(database,method,params);return{start:call('start'),send:call('send'),list:call('nodes'),listTopics:call('topics'),get:call('topicState'),messages:call('messages'),pause:call('pause'),resume:call('resume'),close:call('close'),drain:async()=>{},nextWake:()=>undefined};}
