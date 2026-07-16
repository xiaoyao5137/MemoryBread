-- 每日工作日记只记录已经发生的事实，不再生成未来计划。
-- 使用 replace 保留用户对默认任务提示词的其他编辑。

UPDATE scheduled_tasks
SET user_instruction = replace(
        user_instruction,
        '3. 【明日计划】最多 3 条，只写可交付、可验证目标。',
        '3. 不要生成明日计划、后续计划、待办或建议，只记录当天已经发生并有依据的事实。'
    ),
    updated_at = CAST(strftime('%s', 'now') * 1000 AS INTEGER)
WHERE template_id = 'daily_journal'
  AND user_instruction LIKE '%3. 【明日计划】最多 3 条，只写可交付、可验证目标。%';

INSERT INTO schema_migrations (version, applied_at)
VALUES ('045_remove_daily_diary_future_plans', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
