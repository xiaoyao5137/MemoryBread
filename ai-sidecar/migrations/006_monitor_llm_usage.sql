-- =============================================================================
-- 迁移 006: 监控模块 - LLM 用量日志表
-- 日期: 2026-03-17
-- 描述:
--   新增 llm_usage_logs 表，记录所有 LLM 调用的 token 用量
--   触发流水、问答记录、定时任务执行复用现有表
-- =============================================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS llm_usage_logs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                INTEGER NOT NULL,           -- 调用时间戳（Unix ms）
    caller            TEXT    NOT NULL,           -- 调用来源：'rag' | 'task' | 'knowledge'
    caller_id         TEXT,                       -- 关联ID（task_id / rag_session_id 等）
    model_name        TEXT    NOT NULL,           -- 模型名称，如 "qwen2.5:3b"
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER,                    -- 调用耗时（毫秒）
    status            TEXT    NOT NULL DEFAULT 'success', -- 'success' | 'failed'
    error_msg         TEXT
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_ts     ON llm_usage_logs(ts);
CREATE INDEX IF NOT EXISTS idx_llm_usage_caller ON llm_usage_logs(caller);
CREATE INDEX IF NOT EXISTS idx_llm_usage_model  ON llm_usage_logs(model_name);

-- 记录迁移完成
INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES ('006_monitor_llm_usage', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
