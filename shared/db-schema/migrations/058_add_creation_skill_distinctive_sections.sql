-- 允许模型在固定写作配方之外，提炼多个来源特有且可编辑的特色章节。
ALTER TABLE creation_skills
    ADD COLUMN distinctive_sections TEXT NOT NULL DEFAULT '[]';
