-- P4: direct chat is explicitly authorized; replies never create peer deliveries.
ALTER TABLE topics ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'discussion'
  CHECK(interaction_mode IN ('discussion','direct'));
ALTER TABLE model_turns ADD COLUMN output_action TEXT;
ALTER TABLE model_turns ADD COLUMN effects_suppressed INTEGER NOT NULL DEFAULT 0;
CREATE TABLE user_replies (
  message_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  from_node TEXT NOT NULL REFERENCES model_nodes(node_id),
  operator_id TEXT NOT NULL,
  reply_to TEXT NOT NULL UNIQUE REFERENCES operator_messages(message_id),
  turn_id TEXT NOT NULL UNIQUE REFERENCES model_turns(turn_id),
  content TEXT NOT NULL CHECK(length(trim(content)) BETWEEN 1 AND 8000),
  created_at TEXT NOT NULL
);
CREATE TRIGGER user_reply_binding BEFORE INSERT ON user_replies BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM model_turns t JOIN operator_messages m ON m.message_id=t.operator_message_id
    WHERE t.turn_id=new.turn_id AND t.node_id=new.from_node AND t.topic_id=new.topic_id
      AND m.message_id=new.reply_to AND m.to_node=new.from_node AND m.topic_id=new.topic_id
      AND m.operator_id=new.operator_id AND t.status IN ('running','unknown')
      AND EXISTS(SELECT 1 FROM node_locks l WHERE l.turn_id=t.turn_id AND l.state='running')
  ) THEN RAISE(ABORT,'Invalid user reply binding') END;
END;
CREATE INDEX idx_user_replies_topic ON user_replies(topic_id,created_at);
