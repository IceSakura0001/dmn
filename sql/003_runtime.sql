-- P0 runtime safety floor: bounded authorizations, durable single-writer locks.
CREATE TABLE topic_execution (
  topic_id TEXT PRIMARY KEY REFERENCES topics(topic_id),
  limits_json TEXT NOT NULL CHECK(json_valid(limits_json)),
  reserved_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_input_tokens >= 0),
  reserved_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(reserved_output_tokens >= 0),
  reserved_cost REAL NOT NULL DEFAULT 0 CHECK(reserved_cost >= 0)
);
CREATE TABLE node_locks (
  node_id TEXT PRIMARY KEY REFERENCES model_nodes(node_id),
  turn_id TEXT NOT NULL UNIQUE REFERENCES model_turns(turn_id),
  owner TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('running','quarantined'))
);
CREATE UNIQUE INDEX idx_one_seed_per_topic ON model_turns(topic_id) WHERE input_message_id IS NULL;
CREATE UNIQUE INDEX idx_one_live_turn_per_node ON model_turns(node_id) WHERE status='running';
