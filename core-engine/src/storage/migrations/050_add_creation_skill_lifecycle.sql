-- 创作 Skill 本地生命周期与安装状态。
-- 既有记录视为已保存但未安装；新沉淀的内容由客户端显式写入 draft。
ALTER TABLE creation_skills
    ADD COLUMN status TEXT NOT NULL DEFAULT 'saved'
    CHECK (status IN ('draft', 'saved'));

ALTER TABLE creation_skills
    ADD COLUMN installed INTEGER NOT NULL DEFAULT 0
    CHECK (installed IN (0, 1));

CREATE INDEX IF NOT EXISTS idx_creation_skills_installed
    ON creation_skills(installed, updated_at DESC)
    WHERE deleted_at IS NULL;
