-- 043_normalize_scheduled_task_cron.sql
-- `cron` crate 需要秒字段；将历史默认五段 cron 规范化为六段，并清除卡在过去的执行时间。

UPDATE scheduled_tasks
SET cron_expression = CASE cron_expression
        WHEN '0 9 * * *' THEN '0 0 9 * * *'
        WHEN '0 9 * * 1' THEN '0 0 9 * * 2'
        WHEN '0 9 1 * *' THEN '0 0 9 1 * *'
    END,
    next_run_at = NULL,
    updated_at = CAST(strftime('%s', 'now') * 1000 AS INTEGER)
WHERE cron_expression IN ('0 9 * * *', '0 9 * * 1', '0 9 1 * *');

INSERT INTO schema_migrations (version, applied_at)
VALUES ('043_normalize_scheduled_task_cron', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
