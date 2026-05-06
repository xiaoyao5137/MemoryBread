-- 修复 FTS5 中文分词问题
-- 使用 unicode61 tokenizer 并禁用 remove_diacritics 以更好地支持中文

-- 1. 备份现有数据
CREATE TABLE IF NOT EXISTS episodic_memories_fts_backup AS
SELECT * FROM episodic_memories_fts;

-- 2. 删除旧的 FTS 表
DROP TABLE IF EXISTS episodic_memories_fts;

-- 3. 创建新的 FTS 表，使用更好的中文支持配置
CREATE VIRTUAL TABLE episodic_memories_fts USING fts5(
    summary,
    overview,
    details,
    entities,
    content=episodic_memories,
    content_rowid=id,
    tokenize='unicode61 remove_diacritics 0'
);

-- 4. 重建索引
INSERT INTO episodic_memories_fts(episodic_memories_fts, rank) VALUES('rebuild', 0);

-- 5. 验证
SELECT COUNT(*) as total_indexed FROM episodic_memories_fts;
