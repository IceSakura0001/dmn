-- DMN SQLite Schema v1.0. Application enforces cross-table policy checks.
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS model_nodes (
  node_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  session_id TEXT NOT NULL UNIQUE,
  persona_ref TEXT NOT NULL,
  memory_namespace TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'sleeping'
    CHECK (status IN ('sleeping','queued','running','cooling')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS topics (
  topic_id TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  title TEXT NOT NULL,
  initial_prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','waiting','paused','closed')),
  max_model_turns INTEGER NOT NULL CHECK (max_model_turns > 0),
  max_turns_per_node INTEGER NOT NULL CHECK (max_turns_per_node > 0),
  used_model_turns INTEGER NOT NULL DEFAULT 0 CHECK (used_model_turns >= 0),
  deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS topic_participants (
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  node_id TEXT NOT NULL REFERENCES model_nodes(node_id),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (topic_id, node_id)
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  from_node TEXT NOT NULL REFERENCES model_nodes(node_id),
  to_node TEXT NOT NULL REFERENCES model_nodes(node_id),
  type TEXT NOT NULL CHECK (type IN ('chat','question','reply')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  reply_to TEXT REFERENCES messages(message_id),
  expect_reply INTEGER NOT NULL DEFAULT 0 CHECK (expect_reply IN (0,1)),
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  UNIQUE (from_node, topic_id, idempotency_key),
  CHECK (from_node <> to_node)
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(message_id),
  recipient_node TEXT NOT NULL REFERENCES model_nodes(node_id),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','leased','delivered','handled','retry','unknown','dead_letter','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until TEXT,
  sdk_receipt_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_turns (
  turn_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  node_id TEXT NOT NULL REFERENCES model_nodes(node_id),
  input_message_id TEXT REFERENCES messages(message_id),
  sdk_session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','unknown')),
  sdk_receipt_id TEXT,
  event_offset INTEGER,
  usage_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS memories (
  memory_id TEXT PRIMARY KEY,
  owner_node_id TEXT NOT NULL REFERENCES model_nodes(node_id),
  kind TEXT NOT NULL CHECK (kind IN ('identity','episodic','semantic','relationship')),
  content TEXT NOT NULL,
  subjective INTEGER NOT NULL DEFAULT 0 CHECK (subjective IN (0,1)),
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  source_message_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  revision_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(memory_id),
  prior_content TEXT NOT NULL,
  new_content TEXT NOT NULL,
  reason TEXT NOT NULL,
  revised_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  topic_id TEXT,
  node_id TEXT,
  message_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_messages_topic_time ON messages(topic_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deliveries_status_lease ON deliveries(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_turns_node_topic ON model_turns(node_id, topic_id);
CREATE INDEX IF NOT EXISTS idx_memories_owner_kind ON memories(owner_node_id, kind, archived_at);
CREATE INDEX IF NOT EXISTS idx_events_topic ON events(topic_id, event_seq);

-- External-content FTS5 index. Owner filter is still mandatory on joins against memories.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, content='memories', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

