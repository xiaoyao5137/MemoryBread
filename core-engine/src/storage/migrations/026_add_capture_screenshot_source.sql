-- captures.screenshot_source: 'window' | 'fullscreen' | NULL（历史数据）
-- 用于诊断截图是否拿到了前台窗口（window），还是回退到了全屏（fullscreen）；
-- 全屏 OCR 可能扫到屏幕上其他 app 的窗口内容，引入跨页面噪声。
ALTER TABLE captures ADD COLUMN screenshot_source TEXT;
