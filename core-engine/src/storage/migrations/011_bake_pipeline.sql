CREATE TABLE IF NOT EXISTS bake_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_reason TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    processed_episode_count INTEGER NOT NULL DEFAULT 0,
    auto_created_count INTEGER NOT NULL DEFAULT 0,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    discarded_count INTEGER NOT NULL DEFAULT 0,
    knowledge_created_count INTEGER NOT NULL DEFAULT 0,
    template_created_count INTEGER NOT NULL DEFAULT 0,
    sop_created_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    latency_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bake_runs_started_at ON bake_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_bake_runs_status ON bake_runs(status);

CREATE TABLE IF NOT EXISTS bake_watermarks (
    pipeline_name TEXT PRIMARY KEY,
    last_processed_ts INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

ALTER TABLE bake_templates ADD COLUMN source_capture_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bake_templates ADD COLUMN source_episode_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bake_templates ADD COLUMN match_score REAL;
ALTER TABLE bake_templates ADD COLUMN match_level TEXT;
ALTER TABLE bake_templates ADD COLUMN creation_mode TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE bake_templates ADD COLUMN review_status TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE bake_templates ADD COLUMN evidence_summary TEXT;
ALTER TABLE bake_templates ADD COLUMN generation_version TEXT;
ALTER TABLE bake_templates ADD COLUMN deleted_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_bake_templates_review_status ON bake_templates(review_status);
CREATE INDEX IF NOT EXISTS idx_bake_templates_creation_mode ON bake_templates(creation_mode);
