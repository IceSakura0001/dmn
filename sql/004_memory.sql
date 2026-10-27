-- P1: provenance, optimistic revisions, pending conflicts and idempotent turn batches.
ALTER TABLE memories ADD COLUMN claim_key TEXT;
ALTER TABLE memories ADD COLUMN content_key TEXT NOT NULL DEFAULT '';
ALTER TABLE memories ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'legacy' CHECK(provenance IN ('legacy','human','candidate'));
ALTER TABLE memory_revisions ADD COLUMN prior_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE memory_revisions ADD COLUMN new_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_memory_dedup ON memories(owner_node_id,kind,content_key,archived_at);
CREATE INDEX idx_memory_claim ON memories(owner_node_id,kind,claim_key,archived_at);
CREATE TABLE memory_candidates (
  candidate_id TEXT PRIMARY KEY,
  owner_node_id TEXT NOT NULL REFERENCES model_nodes(node_id),
  memory_id TEXT NOT NULL REFERENCES memories(memory_id),
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  status TEXT NOT NULL CHECK(status IN ('conflict','resolved')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_memory_candidates_owner ON memory_candidates(owner_node_id,status);
CREATE TABLE turn_memory_batches (
  turn_id TEXT PRIMARY KEY REFERENCES model_turns(turn_id),
  owner_node_id TEXT NOT NULL REFERENCES model_nodes(node_id),
  results_json TEXT NOT NULL CHECK(json_valid(results_json))
);

-- unicode61 treats an uninterrupted Chinese sentence as one token.
-- Trigrams support substring matching; the service handles queries shorter than 3 characters.
DROP TRIGGER memories_ai;
DROP TRIGGER memories_ad;
DROP TRIGGER memories_au;
DROP TABLE memories_fts;
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid,content) VALUES(new.rowid,new.content);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts,rowid,content) VALUES('delete',old.rowid,old.content);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts,rowid,content) VALUES('delete',old.rowid,old.content);
  INSERT INTO memories_fts(rowid,content) VALUES(new.rowid,new.content);
END;
INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
