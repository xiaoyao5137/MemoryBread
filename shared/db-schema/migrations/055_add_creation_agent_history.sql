ALTER TABLE creation_history ADD COLUMN session_id TEXT;
ALTER TABLE creation_history ADD COLUMN conversation_json TEXT;
ALTER TABLE creation_history ADD COLUMN agent_trace_json TEXT;
ALTER TABLE creation_history ADD COLUMN goal_json TEXT;

CREATE INDEX IF NOT EXISTS idx_creation_history_session
    ON creation_history(session_id, created_at DESC);
