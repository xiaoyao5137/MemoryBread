-- =============================================================================
-- 迁移 007: 系统资源监控 + 模型事件记录
-- 日期: 2026-03-17
-- =============================================================================

PRAGMA foreign_keys = ON;

-- =============================================================================
-- 1. system_metrics — 系统资源采样表（每30秒一条）
-- =============================================================================
CREATE TABLE IF NOT EXISTS system_metrics (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,           -- 采样时间戳（Unix ms）

    -- CPU
    cpu_total       REAL    NOT NULL DEFAULT 0, -- 全局 CPU 使用率 %
    cpu_process     REAL    NOT NULL DEFAULT 0, -- 当前进程 CPU 使用率 %

    -- 内存
    mem_total_mb    INTEGER NOT NULL DEFAULT 0, -- 系统总内存 MB
    mem_used_mb     INTEGER NOT NULL DEFAULT 0, -- 系统已用内存 MB
    mem_percent     REAL    NOT NULL DEFAULT 0, -- 内存使用率 %
    mem_process_mb  INTEGER NOT NULL DEFAULT 0, -- 当前进程内存 MB

    -- 磁盘 IO（增量，相对上次采样）
    disk_read_mb    REAL    NOT NULL DEFAULT 0, -- 读取 MB（本采样周期）
    disk_write_mb   REAL    NOT NULL DEFAULT 0, -- 写入 MB（本采样周期）

    -- 上下文
    context         TEXT                        -- 'idle_compute' | 'normal' | null
);

CREATE INDEX IF NOT EXISTS idx_metrics_ts      ON system_metrics(ts);
CREATE INDEX IF NOT EXISTS idx_metrics_context ON system_metrics(context);

-- =============================================================================
-- 2. model_events — 模型加载/卸载事件表
-- =============================================================================
CREATE TABLE IF NOT EXISTS model_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,           -- 事件时间戳（Unix ms）
    event_type      TEXT    NOT NULL,           -- 'load_start' | 'load_done' | 'unload' | 'load_failed'
    model_type      TEXT    NOT NULL,           -- 'embedding' | 'llm' | 'vlm' | 'asr' | 'ocr'
    model_name      TEXT    NOT NULL,           -- 模型名称
    duration_ms     INTEGER,                    -- 加载耗时（load_done 时填写）
    memory_mb       INTEGER,                    -- 模型预计内存占用 MB
    mem_before_mb   INTEGER,                    -- 操作前系统可用内存 MB
    mem_after_mb    INTEGER,                    -- 操作后系统可用内存 MB
    error_msg       TEXT                        -- 失败原因（load_failed 时填写）
);

CREATE INDEX IF NOT EXISTS idx_model_events_ts   ON model_events(ts);
CREATE INDEX IF NOT EXISTS idx_model_events_type ON model_events(model_type);

-- 记录迁移完成
INSERT OR IGNORE INTO schema_migrations (version, applied_at)
VALUES ('007_system_metrics', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
