-- =============================================================================
-- 迁移 005: 工作片段合并 + 定时任务模块
-- 日期: 2026-03-17
-- 描述:
--   1. knowledge_entries 新增片段相关字段（capture_ids, start_time, end_time 等）
--   2. captures 新增 timeline_id 反向关联字段
--   3. 新增 scheduled_tasks 定时任务表
--   4. 新增 task_executions 任务执行历史表
-- =============================================================================

PRAGMA foreign_keys = ON;

-- =============================================================================
-- 1. knowledge_entries 新增片段字段
-- =============================================================================
ALTER TABLE knowledge_entries ADD COLUMN capture_ids TEXT;          -- JSON数组，关联的所有 capture IDs
ALTER TABLE knowledge_entries ADD COLUMN start_time INTEGER;        -- 片段开始时间（最早 capture 的 ts）
ALTER TABLE knowledge_entries ADD COLUMN end_time INTEGER;          -- 片段结束时间（最晚 capture 的 ts）
ALTER TABLE knowledge_entries ADD COLUMN duration_minutes INTEGER;  -- 持续时长（分钟）
ALTER TABLE knowledge_entries ADD COLUMN frag_app_name TEXT;        -- 片段主要应用名
ALTER TABLE knowledge_entries ADD COLUMN frag_win_title TEXT;       -- 片段主要窗口标题

-- 为时间范围查询建立索引
CREATE INDEX IF NOT EXISTS idx_knowledge_time ON knowledge_entries(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_knowledge_app  ON knowledge_entries(frag_app_name);

-- =============================================================================
-- 2. captures 新增 timeline_id 反向关联
-- =============================================================================
ALTER TABLE captures ADD COLUMN timeline_id INTEGER REFERENCES knowledge_entries(id);

CREATE INDEX IF NOT EXISTS idx_captures_timeline ON captures(timeline_id);

-- =============================================================================
-- 3. scheduled_tasks — 定时任务定义表
-- =============================================================================
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    name                TEXT    NOT NULL,               -- 任务名称（用户自定义）
    user_instruction    TEXT    NOT NULL,               -- 用户的自然语言指令（完全驱动执行）
    cron_expression     TEXT    NOT NULL,               -- cron 表达式，如 "0 20 * * *"
    enabled             INTEGER NOT NULL DEFAULT 1,     -- 是否启用
    -- 模板相关
    template_id         TEXT,                           -- 来自哪个内置模板（null=完全自定义）
    -- 执行统计
    run_count           INTEGER NOT NULL DEFAULT 0,     -- 累计执行次数
    last_run_at         INTEGER,                        -- 上次执行时间戳（Unix ms）
    last_run_status     TEXT,                           -- 上次执行状态
    next_run_at         INTEGER,                        -- 下次执行时间戳（Unix ms，由调度器维护）
    -- 时间戳
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled  ON scheduled_tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks(next_run_at);

-- =============================================================================
-- 4. task_executions — 任务执行历史表
-- =============================================================================
CREATE TABLE IF NOT EXISTS task_executions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         INTEGER NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    started_at      INTEGER NOT NULL,                   -- 开始执行时间戳（Unix ms）
    completed_at    INTEGER,                            -- 完成时间戳（Unix ms）
    status          TEXT    NOT NULL DEFAULT 'running', -- 'running' | 'success' | 'failed'
    -- 执行上下文
    knowledge_count INTEGER,                            -- 本次检索到的 knowledge 条数
    token_used      INTEGER,                            -- 消耗的 token 数（估算）
    -- 结果
    result_text     TEXT,                               -- LLM 生成的结果（Markdown）
    error_message   TEXT,                               -- 失败原因
    latency_ms      INTEGER                             -- 端到端耗时（毫秒）
);

CREATE INDEX IF NOT EXISTS idx_task_executions_task_id    ON task_executions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_executions_started_at ON task_executions(started_at);
CREATE INDEX IF NOT EXISTS idx_task_executions_status     ON task_executions(status);

-- =============================================================================
-- 5. 内置模板预置数据（仅作参考，UI 从代码读取，不依赖此数据）
-- =============================================================================

-- 记录迁移完成
INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES ('005_fragment_and_scheduled_tasks', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
