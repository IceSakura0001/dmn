import { DmnStore } from './store.ts';
export function refreshNodeState(store:DmnStore,nodeId:string,now:string){
  const lock=store.one<{state:string}>('SELECT state FROM node_locks WHERE node_id=?',nodeId);
  if(lock){store.run('UPDATE model_nodes SET status=? WHERE node_id=?',lock.state==='running'?'running':'cooling',nodeId);return;}
  const head=store.one<{ready_at:string|null}>(`SELECT CASE WHEN d.status='retry' THEN d.next_attempt_at ELSE NULL END AS ready_at,m.created_at AS sort_time,m.rowid AS queue_order,1 AS kind_order
    FROM deliveries d JOIN messages m ON m.message_id=d.message_id JOIN topics t ON t.topic_id=m.topic_id WHERE d.recipient_node=? AND t.status IN ('active','waiting') AND d.status IN ('queued','retry')
    UNION ALL SELECT s.ready_at,COALESCE(s.queue_created_at,s.started_at),s.rowid,0 FROM model_turns s JOIN topics t ON t.topic_id=s.topic_id WHERE s.node_id=? AND s.status='queued' AND t.status IN ('active','waiting') ORDER BY sort_time,kind_order,queue_order LIMIT 1`,nodeId,nodeId);
  const due=head&&(!head.ready_at||head.ready_at<=now);
  const pending=store.one("SELECT 1 FROM deliveries WHERE recipient_node=? AND status IN ('queued','retry') UNION ALL SELECT 1 FROM model_turns WHERE node_id=? AND status='queued' LIMIT 1",nodeId,nodeId);
  store.run('UPDATE model_nodes SET status=? WHERE node_id=?',due?'queued':pending?'cooling':'sleeping',nodeId);
}
