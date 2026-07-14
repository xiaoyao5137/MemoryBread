-- 日记快照表：由时间线生成日记，再由日记汇总周记/月记。
-- 旧 user_profiles 表保留兼容；新功能统一读写 diaries。

CREATE TABLE IF NOT EXISTS user_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('daily', 'weekly', 'monthly', 'yearly')),
    snapshot_date TEXT NOT NULL,
    content TEXT NOT NULL,
    is_system_generated INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_profiles_type_date ON user_profiles(snapshot_type, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_created ON user_profiles(created_at DESC);

CREATE TABLE IF NOT EXISTS diaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_type TEXT NOT NULL CHECK(period_type IN ('daily', 'weekly', 'monthly', 'yearly')),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    diary_date TEXT NOT NULL,
    content TEXT NOT NULL,
    source_timeline_ids TEXT NOT NULL DEFAULT '[]',
    source_diary_ids TEXT NOT NULL DEFAULT '[]',
    generation_status TEXT NOT NULL DEFAULT 'ready',
    is_system_generated INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(period_type, diary_date)
);

CREATE INDEX IF NOT EXISTS idx_diaries_type_date ON diaries(period_type, diary_date DESC);
CREATE INDEX IF NOT EXISTS idx_diaries_period ON diaries(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_diaries_created ON diaries(created_at DESC);

INSERT OR IGNORE INTO diaries (
    period_type,
    period_start,
    period_end,
    diary_date,
    content,
    is_system_generated,
    created_at,
    updated_at
)
SELECT
    snapshot_type,
    snapshot_date,
    snapshot_date,
    snapshot_date,
    content,
    is_system_generated,
    created_at,
    updated_at
FROM user_profiles
WHERE snapshot_type IN ('daily', 'weekly', 'monthly', 'yearly');

UPDATE scheduled_tasks
SET
    name = '生成昨日工作日记',
    cron_expression = '0 0 9 * * *',
    user_instruction = '请根据昨天的工作记录，生成高度浓缩的工作日记。要求：
1. 【今日产出】最多 4 条，只写真正完成的成果、修复、决策或交付，每条不超过 45 个中文字符。
2. 【问题与解决】最多 2 条，仅记录已解决问题或明确结论；没有则写「无」。
3. 【明日计划】最多 3 条，只写可交付、可验证目标。
过滤掉：浏览、阅读、搜索、应用切换、会议过程、配置环境、失败尝试等流水账。',
    next_run_at = NULL,
    updated_at = CAST(strftime('%s','now') * 1000 AS INTEGER)
WHERE template_id = 'daily_journal'
  AND (
    name IN ('每日工作日记', '生成今日工作日记')
    OR user_instruction LIKE '%请根据今天的工作记录%'
  );

UPDATE scheduled_tasks
SET
    name = '生成上周工作周记',
    cron_expression = '0 0 9 * * 2',
    user_instruction = '请根据上周每日工作日记，生成一份工作周记。要求：
1. 【本周核心产出】每条说明做了什么（结果）、为什么重要（价值），有量化数据的必须写出。
2. 【项目进展】各项目阶段状态，用「已完成/进行中/待启动」标注。
3. 【下周计划】每条是具体可交付目标，不写「继续推进」等模糊描述。
4. 【风险/阻塞】（如有）描述具体问题和影响范围。
过滤掉：阅读文档、安装依赖、无结论的调研等活动流水账。',
    next_run_at = NULL,
    updated_at = CAST(strftime('%s','now') * 1000 AS INTEGER)
WHERE template_id = 'weekly_report'
  AND (
    name IN ('每周工作周报', '生成本周工作周报')
    OR user_instruction LIKE '%请根据本周的工作记录%'
  );

UPDATE scheduled_tasks
SET
    name = '生成上月工作月记',
    cron_expression = '0 0 9 1 * *',
    user_instruction = '请根据上月每日工作日记，生成工作月记。要求：
1. 【主要成果】列出上月最重要的 3-5 项交付物，说明其业务价值，有数据的写数据。
2. 【时间分配】按项目/类别分析时间投入占比，指出是否与优先级匹配。
3. 【效率亮点与问题】各一条，基于事实。
4. 【下月目标】具体、可验收的目标。
过滤掉：活动流水、工具配置、无结论的探索。',
    next_run_at = NULL,
    updated_at = CAST(strftime('%s','now') * 1000 AS INTEGER)
WHERE template_id = 'monthly_summary'
  AND (
    name IN ('月度工作总结', '生成本月工作总结')
    OR user_instruction LIKE '%请根据本月的工作记录%'
  );
