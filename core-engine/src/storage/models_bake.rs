use serde::{Deserialize, Serialize};

use crate::storage::db::current_ts_ms;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeTemplateRecord {
    pub id: i64,
    pub name: String,
    pub category: String,
    pub status: String,
    pub tags: String,
    pub applicable_tasks: String,
    pub source_memory_ids: String,
    pub source_capture_ids: String,
    pub source_episode_ids: String,
    pub linked_knowledge_ids: String,
    pub structure_sections: String,
    pub style_phrases: String,
    pub replacement_rules: String,
    pub prompt_hint: Option<String>,
    pub diagram_code: Option<String>,
    pub image_assets: String,
    pub usage_count: i64,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub creation_mode: String,
    pub review_status: String,
    pub evidence_summary: Option<String>,
    pub generation_version: Option<String>,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewBakeTemplate {
    pub name: String,
    pub category: String,
    pub status: String,
    pub tags: String,
    pub applicable_tasks: String,
    pub source_memory_ids: String,
    pub source_capture_ids: String,
    pub source_episode_ids: String,
    pub linked_knowledge_ids: String,
    pub structure_sections: String,
    pub style_phrases: String,
    pub replacement_rules: String,
    pub prompt_hint: Option<String>,
    pub diagram_code: Option<String>,
    pub image_assets: String,
    pub usage_count: i64,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub creation_mode: String,
    pub review_status: String,
    pub evidence_summary: Option<String>,
    pub generation_version: Option<String>,
    pub deleted_at: Option<i64>,
}

impl NewBakeTemplate {
    pub fn with_defaults(name: String, category: String) -> Self {
        Self {
            name,
            category,
            status: "draft".to_string(),
            tags: "[]".to_string(),
            applicable_tasks: "[]".to_string(),
            source_memory_ids: "[]".to_string(),
            source_capture_ids: "[]".to_string(),
            source_episode_ids: "[]".to_string(),
            linked_knowledge_ids: "[]".to_string(),
            structure_sections: "[]".to_string(),
            style_phrases: "[]".to_string(),
            replacement_rules: "[]".to_string(),
            prompt_hint: None,
            diagram_code: None,
            image_assets: "[]".to_string(),
            usage_count: 0,
            match_score: None,
            match_level: None,
            creation_mode: "manual".to_string(),
            review_status: "draft".to_string(),
            evidence_summary: None,
            generation_version: None,
            deleted_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewKnowledgeEntry {
    pub capture_id: i64,
    pub summary: String,
    pub overview: Option<String>,
    pub details: Option<String>,
    pub entities: String,
    pub category: String,
    pub importance: i64,
    pub occurrence_count: Option<i64>,
    pub observed_at: Option<i64>,
    pub event_time_start: Option<i64>,
    pub event_time_end: Option<i64>,
    pub history_view: bool,
    pub content_origin: Option<String>,
    pub activity_type: Option<String>,
    pub is_self_generated: bool,
    pub evidence_strength: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeEntryRecord {
    pub id: i64,
    pub capture_id: i64,
    pub summary: String,
    pub overview: Option<String>,
    pub details: Option<String>,
    pub entities: String,
    pub category: String,
    pub importance: i64,
    pub occurrence_count: Option<i64>,
    pub observed_at: Option<i64>,
    pub event_time_start: Option<i64>,
    pub event_time_end: Option<i64>,
    pub history_view: bool,
    pub content_origin: Option<String>,
    pub activity_type: Option<String>,
    pub is_self_generated: bool,
    pub evidence_strength: Option<String>,
    pub user_verified: bool,
    pub user_edited: bool,
    pub created_at: String,
    pub updated_at: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeMemorySourceRecord {
    pub knowledge: KnowledgeEntryRecord,
    pub capture_ts: i64,
    pub capture_app_name: Option<String>,
    pub capture_win_title: Option<String>,
    pub capture_ax_text: Option<String>,
    pub capture_ocr_text: Option<String>,
    pub capture_input_text: Option<String>,
    pub capture_audio_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeActivityRecord {
    pub message: String,
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeOverviewRecord {
    pub capture_count: i64,
    pub memory_count: i64,
    pub knowledge_count: i64,
    pub template_count: i64,
    pub pending_candidates: i64,
    pub auto_created_today: i64,
    pub candidate_today: i64,
    pub discarded_today: i64,
    pub last_bake_run_status: Option<String>,
    pub last_bake_run_at: Option<i64>,
    pub last_trigger_reason: Option<String>,
    pub knowledge_auto_count: i64,
    pub template_auto_count: i64,
    pub sop_auto_count: i64,
    pub recent_activities: Vec<BakeActivityRecord>,
}

impl BakeOverviewRecord {
    pub fn empty() -> Self {
        Self {
            capture_count: 0,
            memory_count: 0,
            knowledge_count: 0,
            template_count: 0,
            pending_candidates: 0,
            auto_created_today: 0,
            candidate_today: 0,
            discarded_today: 0,
            last_bake_run_status: None,
            last_bake_run_at: None,
            last_trigger_reason: None,
            knowledge_auto_count: 0,
            template_auto_count: 0,
            sop_auto_count: 0,
            recent_activities: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewBakeRun {
    pub trigger_reason: String,
    pub status: String,
    pub started_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeRunRecord {
    pub id: i64,
    pub trigger_reason: String,
    pub status: String,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub processed_episode_count: i64,
    pub auto_created_count: i64,
    pub candidate_count: i64,
    pub discarded_count: i64,
    pub knowledge_created_count: i64,
    pub template_created_count: i64,
    pub sop_created_count: i64,
    pub error_message: Option<String>,
    pub latency_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeWatermarkRecord {
    pub pipeline_name: String,
    pub last_processed_ts: i64,
    pub updated_at: i64,
}

pub fn now_ms() -> i64 {
    current_ts_ms()
}
