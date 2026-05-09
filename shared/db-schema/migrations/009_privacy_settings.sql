-- =============================================================================
-- 迁移版本: 009_privacy_settings
-- 描述: 隐私保护模块 - 应用黑名单 + 敏感内容过滤配置
-- =============================================================================

-- 表 1: app_blacklist — 应用黑名单
-- 作用: 配置需要跳过采集的应用软件
CREATE TABLE IF NOT EXISTS app_blacklist (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id       TEXT NOT NULL UNIQUE,       -- macOS Bundle ID (如 com.tencent.xinWeChat)
    app_name        TEXT NOT NULL,              -- 显示名称
    enabled         INTEGER NOT NULL DEFAULT 1, -- 是否启用 (1=启用, 0=禁用)
    reason          TEXT,                       -- 用户备注
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 表 2: privacy_filters — 敏感内容过滤配置
-- 作用: 配置敏感内容检测规则
CREATE TABLE IF NOT EXISTS privacy_filters (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    filter_type     TEXT NOT NULL UNIQUE,       -- 过滤类型: 'chat' | 'pii' | 'policy'
    filter_name     TEXT NOT NULL,              -- 显示名称
    enabled         INTEGER NOT NULL DEFAULT 1, -- 是否启用
    config_json     TEXT,                       -- JSON 配置（检测规则、关键词等）
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 预置常见个人应用黑名单（默认启用）
INSERT INTO app_blacklist (bundle_id, app_name, enabled, reason) VALUES
('com.tencent.xinWeChat', '微信', 1, '个人聊天软件'),
('com.tencent.qq', 'QQ', 1, '个人聊天软件'),
('com.apple.Photos', '照片', 1, '个人相册'),
('com.apple.Notes', '备忘录', 1, '个人笔记'),
('com.apple.iChat', '信息', 1, '系统消息'),
('com.apple.mail', '邮件', 1, '个人邮件'),
('com.apple.FaceTime', 'FaceTime', 1, '视频通话'),
('com.apple.Safari', 'Safari (私密浏览)', 0, '浏览器默认不过滤'),
('com.apple.MobileSMS', '短信', 1, '个人短信'),
('com.apple.AddressBook', '通讯录', 1, '个人联系人');

-- 预置敏感内容过滤规则（默认全部启用）
INSERT INTO privacy_filters (filter_type, filter_name, enabled, config_json) VALUES
('chat', '敏感聊天内容过滤', 1, '{
  "keywords": ["密码", "验证码", "身份证", "银行卡", "支付宝", "微信支付"],
  "patterns": [
    "密码[:：]\\s*.+",
    "验证码[:：]\\s*\\d+",
    "账号[:：]\\s*.+"
  ]
}'),
('pii', '敏感个人信息过滤', 1, '{
  "entities": [
    "CN_ID_CARD",
    "CREDIT_CARD",
    "PHONE_NUMBER",
    "EMAIL_ADDRESS",
    "BANK_ACCOUNT"
  ],
  "patterns": {
    "id_card": "\\d{17}[0-9Xx]",
    "bank_card": "\\d{16,19}",
    "phone": "1[3-9]\\d{9}"
  }
}'),
('policy', '敏感政策信息过滤', 1, '{
  "keywords": ["涉密", "机密", "内部文件", "保密协议"],
  "context_window": 50
}');

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_app_blacklist_bundle ON app_blacklist(bundle_id) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_privacy_filters_type ON privacy_filters(filter_type) WHERE enabled = 1;
