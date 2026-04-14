DROP TRIGGER IF EXISTS knowledge_ai;
DROP TRIGGER IF EXISTS knowledge_au;
DROP TRIGGER IF EXISTS knowledge_ad;
DROP TABLE IF EXISTS knowledge_fts;

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
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

INSERT INTO knowledge_fts(knowledge_fts) VALUES ('rebuild');
