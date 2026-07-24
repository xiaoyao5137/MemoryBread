-- 扩展创作 Skill：两层标题、逐字段 few-shot 和完全脱离原文的完整示例文档。
-- 旧记录在读取时由应用层补齐安全默认值，避免迁移时伪造来源相关内容。
ALTER TABLE creation_skills
    ADD COLUMN section_headings TEXT NOT NULL DEFAULT '{}';

ALTER TABLE creation_skills
    ADD COLUMN field_examples TEXT NOT NULL DEFAULT '{}';

ALTER TABLE creation_skills
    ADD COLUMN example_document TEXT NOT NULL DEFAULT '';
