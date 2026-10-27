import {z} from 'zod';
import {DmnStore} from './store.ts';
import {DmnGateway} from './gateway.ts';
import {TopicRunner,type RootRuntime,type RuntimeInput,type Inspection} from './runner.ts';
import {decodeModelOutput} from './model-output.ts';
import {fail} from './errors.ts';

const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const turnRef=z.strictObject({turnId:id});
const dropRequest=turnRef.extend({confirmTurnId:id,reason:z.string().trim().min(1).max(500)});
function checked<T>(schema:z.ZodType<T>,input:unknown):T{const p=schema.safeParse(input);if(!p.success)fail('VALIDATION','Invalid recovery request.');return p.data;}
export class RecoveryManager{
 private readonly runner:TopicRunner;
 constructor(private readonly store:DmnStore,private readonly runtime:RootRuntime,private readonly now:()=>Date=()=>new Date(),private readonly operator:'cli-user'|'desktop-user'='cli-user'){
  this.runner=new TopicRunner(store,new DmnGateway(store,now),runtime,now);
 }
 list(){return this.store.all("SELECT t.turn_id AS turnId,t.node_id AS nodeId,t.topic_id AS topicId,t.status,t.attempt_number AS attempt,l.state AS lockState,l.lease_until AS leaseUntil FROM model_turns t LEFT JOIN node_locks l ON l.turn_id=t.turn_id WHERE t.status IN ('unknown','running') ORDER BY t.rowid LIMIT 100");}
 async inspect(input:unknown){
  const {turnId}=checked(turnRef,input);
  const turn=this.store.one<{turn_id:string;node_id:string;topic_id:string;sdk_session_id:string;status:string;sdk_receipt_id:string|null;attempt_number:number;input_snapshot_json:string|null}>('SELECT * FROM model_turns WHERE turn_id=?',turnId);
  if(!turn)fail('NOT_FOUND','Turn does not exist.');
  const cached=this.store.one<{result_json:string}>('SELECT result_json FROM runtime_results WHERE turn_id=? AND node_id=?',turnId,turn.node_id);
  let proof:Inspection={state:'unknown',reason:'NO_INSPECTOR',quiescent:false};
  if(cached){try{proof={state:'completed',receiptId:turn.sdk_receipt_id??'',result:JSON.parse(cached.result_json)};}catch{fail('STORAGE','Stored result is unreadable.');}}
  else if(turn.input_snapshot_json&&this.runtime.inspect){
   const snapshot=JSON.parse(turn.input_snapshot_json) as RuntimeInput;
   if(snapshot.turnId!==turnId||snapshot.node.id!==turn.node_id||snapshot.node.sessionId!==turn.sdk_session_id)fail('FORBIDDEN','Execution snapshot identity mismatch.');
   proof=await this.runtime.inspect(snapshot,turn.sdk_receipt_id);
  }
  const publicProof=proof.state==='completed'?{state:'completed',sessionMatches:proof.result.sessionId===turn.sdk_session_id,validEnvelope:decodeModelOutput(proof.result.text).success,effectsEvaluated:false}:
   {state:'unknown',reason:/^[A-Z0-9_]{1,80}$/.test(proof.reason)?proof.reason:'UNCLASSIFIED',quiescent:proof.quiescent};
  return{turnId,nodeId:turn.node_id,topicId:turn.topic_id,status:turn.status,attempt:turn.attempt_number,hasReceipt:!!turn.sdk_receipt_id,cached:!!cached,
   lock:this.store.one('SELECT state,lease_until AS leaseUntil FROM node_locks WHERE turn_id=?',turnId)??null,proof:publicProof};
 }
 quarantineExpired(){
  return this.store.transaction(()=>{
   const turns=this.store.all<{turn_id:string;node_id:string;topic_id:string;input_message_id:string|null}>("SELECT t.* FROM model_turns t JOIN node_locks l ON l.turn_id=t.turn_id WHERE t.status='running' AND l.state='running' AND l.lease_until<=?",this.now().toISOString());
   for(const t of turns){
    const stamp=this.now().toISOString();this.store.run("UPDATE model_turns SET status='unknown',finished_at=? WHERE turn_id=?",stamp,t.turn_id);
    this.store.run("UPDATE node_locks SET state='quarantined' WHERE turn_id=?",t.turn_id);
    this.store.run("UPDATE model_nodes SET status='cooling' WHERE node_id=?",t.node_id);
    this.store.run("UPDATE delivery_attempts SET outcome='unknown',error_code='LEASE_EXPIRED',finished_at=? WHERE turn_id=?",stamp,t.turn_id);
    if(t.input_message_id)this.store.run("UPDATE deliveries SET status='unknown',last_error='RECONCILE_REQUIRED',updated_at=? WHERE message_id=?",stamp,t.input_message_id);
    this.store.run("INSERT INTO events(event_type,topic_id,node_id,payload_json,created_at) VALUES('turn.lease_quarantined',?,?,?,?)",t.topic_id,t.node_id,JSON.stringify({turnId:t.turn_id,operator:this.operator}),stamp);
   }
   return{quarantined:turns.length,inferenceStarted:false};
  });
 }
 async reconcile(input:unknown){const {turnId}=checked(turnRef,input);return this.runner.reconcile(turnId,'inspect',{operator:this.operator,reason:'Explicit operator proof reconciliation'});}
 async drop(input:unknown){
  const x=checked(dropRequest,input);if(x.confirmTurnId!==x.turnId)fail('VALIDATION','Confirm the exact turn ID before dropping.');
  return this.runner.reconcile(x.turnId,'drop',{operator:this.operator,reason:x.reason});
 }
}

export function readMetrics(store:DmnStore,input:unknown={},now:()=>Date=()=>new Date()){
 return store.readSnapshot(()=>metricsSnapshot(store,input,now));
}
function metricsSnapshot(store:DmnStore,input:unknown,now:()=>Date){
 const {topicId}=checked(z.strictObject({topicId:id.optional()}),input);if(topicId&&!store.one('SELECT 1 FROM topics WHERE topic_id=?',topicId))fail('NOT_FOUND','Topic does not exist.');
 const where=topicId?' WHERE topic_id=?':'',args=topicId?[topicId]:[];
 const turns=store.iterate<{status:string;usage_json:string|null;started_at:string;finished_at:string|null;queue_created_at:string|null;attempt_number:number;attempted:number}>(`SELECT t.status,COALESCE(json_extract(r.result_json,'$.usage'),t.usage_json) AS usage_json,t.started_at,t.finished_at,COALESCE(t.queue_created_at,m.created_at) AS queue_created_at,t.attempt_number,a.turn_id IS NOT NULL AS attempted FROM model_turns t LEFT JOIN runtime_results r ON r.turn_id=t.turn_id LEFT JOIN messages m ON m.message_id=t.input_message_id LEFT JOIN delivery_attempts a ON a.turn_id=t.turn_id${topicId?' WHERE t.topic_id=?':''}`,...args);
 const counts={queued:0,running:0,completed:0,failed:0,unknown:0};let actualInput=0,actualOutput=0,withUsage=0,withoutUsage=0,retryAttempts=0;
 const latency={samples:0,total:0,max:0},duration={samples:0,total:0,max:0};let attempted=0,attemptedFailures=0;
 const record=(summary:typeof latency,value:number)=>{if(Number.isFinite(value)){summary.samples++;summary.total+=value;summary.max=Math.max(summary.max,value);}};
 for(const t of turns){counts[t.status as keyof typeof counts]++;if(t.attempted&&t.attempt_number>1)retryAttempts++;
  if(t.attempted){attempted++;if(t.status==='failed')attemptedFailures++;
   let u:{inputTokens?:number;outputTokens?:number}={};try{u=JSON.parse(t.usage_json??'{}');}catch{}
   if(Number.isFinite(u?.inputTokens)&&Number.isFinite(u?.outputTokens)){actualInput+=u.inputTokens!;actualOutput+=u.outputTokens!;withUsage++;}else withoutUsage++;
   if(t.queue_created_at)record(latency,Math.max(0,Date.parse(t.started_at)-Date.parse(t.queue_created_at)));
   if(t.finished_at)record(duration,Math.max(0,Date.parse(t.finished_at)-Date.parse(t.started_at)));
  }
 }
 const summary=(value:typeof latency)=>({samples:value.samples,meanMs:value.samples?value.total/value.samples:null,maxMs:value.samples?value.max:null});
 const reserved=store.one<{inputTokens:number;outputTokens:number;estimatedCost:number}>(`SELECT COALESCE(sum(reserved_input_tokens),0) AS inputTokens,COALESCE(sum(reserved_output_tokens),0) AS outputTokens,COALESCE(sum(reserved_cost),0) AS estimatedCost FROM topic_execution${where}`,...args)!;
 const deliveries=store.all(`SELECT d.status,count(*) AS count FROM deliveries d JOIN messages m ON m.message_id=d.message_id${topicId?' WHERE m.topic_id=?':''} GROUP BY d.status`,...args);
 const oldest=store.one<{stamp:string|null}>(`SELECT min(stamp) stamp FROM (SELECT m.created_at stamp FROM deliveries d JOIN messages m ON m.message_id=d.message_id WHERE d.status IN ('queued','retry')${topicId?' AND m.topic_id=?':''} UNION ALL SELECT COALESCE(queue_created_at,started_at) FROM model_turns WHERE status='queued'${topicId?' AND topic_id=?':''})`,...(topicId?[topicId,topicId]:[]))?.stamp;
 return{asOf:now().toISOString(),turns:counts,deliveries,retryAttempts,failureRate:attempted?attemptedFailures/attempted:null,unknownRate:attempted?counts.unknown/attempted:null,
  oldestQueuedAgeMs:oldest?Math.max(0,now().getTime()-Date.parse(oldest)):null,queueLatency:summary(latency),observedDuration:summary(duration),
  reserved,tokens:{actualInput,actualOutput,withUsage,withoutUsage,complete:withoutUsage===0},actualCost:null};
}
