-- 为已安装用户补充兜底敏感内容规则；INSERT OR IGNORE 保留用户已有配置。
INSERT OR IGNORE INTO privacy_filters (filter_type, filter_name, enabled, config_json) VALUES
    ('other', '其它敏感信息过滤', 1, '{
  "keywords": [
    "成人信息",
    "成人内容",
    "色情信息",
    "色情内容",
    "成人视频",
    "色情网站",
    "黄色网站",
    "裸聊"
  ]
}');
