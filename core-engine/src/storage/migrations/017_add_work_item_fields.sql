-- 017_add_work_item_fields.sql
-- 为 episodic_memories 表添加工作项相关字段

ALTER TABLE episodic_memories ADD COLUMN work_item TEXT;
ALTER TABLE episodic_memories ADD COLUMN work_status TEXT;
ALTER TABLE episodic_memories ADD COLUMN work_progress TEXT;

-- 创建索引以支持按工作项查询
CREATE INDEX IF NOT EXISTS idx_episodic_memories_work_item ON episodic_memories(work_item);
CREATE INDEX IF NOT EXISTS idx_episodic_memories_work_status ON episodic_memories(work_status);
