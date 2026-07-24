-- 默认开启节能模式。用户可在设置页关闭，关闭后后台任务恢复原始吞吐策略。

INSERT OR IGNORE INTO user_preferences
    (key, value, source, confidence, updated_at, sample_count)
VALUES
    (
        'performance.energy_saving_mode',
        'true',
        'manual',
        1.0,
        CAST(strftime('%s', 'now') * 1000 AS INTEGER),
        0
    );

INSERT INTO schema_migrations (version, applied_at)
VALUES ('046_seed_energy_saving_mode', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
