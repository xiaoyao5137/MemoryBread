-- 040_update_default_capture_interval.sql
-- 将旧安装中的首次安装默认采集间隔从 30 秒放宽到 90 秒，降低截图/OCR 尖峰对鼠标手感的影响。

UPDATE user_preferences
SET value = '90',
    updated_at = CAST(strftime('%s', 'now') * 1000 AS INTEGER)
WHERE key = 'privacy.capture_interval_sec'
  AND value = '30'
  AND source = 'manual'
  AND sample_count = 0;

INSERT INTO schema_migrations (version, applied_at)
VALUES ('040_update_default_capture_interval', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
