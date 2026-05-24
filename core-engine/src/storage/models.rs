//! 与数据库表一一对应的 Rust 数据模型
//!
//! 命名规范：
//! - `XxxRecord`  — 从数据库读出的完整行（含 id）
//! - `NewXxx`     — 插入时用的参数结构体（不含 id/ts 等自动生成字段）

use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────────────────────
// captures 表
// ─────────────────────────────────────────────────────────────────────────────

/// 触发采集的事件类型
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventType {
    AppSwitch,
    MouseClick,
    Scroll,
    KeyPause,
    Manual,
    Auto,
}

impl EventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventType::AppSwitch => "app_switch",
            EventType::MouseClick => "mouse_click",
            EventType::Scroll => "scroll",
            EventType::KeyPause => "key_pause",
            EventType::Manual => "manual",
            EventType::Auto => "auto",
        }
    }
}

impl TryFrom<&str> for EventType {
    type Error = String;
    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s {
            "app_switch" => Ok(EventType::AppSwitch),
            "mouse_click" => Ok(EventType::MouseClick),
            "scroll" => Ok(EventType::Scroll),
            "key_pause" => Ok(EventType::KeyPause),
            "manual" => Ok(EventType::Manual),
            "auto" => Ok(EventType::Auto),
            other => Err(format!("未知事件类型: {other}")),
        }
    }
}

/// 从 captures 表读出的完整行
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptureRecord {
    pub id: i64,
    pub ts: i64,
    pub app_name: Option<String>,
    pub app_bundle_id: Option<String>,
    pub win_title: Option<String>,
    pub event_type: String,
    pub ax_text: Option<String>,
    pub ax_focused_role: Option<String>,
    pub ax_focused_id: Option<String>,
    pub ocr_text: Option<String>,
    pub screenshot_path: Option<String>,
    pub screenshot_source: Option<String>,
    pub input_text: Option<String>,
    pub audio_text: Option<String>,
    pub is_sensitive: bool,
    pub pii_scrubbed: bool,
    pub url: Option<String>,
    pub webpage_title: Option<String>,
}

impl CaptureRecord {
    /// 返回最佳文本（ax_text 优先，fallback 到 ocr_text）
    pub fn best_text(&self) -> Option<&str> {
        self.ax_text.as_deref().or(self.ocr_text.as_deref())
    }
}

/// 插入 captures 时使用的参数
#[derive(Debug, Clone)]
pub struct NewCapture {
    pub ts: i64,
    pub app_name: Option<String>,
    pub app_bundle_id: Option<String>,
    pub win_title: Option<String>,
    pub event_type: EventType,
    pub ax_text: Option<String>,
    pub ax_focused_role: Option<String>,
    pub ax_focused_id: Option<String>,
    pub ocr_text: Option<String>,
    pub screenshot_path: Option<String>,
    pub screenshot_source: Option<String>,
    pub input_text: Option<String>,
    pub is_sensitive: bool,
    pub url: Option<String>,
    pub webpage_title: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// user_preferences 表
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreferenceRecord {
    pub id: i64,
    pub key: String,
    pub value: String,
    pub source: String,
    pub confidence: f64,
    pub updated_at: i64,
    pub sample_count: i64,
}

// ─────────────────────────────────────────────────────────────────────────────
// action_logs 表
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionStatus {
    Pending,
    Success,
    Failed,
    Cancelled,
    Interrupted,
}

impl ActionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionStatus::Pending => "pending",
            ActionStatus::Success => "success",
            ActionStatus::Failed => "failed",
            ActionStatus::Cancelled => "cancelled",
            ActionStatus::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionLogRecord {
    pub id: i64,
    pub ts: i64,
    pub trigger_source: String,
    pub app_name: Option<String>,
    pub action_type: String,
    pub action_payload: String, // JSON 字符串
    pub confirmed_by_user: bool,
    pub status: String,
    pub user_correction: Option<String>,
    pub error_msg: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewActionLog {
    pub ts: i64,
    pub trigger_source: String,
    pub app_name: Option<String>,
    pub action_type: String,
    pub action_payload: String, // JSON 序列化后的字符串
    pub confirmed_by_user: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// style_samples 表
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StyleSampleRecord {
    pub id: i64,
    pub ts: i64,
    pub scene_type: String,
    pub content: String,
    pub app_name: Option<String>,
    pub quality: f64,
    pub word_count: i64,
}

#[derive(Debug, Clone)]
pub struct NewStyleSample {
    pub ts: i64,
    pub scene_type: String,
    pub content: String,
    pub app_name: Option<String>,
    pub quality: f64,
}

// ─────────────────────────────────────────────────────────────────────────────
// vector_index 表
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorIndexRecord {
    pub id: i64,
    pub capture_id: i64,
    pub qdrant_point_id: String,
    pub chunk_index: i64,
    pub chunk_text: String,
    pub model_name: String,
    pub created_at: i64,
    pub doc_key: String,
    pub source_type: String,
    pub knowledge_id: Option<i64>,
    pub time: Option<i64>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub observed_at: Option<i64>,
    pub event_time_start: Option<i64>,
    pub event_time_end: Option<i64>,
    pub history_view: bool,
    pub content_origin: Option<String>,
    pub activity_type: Option<String>,
    pub is_self_generated: bool,
    pub evidence_strength: Option<String>,
    pub app_name: Option<String>,
    pub win_title: Option<String>,
    pub category: Option<String>,
    pub user_verified: bool,
}

#[derive(Debug, Clone)]
pub struct NewVectorIndex {
    pub capture_id: i64,
    pub qdrant_point_id: String,
    pub chunk_index: i64,
    pub chunk_text: String,
    pub model_name: String,
    pub created_at: i64,
    pub doc_key: String,
    pub source_type: String,
    pub knowledge_id: Option<i64>,
    pub time: Option<i64>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub observed_at: Option<i64>,
    pub event_time_start: Option<i64>,
    pub event_time_end: Option<i64>,
    pub history_view: bool,
    pub content_origin: Option<String>,
    pub activity_type: Option<String>,
    pub is_self_generated: bool,
    pub evidence_strength: Option<String>,
    pub app_name: Option<String>,
    pub win_title: Option<String>,
    pub category: Option<String>,
    pub user_verified: bool,
}

// ─────────────────────────────────────────────────────────────────────────────
// rag_sessions 表
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagSessionRecord {
    pub id: i64,
    pub ts: i64,
    pub scene_type: Option<String>,
    pub user_query: String,
    pub retrieved_ids: Option<String>, // JSON 数组字符串
    pub prompt_used: Option<String>,
    pub llm_response: Option<String>,
    pub user_feedback: Option<String>,
    pub latency_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct NewRagSession {
    pub ts: i64,
    pub scene_type: Option<String>,
    pub user_query: String,
    pub retrieved_ids: Option<String>,
    pub prompt_used: Option<String>,
    pub llm_response: Option<String>,
    pub latency_ms: Option<i64>,
}

// ─────────────────────────────────────────────────────────────────────────────
// app_blacklist 表
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppBlacklistRecord {
    pub id: i64,
    pub bundle_id: String,
    pub app_name: String,
    pub enabled: bool,
    pub reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewAppBlacklist {
    pub bundle_id: String,
    pub app_name: String,
    pub enabled: bool,
    pub reason: Option<String>,
}

// ─────────────────────────────────────────────────────────────────────────────
// privacy_filters 表
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacyFilterRecord {
    pub id: i64,
    pub filter_type: String,
    pub filter_name: String,
    pub enabled: bool,
    pub config_json: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewPrivacyFilter {
    pub filter_type: String,
    pub filter_name: String,
    pub enabled: bool,
    pub config_json: Option<String>,
}

/// 隐私拦截统计记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrivacyBlockStat {
    pub id: i64,
    pub stat_type: String,
    pub target_id: String,
    pub block_count: i64,
    pub week_start: String,
    pub updated_at: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// user_profiles 表
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfileRecord {
    pub id: i64,
    pub snapshot_type: String,
    pub snapshot_date: String,
    pub content: String,
    pub is_system_generated: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewUserProfile {
    pub snapshot_type: String,
    pub snapshot_date: String,
    pub content: String,
    pub is_system_generated: bool,
}
