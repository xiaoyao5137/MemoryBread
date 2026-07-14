-- =============================================================================
-- 记忆面包 数据库初始化脚本
-- 迁移版本: 001_init
-- 描述: 创建所有核心表、FTS5 全文索引、触发器和基础配置
-- 数据库引擎: SQLite 3.x + FTS5 扩展
-- =============================================================================

-- 开启 WAL 模式（Write-Ahead Logging），解决多进程并发读写冲突
PRAGMA journal_mode = WAL;
-- 开启外键约束
PRAGMA foreign_keys = ON;
-- 设置页大小为 4KB（优化大量文本读取性能）
PRAGMA page_size = 4096;

-- =============================================================================
-- 表 1: schema_migrations — 数据库迁移版本记录
-- 作用: 追踪已执行的迁移，防止重复执行
-- =============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT    PRIMARY KEY,            -- 迁移版本号，如 "001_init"
    applied_at  INTEGER NOT NULL                -- 执行时间戳（Unix ms）
);


-- =============================================================================
-- 表 2: captures — 核心采集事件主表
-- 作用: 存储所有屏幕感知事件，每一行代表一次"屏幕实质性变化"触发的采集快照
-- 所有多模态数据流（截图/键盘/音频）通过毫秒时间戳 ts 对齐
-- =============================================================================
CREATE TABLE IF NOT EXISTS captures (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,           -- 采集时间戳（Unix 毫秒），多模态对齐基准
    app_name        TEXT,                       -- 当前激活应用名，如 "Feishu"、"Chrome"
    app_bundle_id   TEXT,                       -- macOS Bundle ID 或 Windows 进程名
    win_title       TEXT,                       -- 窗口标题
    event_type      TEXT NOT NULL DEFAULT 'auto',
                                                -- 触发事件类型：
                                                --   'app_switch'   应用切换
                                                --   'browser_navigation' 浏览器 URL / 标签页切换
                                                --   'mouse_click'  鼠标点击
                                                --   'scroll'       页面滚动
                                                --   'key_pause'    键盘停顿(>2s)
                                                --   'manual'       用户手动唤醒
                                                --   'auto'         定时兜底采集
    ax_text         TEXT,                       -- OCR 前程序化提取文本（历史名 ax_text；可能来自 AX Tree、浏览器 DOM innerText 或专用提取器，优先）
    ax_focused_role TEXT,                       -- 当前焦点元素的 AX role，如 "AXTextField"
    ax_focused_id   TEXT,                       -- 当前焦点元素的标识符（用于执行器定位）
    ocr_text        TEXT,                       -- OCR 降级识别文本（ax_text 失败时使用）
    screenshot_path TEXT,                       -- JPEG 关键帧截图相对路径，如 "2026/03/04/1709xxx.jpg"
    input_text      TEXT,                       -- 本次事件前的键盘输入片段（去密码框）
    audio_text      TEXT,                       -- ASR 转录文本（会议/录音场景）
    is_sensitive    INTEGER NOT NULL DEFAULT 0, -- 是否命中隐私过滤（1=已过滤/不记录详情）
    pii_scrubbed    INTEGER NOT NULL DEFAULT 0  -- 是否已完成 PII 脱敏（1=已脱敏）
);

-- captures 核心查询索引
CREATE INDEX IF NOT EXISTS idx_captures_ts        ON captures(ts);
CREATE INDEX IF NOT EXISTS idx_captures_app_ts    ON captures(app_name, ts);
CREATE INDEX IF NOT EXISTS idx_captures_event_ts  ON captures(event_type, ts);
CREATE INDEX IF NOT EXISTS idx_captures_sensitive ON captures(is_sensitive);


-- =============================================================================
-- 表 3: captures_fts — FTS5 全文检索虚拟表
-- 作用: 对 captures 中的文本列建立全文倒排索引，支持毫秒级中英文关键词检索
-- 使用 content= 模式（外部内容表），数据不重复存储
-- =============================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
    ax_text,
    ocr_text,
    input_text,
    audio_text,
    content    = captures,          -- 内容来源表
    content_rowid = id,             -- 关联主键
    tokenize   = 'unicode61'        -- Unicode 分词（兼容中文按字分词，后续可替换为 jieba）
);

-- FTS5 增量同步触发器：captures 写入时自动更新全文索引
CREATE TRIGGER IF NOT EXISTS captures_fts_insert
    AFTER INSERT ON captures BEGIN
    INSERT INTO captures_fts(rowid, ax_text, ocr_text, input_text, audio_text)
    VALUES (new.id, new.ax_text, new.ocr_text, new.input_text, new.audio_text);
END;

CREATE TRIGGER IF NOT EXISTS captures_fts_delete
    AFTER DELETE ON captures BEGIN
    INSERT INTO captures_fts(captures_fts, rowid, ax_text, ocr_text, input_text, audio_text)
    VALUES ('delete', old.id, old.ax_text, old.ocr_text, old.input_text, old.audio_text);
END;

CREATE TRIGGER IF NOT EXISTS captures_fts_update
    AFTER UPDATE ON captures BEGIN
    INSERT INTO captures_fts(captures_fts, rowid, ax_text, ocr_text, input_text, audio_text)
    VALUES ('delete', old.id, old.ax_text, old.ocr_text, old.input_text, old.audio_text);
    INSERT INTO captures_fts(rowid, ax_text, ocr_text, input_text, audio_text)
    VALUES (new.id, new.ax_text, new.ocr_text, new.input_text, new.audio_text);
END;


-- =============================================================================
-- 表 4: vector_index — 向量索引元数据表
-- 作用: 记录已向量化的 capture 记录及其在 Qdrant 中的 point_id
--       SQLite 存储元数据，Qdrant 存储实际向量，两者通过此表关联
-- =============================================================================
CREATE TABLE IF NOT EXISTS vector_index (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_id      INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
    qdrant_point_id TEXT    NOT NULL UNIQUE,    -- Qdrant 中的 UUID point id
    chunk_index     INTEGER NOT NULL DEFAULT 0, -- 同一 capture 的第几个文本分块
    chunk_text      TEXT    NOT NULL,           -- 实际向量化的文本分块内容
    model_name      TEXT    NOT NULL DEFAULT 'bge-m3',  -- 使用的 Embedding 模型
    created_at      INTEGER NOT NULL            -- 向量化时间戳（Unix ms）
);

CREATE INDEX IF NOT EXISTS idx_vector_capture_id ON vector_index(capture_id);
CREATE INDEX IF NOT EXISTS idx_vector_created_at ON vector_index(created_at);


-- =============================================================================
-- 表 5: action_logs — 键鼠自动化执行记录
-- 作用: 记录每次"按键精灵式接管"动作的执行详情、结果和用户反馈
--       用于伴随式学习：分析用户干预行为，优化后续自动化策略
-- =============================================================================
CREATE TABLE IF NOT EXISTS action_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,           -- 执行时间戳（Unix ms）
    trigger_source  TEXT    NOT NULL,           -- 触发来源：'auto'自动/'manual'用户手动
    app_name        TEXT,                       -- 目标应用名
    action_type     TEXT    NOT NULL,           -- 动作类型：
                                                --   'type_text'   模拟键盘输入
                                                --   'click'       模拟鼠标点击
                                                --   'key_combo'   模拟快捷键
                                                --   'scroll'      模拟滚动
    action_payload  TEXT    NOT NULL,           -- JSON：动作参数，如 {"text":"你好","target_ax_id":"xxx"}
    confirmed_by_user INTEGER NOT NULL DEFAULT 0,  -- 是否经用户确认（半自动模式=1）
    status          TEXT    NOT NULL DEFAULT 'pending',
                                                -- 执行状态：
                                                --   'pending'     待执行
                                                --   'success'     执行成功
                                                --   'failed'      执行失败
                                                --   'cancelled'   用户取消
                                                --   'interrupted' 用户中断
    user_correction TEXT,                       -- 用户对 AI 输出的修改内容（null=未修改）
    error_msg       TEXT                        -- 失败原因（status='failed' 时填写）
);

CREATE INDEX IF NOT EXISTS idx_action_logs_ts       ON action_logs(ts);
CREATE INDEX IF NOT EXISTS idx_action_logs_app      ON action_logs(app_name);
CREATE INDEX IF NOT EXISTS idx_action_logs_status   ON action_logs(status);


-- =============================================================================
-- 表 6: user_preferences — 用户偏好与个性化配置
-- 作用: 轻量级 Key-Value 存储，记录从用户行为中学习到的个人习惯
--       注入到每次 RAG Prompt 中，消除 AI 感
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_preferences (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    key         TEXT    NOT NULL UNIQUE,        -- 偏好键，命名规范: namespace.attribute
                                                -- 例: "style.greeting"、"style.sign_off"
                                                --     "format.list_style"、"habit.work_start_hour"
    value       TEXT    NOT NULL,               -- 偏好值（JSON 字符串或纯文本）
    source      TEXT    NOT NULL DEFAULT 'learned',
                                                -- 来源：'learned'(AI学习) / 'manual'(用户手动设置)
    confidence  REAL    NOT NULL DEFAULT 0.5,   -- 置信度 0.0~1.0（learned 类型有效）
    updated_at  INTEGER NOT NULL,               -- 最后更新时间戳（Unix ms）
    sample_count INTEGER NOT NULL DEFAULT 1    -- 学习样本数量（越多越可信）
);

-- 预置常用偏好键（应用启动时 INSERT OR IGNORE 写入默认值）
-- 这里仅作文档说明，实际由应用代码在首次启动时写入


-- =============================================================================
-- 表 7: style_samples — 用户个人写作风格样本库
-- 作用: 存储从用户真实输入中提取的"高质量"文字样本，用于风格学习和复刻
--       在生成周报/SOP/文档时，从此表中抽样作为 few-shot 示例注入 Prompt
-- =============================================================================
CREATE TABLE IF NOT EXISTS style_samples (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,               -- 样本产生时间戳（Unix ms）
    scene_type  TEXT    NOT NULL,               -- 场景分类：
                                                --   'im_reply'    IM 消息回复
                                                --   'doc_writing' 文档撰写
                                                --   'email'       邮件
                                                --   'comment'     代码/文档注释
    content     TEXT    NOT NULL,               -- 实际文字内容
    app_name    TEXT,                           -- 来源应用
    quality     REAL    NOT NULL DEFAULT 0.5,   -- 样本质量评分 0.0~1.0（由 AI 评估）
    word_count  INTEGER NOT NULL DEFAULT 0      -- 字符数
);

CREATE INDEX IF NOT EXISTS idx_style_samples_scene  ON style_samples(scene_type);
CREATE INDEX IF NOT EXISTS idx_style_samples_ts     ON style_samples(ts);
CREATE INDEX IF NOT EXISTS idx_style_samples_quality ON style_samples(quality);


-- =============================================================================
-- 表 8: app_filters — 应用过滤规则（隐私白名单/黑名单）
-- 作用: 配置哪些应用需要采集（白名单模式）或跳过（黑名单模式）
--       命中黑名单的应用，captures 中仅记录 is_sensitive=1，不记录文本内容
-- =============================================================================
CREATE TABLE IF NOT EXISTS app_filters (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    app_name    TEXT    NOT NULL UNIQUE,        -- 应用名（模糊匹配）或 Bundle ID（精确匹配）
    filter_type TEXT    NOT NULL DEFAULT 'blacklist',
                                                -- 'blacklist' 跳过采集（隐私敏感）
                                                -- 'whitelist' 优先采集
    reason      TEXT,                           -- 备注说明
    created_at  INTEGER NOT NULL
);

-- 预置默认黑名单（敏感应用）
INSERT OR IGNORE INTO app_filters (app_name, filter_type, reason, created_at) VALUES
    ('1Password',           'blacklist', '密码管理器，禁止采集', strftime('%s','now') * 1000),
    ('Keychain Access',     'blacklist', '系统钥匙串，禁止采集', strftime('%s','now') * 1000),
    ('WeChat',              'blacklist', '私人微信，默认不采集', strftime('%s','now') * 1000),
    ('FaceTime',            'blacklist', '视频通话，禁止采集',   strftime('%s','now') * 1000),
    ('System Preferences',  'blacklist', '系统设置，禁止采集',   strftime('%s','now') * 1000),
    ('System Settings',     'blacklist', '系统设置，禁止采集',   strftime('%s','now') * 1000);


-- =============================================================================
-- 表 9: rag_sessions — RAG 查询会话记录
-- 作用: 记录每次用户主动唤醒记忆面包、进行 RAG 问答的完整上下文
--       用于追溯历史查询和改进 Prompt 策略
-- =============================================================================
CREATE TABLE IF NOT EXISTS rag_sessions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,           -- 会话开始时间戳（Unix ms）
    scene_type      TEXT,                       -- 生成场景：'weekly_report'/'sop'/'analysis'/'freeform'
    user_query      TEXT    NOT NULL,           -- 用户原始提问
    retrieved_ids   TEXT,                       -- JSON 数组：检索到的 capture id 列表
    prompt_used     TEXT,                       -- 实际发送给 LLM 的完整 Prompt（脱敏后）
    llm_response    TEXT,                       -- LLM 原始返回内容
    user_feedback   TEXT,                       -- 用户对结果的修改/反馈（null=满意未修改）
    latency_ms      INTEGER                     -- 端到端延迟（毫秒）
);

CREATE INDEX IF NOT EXISTS idx_rag_sessions_ts    ON rag_sessions(ts);
CREATE INDEX IF NOT EXISTS idx_rag_sessions_scene ON rag_sessions(scene_type);


-- =============================================================================
-- 表 10: data_cleanup_log — 数据清理记录
-- 作用: 记录自动清理任务的执行历史（如删除 90 天前的截图文件）
-- =============================================================================
CREATE TABLE IF NOT EXISTS data_cleanup_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ts              INTEGER NOT NULL,           -- 清理执行时间戳（Unix ms）
    cleanup_type    TEXT    NOT NULL,           -- 'screenshot_purge'/'old_captures'/'vacuum'
    affected_count  INTEGER NOT NULL DEFAULT 0, -- 清理的记录数
    freed_bytes     INTEGER NOT NULL DEFAULT 0, -- 释放的磁盘空间（字节）
    detail          TEXT                        -- 补充说明
);


-- =============================================================================
-- 记录本次迁移完成
-- =============================================================================
INSERT INTO schema_migrations (version, applied_at)
VALUES ('001_init', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
