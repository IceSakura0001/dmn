-- DMN schema v2: preserve the node tool allowlist across process restarts.
-- Existing v1 nodes default to no tools until explicitly reviewed by an operator.
ALTER TABLE model_nodes ADD COLUMN allowed_tools_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(allowed_tools_json) AND json_type(allowed_tools_json) = 'array');
