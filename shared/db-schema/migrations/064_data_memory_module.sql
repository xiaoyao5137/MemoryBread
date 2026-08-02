-- 064: 与文档、知识、操作平级的数据记忆模块。
-- 数据源保存“去哪里取”，快照保存“何时取到了什么”，来源链接保存可追溯证据。

CREATE TABLE IF NOT EXISTS data_sources (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_key         TEXT    NOT NULL UNIQUE,
    title                 TEXT    NOT NULL,
    source_kind           TEXT    NOT NULL CHECK (source_kind IN ('report_url', 'work_memory')),
    source_url            TEXT,
    access_mode           TEXT    NOT NULL DEFAULT 'memory_only'
                                  CHECK (access_mode IN ('browser_session', 'direct_http', 'memory_only')),
    refresh_policy        TEXT    NOT NULL DEFAULT 'never'
                                  CHECK (refresh_policy IN ('on_demand', 'scheduled', 'never')),
    realtime_level        TEXT    NOT NULL DEFAULT 'observed'
                                  CHECK (realtime_level IN ('live', 'observed')),
    source_app_name       TEXT,
    source_window_title   TEXT,
    tags                  TEXT    NOT NULL DEFAULT '[]',
    first_seen_at         INTEGER NOT NULL,
    last_seen_at          INTEGER NOT NULL,
    last_collected_at     INTEGER,
    last_success_at       INTEGER,
    last_error_code       TEXT,
    status                TEXT    NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'unavailable', 'disabled')),
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL,
    deleted_at            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_data_sources_kind_seen
ON data_sources(source_kind, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_sources_status_updated
ON data_sources(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS data_snapshots (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id             INTEGER NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    collected_at          INTEGER NOT NULL,
    observed_at           INTEGER,
    collector             TEXT    NOT NULL
                                  CHECK (collector IN ('browser_attach', 'chrome_attach', 'direct_http', 'memory_extract', 'capture_observation')),
    content_text          TEXT    NOT NULL,
    structured_data       TEXT    NOT NULL DEFAULT '{}',
    content_hash          TEXT    NOT NULL,
    freshness_ttl_seconds INTEGER NOT NULL DEFAULT 0,
    provenance            TEXT    NOT NULL DEFAULT '{}',
    source_capture_ids    TEXT    NOT NULL DEFAULT '[]',
    source_timeline_ids   TEXT    NOT NULL DEFAULT '[]',
    status                TEXT    NOT NULL DEFAULT 'success'
                                  CHECK (status IN ('success', 'partial')),
    created_at            INTEGER NOT NULL,
    UNIQUE(source_id, content_hash, collected_at)
);

CREATE INDEX IF NOT EXISTS idx_data_snapshots_source_collected
ON data_snapshots(source_id, collected_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS data_source_links (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id           INTEGER NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
    source_ref_key      TEXT    NOT NULL UNIQUE,
    capture_id          INTEGER REFERENCES captures(id) ON DELETE SET NULL,
    timeline_id         INTEGER REFERENCES timelines(id) ON DELETE SET NULL,
    link_kind           TEXT    NOT NULL CHECK (link_kind IN ('active_url', 'embedded_url', 'work_memory')),
    observed_at         INTEGER NOT NULL,
    created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_data_source_links_source
ON data_source_links(source_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_data_source_links_timeline
ON data_source_links(timeline_id);

-- 新版本先处理最近采集，再在后续空闲批次向历史回填；游标不属于用户资产。
CREATE TABLE IF NOT EXISTS data_extraction_state (
    singleton_id               INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    newest_capture_id          INTEGER NOT NULL DEFAULT 0,
    backfill_before_capture_id INTEGER,
    updated_at                 INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS data_snapshots_fts USING fts5(
    content_text,
    structured_data,
    content='data_snapshots',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS data_snapshots_fts_insert
AFTER INSERT ON data_snapshots BEGIN
    INSERT INTO data_snapshots_fts(rowid, content_text, structured_data)
    VALUES (new.id, new.content_text, new.structured_data);
END;

CREATE TRIGGER IF NOT EXISTS data_snapshots_fts_update
AFTER UPDATE ON data_snapshots BEGIN
    INSERT INTO data_snapshots_fts(data_snapshots_fts, rowid, content_text, structured_data)
    VALUES ('delete', old.id, old.content_text, old.structured_data);
    INSERT INTO data_snapshots_fts(rowid, content_text, structured_data)
    VALUES (new.id, new.content_text, new.structured_data);
END;

CREATE TRIGGER IF NOT EXISTS data_snapshots_fts_delete
AFTER DELETE ON data_snapshots BEGIN
    INSERT INTO data_snapshots_fts(data_snapshots_fts, rowid, content_text, structured_data)
    VALUES ('delete', old.id, old.content_text, old.structured_data);
END;
