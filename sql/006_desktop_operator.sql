-- P3: human inputs are distinct from model messages; identity is bound by the host.
CREATE TABLE operator_requests (
  operator_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_json TEXT NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id), PRIMARY KEY(operator_id,idempotency_key)
);
CREATE TABLE operator_messages (
  message_id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  operator_id TEXT NOT NULL, to_node TEXT NOT NULL REFERENCES model_nodes(node_id),
  content TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(operator_id,topic_id,idempotency_key)
);
ALTER TABLE model_turns ADD COLUMN operator_message_id TEXT REFERENCES operator_messages(message_id);
DROP INDEX idx_one_seed_per_topic;
CREATE UNIQUE INDEX idx_one_seed_per_topic ON model_turns(topic_id)
  WHERE input_message_id IS NULL AND operator_message_id IS NULL AND retry_of IS NULL;
CREATE UNIQUE INDEX idx_one_operator_input ON model_turns(operator_message_id)
  WHERE operator_message_id IS NOT NULL AND retry_of IS NULL;
