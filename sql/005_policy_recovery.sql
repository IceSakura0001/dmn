-- P2: per-node reservations, attempt history, bounded retry and control fencing.
ALTER TABLE topics ADD COLUMN control_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topics ADD COLUMN pause_reason TEXT;
ALTER TABLE deliveries ADD COLUMN next_attempt_at TEXT;
ALTER TABLE model_turns ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE model_turns ADD COLUMN retry_of TEXT REFERENCES model_turns(turn_id);
ALTER TABLE model_turns ADD COLUMN ready_at TEXT;
ALTER TABLE model_turns ADD COLUMN topic_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE model_turns ADD COLUMN input_snapshot_json TEXT;
ALTER TABLE model_turns ADD COLUMN queue_created_at TEXT;
DROP INDEX idx_one_seed_per_topic;
CREATE UNIQUE INDEX idx_one_seed_per_topic ON model_turns(topic_id) WHERE input_message_id IS NULL AND retry_of IS NULL;
CREATE TABLE node_budgets (
  topic_id TEXT NOT NULL REFERENCES topics(topic_id), node_id TEXT NOT NULL REFERENCES model_nodes(node_id),
  max_turns INTEGER NOT NULL, max_input_tokens INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL,
  max_cost REAL NOT NULL, deadline_at TEXT NOT NULL,
  used_turns INTEGER NOT NULL DEFAULT 0, reserved_input_tokens INTEGER NOT NULL DEFAULT 0,
  reserved_output_tokens INTEGER NOT NULL DEFAULT 0, reserved_cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(topic_id,node_id)
);
CREATE TABLE delivery_attempts (
  turn_id TEXT PRIMARY KEY REFERENCES model_turns(turn_id), job_key TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number>0),
  outcome TEXT NOT NULL CHECK(outcome IN ('running','completed','failed','unknown','reconciled','dropped')),
  error_code TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE(job_key,attempt_number)
);
CREATE TABLE dead_letters (
  job_key TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES model_turns(turn_id),
  topic_id TEXT NOT NULL REFERENCES topics(topic_id), node_id TEXT NOT NULL REFERENCES model_nodes(node_id),
  message_id TEXT REFERENCES messages(message_id), error_code TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE runtime_results (
  turn_id TEXT PRIMARY KEY REFERENCES model_turns(turn_id), node_id TEXT NOT NULL REFERENCES model_nodes(node_id),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL
);
CREATE INDEX idx_retry_due ON deliveries(status,next_attempt_at);
