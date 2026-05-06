-- 创建 bake_designs 表
CREATE TABLE IF NOT EXISTS bake_designs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    title               TEXT    NOT NULL,
    summary             TEXT    NOT NULL,
    content             TEXT    NOT NULL,
    design_type         TEXT,
    status              TEXT,
    tags                TEXT    NOT NULL DEFAULT '[]',
    key_decisions       TEXT    NOT NULL DEFAULT '[]',
    technologies        TEXT    NOT NULL DEFAULT '[]',
    entities            TEXT    NOT NULL DEFAULT '[]',
    diagram_code        TEXT,
    source_capture_ids  TEXT    NOT NULL DEFAULT '[]',
    source_episode_ids  TEXT    NOT NULL DEFAULT '[]',
    match_score         REAL,
    match_level         TEXT,
    creation_mode       TEXT    NOT NULL DEFAULT 'manual',
    review_status       TEXT    NOT NULL DEFAULT 'draft',
    evidence_summary    TEXT,
    generation_version  TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    deleted_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bake_designs_review_status ON bake_designs(review_status);
CREATE INDEX IF NOT EXISTS idx_bake_designs_created_at ON bake_designs(created_at);
CREATE INDEX IF NOT EXISTS idx_bake_designs_deleted_at ON bake_designs(deleted_at);

-- 创建 FTS 表
CREATE VIRTUAL TABLE IF NOT EXISTS bake_designs_fts USING fts5(
    title,
    summary,
    content,
    entities,
    content='bake_designs',
    content_rowid='id'
);

-- FTS 触发器
CREATE TRIGGER IF NOT EXISTS bake_designs_fts_insert AFTER INSERT ON bake_designs BEGIN
    INSERT INTO bake_designs_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS bake_designs_fts_delete AFTER DELETE ON bake_designs BEGIN
    DELETE FROM bake_designs_fts WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS bake_designs_fts_update AFTER UPDATE ON bake_designs BEGIN
    DELETE FROM bake_designs_fts WHERE rowid = old.id;
    INSERT INTO bake_designs_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;
