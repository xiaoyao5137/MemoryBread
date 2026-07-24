-- 周记/月记改为直接总结对应时间段的 timelines，避免依赖日记级联汇总。

UPDATE scheduled_tasks
SET user_instruction = replace(
        user_instruction,
        '请根据上周每日工作日记',
        '请根据上周时间线记录'
    ),
    updated_at = CAST(strftime('%s', 'now') * 1000 AS INTEGER)
WHERE template_id = 'weekly_report'
  AND user_instruction LIKE '%请根据上周每日工作日记%';

UPDATE scheduled_tasks
SET user_instruction = replace(
        user_instruction,
        '请根据上月每日工作日记',
        '请根据上月时间线记录'
    ),
    updated_at = CAST(strftime('%s', 'now') * 1000 AS INTEGER)
WHERE template_id = 'monthly_summary'
  AND user_instruction LIKE '%请根据上月每日工作日记%';

INSERT INTO schema_migrations (version, applied_at)
VALUES ('047_update_diary_timeline_sources', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
