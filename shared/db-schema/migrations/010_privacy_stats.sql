-- 表 3: privacy_block_stats — 隐私拦截统计
CREATE TABLE IF NOT EXISTS privacy_block_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    stat_type       TEXT NOT NULL,              -- 'blacklist' | 'filter'
    target_id       TEXT NOT NULL,              -- bundle_id 或 filter_type
    block_count     INTEGER NOT NULL DEFAULT 0, -- 拦截次数
    week_start      TEXT NOT NULL,              -- 本周开始日期 (YYYY-MM-DD)
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(stat_type, target_id, week_start)
);

CREATE INDEX IF NOT EXISTS idx_privacy_stats_week ON privacy_block_stats(week_start);
