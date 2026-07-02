-- =============================================================================
-- 记忆面包 数据库默认配置种子数据
-- 迁移版本: 002_seed_defaults
-- 描述: 写入应用启动所需的默认用户偏好和系统配置
-- 依赖: 001_init.sql
-- =============================================================================

-- =============================================================================
-- 默认用户偏好（首次安装时写入，用户可在设置页覆盖）
-- =============================================================================
INSERT OR IGNORE INTO user_preferences (key, value, source, confidence, updated_at, sample_count) VALUES

    -- ——— 文字风格偏好 ———
    ('style.greeting',          '"你好"',           'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('style.sign_off',          '"谢谢"',           'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('style.formality',         '"semi-formal"',    'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 'formal'正式 / 'semi-formal'半正式 / 'casual'轻松

    -- ——— 排版格式偏好 ———
    ('format.list_style',       '"dash"',           'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 'dash'用"-" / 'bullet'用"·" / 'number'用"1."
    ('format.paragraph_break',  '"double"',         'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 'single'单换行 / 'double'双换行
    ('format.emoji_usage',      '"none"',           'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 'none'不用 / 'sparse'偶尔 / 'rich'经常

    -- ——— 工作习惯 ———
    ('habit.work_start_hour',   '9',                'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('habit.work_end_hour',     '18',               'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('habit.weekly_report_day', '"friday"',         'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('habit.primary_im',        '"feishu"',         'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 'feishu'飞书 / 'dingtalk'钉钉 / 'wechat_work'企微

    -- ——— 隐私与采集策略 ———
    ('privacy.capture_mode',    '"event_driven"',   'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 'event_driven'事件驱动 / 'interval'定时（备用）
    ('privacy.capture_interval_sec', '30',          'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 定时模式下的采集间隔（秒）
    ('privacy.keyboard_capture','true',             'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('privacy.audio_capture',   'false',            'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('privacy.screenshot_keep_days', '90',          'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 截图文件保留天数，超出自动删除
    ('privacy.capture_retention_days', '14',        'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 原始采集记录保留天数，超出自动清空；时间线/知识/操作记录等提炼物不清空

    -- ——— 大模型配置 ———
    ('llm.provider',            '"ollama"',         'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 'ollama'本地 / 'qianwen'通义 / 'ernie'文心 / 'claude'
    ('llm.model_name',          '"qwen2.5:7b"',     'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('llm.api_base',            '"http://localhost:11434"', 'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('llm.api_key',             '""',               'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 云端模型 API Key（本地模型留空）
    ('llm.max_context_tokens',  '8192',             'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('llm.temperature',         '0.7',              'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),

    -- ——— 自动化执行策略 ———
    ('executor.mode',           '"semi-auto"',      'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 'semi-auto'需确认 / 'full-auto'全自动 / 'disabled'关闭
    ('executor.confirm_timeout_sec', '10',          'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 接管确认弹窗超时后自动取消

    -- ——— RAG 检索策略 ———
    ('rag.top_k',               '10',               'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
    ('rag.keyword_weight',      '0.4',              'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- RRF 混合检索中关键词权重（语义权重=1-此值）
    ('rag.time_decay_days',     '30',               'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 超过N天的记录在排名中降权
    ('rag.chunk_size',          '512',              'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0),
                                                    -- 文本向量化时的分块大小（字符数）
    ('rag.chunk_overlap',       '64',               'manual', 1.0, CAST(strftime('%s','now')*1000 AS INTEGER), 0);
                                                    -- 相邻分块的重叠字符数


-- =============================================================================
-- 记录本次迁移完成
-- =============================================================================
INSERT INTO schema_migrations (version, applied_at)
VALUES ('002_seed_defaults', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
