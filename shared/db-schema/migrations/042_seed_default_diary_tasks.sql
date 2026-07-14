-- 042_seed_default_diary_tasks.sql
-- 确保日记链路有默认定时任务。daily 任务立即到期，用于补偿升级前缺失的最近日记。

INSERT INTO scheduled_tasks (
    name, user_instruction, cron_expression, template_id,
    enabled, run_count, next_run_at, created_at, updated_at
)
SELECT
    '生成昨日工作日记',
    '请根据昨天的工作记录，生成高度浓缩的工作日记。要求：
默认使用简体中文；即使原始记录主要为英文，也使用中文叙述，产品名和代码标识符可保留原文。
1. 【今日产出】最多 4 条，只写真正完成的成果、修复、决策或交付，每条不超过 45 个中文字符。
2. 【问题与解决】最多 2 条，仅记录已解决问题或明确结论；没有则写「无」。
3. 【明日计划】最多 3 条，只写可交付、可验证目标。
过滤掉：浏览、阅读、搜索、应用切换、会议过程、配置环境、失败尝试等流水账。',
    '0 0 9 * * *',
    'daily_journal',
    1,
    0,
    0,
    CAST(strftime('%s', 'now') * 1000 AS INTEGER),
    CAST(strftime('%s', 'now') * 1000 AS INTEGER)
WHERE NOT EXISTS (
    SELECT 1 FROM scheduled_tasks
    WHERE template_id = 'daily_journal'
       OR name IN ('每日工作日记', '生成今日工作日记', '生成昨日工作日记')
       OR user_instruction LIKE '%工作日记%'
);

INSERT INTO scheduled_tasks (
    name, user_instruction, cron_expression, template_id,
    enabled, run_count, next_run_at, created_at, updated_at
)
SELECT
    '生成上周工作周记',
    '请根据上周每日工作日记，生成一份工作周记。要求：
1. 【本周核心产出】每条说明做了什么（结果）、为什么重要（价值），有量化数据的写数据。
2. 【项目进展】各项目阶段状态，用「已完成/进行中/待启动」标注。
3. 【下周计划】每条是具体可交付目标，不写「继续推进」等模糊描述。
4. 【风险/阻塞】（如有）描述具体问题和影响范围。
过滤掉：阅读文档、安装依赖、无结论的调研等活动流水账。',
    '0 0 9 * * 2',
    'weekly_report',
    1,
    0,
    NULL,
    CAST(strftime('%s', 'now') * 1000 AS INTEGER),
    CAST(strftime('%s', 'now') * 1000 AS INTEGER)
WHERE NOT EXISTS (
    SELECT 1 FROM scheduled_tasks
    WHERE template_id = 'weekly_report'
       OR name IN ('每周工作周报', '生成本周工作周报', '生成上周工作周记')
);

INSERT INTO scheduled_tasks (
    name, user_instruction, cron_expression, template_id,
    enabled, run_count, next_run_at, created_at, updated_at
)
SELECT
    '生成上月工作月记',
    '请根据上月每日工作日记，生成工作月记。要求：
1. 【主要成果】列出上月最重要的 3-5 项交付物，说明其业务价值，有数据的写数据。
2. 【时间分配】按项目/类别分析时间投入占比，指出是否与优先级匹配。
3. 【效率亮点与问题】各一条，基于事实。
4. 【下月目标】具体、可验收的目标。
过滤掉：活动流水、工具配置、无结论的探索。',
    '0 0 9 1 * *',
    'monthly_summary',
    1,
    0,
    NULL,
    CAST(strftime('%s', 'now') * 1000 AS INTEGER),
    CAST(strftime('%s', 'now') * 1000 AS INTEGER)
WHERE NOT EXISTS (
    SELECT 1 FROM scheduled_tasks
    WHERE template_id = 'monthly_summary'
       OR name IN ('月度工作总结', '生成本月工作总结', '生成上月工作月记')
);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('042_seed_default_diary_tasks', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
