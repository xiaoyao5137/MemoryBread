CREATE TABLE IF NOT EXISTS knowledge_entries (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id          INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    summary             TEXT    NOT NULL,
    overview            TEXT,
    details             TEXT,
    entities            TEXT,
    category            TEXT,
    importance          INTEGER NOT NULL DEFAULT 3,
    occurrence_count    INTEGER NOT NULL DEFAULT 1,
    user_verified       INTEGER NOT NULL DEFAULT 0,
    user_edited         INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    capture_ids         TEXT,
    start_time          INTEGER,
    end_time            INTEGER,
    duration_minutes    INTEGER,
    frag_app_name       TEXT,
    frag_win_title      TEXT,
    observed_at         INTEGER,
    event_time_start    INTEGER,
    event_time_end      INTEGER,
    history_view        INTEGER NOT NULL DEFAULT 0,
    content_origin      TEXT,
    activity_type       TEXT,
    is_self_generated   INTEGER NOT NULL DEFAULT 0,
    evidence_strength   TEXT
);

CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_entries(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_capture_id ON knowledge_entries(capture_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_updated_at ON knowledge_entries(updated_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_time ON knowledge_entries(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_knowledge_app ON knowledge_entries(frag_app_name);
CREATE INDEX IF NOT EXISTS idx_knowledge_observed_at ON knowledge_entries(observed_at);
CREATE INDEX IF NOT EXISTS idx_knowledge_event_time ON knowledge_entries(event_time_start, event_time_end);
CREATE INDEX IF NOT EXISTS idx_knowledge_activity_type ON knowledge_entries(activity_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_history_view ON knowledge_entries(history_view);
CREATE INDEX IF NOT EXISTS idx_knowledge_self_generated ON knowledge_entries(is_self_generated);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
    overview,
    details,
    entities,
    content='knowledge_entries',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_entries BEGIN
    INSERT INTO knowledge_fts(rowid, overview, details, entities)
    VALUES (new.id, new.overview, new.details, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_entries BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, overview, details, entities)
    VALUES ('delete', old.id, old.overview, old.details, old.entities);
    INSERT INTO knowledge_fts(rowid, overview, details, entities)
    VALUES (new.id, new.overview, new.details, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_entries BEGIN
    INSERT INTO knowledge_fts(knowledge_fts, rowid, overview, details, entities)
    VALUES ('delete', old.id, old.overview, old.details, old.entities);
END;