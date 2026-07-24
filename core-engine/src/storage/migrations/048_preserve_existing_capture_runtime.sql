-- 新版本将首次安装的采集开关改为默认关闭。升级用户在该偏好键出现前
-- 已经明确使用过采集，因此为有历史采集记录的旧库保留原来的开启状态。
-- 空库不会写入此键，仍由首次引导显式开启。

INSERT OR IGNORE INTO user_preferences
    (key, value, source, confidence, updated_at, sample_count)
SELECT
    'runtime.capture_enabled',
    'true',
    'manual',
    1.0,
    CAST(strftime('%s', 'now') * 1000 AS INTEGER),
    0
WHERE EXISTS (SELECT 1 FROM captures LIMIT 1);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('048_preserve_existing_capture_runtime', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
