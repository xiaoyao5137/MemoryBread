-- 本地集成 Skill 的可审计执行记录与增量导入索引。

CREATE TABLE IF NOT EXISTS integration_skill_runs (
    id              TEXT PRIMARY KEY,
    skill_id        TEXT NOT NULL,
    mode            TEXT NOT NULL,
    status          TEXT NOT NULL,
    input_summary   TEXT NOT NULL DEFAULT '{}',
    result_json     TEXT,
    logs_json       TEXT NOT NULL DEFAULT '[]',
    error_code      TEXT,
    error_message   TEXT,
    created_at_ms   INTEGER NOT NULL,
    started_at_ms   INTEGER,
    finished_at_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_integration_skill_runs_skill
    ON integration_skill_runs(skill_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_integration_skill_runs_status
    ON integration_skill_runs(status, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS integration_import_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id        TEXT NOT NULL,
    source_key      TEXT NOT NULL,
    source_path     TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    capture_id      INTEGER NOT NULL,
    timeline_id     INTEGER NOT NULL,
    metadata_json   TEXT NOT NULL DEFAULT '{}',
    created_at_ms   INTEGER NOT NULL,
    updated_at_ms   INTEGER NOT NULL,
    UNIQUE(skill_id, source_key),
    FOREIGN KEY (capture_id) REFERENCES captures(id),
    FOREIGN KEY (timeline_id) REFERENCES timelines(id)
);

CREATE INDEX IF NOT EXISTS idx_integration_import_items_skill
    ON integration_import_items(skill_id, updated_at_ms DESC);

INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES (
    '067_integration_skill_runs',
    CAST(strftime('%s', 'now') * 1000 AS INTEGER)
);
