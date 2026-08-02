-- 066: 创作证据截图与“每个数据源只保留最新快照”契约。

BEGIN IMMEDIATE;

-- 数据面板以 data_sources 为稳定数据项；同一数据项只保留最近一次采集结果。
DELETE FROM data_snapshots
WHERE id NOT IN (
    SELECT latest.id
    FROM data_snapshots latest
    WHERE latest.id = (
        SELECT candidate.id
        FROM data_snapshots candidate
        WHERE candidate.source_id = latest.source_id
        ORDER BY candidate.collected_at DESC, candidate.id DESC
        LIMIT 1
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_data_snapshots_single_latest
ON data_snapshots(source_id);

ALTER TABLE creation_history ADD COLUMN evidence_json TEXT;

CREATE TABLE IF NOT EXISTS creation_evidence_assets (
    id                  TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL,
    session_id          TEXT NOT NULL,
    history_id          INTEGER REFERENCES creation_history(id) ON DELETE SET NULL,
    source_id           INTEGER REFERENCES data_sources(id) ON DELETE SET NULL,
    data_snapshot_id    INTEGER REFERENCES data_snapshots(id) ON DELETE SET NULL,
    source_url          TEXT NOT NULL,
    page_title          TEXT NOT NULL,
    captured_at         INTEGER NOT NULL,
    image_path          TEXT NOT NULL,
    mime_type           TEXT NOT NULL DEFAULT 'image/jpeg',
    width               INTEGER NOT NULL,
    height              INTEGER NOT NULL,
    content_hash        TEXT NOT NULL,
    screenshot_source   TEXT NOT NULL,
    validation_status   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (validation_status IN ('pending', 'verified', 'rejected')),
    validation_json     TEXT NOT NULL DEFAULT '{}',
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_creation_evidence_run
ON creation_evidence_assets(run_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_creation_evidence_history
ON creation_evidence_assets(history_id, captured_at DESC);

COMMIT;
