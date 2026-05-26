CREATE TABLE IF NOT EXISTS bake_retry_state (
  timeline_id        INTEGER PRIMARY KEY,
  failure_count      INTEGER NOT NULL DEFAULT 0,
  last_error         TEXT,
  last_failed_at_ms  INTEGER NOT NULL,
  FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bake_retry_state_count
  ON bake_retry_state(failure_count);
