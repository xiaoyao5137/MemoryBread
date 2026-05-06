-- 016_rename_to_timelines.sql
-- 将 episodic_memories 重命名为 timelines，并增加时间范围字段
-- 将 bake_articles 重命名为 designs

PRAGMA foreign_keys = OFF;

-- 1. 重命名 episodic_memories 为 timelines，并增加时间范围字段
ALTER TABLE episodic_memories RENAME TO episodic_memories_old;

CREATE TABLE timelines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id INTEGER NOT NULL,
    summary TEXT NOT NULL,
    overview TEXT,
    details TEXT,
    entities TEXT,
    category TEXT,
    importance INTEGER DEFAULT 3,
    occurrence_count INTEGER DEFAULT 1,
    observed_at INTEGER,
    event_time_start INTEGER,
    event_time_end INTEGER,
    history_view INTEGER NOT NULL DEFAULT 0,
    content_origin TEXT,
    activity_type TEXT,
    is_self_generated INTEGER NOT NULL DEFAULT 0,
    evidence_strength TEXT,
    user_verified BOOLEAN DEFAULT 0,
    user_edited BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_at_ms INTEGER,
    updated_at_ms INTEGER,
    capture_ids TEXT,
    start_time INTEGER,
    end_time INTEGER,
    duration_minutes INTEGER,
    frag_app_name TEXT,
    frag_win_title TEXT,
    -- 新增时间范围字段
    time_range_start INTEGER,  -- 时间线起始时间戳（毫秒）
    time_range_end INTEGER,    -- 时间线结束时间戳（毫秒）
    key_timestamps TEXT,       -- JSON数组，存储关键时间点 [{"ts": 123456, "label": "开始编码"}, ...]
    FOREIGN KEY (capture_id) REFERENCES captures(id)
);

-- 迁移数据
INSERT INTO timelines (
    id, capture_id, summary, overview, details, entities, category,
    importance, occurrence_count, observed_at, event_time_start, event_time_end,
    history_view, content_origin, activity_type, is_self_generated,
    evidence_strength, user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, capture_ids, start_time, end_time,
    duration_minutes, frag_app_name, frag_win_title,
    time_range_start, time_range_end, key_timestamps
)
SELECT
    id, capture_id, summary, overview, details, entities, category,
    importance, occurrence_count, observed_at, event_time_start, event_time_end,
    history_view, content_origin, activity_type, is_self_generated,
    evidence_strength, user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, capture_ids, start_time, end_time,
    duration_minutes, frag_app_name, frag_win_title,
    -- 使用现有的 start_time 和 end_time 作为初始值
    start_time, end_time, '[]'
FROM episodic_memories_old;

-- 创建索引
CREATE INDEX idx_timelines_capture_id ON timelines(capture_id);
CREATE INDEX idx_timelines_time_range ON timelines(time_range_start, time_range_end);
CREATE INDEX idx_timelines_created_at ON timelines(created_at_ms);

-- 2. 重命名 bake_articles 为 designs
ALTER TABLE bake_articles RENAME TO bake_articles_old;

CREATE TABLE designs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timeline_id INTEGER NOT NULL,
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
    source_capture_ids TEXT DEFAULT '[]',  -- 新增：直接关联的 Capture IDs
    FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE
);

-- 迁移数据
INSERT INTO designs (
    id, timeline_id, title, summary, content, entities,
    importance, user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, source_capture_ids
)
SELECT
    id, episodic_memory_id, title, summary, content, entities,
    importance, user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, '[]'
FROM bake_articles_old;

-- 创建索引
CREATE INDEX idx_designs_timeline_id ON designs(timeline_id);
CREATE INDEX idx_designs_created_at ON designs(created_at_ms);

-- 3. 更新 bake_knowledge 表的外键引用
ALTER TABLE bake_knowledge RENAME TO bake_knowledge_old;

CREATE TABLE bake_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timeline_id INTEGER NOT NULL,
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
    source_capture_ids TEXT DEFAULT '[]',  -- 新增：直接关联的 Capture IDs
    FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE
);

INSERT INTO bake_knowledge (
    id, timeline_id, title, summary, content, entities,
    importance, user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, source_capture_ids
)
SELECT
    id, episodic_memory_id, title, summary, content, entities,
    importance, user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, '[]'
FROM bake_knowledge_old;

CREATE INDEX idx_bake_knowledge_timeline_id ON bake_knowledge(timeline_id);
CREATE INDEX idx_bake_knowledge_created_at ON bake_knowledge(created_at_ms);

-- 4. 更新 bake_sops 表的外键引用
ALTER TABLE bake_sops RENAME TO bake_sops_old;

CREATE TABLE bake_sops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timeline_id INTEGER NOT NULL,
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
    source_capture_ids TEXT DEFAULT '[]',  -- 新增：直接关联的 Capture IDs
    FOREIGN KEY (timeline_id) REFERENCES timelines(id) ON DELETE CASCADE
);

INSERT INTO bake_sops (
    id, timeline_id, title, summary, content, entities,
    importance, user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, source_capture_ids
)
SELECT
    id, episodic_memory_id, title, summary, content, entities,
    importance, user_verified, user_edited, created_at, updated_at,
    created_at_ms, updated_at_ms, '[]'
FROM bake_sops_old;

CREATE INDEX idx_bake_sops_timeline_id ON bake_sops(timeline_id);
CREATE INDEX idx_bake_sops_created_at ON bake_sops(created_at_ms);

-- 5. 重建 FTS 表
DROP TABLE IF EXISTS bake_articles_fts;
DROP TABLE IF EXISTS designs_fts;

CREATE VIRTUAL TABLE designs_fts USING fts5(
    title, summary, content, entities,
    content='designs',
    content_rowid='id'
);

INSERT INTO designs_fts(rowid, title, summary, content, entities)
SELECT id, title, summary, content, entities FROM designs;

-- 6. 重建 FTS 触发器
DROP TRIGGER IF EXISTS bake_articles_fts_insert;
DROP TRIGGER IF EXISTS bake_articles_fts_delete;
DROP TRIGGER IF EXISTS bake_articles_fts_update;

CREATE TRIGGER designs_fts_insert AFTER INSERT ON designs BEGIN
    INSERT INTO designs_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

CREATE TRIGGER designs_fts_delete AFTER DELETE ON designs BEGIN
    DELETE FROM designs_fts WHERE rowid = old.id;
END;

CREATE TRIGGER designs_fts_update AFTER UPDATE ON designs BEGIN
    DELETE FROM designs_fts WHERE rowid = old.id;
    INSERT INTO designs_fts(rowid, title, summary, content, entities)
    VALUES (new.id, new.title, new.summary, new.content, new.entities);
END;

-- 7. 删除旧表
DROP TABLE IF EXISTS episodic_memories_old;
DROP TABLE IF EXISTS bake_articles_old;
DROP TABLE IF EXISTS bake_knowledge_old;
DROP TABLE IF EXISTS bake_sops_old;

PRAGMA foreign_keys = ON;
