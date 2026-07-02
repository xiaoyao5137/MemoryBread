-- 036_seed_capture_retention_days.sql
-- 为已有安装补充采集记录保留天数默认配置。

INSERT OR IGNORE INTO user_preferences (key, value, source, confidence, updated_at, sample_count)
VALUES (
    'privacy.capture_retention_days',
    '14',
    'manual',
    1.0,
    CAST(strftime('%s','now') * 1000 AS INTEGER),
    0
);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('036_seed_capture_retention_days', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
