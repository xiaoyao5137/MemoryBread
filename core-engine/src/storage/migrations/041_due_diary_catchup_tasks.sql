-- 041_due_diary_catchup_tasks.sql
-- 日记功能升级后，将已有日记任务标记为到期，让 sidecar 立即补偿最近缺失的日记。

UPDATE scheduled_tasks
SET next_run_at = 0,
    updated_at = CAST(strftime('%s', 'now') * 1000 AS INTEGER)
WHERE enabled = 1
  AND template_id IN ('daily_journal', 'weekly_report', 'monthly_summary')
  AND next_run_at IS NULL;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('041_due_diary_catchup_tasks', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
