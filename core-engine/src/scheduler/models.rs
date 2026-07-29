//! 定时任务数据模型

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: i64,
    pub name: String,
    pub user_instruction: String,
    pub cron_expression: String,
    pub enabled: bool,
    pub template_id: Option<String>,
    pub is_builtin: bool,
    pub can_delete: bool,
    pub notification_channel_ids: Vec<i64>,
    pub run_count: i64,
    pub last_run_at: Option<i64>,
    pub last_run_status: Option<String>,
    pub next_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewScheduledTask {
    pub name: String,
    pub user_instruction: String,
    pub cron_expression: String,
    pub template_id: Option<String>,
    #[serde(default)]
    pub notification_channel_ids: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateScheduledTask {
    pub name: Option<String>,
    pub user_instruction: Option<String>,
    pub cron_expression: Option<String>,
    pub enabled: Option<bool>,
    pub notification_channel_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationChannel {
    pub id: i64,
    pub name: String,
    pub channel_type: String,
    pub webhook_url: String,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewNotificationChannel {
    pub name: String,
    pub channel_type: String,
    pub webhook_url: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateNotificationChannel {
    pub name: Option<String>,
    pub channel_type: Option<String>,
    pub webhook_url: Option<String>,
    pub enabled: Option<bool>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskExecution {
    pub id: i64,
    pub task_id: i64,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub status: String, // "running" | "success" | "failed"
    pub knowledge_count: Option<i64>,
    pub token_used: Option<i64>,
    pub result_text: Option<String>,
    pub error_message: Option<String>,
    pub latency_ms: Option<i64>,
    pub notification_deliveries: Vec<TaskNotificationDelivery>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskNotificationDelivery {
    pub channel_id: i64,
    pub channel_name: String,
    pub channel_type: String,
    pub status: String,
    pub error_message: Option<String>,
    pub delivered_at: Option<i64>,
}
