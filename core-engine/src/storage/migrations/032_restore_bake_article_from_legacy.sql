-- 032_restore_bake_article_from_legacy.sql
-- 回滚 030：将被错误归档的 legacy_bake_candidate 恢复为 bake_article。

UPDATE timelines
SET category = 'bake_article'
WHERE category = 'legacy_bake_candidate';
