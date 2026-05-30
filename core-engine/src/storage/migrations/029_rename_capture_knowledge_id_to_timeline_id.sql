-- 029_rename_capture_knowledge_id_to_timeline_id.sql
-- captures.knowledge_id 历史上实际指向 timelines.id；统一命名为 timeline_id。

DROP INDEX IF EXISTS idx_captures_knowledge;
DROP INDEX IF EXISTS idx_captures_timeline;

ALTER TABLE captures RENAME COLUMN knowledge_id TO timeline_id;

CREATE INDEX IF NOT EXISTS idx_captures_timeline ON captures(timeline_id);
