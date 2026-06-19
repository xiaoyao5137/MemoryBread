-- 035_seed_privacy_defaults.sql
-- 补齐隐私页默认配置。031 只确保表存在，不会写入默认项；
-- 因此已有库可能出现隐私页配置为空或缺少微信、照片等敏感应用的情况。

INSERT OR IGNORE INTO app_blacklist (bundle_id, app_name, enabled, reason) VALUES
    ('com.tencent.xinWeChat', '微信', 1, '个人聊天软件，默认跳过采集'),
    ('com.tencent.qq', 'QQ', 1, '个人聊天软件，默认跳过采集'),
    ('com.apple.Photos', '照片', 1, '个人相册，默认跳过采集'),
    ('com.apple.Notes', '备忘录', 1, '个人笔记，默认跳过采集'),
    ('com.apple.iChat', '信息', 1, '系统消息，默认跳过采集'),
    ('com.apple.MobileSMS', '短信', 1, '个人短信，默认跳过采集'),
    ('com.apple.AddressBook', '通讯录', 1, '个人联系人，默认跳过采集'),
    ('com.apple.mail', '邮件', 1, '个人邮件，默认跳过采集'),
    ('com.apple.FaceTime', 'FaceTime', 1, '视频通话，默认跳过采集'),
    ('com.apple.keychainaccess', '钥匙串访问', 1, '系统钥匙串，禁止采集'),
    ('com.agilebits.onepassword7', '1Password', 1, '密码管理器，禁止采集');

INSERT OR IGNORE INTO privacy_filters (filter_type, filter_name, enabled, config_json) VALUES
    ('chat', '敏感聊天内容过滤', 1, '{
  "keywords": ["密码", "验证码", "身份证", "银行卡", "支付宝", "微信支付"],
  "patterns": [
    "密码[:：]\\s*.+",
    "验证码[:：]\\s*\\d+",
    "账号[:：]\\s*.+"
  ]
}'),
    ('pii', '身份与个人信息过滤', 1, '{
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
    "phone": "1[3-9]\\d{9}",
    "email": "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"
  }
}'),
    ('policy', '敏感政策信息过滤', 1, '{
  "keywords": ["涉密", "机密", "内部文件", "保密协议"],
  "context_window": 50
}');

CREATE INDEX IF NOT EXISTS idx_app_blacklist_bundle ON app_blacklist(bundle_id) WHERE enabled = 1;
CREATE INDEX IF NOT EXISTS idx_privacy_filters_type ON privacy_filters(filter_type) WHERE enabled = 1;
