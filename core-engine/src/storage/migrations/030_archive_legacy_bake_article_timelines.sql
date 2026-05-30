-- 030_archive_legacy_bake_article_timelines.sql
-- 旧版 bake 流程会把提炼候选壳写回 timelines.category=bake_article。
-- 新版文档/知识/SOP 已落到专门 bake_* 表，历史壳改为 legacy 类别避免继续混淆为业务时间线。

UPDATE timelines
SET category = 'legacy_bake_candidate'
WHERE category = 'bake_article'
  AND json_valid(COALESCE(details, '{}'))
  AND json_extract(details, '$.init_method') = 'knowledge_bootstrap';
