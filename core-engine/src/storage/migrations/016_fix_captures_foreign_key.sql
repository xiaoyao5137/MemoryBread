-- 016_fix_captures_foreign_key.sql
-- 修复 captures 表的外键引用，从 knowledge_entries_backup 改为 episodic_memories

-- 临时禁用外键约束
PRAGMA foreign_keys = OFF;

-- 创建新的 captures 表（修正外键）
CREATE TABLE captures_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,
    app_name        TEXT,
    app_bundle_id   TEXT,
    win_title       TEXT,
    event_type      TEXT NOT NULL DEFAULT 'auto',
    ax_text         TEXT,                       -- OCR 前程序化提取文本（历史名 ax_text；可能来自 AX Tree、浏览器 DOM innerText 或专用提取器）
    ax_focused_role TEXT,
    ax_focused_id   TEXT,
    ocr_text        TEXT,
    screenshot_path TEXT,
    input_text      TEXT,
    audio_text      TEXT,
    is_sensitive    INTEGER NOT NULL DEFAULT 0,
    pii_scrubbed    INTEGER NOT NULL DEFAULT 0,
    knowledge_id    INTEGER REFERENCES episodic_memories(id)
);

-- 复制数据
INSERT INTO captures_new SELECT * FROM captures;

-- 删除旧表
DROP TABLE captures;

-- 重命名新表
ALTER TABLE captures_new RENAME TO captures;

-- 重建索引
CREATE INDEX idx_captures_ts ON captures(ts);
CREATE INDEX idx_captures_app ON captures(app_name);
CREATE INDEX idx_captures_knowledge ON captures(knowledge_id);

-- 重建 FTS triggers
CREATE TRIGGER captures_fts_insert
    AFTER INSERT ON captures BEGIN
    INSERT INTO captures_fts(rowid, ax_text, ocr_text, input_text, audio_text)
    VALUES (new.id, new.ax_text, new.ocr_text, new.input_text, new.audio_text);
END;

CREATE TRIGGER captures_fts_delete
    AFTER DELETE ON captures BEGIN
    INSERT INTO captures_fts(captures_fts, rowid, ax_text, ocr_text, input_text, audio_text)
    VALUES ('delete', old.id, old.ax_text, old.ocr_text, old.input_text, old.audio_text);
END;

CREATE TRIGGER captures_fts_update
    AFTER UPDATE ON captures BEGIN
    INSERT INTO captures_fts(captures_fts, rowid, ax_text, ocr_text, input_text, audio_text)
    VALUES ('delete', old.id, old.ax_text, old.ocr_text, old.input_text, old.audio_text);
    INSERT INTO captures_fts(rowid, ax_text, ocr_text, input_text, audio_text)
    VALUES (new.id, new.ax_text, new.ocr_text, new.input_text, new.audio_text);
END;

-- 重新启用外键约束
PRAGMA foreign_keys = ON;
