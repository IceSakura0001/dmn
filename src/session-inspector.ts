import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client';
import { closeSync,existsSync,mkdirSync,openSync,readdirSync,readFileSync,realpathSync,statSync,unlinkSync } from 'node:fs';
import { isAbsolute,join,relative,resolve } from 'node:path';
import type { Inspection,RuntimeInput } from './runner.ts';
import { parseNode } from './contracts.ts';

/** Version-pinned, read-only proof reader. Missing evidence is never proof of non-submission. */
export async function inspectSession(root: string,input: RuntimeInput,receiptId: string|null): Promise<Inspection> {
  parseNode(input.node);
  const nodeRoot=resolve(root,input.node.id); mkdirSync(nodeRoot,{recursive:true});
  const marker=join(nodeRoot,'runtime.lock');let fd:number;
  try{fd=openSync(marker,'wx');}catch{return{state:'unknown',reason:'RUNTIME_HOME_BUSY',quiescent:false};}
  const unknown=(reason:string):Inspection=>({state:'unknown',reason,quiescent:true});
  try{
    const sessions=join(nodeRoot,'sessions');if(!existsSync(sessions))return unknown('NO_DURABLE_LOG');
    const files:string[]=[];let visited=0;
    const base=realpathSync(nodeRoot);
    function walk(dir:string,depth:number){
      if(depth>3||++visited>1000)throw Error('bounded traversal');
      const rel=relative(base,realpathSync(dir));if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw Error('outside home');
      for(const entry of readdirSync(dir,{withFileTypes:true})){
        if(entry.isSymbolicLink())throw Error('link');const path=join(dir,entry.name);
        if(entry.isDirectory())walk(path,depth+1);
        else if(/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(entry.name))files.push(path);
      }
    }
    walk(sessions,0);
    const candidates:{path:string;rows:Record<string,any>[]}[]=[];
    for(const path of files){
      if(!path.endsWith('session.v4.jsonl'))continue;
      if(statSync(path).size>16*1024*1024)return unknown('LOG_TOO_LARGE');
      const text=readFileSync(path,'utf8');if(!text.endsWith('\n'))return unknown('TORN_LOG');
      const rows=text.trimEnd().split('\n').map(line=>JSON.parse(line));const header=rows[0];
      if(header?.id!==input.node.sessionId)continue;
      if(files.some(other=>other!==path&&resolve(other,'..')===resolve(path,'..')))return unknown('UNSUPPORTED_GENERATION');
      if(header.type!=='session'||header.version!==4||header.isSeeded!==false||header.parentSession!==undefined||header.origin==='subagent'||header.delegationDepth!==0||resolve(header.cwd??'')!==resolve(nodeRoot,'workspace'))return unknown('ROOT_HEADER_MISMATCH');
      candidates.push({path,rows});
    }
    if(candidates.length!==1)return unknown('MISSING_OR_AMBIGUOUS_SESSION');
    const rows=candidates[0]!.rows.slice(1);let currentTurn:number|undefined;let matchedTurn:number|undefined;let matchedId:string|undefined;
    let matchCount=0;let terminal=false;let headerSeen=false;let assistant:Record<string,any>|undefined;let terminalSeq=0;const receipts=new Set<string>();
    const userInputs=new Map<number,string[]>();
    for(const [seq,event]of rows.entries()){
      if(event.seq!==seq||!Number.isSafeInteger(event.time)||typeof event.type!=='string')return unknown('INVALID_EVENT_SEQUENCE');
      if(!KNOWN_SESSION_EVENT_TYPES.has(event.type)){if(event.ignorable===true)continue;return unknown('UNKNOWN_REQUIRED_EVENT');}
      validatedSessionEvent(event);
      if(event.type==='request/header'){
        const h=event.data?.header;
        if(!h||h.config?.provider!==input.node.provider||h.config?.model!==input.node.model||h.tools?.length)return unknown('ROUTE_OR_TOOL_MISMATCH');
        headerSeen=true;
      }
      if(event.type==='agent/inbox/spliced')for(const message of event.data?.inserted??[]){
        const content=message.content?.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('');
        if(content===input.prompt&&typeof message.id==='string')receipts.add(message.id);
      }
      if(event.type==='turn/start'){currentTurn=event.data?.turn;if(!Number.isSafeInteger(currentTurn))return unknown('INVALID_TURN');}
      if(event.type==='user/message'&&event.data?.source?.kind==='user'){
        if(currentTurn!==undefined)userInputs.set(currentTurn,[...(userInputs.get(currentTurn)??[]),event.data.id]);
        const content=event.data.content?.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join('');
        if(content===input.prompt){
          let binding:unknown;try{binding=JSON.parse(content);}catch{return unknown('INVALID_HOST_INPUT');}
          if(!binding||typeof binding!=='object'||!('dmnTurnId'in binding)||binding.dmnTurnId!==input.turnId)return unknown('TURN_BINDING_MISMATCH');
          if(receiptId&&event.data.id!==receiptId)return unknown('RECEIPT_MISMATCH');
          if(!receipts.has(event.data.id)||currentTurn===undefined)return unknown('NO_INBOX_RECEIPT');
          matchCount++;matchedTurn=currentTurn;matchedId=event.data.id;
        }else if(matchedTurn!==undefined&&currentTurn===matchedTurn)return unknown('MULTIPLE_USER_INPUTS');
      }
      if(matchedTurn!==undefined&&currentTurn===matchedTurn){
        if(event.type==='assistant/message'&&event.data?.turn===matchedTurn)assistant=event;
        if(event.type==='turn/end'&&event.data?.turn===matchedTurn){terminal=event.data.reason?.kind==='completed';terminalSeq=event.seq;}
      }
    }
    const steps=rows.filter(event=>event.type==='step/start'&&event.data?.turn===matchedTurn).length;
    if(matchCount!==1||!matchedId||!terminal||!headerSeen||!assistant||steps!==1||userInputs.get(matchedTurn!)?.length!==1)return unknown('NO_UNAMBIGUOUS_COMPLETED_ACTIVITY');
    const usage=assistant.data.usage;
    const inputTokens=usage ? usage.inputTokens+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0):undefined;
    if(usage&&(!Number.isFinite(inputTokens)||!Number.isFinite(usage.outputTokens)||inputTokens>input.limits.inputTokensPerTurn||usage.outputTokens>input.limits.outputTokensPerTurn))return unknown('USAGE_BOUND_MISMATCH');
    return{state:'completed',receiptId:matchedId,result:{sessionId:input.node.sessionId,text:assistant.data.message.content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join(''),
      ...(usage?{usage:{inputTokens,outputTokens:usage.outputTokens}}:{}),eventOffset:terminalSeq}};
  }catch{return unknown('UNREADABLE_OR_UNSUPPORTED_LOG');}
  finally{closeSync(fd);unlinkSync(marker);}
}
