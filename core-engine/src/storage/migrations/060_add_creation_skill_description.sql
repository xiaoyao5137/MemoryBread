-- 为创作 Skill 增加可触发的能力描述和可执行的分步工作流。
ALTER TABLE creation_skills
    ADD COLUMN skill_description TEXT NOT NULL DEFAULT '{}';

ALTER TABLE creation_skills
    ADD COLUMN execution_steps TEXT NOT NULL DEFAULT '[]';
