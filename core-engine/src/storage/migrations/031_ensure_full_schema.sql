-- 031_ensure_full_schema.sql
-- 兜底迁移：确保所有表存在。
-- ALTER TABLE 列补全由 Rust 层的 run_ensure_full_schema() 幂等处理，
-- 此文件只放 CREATE TABLE IF NOT EXISTS 等天然幂等的语句。

CREATE INDEX IF NOT EXISTS idx_captures_url ON captures(url);
CREATE INDEX IF NOT EXISTS idx_captures_timeline ON captures(timeline_id);

CREATE TABLE IF NOT EXISTS privacy_block_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_type       TEXT NOT NULL,
    target_id       TEXT NOT NULL,
    block_count     INTEGER NOT NULL DEFAULT 0,
    week_start      TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(stat_type, target_id, week_start)
);
CREATE INDEX IF NOT EXISTS idx_privacy_stats_week ON privacy_block_stats(week_start);

CREATE TABLE IF NOT EXISTS app_blacklist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id  TEXT    NOT NULL UNIQUE,
    app_name   TEXT    NOT NULL DEFAULT '',
    enabled    INTEGER NOT NULL DEFAULT 1,
    reason     TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS privacy_filters (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filter_type TEXT    NOT NULL UNIQUE,
    filter_name TEXT    NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    config_json TEXT,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bake_retry_state (
    timeline_id       INTEGER PRIMARY KEY,
    failure_count     INTEGER NOT NULL DEFAULT 0,
    last_error        TEXT,
    last_failed_at_ms INTEGER NOT NULL,
    FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bake_retry_state_count ON bake_retry_state(failure_count);

CREATE TABLE IF NOT EXISTS bake_documents (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    title                TEXT    NOT NULL,
    doc_type             TEXT    NOT NULL DEFAULT 'article',
    status               TEXT    NOT NULL DEFAULT 'draft',
    tags                 TEXT    NOT NULL DEFAULT '[]',
    applicable_tasks     TEXT    NOT NULL DEFAULT '[]',
    source_memory_ids    TEXT    NOT NULL DEFAULT '[]',
    source_capture_ids   TEXT    NOT NULL DEFAULT '[]',
    source_episode_ids   TEXT    NOT NULL DEFAULT '[]',
    linked_knowledge_ids TEXT    NOT NULL DEFAULT '[]',
    sections_json        TEXT    NOT NULL DEFAULT '[]',
    style_phrases        TEXT    NOT NULL DEFAULT '[]',
    replacement_rules    TEXT    NOT NULL DEFAULT '[]',
    summary              TEXT,
    full_content         TEXT,
    structured_content   TEXT    NOT NULL DEFAULT '{}',
    prompt_hint          TEXT,
    diagram_code         TEXT,
    image_assets         TEXT    NOT NULL DEFAULT '[]',
    source_app_name      TEXT,
    source_win_title     TEXT,
    source_url           TEXT,
    content_hash         TEXT,
    language             TEXT,
    usage_count          INTEGER NOT NULL DEFAULT 0,
    match_score          REAL,
    match_level          TEXT,
    creation_mode        TEXT    NOT NULL DEFAULT 'manual',
    review_status        TEXT    NOT NULL DEFAULT 'draft',
    evidence_summary     TEXT,
    generation_version   TEXT,
    deleted_at           INTEGER,
    created_at           INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at           INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE TABLE IF NOT EXISTS bake_document_sections (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id   INTEGER NOT NULL REFERENCES bake_documents(id) ON DELETE CASCADE,
    section_index INTEGER NOT NULL,
    section_path  TEXT    NOT NULL DEFAULT '[]',
    title         TEXT,
    content       TEXT,
    content_hash  TEXT,
    created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_bake_documents_status ON bake_documents(status);
CREATE INDEX IF NOT EXISTS idx_bake_documents_updated_at ON bake_documents(updated_at);
CREATE INDEX IF NOT EXISTS idx_bake_document_sections_document_id ON bake_document_sections(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS bake_documents_fts USING fts5(
    title, doc_type, summary, full_content, sections_json, structured_content, prompt_hint,
    content='bake_documents', content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS bake_document_sections_fts USING fts5(
    title, content, section_path,
    content='bake_document_sections', content_rowid='id'
);
