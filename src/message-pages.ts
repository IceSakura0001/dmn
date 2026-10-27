import {z} from 'zod';
import {DmnStore} from './store.ts';
import {TopicManager} from './topic-manager.ts';
import {fail} from './errors.ts';
const topicId=z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),number=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const messagesRequest=z.strictObject({topicId,limit:z.number().int().min(1).max(100).default(100),cursor:z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),order:z.enum(['asc','desc']).default('asc')});
const positions=z.strictObject({messages:number,operatorMessages:number,userReplies:number});
const cursorSchema=z.strictObject({version:z.literal(1),topicId,order:z.enum(['asc','desc']),after:positions,high:positions});
const tables={messages:'messages',operatorMessages:'operator_messages',userReplies:'user_replies'} as const;
export function getMessagesPage(store:DmnStore,input:unknown){
 return store.readSnapshot(()=>readPage(store,input));
}
function readPage(store:DmnStore,input:unknown){
 const parsed=messagesRequest.safeParse(input);if(!parsed.success)fail('VALIDATION','Invalid message page request.');const x=parsed.data;new TopicManager(store).row(x.topicId);
 const high={messages:0,operatorMessages:0,userReplies:0};for(const key of Object.keys(tables) as (keyof typeof tables)[])high[key]=store.one<{n:number}>(`SELECT COALESCE(max(rowid),0) n FROM ${tables[key]} WHERE topic_id=?`,x.topicId)!.n;
 let cursor={version:1 as const,topicId:x.topicId,order:x.order,high,after:x.order==='asc'?{messages:0,operatorMessages:0,userReplies:0}:{messages:high.messages+1,operatorMessages:high.operatorMessages+1,userReplies:high.userReplies+1}};
 if(x.cursor){let decoded:unknown;try{decoded=JSON.parse(Buffer.from(x.cursor,'base64url').toString('utf8'));}catch{fail('VALIDATION','Invalid message cursor.');}const c=cursorSchema.safeParse(decoded);if(!c.success||c.data.topicId!==x.topicId||c.data.order!==x.order)fail('VALIDATION','Cursor belongs to another topic or order.');cursor=c.data;}
 const select={messages:`SELECT m.rowid AS _row,m.message_id AS id,m.from_node AS sender,m.to_node AS recipient,m.type,m.content,m.created_at AS createdAt,d.status AS state FROM messages m JOIN deliveries d ON d.message_id=m.message_id`,
  operatorMessages:`SELECT m.rowid AS _row,m.message_id AS id,m.operator_id AS sender,m.to_node AS recipient,m.content,m.created_at AS createdAt,CASE WHEN r.message_id IS NOT NULL THEN 'replied' WHEN t.effects_suppressed=1 THEN 'suppressed' WHEN t.status='completed' THEN COALESCE(t.output_action,'completed') WHEN t.status='queued' AND t.retry_of IS NOT NULL THEN 'retry' ELSE t.status END AS state FROM operator_messages m LEFT JOIN model_turns t ON t.turn_id=(SELECT turn_id FROM model_turns WHERE operator_message_id=m.message_id ORDER BY attempt_number DESC,rowid DESC LIMIT 1) LEFT JOIN user_replies r ON r.reply_to=m.message_id`,
  userReplies:`SELECT m.rowid AS _row,m.message_id AS id,m.from_node AS sender,m.operator_id AS recipient,m.reply_to AS replyTo,m.turn_id AS turnId,m.content,m.created_at AS createdAt FROM user_replies m`};
 const result:{messages:any[];operatorMessages:any[];userReplies:any[]}={messages:[],operatorMessages:[],userReplies:[]};let more=false;
 for(const key of Object.keys(tables) as (keyof typeof tables)[]){
  const rows=store.all<{_row:number;[key:string]:unknown}>(`${select[key]} WHERE m.topic_id=? AND m.rowid<=? AND m.rowid${x.order==='asc'?'>':'<'}? ORDER BY m.rowid ${x.order} LIMIT ?`,x.topicId,cursor.high[key],cursor.after[key],x.limit+1);
  const page=rows.slice(0,x.limit);if(rows.length>x.limit)more=true;
  if(page.length)cursor.after[key]=page.at(-1)!._row;
  result[key]=page.map(({_row,...publicFields})=>publicFields);
 }
 return{...result,page:{limit:x.limit,order:x.order,nextCursor:more?Buffer.from(JSON.stringify(cursor)).toString('base64url'):null}};
}
