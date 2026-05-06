-- 016_fix_split_tables_fts_triggers.sql
-- 修复 split tables 的 external-content FTS5 触发器

DROP TRIGGER IF EXISTS episodic_memories_fts_insert;
DROP TRIGGER IF EXISTS episodic_memories_fts_update;
DROP TRIGGER IF EXISTS episodic_memories_fts_delete;

DROP TRIGGER IF EXISTS bake_articles_fts_insert;
DROP TRIGGER IF EXISTS bake_articles_fts_update;
DROP TRIGGER IF EXISTS bake_articles_fts_delete;

DROP TRIGGER IF EXISTS bake_knowledge_fts_insert;
DROP TRIGGER IF EXISTS bake_knowledge_fts_update;
DROP TRIGGER IF EXISTS bake_knowledge_fts_delete;

DROP TRIGGER IF EXISTS bake_sops_fts_insert;
DROP TRIGGER IF EXISTS bake_sops_fts_update;
DROP TRIGGER IF EXISTS bake_sops_fts_delete;

CREATE TRIGGER IF NOT EXISTS episodic_memories_fts_insert AFTER INSERT ON episodic_memories BEGIN
    INSERT INTO episodic_memories_fts(rowid, summary, overview, details, entities)
    VALUES (new.id, new.summary, new.overview, new.details, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS episodic_memories_fts_update AFTER UPDATE ON episodic_memories BEGIN
    INSERT INTO episodic_memories_fts(episodic_memories_fts, rowid, summary, overview, details, entities)
    VALUES ('delete', old.id, old.summary, old.overview, old.details, old.entities);
    INSERT INTO episodic_memories_fts(rowid, summary, overview, details, entities)
    VALUES (new.id, new.summary, new.overview, new.details, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS episodic_memories_fts_delete AFTER DELETE ON episodic_memories BEGIN
    INSERT INTO episodic_memories_fts(episodic_memories_fts, rowid, summary, overview, details, entities)
    VALUES ('delete', old.id, old.summary, old.overview, old.details, old.entities);
END;

CREATE TRIGGER IF NOT EXISTS bake_articles_fts_insert AFTER INSERT ON bake_articles BEGIN
    INSERT INTO bake_articles_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS bake_articles_fts_update AFTER UPDATE ON bake_articles BEGIN
    INSERT INTO bake_articles_fts(bake_articles_fts, rowid, title, summary, content, entities)
    VALUES ('delete', old.id, old.title, old.summary, old.content, old.entities);
    INSERT INTO bake_articles_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS bake_articles_fts_delete AFTER DELETE ON bake_articles BEGIN
    INSERT INTO bake_articles_fts(bake_articles_fts, rowid, title, summary, content, entities)
    VALUES ('delete', old.id, old.title, old.summary, old.content, old.entities);
END;

CREATE TRIGGER IF NOT EXISTS bake_knowledge_fts_insert AFTER INSERT ON bake_knowledge BEGIN
    INSERT INTO bake_knowledge_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS bake_knowledge_fts_update AFTER UPDATE ON bake_knowledge BEGIN
    INSERT INTO bake_knowledge_fts(bake_knowledge_fts, rowid, title, summary, content, entities)
    VALUES ('delete', old.id, old.title, old.summary, old.content, old.entities);
    INSERT INTO bake_knowledge_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS bake_knowledge_fts_delete AFTER DELETE ON bake_knowledge BEGIN
    INSERT INTO bake_knowledge_fts(bake_knowledge_fts, rowid, title, summary, content, entities)
    VALUES ('delete', old.id, old.title, old.summary, old.content, old.entities);
END;

CREATE TRIGGER IF NOT EXISTS bake_sops_fts_insert AFTER INSERT ON bake_sops BEGIN
    INSERT INTO bake_sops_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS bake_sops_fts_update AFTER UPDATE ON bake_sops BEGIN
    INSERT INTO bake_sops_fts(bake_sops_fts, rowid, title, summary, content, entities)
    VALUES ('delete', old.id, old.title, old.summary, old.content, old.entities);
    INSERT INTO bake_sops_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

CREATE TRIGGER IF NOT EXISTS bake_sops_fts_delete AFTER DELETE ON bake_sops BEGIN
    INSERT INTO bake_sops_fts(bake_sops_fts, rowid, title, summary, content, entities)
    VALUES ('delete', old.id, old.title, old.summary, old.content, old.entities);
END;

INSERT INTO episodic_memories_fts(episodic_memories_fts) VALUES ('rebuild');
INSERT INTO bake_articles_fts(bake_articles_fts) VALUES ('rebuild');
INSERT INTO bake_knowledge_fts(bake_knowledge_fts) VALUES ('rebuild');
INSERT INTO bake_sops_fts(bake_sops_fts) VALUES ('rebuild');
