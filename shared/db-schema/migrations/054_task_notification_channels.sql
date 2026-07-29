-- 任务结果消息渠道保持在本地 SQLite；webhook 地址不会同步到云端。
ALTER TABLE scheduled_tasks
  ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0;

ALTER TABLE scheduled_tasks
  ADD COLUMN notification_channel_ids TEXT NOT NULL DEFAULT '[]';

UPDATE scheduled_tasks
SET is_builtin = 1
WHERE template_id IN ('daily_journal', 'weekly_report', 'monthly_summary');

CREATE TABLE IF NOT EXISTS notification_channels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  channel_type TEXT NOT NULL CHECK (channel_type IN ('feishu', 'dingtalk', 'wecom', 'webhook')),
  webhook_url  TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_channels_enabled
  ON notification_channels(enabled, id);

CREATE TABLE IF NOT EXISTS task_notification_deliveries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id  INTEGER NOT NULL REFERENCES task_executions(id) ON DELETE CASCADE,
  channel_id    INTEGER NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  error_message TEXT,
  delivered_at  INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE (execution_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_task_notification_deliveries_execution
  ON task_notification_deliveries(execution_id, id);

INSERT INTO schema_migrations (version, applied_at)
VALUES ('054_task_notification_channels', CAST(strftime('%s', 'now') * 1000 AS INTEGER));
