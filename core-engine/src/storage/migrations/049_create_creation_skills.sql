-- 本地创作 Skill 草稿。源文档内容仍留在原文档表中，不在此重复保存。
CREATE TABLE IF NOT EXISTS creation_skills (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    client_skill_key    TEXT NOT NULL UNIQUE,
    cloud_skill_id      TEXT,
    source_kind         TEXT NOT NULL CHECK (source_kind IN ('creation_history', 'bake_document')),
    source_id           TEXT NOT NULL,
    title               TEXT NOT NULL,
    summary             TEXT NOT NULL,
    category_id         TEXT,
    common_titles       TEXT NOT NULL DEFAULT '[]',
    title_style         TEXT NOT NULL DEFAULT '',
    text_style          TEXT NOT NULL DEFAULT '',
    diagram_style       TEXT NOT NULL DEFAULT '',
    structure_pattern   TEXT NOT NULL DEFAULT '[]',
    writing_guidelines  TEXT NOT NULL DEFAULT '[]',
    published           INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    deleted_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_creation_skills_updated_at
    ON creation_skills(updated_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_creation_skills_source
    ON creation_skills(source_kind, source_id)
    WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_creation_skills_cloud_id
    ON creation_skills(cloud_skill_id)
    WHERE cloud_skill_id IS NOT NULL AND deleted_at IS NULL;
