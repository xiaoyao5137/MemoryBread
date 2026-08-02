-- 065: 修复早期数据模块草案已创建 data_snapshots 时，064 的
-- CREATE TABLE IF NOT EXISTS 无法扩展 collector CHECK 的升级兼容问题。

BEGIN IMMEDIATE;

DROP TRIGGER IF EXISTS data_snapshots_fts_insert;
DROP TRIGGER IF EXISTS data_snapshots_fts_update;
DROP TRIGGER IF EXISTS data_snapshots_fts_delete;
DROP TABLE IF EXISTS data_snapshots_fts;

CREATE TABLE data_snapshots_v2 (
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

INSERT INTO data_snapshots_v2 (
    id, source_id, collected_at, observed_at, collector, content_text,
    structured_data, content_hash, freshness_ttl_seconds, provenance,
    source_capture_ids, source_timeline_ids, status, created_at
)
SELECT
    id, source_id, collected_at, observed_at, collector, content_text,
    structured_data, content_hash, freshness_ttl_seconds, provenance,
    source_capture_ids, source_timeline_ids, status, created_at
FROM data_snapshots;

DROP TABLE data_snapshots;
ALTER TABLE data_snapshots_v2 RENAME TO data_snapshots;

CREATE INDEX idx_data_snapshots_source_collected
ON data_snapshots(source_id, collected_at DESC, id DESC);

CREATE VIRTUAL TABLE data_snapshots_fts USING fts5(
    content_text,
    structured_data,
    content='data_snapshots',
    content_rowid='id',
    tokenize='unicode61'
);

CREATE TRIGGER data_snapshots_fts_insert
AFTER INSERT ON data_snapshots BEGIN
    INSERT INTO data_snapshots_fts(rowid, content_text, structured_data)
    VALUES (new.id, new.content_text, new.structured_data);
END;

CREATE TRIGGER data_snapshots_fts_update
AFTER UPDATE ON data_snapshots BEGIN
    INSERT INTO data_snapshots_fts(data_snapshots_fts, rowid, content_text, structured_data)
    VALUES ('delete', old.id, old.content_text, old.structured_data);
    INSERT INTO data_snapshots_fts(rowid, content_text, structured_data)
    VALUES (new.id, new.content_text, new.structured_data);
END;

CREATE TRIGGER data_snapshots_fts_delete
AFTER DELETE ON data_snapshots BEGIN
    INSERT INTO data_snapshots_fts(data_snapshots_fts, rowid, content_text, structured_data)
    VALUES ('delete', old.id, old.content_text, old.structured_data);
END;

INSERT INTO data_snapshots_fts(data_snapshots_fts) VALUES ('rebuild');

COMMIT;
