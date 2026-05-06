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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateScheduledTask {
    pub name: Option<String>,
    pub user_instruction: Option<String>,
    pub cron_expression: Option<String>,
    pub enabled: Option<bool>,
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
}
