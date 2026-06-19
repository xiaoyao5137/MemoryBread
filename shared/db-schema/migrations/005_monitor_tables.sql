-- 005_monitor_tables.sql
-- 监控相关表

CREATE TABLE IF NOT EXISTS llm_usage_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    model_name  TEXT NOT NULL,
    caller      TEXT,
    caller_id   TEXT,
    prompt_tokens   INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens    INTEGER DEFAULT 0,
    latency_ms  INTEGER,
    status      TEXT DEFAULT 'success',
    error_msg   TEXT,
    raw_preview TEXT,
    response_preview TEXT,
    done_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_ts ON llm_usage_logs(ts);

CREATE TABLE IF NOT EXISTS system_metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    cpu_total   REAL DEFAULT 0,
    cpu_process REAL DEFAULT 0,
    mem_total_mb  INTEGER DEFAULT 0,
    mem_used_mb   INTEGER DEFAULT 0,
    mem_process_mb INTEGER DEFAULT 0,
    mem_percent    REAL DEFAULT 0,
    disk_read_mb  REAL DEFAULT 0,
    disk_write_mb REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_system_metrics_ts ON system_metrics(ts);

CREATE TABLE IF NOT EXISTS model_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            INTEGER NOT NULL,
    model_name    TEXT NOT NULL,
    model_type    TEXT NOT NULL DEFAULT '',
    event_type    TEXT NOT NULL,
    memory_mb     INTEGER,
    duration_ms   INTEGER,
    mem_before_mb INTEGER,
    mem_after_mb  INTEGER,
    error_msg     TEXT,
    detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_model_events_ts ON model_events(ts);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    user_instruction TEXT NOT NULL,
    cron_expression  TEXT NOT NULL,
    template_id      TEXT,
    enabled          INTEGER NOT NULL DEFAULT 1,
    run_count        INTEGER NOT NULL DEFAULT 0,
    last_run_at      INTEGER,
    last_run_status  TEXT,
    next_run_at      INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_executions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         INTEGER NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
    started_at      INTEGER NOT NULL,
    completed_at    INTEGER,
    status          TEXT NOT NULL DEFAULT 'running',
    knowledge_count INTEGER DEFAULT 0,
    token_used      INTEGER DEFAULT 0,
    result_text     TEXT,
    error_message   TEXT,
    latency_ms      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_executions_started ON task_executions(started_at);
CREATE INDEX IF NOT EXISTS idx_task_executions_task ON task_executions(task_id);
