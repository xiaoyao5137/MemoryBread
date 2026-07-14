-- 044_correct_weekday_semantics.sql
-- 五段 cron 的 1=周一；`cron` crate 的六段格式中 2=周一。
-- 修正 043 已经规范化、但星期数字仍沿用五段语义的默认周记任务。

UPDATE scheduled_tasks
SET cron_expression = '0 0 9 * * 2',
    next_run_at = NULL,
    updated_at = CAST(strftime('%s', 'now') * 1000 AS INTEGER)
WHERE template_id = 'weekly_report'
  AND cron_expression = '0 0 9 * * 1';

INSERT INTO schema_migrations (version, applied_at)
VALUES ('044_correct_weekday_semantics', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
