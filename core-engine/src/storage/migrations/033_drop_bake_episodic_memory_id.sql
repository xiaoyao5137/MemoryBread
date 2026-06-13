-- 033_drop_bake_episodic_memory_id.sql
-- bake_knowledge / bake_sops 残留旧列 episodic_memory_id：
--   1) NOT NULL —— 插入不写它就失败；
--   2) FOREIGN KEY → episodic_memories_old(id)，而该表已空 —— 写任何非 NULL 值又违反外键。
-- 两个约束互斥导致该列无法插入，knowledge/sop 提炼结果永远落不了库。
-- 列重命名为 timeline_id 后这个旧列已无用，这里重建表彻底移除它（连同 NOT NULL 与 FK）。
-- 两表数据量为 0（提炼从未成功落库过），重建零数据风险；仍保留 INSERT...SELECT 兜底。

PRAGMA foreign_keys = OFF;

-- ── bake_knowledge 重建 ────────────────────────────────────────────────
DROP TABLE IF EXISTS bake_knowledge_new;

CREATE TABLE bake_knowledge_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT,
    entities TEXT,
    importance INTEGER DEFAULT 3,
    user_verified BOOLEAN DEFAULT 0,
    user_edited BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at_ms INTEGER,
    updated_at_ms INTEGER,
    detailed_content TEXT,
    document_id INTEGER,
    section_ids TEXT DEFAULT '[]',
    source_timeline_ids TEXT DEFAULT '[]',
    timeline_id INTEGER,
    source_capture_ids TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO bake_knowledge_new (
    id, title, summary, content, entities, importance,
    user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, detailed_content, document_id,
    section_ids, source_timeline_ids, timeline_id, source_capture_ids
)
SELECT
    id, title, summary, content, entities, importance,
    user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, detailed_content, document_id,
    section_ids, source_timeline_ids,
    COALESCE(timeline_id, episodic_memory_id),
    COALESCE(source_capture_ids, '[]')
FROM bake_knowledge;

DROP TABLE bake_knowledge;
ALTER TABLE bake_knowledge_new RENAME TO bake_knowledge;

CREATE INDEX IF NOT EXISTS idx_bake_knowledge_importance ON bake_knowledge(importance);
CREATE INDEX IF NOT EXISTS idx_bake_knowledge_updated_at_ms ON bake_knowledge(updated_at_ms);
CREATE INDEX IF NOT EXISTS idx_bake_knowledge_timeline_id ON bake_knowledge(timeline_id);

-- ── bake_sops 重建 ────────────────────────────────────────────────────
DROP TABLE IF EXISTS bake_sops_new;

CREATE TABLE bake_sops_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT,
    entities TEXT,
    importance INTEGER DEFAULT 3,
    user_verified BOOLEAN DEFAULT 0,
    user_edited BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at_ms INTEGER,
    updated_at_ms INTEGER,
    detailed_content TEXT,
    timeline_id INTEGER,
    source_capture_ids TEXT DEFAULT '[]'
);

INSERT INTO bake_sops_new (
    id, title, summary, content, entities, importance,
    user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, detailed_content, timeline_id, source_capture_ids
)
SELECT
    id, title, summary, content, entities, importance,
    user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, detailed_content,
    COALESCE(timeline_id, episodic_memory_id),
    COALESCE(source_capture_ids, '[]')
FROM bake_sops;

DROP TABLE bake_sops;
ALTER TABLE bake_sops_new RENAME TO bake_sops;

CREATE INDEX IF NOT EXISTS idx_bake_sops_importance ON bake_sops(importance);
CREATE INDEX IF NOT EXISTS idx_bake_sops_updated_at_ms ON bake_sops(updated_at_ms);
CREATE INDEX IF NOT EXISTS idx_bake_sops_timeline_id ON bake_sops(timeline_id);

-- 重建 bake_sops 的 FTS 同步触发器（DROP TABLE 已连带删除旧触发器）
DROP TRIGGER IF EXISTS bake_sops_fts_insert;
DROP TRIGGER IF EXISTS bake_sops_fts_update;
DROP TRIGGER IF EXISTS bake_sops_fts_delete;

CREATE TRIGGER bake_sops_fts_insert AFTER INSERT ON bake_sops BEGIN
    INSERT INTO bake_sops_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

CREATE TRIGGER bake_sops_fts_update AFTER UPDATE ON bake_sops BEGIN
    INSERT INTO bake_sops_fts(bake_sops_fts, rowid, title, summary, content, entities)
    VALUES ('delete', old.id, old.title, old.summary, old.content, old.entities);
    INSERT INTO bake_sops_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

CREATE TRIGGER bake_sops_fts_delete AFTER DELETE ON bake_sops BEGIN
    INSERT INTO bake_sops_fts(bake_sops_fts, rowid, title, summary, content, entities)
    VALUES ('delete', old.id, old.title, old.summary, old.content, old.entities);
END;

-- 清空可能残留的 FTS 索引并重建（两表数据为 0，rebuild 即清空）
INSERT INTO bake_sops_fts(bake_sops_fts) VALUES ('rebuild');

PRAGMA foreign_keys = ON;
