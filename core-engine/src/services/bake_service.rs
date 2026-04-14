use std::time::Duration;

use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::error::ApiError;
use crate::storage::{
    now_ms,
    BakeActivityRecord,
    BakeMemorySourceRecord,
    BakeOverviewRecord,
    BakeRunRecord,
    BakeTemplateRecord,
    KnowledgeEntryRecord,
    NewBakeRun,
    NewBakeTemplate,
    NewKnowledgeEntry,
    StorageError,
    StorageManager,
};
use crate::storage::models::CaptureRecord;

const BAKE_STYLE_CONFIG_KEY: &str = "bake.style.config";
const CATEGORY_BAKE_ARTICLE: &str = "bake_article";
const CATEGORY_BAKE_SOP: &str = "bake_sop";
const CATEGORY_BAKE_KNOWLEDGE: &str = "bake_knowledge";
const UNIFIED_BAKE_PIPELINE_NAME: &str = "unified";
const BAKE_GENERATION_VERSION: &str = "bake-v1";
const MATCH_LEVEL_HIGH: &str = "high";
const MATCH_LEVEL_MEDIUM: &str = "medium";
const MATCH_LEVEL_LOW: &str = "low";
const BAKE_SIDECAR_TIMEOUT_SECS: u64 = 360;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakePagedResponse<T> {
    pub items: Vec<T>,
    pub total: i64,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BakeBucket {
    Extracted,
    Pending,
}

impl BakeBucket {
    pub fn from_query(value: Option<&str>) -> Result<Option<Self>, ApiError> {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            None => Ok(None),
            Some("extracted") => Ok(Some(Self::Extracted)),
            Some("pending") => Ok(Some(Self::Pending)),
            Some(other) => Err(ApiError::BadRequest(format!("invalid bake bucket: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct BakeMemoryFilter {
    pub q: Option<String>,
    pub from_ts: Option<i64>,
    pub to_ts: Option<i64>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, Default)]
pub struct BakeListFilter {
    pub q: Option<String>,
    pub bucket: Option<BakeBucket>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, Default)]
pub struct BakeCaptureFilter {
    pub q: Option<String>,
    pub from_ts: Option<i64>,
    pub to_ts: Option<i64>,
    pub source_capture_id: Option<i64>,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeCapturePayload {
    pub id: String,
    pub ts: i64,
    pub app_name: Option<String>,
    pub app_bundle_id: Option<String>,
    pub win_title: Option<String>,
    pub event_type: String,
    pub semantic_type_label: String,
    pub raw_type_label: String,
    pub ax_text: Option<String>,
    pub ax_focused_role: Option<String>,
    pub ax_focused_id: Option<String>,
    pub ocr_text: Option<String>,
    pub input_text: Option<String>,
    pub audio_text: Option<String>,
    pub screenshot_path: Option<String>,
    pub is_sensitive: bool,
    pub pii_scrubbed: bool,
    pub best_text: Option<String>,
    pub summary: Option<String>,
    pub linked_knowledge_id: Option<String>,
    pub linked_knowledge_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeKnowledgePayload {
    pub id: String,
    pub capture_id: String,
    pub summary: String,
    pub overview: Option<String>,
    pub details: Option<String>,
    pub entities: Vec<String>,
    pub category: String,
    pub importance: i64,
    pub occurrence_count: i64,
    pub observed_at: Option<i64>,
    pub status: String,
    pub review_status: String,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub updated_at: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeStyleConfig {
    pub preferred_phrases: Vec<String>,
    pub replacement_rules: Vec<ReplacementRulePayload>,
    pub style_samples: Vec<String>,
    pub apply_to_creation: bool,
    pub apply_to_template_editing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplacementRulePayload {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateSectionPayload {
    pub title: String,
    pub keywords: Vec<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeTemplatePayload {
    pub id: String,
    pub name: String,
    pub category: String,
    pub status: String,
    pub tags: Vec<String>,
    pub applicable_tasks: Vec<String>,
    pub source_article_ids: Vec<String>,
    pub source_memory_ids: Vec<String>,
    pub source_capture_ids: Vec<String>,
    pub source_episode_ids: Vec<String>,
    pub linked_knowledge_ids: Vec<String>,
    pub structure_sections: Vec<TemplateSectionPayload>,
    pub style_phrases: Vec<String>,
    pub replacement_rules: Vec<ReplacementRulePayload>,
    pub prompt_hint: Option<String>,
    pub diagram_code: Option<String>,
    pub image_assets: Vec<String>,
    pub usage_count: i64,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub creation_mode: String,
    pub review_status: String,
    pub evidence_summary: Option<String>,
    pub generation_version: Option<String>,
    pub deleted_at: Option<i64>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeMemoryPayload {
    pub id: String,
    pub title: String,
    pub url: Option<String>,
    pub source_capture_id: Option<String>,
    pub source_knowledge_id: Option<String>,
    pub summary: Option<String>,
    pub weight: i64,
    pub open_count: i64,
    pub dwell_seconds: i64,
    pub has_edit_action: bool,
    pub knowledge_ref_count: i64,
    pub status: String,
    pub suggested_action: Option<String>,
    pub tags: Vec<String>,
    pub last_visited_at: Option<String>,
    pub created_at: String,
    pub created_at_ms: i64,
    pub knowledge_match_score: Option<f64>,
    pub knowledge_match_level: Option<String>,
    pub template_match_score: Option<f64>,
    pub template_match_level: Option<String>,
    pub sop_match_score: Option<f64>,
    pub sop_match_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeSopPayload {
    pub id: String,
    pub source_capture_id: String,
    pub source_title: Option<String>,
    pub trigger_keywords: Vec<String>,
    pub confidence: String,
    pub extracted_problem: Option<String>,
    pub steps: Vec<String>,
    pub linked_knowledge_ids: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeOverviewPayload {
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
    pub recent_activities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeRunPayload {
    pub id: String,
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
pub struct InitializeBakeMemoriesResponse {
    pub created_count: i64,
    pub skipped_count: i64,
    pub articles: Vec<BakeMemoryPayload>,
    pub memories: Vec<BakeMemoryPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeExtractRequest {
    pub trigger_reason: String,
    pub candidate: BakeExtractCandidatePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeExtractCandidatePayload {
    pub source_knowledge_id: i64,
    pub source_capture_id: i64,
    pub summary: String,
    pub overview: Option<String>,
    pub details: Option<String>,
    pub entities: Vec<String>,
    pub importance: i64,
    pub occurrence_count: Option<i64>,
    pub observed_at: Option<i64>,
    pub event_time_start: Option<i64>,
    pub event_time_end: Option<i64>,
    pub history_view: bool,
    pub content_origin: Option<String>,
    pub activity_type: Option<String>,
    pub evidence_strength: Option<String>,
    pub capture_ts: i64,
    pub capture_app_name: Option<String>,
    pub capture_win_title: Option<String>,
    pub capture_ax_text: Option<String>,
    pub capture_ocr_text: Option<String>,
    pub capture_input_text: Option<String>,
    pub capture_audio_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeExtractResponse {
    pub knowledge: BakeArtifactExtraction,
    pub template: BakeArtifactExtraction,
    pub sop: BakeArtifactExtraction,
    pub usage: Option<Value>,
    pub model: Option<String>,
    pub degraded: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeArtifactExtraction {
    pub accepted: bool,
    pub reason: Option<String>,
    pub payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeKnowledgeArtifactPayload {
    pub summary: String,
    pub overview: Option<String>,
    #[serde(default)]
    pub entities: Vec<String>,
    pub importance: Option<i64>,
    pub occurrence_count: Option<i64>,
    pub observed_at: Option<i64>,
    pub event_time_start: Option<i64>,
    pub event_time_end: Option<i64>,
    pub history_view: Option<bool>,
    pub content_origin: Option<String>,
    pub activity_type: Option<String>,
    pub evidence_strength: Option<String>,
    pub evidence_summary: Option<String>,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub review_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeTemplateArtifactPayload {
    pub name: String,
    pub category: Option<String>,
    pub status: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub applicable_tasks: Vec<String>,
    #[serde(default)]
    pub linked_knowledge_ids: Vec<String>,
    #[serde(default)]
    pub structure_sections: Vec<TemplateSectionPayload>,
    #[serde(default)]
    pub style_phrases: Vec<String>,
    #[serde(default)]
    pub replacement_rules: Vec<ReplacementRulePayload>,
    pub prompt_hint: Option<String>,
    pub diagram_code: Option<String>,
    #[serde(default)]
    pub image_assets: Vec<String>,
    pub evidence_summary: Option<String>,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub review_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeSopArtifactPayload {
    pub summary: String,
    pub overview: Option<String>,
    pub source_title: Option<String>,
    #[serde(default)]
    pub trigger_keywords: Vec<String>,
    pub extracted_problem: Option<String>,
    #[serde(default)]
    pub steps: Vec<String>,
    #[serde(default)]
    pub linked_knowledge_ids: Vec<String>,
    pub confidence: Option<String>,
    pub evidence_summary: Option<String>,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub review_status: Option<String>,
}

#[derive(Debug, Clone)]
pub struct BakeSidecarError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

#[derive(Clone)]
pub struct BakeService {
    storage: StorageManager,
    sidecar_url: String,
    client: reqwest::Client,
}

impl BakeService {
    pub fn new(storage: StorageManager, sidecar_url: impl Into<String>) -> Self {
        Self {
            storage,
            sidecar_url: sidecar_url.into(),
            client: reqwest::Client::new(),
        }
    }

    pub async fn preview_memory(&self, id: i64, trigger_reason: &str) -> Result<BakeExtractResponse, ApiError> {
        let memory = self.storage
            .get_knowledge_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found")))?;
        if memory.category != CATEGORY_BAKE_ARTICLE {
            return Err(ApiError::BadRequest(format!("knowledge {id} is not in category {CATEGORY_BAKE_ARTICLE}")));
        }

        let details = parse_details(memory.details.as_deref());
        let source_knowledge_id = details
            .get("source_knowledge_id")
            .and_then(Value::as_i64)
            .ok_or_else(|| ApiError::BadRequest(format!("memory {id} missing source_knowledge_id")))?;

        let source_knowledge = self.storage
            .get_knowledge_entry(source_knowledge_id)?
            .ok_or_else(|| ApiError::NotFound(format!("source knowledge {source_knowledge_id} not found")))?;

        let capture = self.storage
            .get_capture(source_knowledge.capture_id)?
            .ok_or_else(|| ApiError::NotFound(format!("capture {} not found", source_knowledge.capture_id)))?;

        let candidate = BakeMemorySourceRecord {
            knowledge: source_knowledge,
            capture_ts: capture.ts,
            capture_app_name: capture.app_name,
            capture_win_title: capture.win_title,
            capture_ax_text: capture.ax_text,
            capture_ocr_text: capture.ocr_text,
            capture_input_text: capture.input_text,
            capture_audio_text: capture.audio_text,
        };

        self.extract_candidate(trigger_reason, &candidate).await
    }

    pub fn get_style_config(&self) -> Result<BakeStyleConfig, ApiError> {
        let maybe_value = self.storage.get_preference_value(BAKE_STYLE_CONFIG_KEY)?;
        if let Some(value) = maybe_value {
            serde_json::from_str::<BakeStyleConfig>(&value)
                .map_err(|err| ApiError::Internal(format!("解析 bake.style.config 失败: {err}")))
        } else {
            Ok(default_style_config())
        }
    }

    pub fn save_style_config(&self, config: &BakeStyleConfig) -> Result<BakeStyleConfig, ApiError> {
        let value = serde_json::to_string(config)
            .map_err(|err| ApiError::Internal(format!("序列化写作自然感配置失败: {err}")))?;
        self.storage.upsert_preference(BAKE_STYLE_CONFIG_KEY, &value, "user", 1.0)?;
        Ok(config.clone())
    }

    pub fn list_templates(&self) -> Result<Vec<BakeTemplatePayload>, ApiError> {
        Ok(self.storage.list_bake_templates()?
            .into_iter()
            .filter(is_current_bake_template)
            .map(map_template_record)
            .collect())
    }

    pub fn list_templates_paginated(&self, filter: BakeListFilter) -> Result<BakePagedResponse<BakeTemplatePayload>, ApiError> {
        let mut items = self.storage
            .list_bake_templates()?
            .into_iter()
            .filter(is_current_bake_template)
            .filter(|record| matches_template_bucket(record, filter.bucket))
            .map(map_template_record)
            .collect::<Vec<_>>();

        if let Some(query) = filter.q.as_deref() {
            let query_lower = query.to_lowercase();
            items.retain(|item| {
                item.name.to_lowercase().contains(&query_lower)
                    || item.category.to_lowercase().contains(&query_lower)
                    || item.prompt_hint.as_deref().unwrap_or_default().to_lowercase().contains(&query_lower)
            });
        }

        let total = items.len() as i64;
        let items = items.into_iter().skip(filter.offset).take(filter.limit).collect();
        Ok(BakePagedResponse { items, total, limit: filter.limit, offset: filter.offset })
    }

    pub fn create_template(&self, payload: CreateOrUpdateTemplateRequest) -> Result<BakeTemplatePayload, ApiError> {
        let record = request_to_new_template(payload)?;
        let id = self.storage.insert_bake_template(&record)?;
        let template = self.storage
            .get_bake_template(id)?
            .ok_or_else(|| ApiError::NotFound(format!("template {id} not found after insert")))?;
        Ok(map_template_record(template))
    }

    pub fn update_template(&self, id: i64, payload: CreateOrUpdateTemplateRequest) -> Result<BakeTemplatePayload, ApiError> {
        let record = request_to_new_template(payload)?;
        let updated = self.storage.update_bake_template(id, &record)?;
        if !updated {
            return Err(ApiError::NotFound(format!("template {id} not found")));
        }
        let template = self.storage
            .get_bake_template(id)?
            .ok_or_else(|| ApiError::NotFound(format!("template {id} not found after update")))?;
        Ok(map_template_record(template))
    }

    pub fn toggle_template_status(&self, id: i64) -> Result<BakeTemplatePayload, ApiError> {
        let template = self.storage
            .toggle_bake_template_status(id)?
            .ok_or_else(|| ApiError::NotFound(format!("template {id} not found")))?;
        Ok(map_template_record(template))
    }

    pub fn delete_template(&self, id: i64) -> Result<(), ApiError> {
        if !self.storage.soft_delete_bake_template(id)? {
            return Err(ApiError::NotFound(format!("template {id} not found")));
        }
        Ok(())
    }

    pub fn list_sops(&self) -> Result<Vec<BakeSopPayload>, ApiError> {
        Ok(self.storage.list_knowledge_by_category(CATEGORY_BAKE_SOP)?
            .into_iter()
            .filter(is_current_bake_entry)
            .filter(|record| matches_entry_bucket(record, None))
            .map(map_sop_record)
            .collect())
    }

    pub fn list_sops_paginated(&self, filter: BakeListFilter) -> Result<BakePagedResponse<BakeSopPayload>, ApiError> {
        let records = self.storage.list_knowledge_by_category(CATEGORY_BAKE_SOP)?;
        let filtered_records = if let Some(query) = filter.q.as_deref() {
            let query_lower = query.to_lowercase();
            records.into_iter().filter(|record| {
                is_current_bake_entry(record)
                    && matches_entry_bucket(record, filter.bucket)
                    && (record.summary.to_lowercase().contains(&query_lower)
                        || record.overview.as_deref().unwrap_or_default().to_lowercase().contains(&query_lower)
                        || record.details.as_deref().unwrap_or_default().to_lowercase().contains(&query_lower)
                        || record.category.to_lowercase().contains(&query_lower))
            }).collect::<Vec<_>>()
        } else {
            records.into_iter()
                .filter(is_current_bake_entry)
                .filter(|record| matches_entry_bucket(record, filter.bucket))
                .collect::<Vec<_>>()
        };
        let total = filtered_records.len() as i64;
        let items = filtered_records
            .into_iter()
            .skip(filter.offset)
            .take(filter.limit)
            .map(map_sop_record)
            .collect();
        Ok(BakePagedResponse { items, total, limit: filter.limit, offset: filter.offset })
    }

    pub fn adopt_sop(&self, id: i64) -> Result<BakeSopPayload, ApiError> {
        let entry = self.storage
            .get_knowledge_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("sop {id} not found")))?;
        if entry.category != CATEGORY_BAKE_SOP {
            return Err(ApiError::BadRequest(format!("knowledge {id} is not a bake sop")));
        }
        let details = parse_details(entry.details.as_deref())
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut next_details = serde_json::Map::from_iter(details);
        next_details.insert("status".to_string(), json!("confirmed"));
        next_details.insert("review_status".to_string(), json!("confirmed"));
        let entities = entry.entities.clone();
        self.storage.update_knowledge_details_system(
            id,
            &entry.summary,
            entry.overview.as_deref(),
            Some(&Value::Object(next_details).to_string()),
            &entities,
        )?;
        self.storage.set_knowledge_verified(id, true)?;
        let updated = self.storage
            .get_knowledge_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("sop {id} not found after update")))?;
        Ok(map_sop_record(updated))
    }

    pub fn ignore_sop(&self, id: i64) -> Result<BakeSopPayload, ApiError> {
        let updated = self.update_bake_artifact_status(id, CATEGORY_BAKE_SOP, "ignored")?;
        Ok(map_sop_record(updated))
    }

    pub fn delete_sop(&self, id: i64) -> Result<(), ApiError> {
        self.delete_bake_artifact(id, CATEGORY_BAKE_SOP)
    }

    pub fn list_memories(&self) -> Result<Vec<BakeMemoryPayload>, ApiError> {
        Ok(self.storage.list_knowledge_by_category(CATEGORY_BAKE_ARTICLE)?
            .into_iter()
            .map(map_memory_record)
            .collect())
    }

    pub fn list_memories_paginated(&self, filter: BakeMemoryFilter) -> Result<BakePagedResponse<BakeMemoryPayload>, ApiError> {
        let total = self.storage.count_bake_memories_filtered(filter.q.as_deref(), filter.from_ts, filter.to_ts)?;
        let items = self.storage.list_bake_memories_paginated(filter.q.as_deref(), filter.from_ts, filter.to_ts, filter.limit, filter.offset)?
            .into_iter()
            .map(map_memory_record)
            .collect();
        Ok(BakePagedResponse { items, total, limit: filter.limit, offset: filter.offset })
    }

    pub fn list_knowledge_paginated(&self, filter: BakeListFilter) -> Result<BakePagedResponse<BakeKnowledgePayload>, ApiError> {
        let records = self.storage.list_bake_knowledge_paginated(filter.q.as_deref(), 5000, 0)?;
        let filtered = records
            .into_iter()
            .filter(is_current_bake_entry)
            .filter(|record| matches_entry_bucket(record, filter.bucket))
            .map(map_bake_knowledge_record)
            .collect::<Vec<_>>();
        let total = filtered.len() as i64;
        let items = filtered.into_iter().skip(filter.offset).take(filter.limit).collect();
        Ok(BakePagedResponse { items, total, limit: filter.limit, offset: filter.offset })
    }

    pub fn ignore_knowledge(&self, id: i64) -> Result<BakeKnowledgePayload, ApiError> {
        let updated = self.update_bake_artifact_status(id, CATEGORY_BAKE_KNOWLEDGE, "ignored")?;
        Ok(map_bake_knowledge_record(updated))
    }

    pub fn delete_knowledge(&self, id: i64) -> Result<(), ApiError> {
        self.delete_bake_artifact(id, CATEGORY_BAKE_KNOWLEDGE)
    }

    pub fn list_capture_records_paginated(&self, filter: BakeCaptureFilter) -> Result<BakePagedResponse<BakeCapturePayload>, ApiError> {
        let mut capture_filter = crate::storage::repo::capture::CaptureFilter::new();
        capture_filter.limit = filter.limit;
        capture_filter.offset = filter.offset;
        capture_filter.from_ts = filter.from_ts;
        capture_filter.to_ts = filter.to_ts;
        capture_filter.query = filter.q;
        capture_filter.capture_id = filter.source_capture_id;
        let total = self.storage.count_captures(&capture_filter)?;
        let records = self.storage.list_captures(&capture_filter)?;
        let capture_ids = records.iter().map(|record| record.id).collect::<Vec<_>>();
        let knowledge_links = self.storage.list_capture_knowledge_links(&capture_ids)?;
        let items = records
            .into_iter()
            .map(|record| {
                let capture_id = record.id;
                map_capture_record(record, knowledge_links.get(&capture_id))
            })
            .collect();
        Ok(BakePagedResponse { items, total, limit: capture_filter.limit, offset: capture_filter.offset })
    }

    pub fn get_capture_record(&self, id: i64) -> Result<BakeCapturePayload, ApiError> {
        let record = self.storage
            .get_capture(id)?
            .ok_or_else(|| ApiError::NotFound(format!("capture {id} not found")))?;
        let knowledge_links = self.storage.list_capture_knowledge_links(&[record.id])?;
        Ok(map_capture_record(record, knowledge_links.get(&id)))
    }

    pub fn initialize_memories(&self, limit: usize) -> Result<InitializeBakeMemoriesResponse, ApiError> {
        let existing_memories = self.storage.list_knowledge_by_category(CATEGORY_BAKE_ARTICLE)?;
        let existing_sops = self.storage.list_knowledge_by_category(CATEGORY_BAKE_SOP)?;
        let existing_sources = collect_source_knowledge_ids(&existing_memories);
        let existing_sop_sources = collect_source_knowledge_ids(&existing_sops);

        let candidates = self.storage.list_bake_memory_init_candidates(limit.saturating_mul(4).max(limit))?;
        let mut created = Vec::new();
        let mut skipped = 0_i64;

        for candidate in candidates {
            if created.len() >= limit {
                break;
            }
            if !is_high_value_candidate(&candidate.knowledge) {
                skipped += 1;
                continue;
            }
            if existing_sources.contains(&candidate.knowledge.id) || existing_sop_sources.contains(&candidate.knowledge.id) {
                skipped += 1;
                continue;
            }

            let score = score_candidate(&candidate.knowledge);
            let record = build_bake_memory_from_source(&candidate, score)?;
            let id = self.storage.insert_knowledge_entry(&record)?;
            let memory = self.storage
                .get_knowledge_entry(id)?
                .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found after init")))?;
            created.push(map_memory_record(memory));
        }

        Ok(InitializeBakeMemoriesResponse {
            created_count: created.len() as i64,
            skipped_count: skipped,
            articles: created.clone(),
            memories: created,
        })
    }

    pub fn ignore_memory(&self, id: i64) -> Result<BakeMemoryPayload, ApiError> {
        self.update_memory_status(id, "ignored")
    }

    fn update_bake_artifact_status(
        &self,
        id: i64,
        expected_category: &str,
        status: &str,
    ) -> Result<KnowledgeEntryRecord, ApiError> {
        let entry = self.storage
            .get_knowledge_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("artifact {id} not found")))?;
        if entry.category != expected_category {
            return Err(ApiError::BadRequest(format!("knowledge {id} is not in category {expected_category}")));
        }

        let details = parse_details(entry.details.as_deref())
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut next_details = serde_json::Map::from_iter(details);
        next_details.insert("status".to_string(), json!(status));
        next_details.insert("review_status".to_string(), json!(status));
        self.storage.update_knowledge_details_system(
            id,
            &entry.summary,
            entry.overview.as_deref(),
            Some(&Value::Object(next_details).to_string()),
            &entry.entities,
        )?;
        if matches!(status, "confirmed" | "auto_created") {
            self.storage.set_knowledge_verified(id, true)?;
        }
        let updated = self.storage
            .get_knowledge_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("artifact {id} not found after update")))?;
        Ok(updated)
    }

    fn delete_bake_artifact(&self, id: i64, expected_category: &str) -> Result<(), ApiError> {
        let entry = self.storage
            .get_knowledge_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("artifact {id} not found")))?;
        if entry.category != expected_category {
            return Err(ApiError::BadRequest(format!("knowledge {id} is not in category {expected_category}")));
        }
        if extract_status(&entry) == "candidate" {
            self.update_bake_artifact_status(id, expected_category, "ignored")?;
            return Ok(());
        }
        if !self.storage.delete_knowledge_entry(id)? {
            return Err(ApiError::NotFound(format!("artifact {id} not found")));
        }
        Ok(())
    }

    pub fn promote_memory_to_template(&self, id: i64) -> Result<BakeTemplatePayload, ApiError> {
        let memory = self.storage
            .get_knowledge_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found")))?;
        let memory_payload = map_memory_record(memory.clone());
        let template = NewBakeTemplate {
            name: memory_payload.title.clone(),
            category: first_or_default(&memory_payload.tags, "精选文档"),
            status: "draft".to_string(),
            tags: to_json_string(&memory_payload.tags)?,
            applicable_tasks: to_json_string(&vec!["creation".to_string()])?,
            source_memory_ids: to_json_string(&vec![memory_payload.id.clone()])?,
            source_capture_ids: to_json_string(&memory_payload.source_capture_id.clone().into_iter().collect::<Vec<_>>())?,
            source_episode_ids: "[]".to_string(),
            linked_knowledge_ids: to_json_string(&vec![memory_payload.id.clone()])?,
            structure_sections: "[]".to_string(),
            style_phrases: "[]".to_string(),
            replacement_rules: "[]".to_string(),
            prompt_hint: memory_payload.summary.clone(),
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
        };
        let template_id = self.storage.insert_bake_template(&template)?;
        self.update_memory_status(id, "templated")?;
        let created = self.storage
            .get_bake_template(template_id)?
            .ok_or_else(|| ApiError::NotFound(format!("template {template_id} not found after insert")))?;
        Ok(map_template_record(created))
    }

    pub fn promote_memory_to_sop(&self, id: i64) -> Result<BakeSopPayload, ApiError> {
        let memory = self.storage
            .get_knowledge_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found")))?;
        let payload = map_memory_record(memory.clone());
        let details = json!({
            "source_capture_id": memory.capture_id.to_string(),
            "source_title": payload.title,
            "trigger_keywords": payload.tags,
            "confidence": "medium",
            "steps": ["确认问题类型", "查找关联知识", "输出标准说明"],
            "linked_knowledge_ids": [id.to_string()],
            "status": "candidate"
        });
        let new_entry = NewKnowledgeEntry {
            capture_id: memory.capture_id,
            summary: memory.summary,
            overview: memory.overview,
            details: Some(details.to_string()),
            entities: memory.entities,
            category: CATEGORY_BAKE_SOP.to_string(),
            importance: memory.importance.max(3),
            occurrence_count: memory.occurrence_count,
            observed_at: memory.observed_at,
            event_time_start: memory.event_time_start,
            event_time_end: memory.event_time_end,
            history_view: memory.history_view,
            content_origin: memory.content_origin,
            activity_type: memory.activity_type,
            is_self_generated: memory.is_self_generated,
            evidence_strength: memory.evidence_strength,
        };
        let sop_id = self.storage.insert_knowledge_entry(&new_entry)?;
        let created = self.storage
            .get_knowledge_entry(sop_id)?
            .ok_or_else(|| ApiError::NotFound(format!("sop {sop_id} not found after insert")))?;
        Ok(map_sop_record(created))
    }

    pub async fn run_bake_pipeline(&self, trigger_reason: &str, limit: usize) -> Result<BakeRunPayload, ApiError> {
        let started_at = now_ms();
        let run_id = self.storage.insert_bake_run(&NewBakeRun {
            trigger_reason: trigger_reason.to_string(),
            status: "running".to_string(),
            started_at,
        })?;

        let result = self.execute_bake_pipeline(run_id, trigger_reason, started_at, limit).await;
        match result {
            Ok(payload) => Ok(payload),
            Err(err) => {
                let completed_at = now_ms();
                let latency_ms = completed_at.saturating_sub(started_at);
                let _ = self.storage.complete_bake_run(
                    run_id,
                    "failed",
                    completed_at,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    0,
                    Some(&err.to_string()),
                    Some(latency_ms),
                );
                Err(err)
            }
        }
    }

    async fn execute_bake_pipeline(
        &self,
        run_id: i64,
        trigger_reason: &str,
        started_at: i64,
        limit: usize,
    ) -> Result<BakeRunPayload, ApiError> {
        let existing_memories = self.storage.list_knowledge_by_category(CATEGORY_BAKE_ARTICLE)?;
        let existing_sops = self.storage.list_knowledge_by_category(CATEGORY_BAKE_SOP)?;
        let existing_knowledge = self.storage.list_bake_knowledge_paginated(None, 500, 0)?;
        let existing_templates = self.storage.list_bake_templates()?;
        let watermark = self.storage.get_bake_watermark(UNIFIED_BAKE_PIPELINE_NAME)?;
        let mut existing_memory_sources = collect_source_knowledge_ids(&existing_memories);
        let mut existing_memory_ids = collect_source_memory_ids(&existing_memories);
        let mut existing_sop_sources = collect_current_bake_source_knowledge_ids(&existing_sops);
        let mut existing_knowledge_sources = collect_current_bake_source_knowledge_ids(&existing_knowledge);
        let mut existing_template_sources = collect_current_template_source_knowledge_ids(&existing_templates);
        let mut max_processed_ts = watermark.as_ref().map(|item| item.last_processed_ts).unwrap_or(0);

        let candidates = self.storage.list_bake_memory_init_candidates(limit.saturating_mul(6).max(limit))?;
        let mut processed_episode_count = 0_i64;
        let mut auto_created_count = 0_i64;
        let mut candidate_count = 0_i64;
        let mut discarded_count = 0_i64;
        let mut knowledge_created_count = 0_i64;
        let mut template_created_count = 0_i64;
        let mut sop_created_count = 0_i64;

        for candidate in candidates {
            if processed_episode_count >= limit as i64 {
                break;
            }
            if !is_high_value_candidate(&candidate.knowledge) {
                continue;
            }
            if candidate.knowledge.updated_at_ms <= max_processed_ts {
                continue;
            }

            let extracted = self.extract_candidate(trigger_reason, &candidate).await?;
            processed_episode_count += 1;
            max_processed_ts = max_processed_ts.max(candidate.knowledge.updated_at_ms);

            let memory_id = if existing_memory_sources.contains(&candidate.knowledge.id) {
                discarded_count += 1;
                existing_memory_ids.get(&candidate.knowledge.id).copied()
            } else {
                let score = score_candidate(&candidate.knowledge);
                let record = build_bake_memory_from_source(&candidate, score)?;
                let memory_id = self.storage.insert_knowledge_entry(&record)?;
                existing_memory_sources.insert(candidate.knowledge.id);
                existing_memory_ids.insert(candidate.knowledge.id, memory_id);
                candidate_count += 1;
                Some(memory_id)
            };

            let candidate_result = self.persist_extracted_candidate(
                memory_id,
                &candidate,
                trigger_reason,
                extracted,
                &mut existing_knowledge_sources,
                &mut existing_template_sources,
                &mut existing_sop_sources,
            )?;

            auto_created_count += candidate_result.auto_created_count;
            candidate_count += candidate_result.candidate_count;
            discarded_count += candidate_result.discarded_count;
            knowledge_created_count += candidate_result.knowledge_created_count;
            template_created_count += candidate_result.template_created_count;
            sop_created_count += candidate_result.sop_created_count;

            self.storage.upsert_bake_watermark(UNIFIED_BAKE_PIPELINE_NAME, max_processed_ts)?;
        }

        let completed_at = now_ms();
        let latency_ms = completed_at.saturating_sub(started_at);
        self.storage.complete_bake_run(
            run_id,
            "completed",
            completed_at,
            processed_episode_count,
            auto_created_count,
            candidate_count,
            discarded_count,
            knowledge_created_count,
            template_created_count,
            sop_created_count,
            None,
            Some(latency_ms),
        )?;
        let latest = self.storage
            .get_latest_bake_run()?
            .ok_or_else(|| ApiError::NotFound(format!("bake run {run_id} not found after completion")))?;
        Ok(map_bake_run_record(latest))
    }

    async fn extract_candidate(
        &self,
        trigger_reason: &str,
        candidate: &BakeMemorySourceRecord,
    ) -> Result<BakeExtractResponse, ApiError> {
        let url = format!("{}/bake/extract", self.sidecar_url);
        let request_body = BakeExtractRequest {
            trigger_reason: trigger_reason.to_string(),
            candidate: map_extract_candidate_payload(candidate),
        };

        let response = self.client
            .post(&url)
            .json(&request_body)
            .timeout(Duration::from_secs(BAKE_SIDECAR_TIMEOUT_SECS))
            .send()
            .await
            .map_err(map_sidecar_request_error)?;

        if response.status().is_success() {
            response
                .json::<BakeExtractResponse>()
                .await
                .map_err(|err| ApiError::Internal(format!("解析 bake sidecar 响应失败: {err}")))
        } else {
            let status = response.status();
            let body_text = response.text().await.unwrap_or_default();
            tracing::warn!("bake sidecar 返回错误 status={} body={}", status, body_text);
            let status = StatusCode::from_u16(status.as_u16())
                .unwrap_or(StatusCode::BAD_GATEWAY);
            let error = map_sidecar_error(status, body_text, "bake 提炼服务");
            Err(ApiError::Upstream {
                status: error.status,
                code: error.code,
                message: error.message,
            })
        }
    }

    fn persist_extracted_candidate(
        &self,
        memory_id: Option<i64>,
        candidate: &BakeMemorySourceRecord,
        trigger_reason: &str,
        extracted: BakeExtractResponse,
        existing_knowledge_sources: &mut std::collections::HashSet<i64>,
        existing_template_sources: &mut std::collections::HashSet<i64>,
        existing_sop_sources: &mut std::collections::HashSet<i64>,
    ) -> Result<CandidatePersistResult, ApiError> {
        let mut result = CandidatePersistResult::default();

        result.apply(self.persist_knowledge_artifact(
            memory_id,
            candidate,
            trigger_reason,
            &extracted.knowledge,
            existing_knowledge_sources,
        )?);
        result.apply(self.persist_template_artifact(
            memory_id,
            candidate,
            &extracted.template,
            existing_template_sources,
        )?);
        result.apply(self.persist_sop_artifact(
            memory_id,
            candidate,
            trigger_reason,
            &extracted.sop,
            existing_sop_sources,
        )?);

        Ok(result)
    }

    fn persist_knowledge_artifact(
        &self,
        memory_id: Option<i64>,
        candidate: &BakeMemorySourceRecord,
        trigger_reason: &str,
        extraction: &BakeArtifactExtraction,
        existing_sources: &mut std::collections::HashSet<i64>,
    ) -> Result<CandidatePersistResult, ApiError> {
        if existing_sources.contains(&candidate.knowledge.id) {
            return Ok(CandidatePersistResult::discarded());
        }
        if !extraction.accepted {
            return Ok(CandidatePersistResult::discarded());
        }

        let payload = extraction.payload.clone().ok_or_else(|| ApiError::Internal("bake sidecar 返回 knowledge.accepted=true 但缺少 payload".to_string()))?;
        let payload: BakeKnowledgeArtifactPayload = serde_json::from_value(payload)
            .map_err(|err| ApiError::Internal(format!("解析 bake knowledge payload 失败: {err}")))?;
        if let Some(memory_id) = memory_id {
            self.update_memory_match_metadata(
                memory_id,
                "knowledge",
                payload.match_score,
                payload.match_level.as_deref(),
            )?;
        }
        let review_status = normalize_review_status(payload.review_status.as_deref(), true);
        let record = build_bake_knowledge_entry(candidate, &payload, &review_status, trigger_reason)?;
        self.storage.insert_knowledge_entry(&record)?;
        existing_sources.insert(candidate.knowledge.id);
        Ok(CandidatePersistResult::created_knowledge(review_status == "auto_created"))
    }

    fn persist_template_artifact(
        &self,
        memory_id: Option<i64>,
        candidate: &BakeMemorySourceRecord,
        extraction: &BakeArtifactExtraction,
        existing_sources: &mut std::collections::HashSet<i64>,
    ) -> Result<CandidatePersistResult, ApiError> {
        if existing_sources.contains(&candidate.knowledge.id) {
            return Ok(CandidatePersistResult::discarded());
        }
        if !extraction.accepted {
            return Ok(CandidatePersistResult::discarded());
        }

        let payload = extraction.payload.clone().ok_or_else(|| ApiError::Internal("bake sidecar 返回 template.accepted=true 但缺少 payload".to_string()))?;
        let payload: BakeTemplateArtifactPayload = serde_json::from_value(payload)
            .map_err(|err| ApiError::Internal(format!("解析 bake template payload 失败: {err}")))?;
        if let Some(memory_id) = memory_id {
            self.update_memory_match_metadata(
                memory_id,
                "template",
                payload.match_score,
                payload.match_level.as_deref(),
            )?;
        }
        let review_status = normalize_review_status(payload.review_status.as_deref(), true);
        let template = build_bake_template(candidate, &payload, &review_status)?;
        self.storage.insert_bake_template(&template)?;
        existing_sources.insert(candidate.knowledge.id);
        Ok(CandidatePersistResult::created_template(review_status == "auto_created"))
    }

    fn persist_sop_artifact(
        &self,
        memory_id: Option<i64>,
        candidate: &BakeMemorySourceRecord,
        trigger_reason: &str,
        extraction: &BakeArtifactExtraction,
        existing_sources: &mut std::collections::HashSet<i64>,
    ) -> Result<CandidatePersistResult, ApiError> {
        if existing_sources.contains(&candidate.knowledge.id) {
            return Ok(CandidatePersistResult::discarded());
        }
        if !extraction.accepted {
            return Ok(CandidatePersistResult::discarded());
        }

        let payload = extraction.payload.clone().ok_or_else(|| ApiError::Internal("bake sidecar 返回 sop.accepted=true 但缺少 payload".to_string()))?;
        let payload: BakeSopArtifactPayload = serde_json::from_value(payload)
            .map_err(|err| ApiError::Internal(format!("解析 bake sop payload 失败: {err}")))?;
        if let Some(memory_id) = memory_id {
            self.update_memory_match_metadata(
                memory_id,
                "sop",
                payload.match_score,
                payload.match_level.as_deref(),
            )?;
        }
        let review_status = normalize_review_status(payload.review_status.as_deref(), true);
        let sop = build_bake_sop_entry(candidate, &payload, &review_status, trigger_reason)?;
        self.storage.insert_knowledge_entry(&sop)?;
        existing_sources.insert(candidate.knowledge.id);
        Ok(CandidatePersistResult::created_sop(review_status == "auto_created"))
    }
    fn update_memory_match_metadata(
        &self,
        memory_id: i64,
        artifact_kind: &str,
        match_score: Option<f64>,
        match_level: Option<&str>,
    ) -> Result<(), ApiError> {
        let entry = self.storage
            .get_knowledge_entry(memory_id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {memory_id} not found")))?;
        let details = parse_details(entry.details.as_deref())
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut next_details = serde_json::Map::from_iter(details);
        next_details.insert(format!("{artifact_kind}_match_score"), match_score.map_or(Value::Null, Value::from));
        next_details.insert(
            format!("{artifact_kind}_match_level"),
            match_level.map_or(Value::Null, |value| Value::String(value.to_string())),
        );
        self.storage.update_knowledge_details_system(
            memory_id,
            &entry.summary,
            entry.overview.as_deref(),
            Some(&Value::Object(next_details).to_string()),
            &entry.entities,
        )?;
        Ok(())
    }


    pub fn get_overview(&self) -> Result<BakeOverviewPayload, ApiError> {
        let capture_count = self.storage.with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM captures", [], |row| row.get(0))
                .map_err(StorageError::Sqlite)
        })?;
        let memory_entries = self.storage.list_knowledge_by_category(CATEGORY_BAKE_ARTICLE)?;
        let sop_entries = self.storage
            .list_knowledge_by_category(CATEGORY_BAKE_SOP)?
            .into_iter()
            .filter(is_current_bake_entry)
            .collect::<Vec<_>>();
        let knowledge_entries = self.storage
            .list_bake_knowledge_paginated(None, 5000, 0)?
            .into_iter()
            .filter(is_current_bake_entry)
            .collect::<Vec<_>>();
        let templates = self.storage
            .list_bake_templates()?
            .into_iter()
            .filter(is_current_bake_template)
            .collect::<Vec<_>>();
        let latest_run = self.storage.get_latest_bake_run()?;
        let memory_count = memory_entries.len() as i64;

        let pending_candidates = memory_entries.iter().filter(|entry| extract_status(entry) == "candidate").count() as i64
            + sop_entries.iter().filter(|entry| extract_status(entry) == "candidate").count() as i64
            + knowledge_entries.iter().filter(|entry| extract_status(entry) == "candidate").count() as i64
            + templates.iter().filter(|item| item.review_status == "candidate").count() as i64;

        let mut recent_activities: Vec<BakeActivityRecord> = memory_entries.iter()
            .take(3)
            .map(|entry| BakeActivityRecord {
                message: format!("情节记忆《{}》已进入烤面包队列", entry.summary),
                ts: entry.updated_at_ms,
            })
            .collect();
        recent_activities.extend(knowledge_entries.iter().take(2).map(|entry| BakeActivityRecord {
            message: format!("知识《{}》已由 LLM 烤面包提炼", entry.summary),
            ts: entry.updated_at_ms,
        }));
        recent_activities.extend(templates.iter().take(2).map(|template| BakeActivityRecord {
            message: format!("模板《{}》状态已更新为 {}", template.name, template.status),
            ts: template.updated_at,
        }));
        if let Some(run) = latest_run.as_ref() {
            recent_activities.push(BakeActivityRecord {
                message: format_bake_run_activity(run),
                ts: run.completed_at.unwrap_or(run.started_at),
            });
        }
        recent_activities.sort_by(|a, b| b.ts.cmp(&a.ts));

        let overview = BakeOverviewRecord {
            capture_count,
            memory_count,
            knowledge_count: knowledge_entries.len() as i64,
            template_count: templates.len() as i64,
            pending_candidates,
            auto_created_today: latest_run.as_ref().map(|run| run.auto_created_count).unwrap_or(0),
            candidate_today: latest_run.as_ref().map(|run| run.candidate_count).unwrap_or(0),
            discarded_today: latest_run.as_ref().map(|run| run.discarded_count).unwrap_or(0),
            last_bake_run_status: latest_run.as_ref().map(|run| run.status.clone()),
            last_bake_run_at: latest_run.as_ref().map(|run| run.completed_at.unwrap_or(run.started_at)),
            last_trigger_reason: latest_run.as_ref().map(|run| run.trigger_reason.clone()),
            knowledge_auto_count: latest_run.as_ref().map(|run| run.knowledge_created_count).unwrap_or(0),
            template_auto_count: latest_run.as_ref().map(|run| run.template_created_count).unwrap_or(0),
            sop_auto_count: latest_run.as_ref().map(|run| run.sop_created_count).unwrap_or(0),
            recent_activities,
        };

        Ok(BakeOverviewPayload {
            capture_count: overview.capture_count,
            memory_count: overview.memory_count,
            knowledge_count: overview.knowledge_count,
            template_count: overview.template_count,
            pending_candidates: overview.pending_candidates,
            auto_created_today: overview.auto_created_today,
            candidate_today: overview.candidate_today,
            discarded_today: overview.discarded_today,
            last_bake_run_status: overview.last_bake_run_status,
            last_bake_run_at: overview.last_bake_run_at,
            last_trigger_reason: overview.last_trigger_reason,
            knowledge_auto_count: overview.knowledge_auto_count,
            template_auto_count: overview.template_auto_count,
            sop_auto_count: overview.sop_auto_count,
            recent_activities: overview.recent_activities.into_iter().map(|item| item.message).collect(),
        })
    }

    fn update_memory_status(&self, id: i64, status: &str) -> Result<BakeMemoryPayload, ApiError> {
        let entry = self.storage
            .get_knowledge_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found")))?;
        let details = parse_details(entry.details.as_deref())
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut next_details = serde_json::Map::from_iter(details);
        next_details.insert("status".to_string(), json!(status));
        self.storage.update_knowledge_details_system(
            id,
            &entry.summary,
            entry.overview.as_deref(),
            Some(&Value::Object(next_details).to_string()),
            &entry.entities,
        )?;
        let updated = self.storage
            .get_knowledge_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found after update")))?;
        Ok(map_memory_record(updated))
    }
}

#[derive(Debug, Clone, Default)]
struct CandidatePersistResult {
    auto_created_count: i64,
    candidate_count: i64,
    discarded_count: i64,
    knowledge_created_count: i64,
    template_created_count: i64,
    sop_created_count: i64,
}

impl CandidatePersistResult {
    fn discarded() -> Self {
        Self {
            discarded_count: 1,
            ..Self::default()
        }
    }

    fn created_knowledge(auto_created: bool) -> Self {
        Self {
            auto_created_count: if auto_created { 1 } else { 0 },
            candidate_count: if auto_created { 0 } else { 1 },
            knowledge_created_count: 1,
            ..Self::default()
        }
    }

    fn created_template(auto_created: bool) -> Self {
        Self {
            auto_created_count: if auto_created { 1 } else { 0 },
            candidate_count: if auto_created { 0 } else { 1 },
            template_created_count: 1,
            ..Self::default()
        }
    }

    fn created_sop(auto_created: bool) -> Self {
        Self {
            auto_created_count: if auto_created { 1 } else { 0 },
            candidate_count: if auto_created { 0 } else { 1 },
            sop_created_count: 1,
            ..Self::default()
        }
    }

    fn apply(&mut self, other: Self) {
        self.auto_created_count += other.auto_created_count;
        self.candidate_count += other.candidate_count;
        self.discarded_count += other.discarded_count;
        self.knowledge_created_count += other.knowledge_created_count;
        self.template_created_count += other.template_created_count;
        self.sop_created_count += other.sop_created_count;
    }
}

fn map_extract_candidate_payload(candidate: &BakeMemorySourceRecord) -> BakeExtractCandidatePayload {
    BakeExtractCandidatePayload {
        source_knowledge_id: candidate.knowledge.id,
        source_capture_id: candidate.knowledge.capture_id,
        summary: candidate.knowledge.summary.clone(),
        overview: candidate.knowledge.overview.clone(),
        details: candidate.knowledge.details.clone(),
        entities: parse_json_vec_string(&candidate.knowledge.entities),
        importance: candidate.knowledge.importance,
        occurrence_count: candidate.knowledge.occurrence_count,
        observed_at: candidate.knowledge.observed_at,
        event_time_start: candidate.knowledge.event_time_start,
        event_time_end: candidate.knowledge.event_time_end,
        history_view: candidate.knowledge.history_view,
        content_origin: candidate.knowledge.content_origin.clone(),
        activity_type: candidate.knowledge.activity_type.clone(),
        evidence_strength: candidate.knowledge.evidence_strength.clone(),
        capture_ts: candidate.capture_ts,
        capture_app_name: candidate.capture_app_name.clone(),
        capture_win_title: candidate.capture_win_title.clone(),
        capture_ax_text: candidate.capture_ax_text.clone(),
        capture_ocr_text: candidate.capture_ocr_text.clone(),
        capture_input_text: candidate.capture_input_text.clone(),
        capture_audio_text: candidate.capture_audio_text.clone(),
    }
}

fn map_sidecar_request_error(err: reqwest::Error) -> ApiError {
    let msg = err.to_string();
    if err.is_timeout() || msg.contains("timed out") || msg.contains("timeout") {
        tracing::warn!("bake sidecar 响应超时: {}", err);
        ApiError::Internal(format!(
            "bake 提炼请求超时（>{} 秒），请稍后重试",
            BAKE_SIDECAR_TIMEOUT_SECS
        ))
    } else {
        tracing::warn!("无法连接到 bake sidecar: {}", err);
        ApiError::Internal(format!("bake 提炼服务不可用，请确认 AI Sidecar 已正常启动: {err}"))
    }
}

fn map_sidecar_error(status: StatusCode, body_text: String, service_name: &str) -> BakeSidecarError {
    let (mapped_status, code) = match status.as_u16() {
        400 | 422 => (StatusCode::BAD_REQUEST, "BAD_REQUEST"),
        502 => (StatusCode::BAD_GATEWAY, "BAD_GATEWAY"),
        503 => (StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE"),
        504 => (StatusCode::GATEWAY_TIMEOUT, "GATEWAY_TIMEOUT"),
        code if code >= 500 => (StatusCode::BAD_GATEWAY, "BAD_GATEWAY"),
        _ => (StatusCode::BAD_GATEWAY, "BAD_GATEWAY"),
    };

    let message = if body_text.trim().is_empty() {
        format!("{service_name}返回错误 ({status})")
    } else {
        format!("{service_name}返回错误 ({status})：{body_text}")
    };

    BakeSidecarError {
        status: mapped_status,
        code,
        message,
    }
}

fn normalize_review_status(value: Option<&str>, default_auto_created: bool) -> String {
    match value.unwrap_or_default() {
        "auto_created" => "auto_created".to_string(),
        "candidate" => "candidate".to_string(),
        "confirmed" => "confirmed".to_string(),
        _ if default_auto_created => "auto_created".to_string(),
        _ => "candidate".to_string(),
    }
}

fn collect_template_source_knowledge_ids(records: &[BakeTemplateRecord]) -> std::collections::HashSet<i64> {
    records
        .iter()
        .flat_map(|record| {
            parse_json_vec_string(&record.source_memory_ids)
                .into_iter()
                .filter_map(|value| value.parse::<i64>().ok())
        })
        .collect()
}

fn collect_current_template_source_knowledge_ids(records: &[BakeTemplateRecord]) -> std::collections::HashSet<i64> {
    records
        .iter()
        .filter(|record| is_current_bake_template(record))
        .flat_map(|record| {
            parse_json_vec_string(&record.source_memory_ids)
                .into_iter()
                .filter_map(|value| value.parse::<i64>().ok())
        })
        .collect()
}

fn build_bake_knowledge_entry(
    source: &BakeMemorySourceRecord,
    payload: &BakeKnowledgeArtifactPayload,
    review_status: &str,
    trigger_reason: &str,
) -> Result<NewKnowledgeEntry, ApiError> {
    let entities = if payload.entities.is_empty() {
        parse_json_vec_string(&source.knowledge.entities)
    } else {
        payload.entities.clone()
    };
    let details = json!({
        "source_knowledge_id": source.knowledge.id,
        "source_memory_ids": [source.knowledge.id.to_string()],
        "source_capture_ids": [source.knowledge.capture_id.to_string()],
        "source_knowledge_ids": [source.knowledge.id.to_string()],
        "episode_cluster_id": source.knowledge.capture_id.to_string(),
        "match_score": payload.match_score,
        "match_level": payload.match_level.clone(),
        "creation_mode": "llm_bake",
        "review_status": review_status,
        "evidence_summary": payload.evidence_summary.clone(),
        "generation_version": BAKE_GENERATION_VERSION,
        "trigger_reason": trigger_reason,
        "status": review_status,
        "source_title": source.knowledge.summary.clone(),
    });
    Ok(NewKnowledgeEntry {
        capture_id: source.knowledge.capture_id,
        summary: payload.summary.clone(),
        overview: payload.overview.clone().or_else(|| source.knowledge.overview.clone()),
        details: Some(details.to_string()),
        entities: to_json_string(&entities)?,
        category: CATEGORY_BAKE_KNOWLEDGE.to_string(),
        importance: payload.importance.unwrap_or(source.knowledge.importance).max(1),
        occurrence_count: payload.occurrence_count.or(source.knowledge.occurrence_count),
        observed_at: payload.observed_at.or(source.knowledge.observed_at).or(Some(source.capture_ts)),
        event_time_start: payload.event_time_start.or(source.knowledge.event_time_start),
        event_time_end: payload.event_time_end.or(source.knowledge.event_time_end),
        history_view: payload.history_view.unwrap_or(source.knowledge.history_view),
        content_origin: payload.content_origin.clone().or_else(|| source.knowledge.content_origin.clone()),
        activity_type: payload.activity_type.clone().or_else(|| source.knowledge.activity_type.clone()),
        is_self_generated: false,
        evidence_strength: payload.evidence_strength.clone().or_else(|| source.knowledge.evidence_strength.clone()),
    })
}

fn build_bake_template(
    source: &BakeMemorySourceRecord,
    payload: &BakeTemplateArtifactPayload,
    review_status: &str,
) -> Result<NewBakeTemplate, ApiError> {
    let tags = if payload.tags.is_empty() {
        parse_json_vec_string(&source.knowledge.entities)
    } else {
        payload.tags.clone()
    };
    let applicable_tasks = if payload.applicable_tasks.is_empty() {
        vec!["creation".to_string()]
    } else {
        payload.applicable_tasks.clone()
    };
    Ok(NewBakeTemplate {
        name: payload.name.clone(),
        category: payload.category.clone().unwrap_or_else(|| first_or_default(&tags, "精选文档")),
        status: payload.status.clone().unwrap_or_else(|| if review_status == "auto_created" { "enabled".to_string() } else { "draft".to_string() }),
        tags: to_json_string(&tags)?,
        applicable_tasks: to_json_string(&applicable_tasks)?,
        source_memory_ids: to_json_string(&vec![source.knowledge.id.to_string()])?,
        source_capture_ids: to_json_string(&vec![source.knowledge.capture_id.to_string()])?,
        source_episode_ids: to_json_string(&vec![source.knowledge.capture_id.to_string()])?,
        linked_knowledge_ids: to_json_string(&payload.linked_knowledge_ids)?,
        structure_sections: to_json_string(&payload.structure_sections)?,
        style_phrases: to_json_string(&payload.style_phrases)?,
        replacement_rules: to_json_string(&payload.replacement_rules)?,
        prompt_hint: payload.prompt_hint.clone(),
        diagram_code: payload.diagram_code.clone(),
        image_assets: to_json_string(&payload.image_assets)?,
        usage_count: 0,
        match_score: payload.match_score,
        match_level: payload.match_level.clone(),
        creation_mode: "llm_bake".to_string(),
        review_status: review_status.to_string(),
        evidence_summary: payload.evidence_summary.clone(),
        generation_version: Some(BAKE_GENERATION_VERSION.to_string()),
        deleted_at: None,
    })
}

fn build_bake_sop_entry(
    source: &BakeMemorySourceRecord,
    payload: &BakeSopArtifactPayload,
    review_status: &str,
    trigger_reason: &str,
) -> Result<NewKnowledgeEntry, ApiError> {
    let trigger_keywords = if payload.trigger_keywords.is_empty() {
        parse_json_vec_string(&source.knowledge.entities)
    } else {
        payload.trigger_keywords.clone()
    };
    let linked_knowledge_ids = if payload.linked_knowledge_ids.is_empty() {
        vec![source.knowledge.id.to_string()]
    } else {
        payload.linked_knowledge_ids.clone()
    };
    let details = json!({
        "source_knowledge_id": source.knowledge.id,
        "source_memory_ids": [source.knowledge.id.to_string()],
        "source_capture_ids": [source.knowledge.capture_id.to_string()],
        "match_score": payload.match_score,
        "match_level": payload.match_level.clone(),
        "creation_mode": "llm_bake",
        "review_status": review_status,
        "evidence_summary": payload.evidence_summary.clone(),
        "generation_version": BAKE_GENERATION_VERSION,
        "trigger_reason": trigger_reason,
        "source_capture_id": source.knowledge.capture_id.to_string(),
        "source_title": payload.source_title.clone().unwrap_or_else(|| source.knowledge.summary.clone()),
        "trigger_keywords": trigger_keywords,
        "confidence": payload.confidence.clone().unwrap_or_else(|| infer_confidence(source.knowledge.importance, source.knowledge.occurrence_count)),
        "extracted_problem": payload.extracted_problem.clone(),
        "steps": payload.steps,
        "linked_knowledge_ids": linked_knowledge_ids,
        "status": review_status,
    });
    Ok(NewKnowledgeEntry {
        capture_id: source.knowledge.capture_id,
        summary: payload.summary.clone(),
        overview: payload.overview.clone().or_else(|| source.knowledge.overview.clone()),
        details: Some(details.to_string()),
        entities: source.knowledge.entities.clone(),
        category: CATEGORY_BAKE_SOP.to_string(),
        importance: source.knowledge.importance.max(3),
        occurrence_count: source.knowledge.occurrence_count,
        observed_at: source.knowledge.observed_at.or(Some(source.capture_ts)),
        event_time_start: source.knowledge.event_time_start,
        event_time_end: source.knowledge.event_time_end,
        history_view: source.knowledge.history_view,
        content_origin: source.knowledge.content_origin.clone(),
        activity_type: source.knowledge.activity_type.clone(),
        is_self_generated: false,
        evidence_strength: source.knowledge.evidence_strength.clone(),
    })
}

fn map_bake_run_record(record: BakeRunRecord) -> BakeRunPayload {
    BakeRunPayload {
        id: record.id.to_string(),
        trigger_reason: record.trigger_reason,
        status: record.status,
        started_at: record.started_at,
        completed_at: record.completed_at,
        processed_episode_count: record.processed_episode_count,
        auto_created_count: record.auto_created_count,
        candidate_count: record.candidate_count,
        discarded_count: record.discarded_count,
        knowledge_created_count: record.knowledge_created_count,
        template_created_count: record.template_created_count,
        sop_created_count: record.sop_created_count,
        error_message: record.error_message,
        latency_ms: record.latency_ms,
    }
}

fn format_bake_run_activity(run: &BakeRunRecord) -> String {
    let summary = format!("自动 {}，候选 {}，丢弃 {}", run.auto_created_count, run.candidate_count, run.discarded_count);
    match run.trigger_reason.as_str() {
        "knowledge_background" => format!("知识后台提炼后已自动执行分类烤面包（{}）", summary),
        "manual_debug" => format!("手动触发分类烤面包执行完成（{}）", summary),
        other => format!("分类提炼执行完成：{}（{}）", other, summary),
    }
}

fn template_uses_source(template: &BakeTemplateRecord, source_knowledge_id: i64) -> bool {
    parse_json_vec_string(&template.source_memory_ids)
        .iter()
        .any(|value| value == &source_knowledge_id.to_string())
}

fn map_capture_record(
    record: CaptureRecord,
    linked_knowledge: Option<&(i64, String)>,
) -> BakeCapturePayload {
    let best_text = record.best_text().map(ToString::to_string);
    let summary = record.win_title.clone().or_else(|| best_text.as_ref().map(|text| text.chars().take(80).collect::<String>()));
    let semantic_type_label = infer_semantic_type_label(&record);
    let raw_type_label = friendly_raw_type_label(&record.event_type, &record);

    BakeCapturePayload {
        id: record.id.to_string(),
        ts: record.ts,
        app_name: record.app_name,
        app_bundle_id: record.app_bundle_id,
        win_title: record.win_title,
        event_type: record.event_type,
        semantic_type_label,
        raw_type_label,
        ax_text: record.ax_text,
        ax_focused_role: record.ax_focused_role,
        ax_focused_id: record.ax_focused_id,
        ocr_text: record.ocr_text,
        input_text: record.input_text,
        audio_text: record.audio_text,
        screenshot_path: record.screenshot_path,
        is_sensitive: record.is_sensitive,
        pii_scrubbed: record.pii_scrubbed,
        best_text,
        summary,
        linked_knowledge_id: linked_knowledge.map(|(id, _)| id.to_string()),
        linked_knowledge_summary: linked_knowledge.map(|(_, summary)| summary.clone()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateOrUpdateTemplateRequest {
    pub name: String,
    pub category: String,
    pub status: String,
    pub tags: Vec<String>,
    pub applicable_tasks: Vec<String>,
    #[serde(default)]
    pub source_article_ids: Vec<String>,
    #[serde(default)]
    pub source_memory_ids: Vec<String>,
    #[serde(default)]
    pub source_capture_ids: Vec<String>,
    #[serde(default)]
    pub source_episode_ids: Vec<String>,
    pub linked_knowledge_ids: Vec<String>,
    pub structure_sections: Vec<TemplateSectionPayload>,
    pub style_phrases: Vec<String>,
    pub replacement_rules: Vec<ReplacementRulePayload>,
    pub prompt_hint: Option<String>,
    pub diagram_code: Option<String>,
    pub image_assets: Vec<String>,
    pub usage_count: Option<i64>,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub creation_mode: Option<String>,
    pub review_status: Option<String>,
    pub evidence_summary: Option<String>,
    pub generation_version: Option<String>,
    pub deleted_at: Option<i64>,
}

fn request_to_new_template(payload: CreateOrUpdateTemplateRequest) -> Result<NewBakeTemplate, ApiError> {
    Ok(NewBakeTemplate {
        name: payload.name,
        category: payload.category,
        status: payload.status,
        tags: to_json_string(&payload.tags)?,
        applicable_tasks: to_json_string(&payload.applicable_tasks)?,
        source_memory_ids: to_json_string(&if payload.source_memory_ids.is_empty() {
            payload.source_article_ids.clone()
        } else {
            payload.source_memory_ids.clone()
        })?,
        source_capture_ids: to_json_string(&payload.source_capture_ids)?,
        source_episode_ids: to_json_string(&payload.source_episode_ids)?,
        linked_knowledge_ids: to_json_string(&payload.linked_knowledge_ids)?,
        structure_sections: to_json_string(&payload.structure_sections)?,
        style_phrases: to_json_string(&payload.style_phrases)?,
        replacement_rules: to_json_string(&payload.replacement_rules)?,
        prompt_hint: payload.prompt_hint,
        diagram_code: payload.diagram_code,
        image_assets: to_json_string(&payload.image_assets)?,
        usage_count: payload.usage_count.unwrap_or(0),
        match_score: payload.match_score,
        match_level: payload.match_level,
        creation_mode: payload.creation_mode.unwrap_or_else(|| "manual".to_string()),
        review_status: payload.review_status.unwrap_or_else(|| "draft".to_string()),
        evidence_summary: payload.evidence_summary,
        generation_version: payload.generation_version,
        deleted_at: payload.deleted_at,
    })
}

fn map_template_record(record: BakeTemplateRecord) -> BakeTemplatePayload {
    let source_memory_ids = parse_json_vec_string(&record.source_memory_ids);
    BakeTemplatePayload {
        id: record.id.to_string(),
        name: record.name,
        category: record.category,
        status: record.status,
        tags: parse_json_vec_string(&record.tags),
        applicable_tasks: parse_json_vec_string(&record.applicable_tasks),
        source_article_ids: source_memory_ids.clone(),
        source_memory_ids,
        source_capture_ids: parse_json_vec_string(&record.source_capture_ids),
        source_episode_ids: parse_json_vec_string(&record.source_episode_ids),
        linked_knowledge_ids: parse_json_vec_string(&record.linked_knowledge_ids),
        structure_sections: parse_json_value(&record.structure_sections),
        style_phrases: parse_json_vec_string(&record.style_phrases),
        replacement_rules: parse_json_value(&record.replacement_rules),
        prompt_hint: record.prompt_hint,
        diagram_code: record.diagram_code,
        image_assets: parse_json_vec_string(&record.image_assets),
        usage_count: record.usage_count,
        match_score: record.match_score,
        match_level: record.match_level,
        creation_mode: record.creation_mode,
        review_status: record.review_status,
        evidence_summary: record.evidence_summary,
        generation_version: record.generation_version,
        deleted_at: record.deleted_at,
        updated_at: format_ts_ms(record.updated_at),
    }
}

fn map_memory_record(record: KnowledgeEntryRecord) -> BakeMemoryPayload {
    let details = parse_details(record.details.as_deref());
    let tags = details.get("tags")
        .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
        .unwrap_or_else(|| parse_json_vec_string(&record.entities));

    BakeMemoryPayload {
        id: record.id.to_string(),
        title: record.summary,
        url: details.get("url").and_then(Value::as_str).map(ToString::to_string),
        source_capture_id: details.get("source_capture_id").and_then(Value::as_str).map(ToString::to_string).or_else(|| Some(record.capture_id.to_string())),
        source_knowledge_id: details.get("source_knowledge_id").and_then(Value::as_i64).map(|value| value.to_string()),
        summary: record.overview,
        weight: details.get("weight").and_then(Value::as_i64).unwrap_or(record.importance * 20),
        open_count: details.get("open_count").and_then(Value::as_i64).unwrap_or(0),
        dwell_seconds: details.get("dwell_seconds").and_then(Value::as_i64).unwrap_or(0),
        has_edit_action: details.get("has_edit_action").and_then(Value::as_bool).unwrap_or(false),
        knowledge_ref_count: details.get("knowledge_ref_count").and_then(Value::as_i64).or(record.occurrence_count).unwrap_or(0),
        status: details.get("status").and_then(Value::as_str).map(ToString::to_string)
            .unwrap_or_else(|| if record.user_verified { "confirmed".to_string() } else { "candidate".to_string() }),
        suggested_action: details.get("suggested_action").and_then(Value::as_str).map(ToString::to_string)
            .or_else(|| infer_suggested_action(&tags)),
        tags,
        last_visited_at: details.get("last_visited_at").and_then(Value::as_str).map(ToString::to_string),
        created_at: record.created_at,
        created_at_ms: record.created_at_ms,
        knowledge_match_score: details.get("knowledge_match_score").and_then(Value::as_f64),
        knowledge_match_level: details.get("knowledge_match_level").and_then(Value::as_str).map(ToString::to_string),
        template_match_score: details.get("template_match_score").and_then(Value::as_f64),
        template_match_level: details.get("template_match_level").and_then(Value::as_str).map(ToString::to_string),
        sop_match_score: details.get("sop_match_score").and_then(Value::as_f64),
        sop_match_level: details.get("sop_match_level").and_then(Value::as_str).map(ToString::to_string),
    }
}

fn map_bake_knowledge_record(record: KnowledgeEntryRecord) -> BakeKnowledgePayload {
    let details = parse_details(record.details.as_deref());
    let status = extract_status_from_details(&details, record.user_verified);
    let review_status = details.get("review_status")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| status.clone());
    BakeKnowledgePayload {
        id: record.id.to_string(),
        capture_id: record.capture_id.to_string(),
        summary: record.summary,
        overview: record.overview,
        details: record.details,
        entities: parse_json_vec_string(&record.entities),
        category: record.category,
        importance: record.importance,
        occurrence_count: record.occurrence_count.unwrap_or(0),
        observed_at: record.observed_at,
        status,
        review_status,
        match_score: details.get("match_score").and_then(Value::as_f64),
        match_level: details.get("match_level").and_then(Value::as_str).map(ToString::to_string),
        updated_at: record.updated_at,
        updated_at_ms: record.updated_at_ms,
    }
}

fn map_sop_record(record: KnowledgeEntryRecord) -> BakeSopPayload {
    let details = parse_details(record.details.as_deref());
    BakeSopPayload {
        id: record.id.to_string(),
        source_capture_id: details.get("source_capture_id").and_then(Value::as_str).unwrap_or_default().to_string(),
        source_title: details.get("source_title").and_then(Value::as_str).map(ToString::to_string).or_else(|| Some(record.summary.clone())),
        trigger_keywords: details.get("trigger_keywords")
            .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
            .unwrap_or_else(|| parse_json_vec_string(&record.entities)),
        confidence: details.get("confidence").and_then(Value::as_str).map(ToString::to_string)
            .unwrap_or_else(|| infer_confidence(record.importance, record.occurrence_count)),
        extracted_problem: Some(record.summary),
        steps: details.get("steps")
            .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
            .unwrap_or_default(),
        linked_knowledge_ids: details.get("linked_knowledge_ids")
            .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
            .unwrap_or_default(),
        status: details.get("status").and_then(Value::as_str).map(ToString::to_string)
            .unwrap_or_else(|| if record.user_verified { "confirmed".to_string() } else { "candidate".to_string() }),
    }
}

fn collect_source_knowledge_ids(records: &[KnowledgeEntryRecord]) -> std::collections::HashSet<i64> {
    records
        .iter()
        .filter_map(|record| {
            parse_details(record.details.as_deref())
                .get("source_knowledge_id")
                .and_then(Value::as_i64)
        })
        .collect()
}

fn collect_source_memory_ids(records: &[KnowledgeEntryRecord]) -> std::collections::HashMap<i64, i64> {
    records
        .iter()
        .filter_map(|record| {
            parse_details(record.details.as_deref())
                .get("source_knowledge_id")
                .and_then(Value::as_i64)
                .map(|source_id| (source_id, record.id))
        })
        .collect()
}

fn collect_current_bake_source_knowledge_ids(records: &[KnowledgeEntryRecord]) -> std::collections::HashSet<i64> {
    records
        .iter()
        .filter(|record| is_current_bake_entry(record))
        .filter_map(|record| {
            parse_details(record.details.as_deref())
                .get("source_knowledge_id")
                .and_then(Value::as_i64)
        })
        .collect()
}

fn is_high_value_candidate(record: &KnowledgeEntryRecord) -> bool {
    if record.is_self_generated {
        return false;
    }
    if record.importance >= 4 || record.user_verified {
        return true;
    }

    let occurrences = record.occurrence_count.unwrap_or(0);
    let strong_evidence = matches!(record.evidence_strength.as_deref(), Some("high") | Some("medium"));
    let preferred_activity = matches!(record.activity_type.as_deref(), Some("coding") | Some("reading") | Some("reviewing_history") | Some("document_reference"));
    let preferred_origin = matches!(record.content_origin.as_deref(), Some("historical_content") | Some("live_interaction"));

    occurrences >= 2 && strong_evidence && (record.history_view || preferred_activity || preferred_origin)
}

fn score_candidate(record: &KnowledgeEntryRecord) -> i64 {
    let mut score = record.importance * 20;
    score += record.occurrence_count.unwrap_or(0).min(5) * 8;
    if record.user_verified {
        score += 15;
    }
    if record.history_view {
        score += 8;
    }
    if matches!(record.evidence_strength.as_deref(), Some("high")) {
        score += 10;
    } else if matches!(record.evidence_strength.as_deref(), Some("medium")) {
        score += 5;
    }
    if matches!(record.activity_type.as_deref(), Some("coding") | Some("reading") | Some("reviewing_history") | Some("document_reference")) {
        score += 8;
    }
    score
}

fn build_bake_memory_from_source(source: &BakeMemorySourceRecord, score: i64) -> Result<NewKnowledgeEntry, ApiError> {
    let fallback_tags = parse_json_vec_string(&source.knowledge.entities);
    let tags = if fallback_tags.is_empty() {
        infer_tags_from_capture(source)
    } else {
        fallback_tags
    };
    let last_visited_at = format_ts_ms(source.capture_ts);
    let details = json!({
        "source_knowledge_id": source.knowledge.id,
        "source_capture_id": source.knowledge.capture_id.to_string(),
        "init_method": "knowledge_bootstrap",
        "init_version": 1,
        "score": score,
        "weight": score.max(source.knowledge.importance * 20),
        "tags": tags,
        "status": "candidate",
        "knowledge_ref_count": source.knowledge.occurrence_count.unwrap_or(0),
        "suggested_action": infer_suggested_action(&tags),
        "last_visited_at": last_visited_at,
        "open_count": 0,
        "dwell_seconds": 0,
        "has_edit_action": false,
        "knowledge_match_score": null,
        "knowledge_match_level": null,
        "template_match_score": null,
        "template_match_level": null,
        "sop_match_score": null,
        "sop_match_level": null,
    });

    Ok(NewKnowledgeEntry {
        capture_id: source.knowledge.capture_id,
        summary: source.knowledge.summary.clone(),
        overview: source.knowledge.overview.clone(),
        details: Some(details.to_string()),
        entities: to_json_string(&tags)?,
        category: CATEGORY_BAKE_ARTICLE.to_string(),
        importance: source.knowledge.importance,
        occurrence_count: source.knowledge.occurrence_count,
        observed_at: source.knowledge.observed_at.or(Some(source.capture_ts)),
        event_time_start: source.knowledge.event_time_start,
        event_time_end: source.knowledge.event_time_end,
        history_view: source.knowledge.history_view,
        content_origin: source.knowledge.content_origin.clone(),
        activity_type: source.knowledge.activity_type.clone(),
        is_self_generated: false,
        evidence_strength: source.knowledge.evidence_strength.clone(),
    })
}

fn infer_tags_from_capture(source: &BakeMemorySourceRecord) -> Vec<String> {
    let mut tags = Vec::new();
    if let Some(app_name) = &source.capture_app_name {
        tags.push(app_name.clone());
    }
    if let Some(win_title) = &source.capture_win_title {
        let trimmed = win_title.trim();
        if !trimmed.is_empty() {
            tags.push(trimmed.chars().take(24).collect());
        }
    }
    if tags.is_empty() {
        tags.push("高价值内容".to_string());
    }
    tags
}

fn parse_details(value: Option<&str>) -> Value {
    value
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| json!({}))
}

fn is_current_bake_entry(record: &KnowledgeEntryRecord) -> bool {
    let details = parse_details(record.details.as_deref());
    !is_legacy_bake_entry_details(&details)
}

fn is_legacy_bake_entry_details(details: &Value) -> bool {
    details.get("creation_mode").and_then(Value::as_str) == Some("auto")
        && details.get("generation_version").and_then(Value::as_str) == Some(BAKE_GENERATION_VERSION)
}

fn is_current_bake_template(record: &BakeTemplateRecord) -> bool {
    !is_legacy_bake_template(record)
}

fn is_legacy_bake_template(record: &BakeTemplateRecord) -> bool {
    record.creation_mode == "auto"
        && record.generation_version.as_deref() == Some(BAKE_GENERATION_VERSION)
}

fn matches_template_bucket(record: &BakeTemplateRecord, bucket: Option<BakeBucket>) -> bool {
    match bucket {
        None => record.review_status != "ignored",
        Some(BakeBucket::Pending) => record.review_status == "candidate",
        Some(BakeBucket::Extracted) => record.review_status != "candidate" && record.review_status != "ignored",
    }
}

fn matches_entry_bucket(record: &KnowledgeEntryRecord, bucket: Option<BakeBucket>) -> bool {
    let status = extract_status(record);
    match bucket {
        None => status != "ignored",
        Some(BakeBucket::Pending) => status == "candidate",
        Some(BakeBucket::Extracted) => status != "candidate" && status != "ignored",
    }
}

fn extract_status_from_details(details: &Value, user_verified: bool) -> String {
    details
        .get("status")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| if user_verified { "confirmed".to_string() } else { "candidate".to_string() })
}

fn infer_semantic_type_label(record: &CaptureRecord) -> String {
    if record.input_text.as_deref().is_some_and(has_meaningful_text) {
        return "输入片段".to_string();
    }
    if record.audio_text.as_deref().is_some_and(has_meaningful_text) {
        return "语音片段".to_string();
    }
    if record.screenshot_path.is_some() || record.ocr_text.as_deref().is_some_and(has_meaningful_text) {
        return "截图片段".to_string();
    }
    if record.ax_text.as_deref().is_some_and(has_meaningful_text) || record.ax_focused_role.is_some() {
        return "界面片段".to_string();
    }
    friendly_event_type_label(&record.event_type).to_string()
}

fn friendly_raw_type_label(event_type: &str, record: &CaptureRecord) -> String {
    if record.input_text.as_deref().is_some_and(has_meaningful_text) {
        return "原始模态：输入".to_string();
    }
    if record.audio_text.as_deref().is_some_and(has_meaningful_text) {
        return "原始模态：音频".to_string();
    }
    if record.ocr_text.as_deref().is_some_and(has_meaningful_text) || record.screenshot_path.is_some() {
        return "原始模态：OCR / 截图".to_string();
    }
    if record.ax_text.as_deref().is_some_and(has_meaningful_text) || record.ax_focused_role.is_some() {
        return "原始模态：AX / UI".to_string();
    }
    format!("原始事件：{}", friendly_event_type_label(event_type))
}

fn friendly_event_type_label(event_type: &str) -> &'static str {
    match event_type {
        "app_switch" => "应用切换",
        "mouse_click" => "鼠标点击",
        "scroll" => "滚动",
        "key_pause" => "键入停顿",
        "manual" => "手动记录",
        "auto" => "自动采集",
        _ => "其他片段",
    }
}

fn has_meaningful_text(value: &str) -> bool {
    !value.trim().is_empty()
}

fn parse_json_vec_string(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

fn parse_json_value<T>(value: &str) -> Vec<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str::<Vec<T>>(value).unwrap_or_default()
}

fn to_json_string<T: Serialize>(value: &T) -> Result<String, ApiError> {
    serde_json::to_string(value).map_err(|err| ApiError::Internal(format!("序列化 bake 数据失败: {err}")))
}

fn infer_suggested_action(tags: &[String]) -> Option<String> {
    if tags.iter().any(|tag| tag.contains("SOP") || tag.contains("流程")) {
        Some("sop".to_string())
    } else if tags.iter().any(|tag| tag.contains("方案") || tag.contains("模板")) {
        Some("template".to_string())
    } else {
        Some("knowledge".to_string())
    }
}

fn infer_confidence(importance: i64, occurrence_count: Option<i64>) -> String {
    let occurrences = occurrence_count.unwrap_or(0);
    if importance >= 4 || occurrences >= 3 {
        "high".to_string()
    } else if importance >= 3 || occurrences >= 1 {
        "medium".to_string()
    } else {
        "low".to_string()
    }
}

fn extract_status(entry: &KnowledgeEntryRecord) -> String {
    let details = parse_details(entry.details.as_deref());
    extract_status_from_details(&details, entry.user_verified)
}

fn format_ts_ms(ts: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ts)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| now_ms().to_string())
}

fn first_or_default(values: &[String], default: &str) -> String {
    values.first().cloned().unwrap_or_else(|| default.to_string())
}

fn default_style_config() -> BakeStyleConfig {
    BakeStyleConfig {
        preferred_phrases: vec!["整体看".to_string(), "这里建议".to_string(), "当前主要问题是".to_string()],
        replacement_rules: vec![
            ReplacementRulePayload { from: "综上所述".to_string(), to: "整体看".to_string() },
            ReplacementRulePayload { from: "进一步优化".to_string(), to: "继续改进".to_string() },
        ],
        style_samples: vec![
            "整体看，这次改动优先解决主链路稳定性问题。".to_string(),
            "这里建议先把页面骨架搭起来，再逐步接真接口。".to_string(),
        ],
        apply_to_creation: true,
        apply_to_template_editing: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::models::{EventType, NewCapture};

    fn make_service() -> BakeService {
        let storage = StorageManager::open_in_memory().expect("内存数据库初始化失败");
        BakeService::new(storage, "http://127.0.0.1:7071")
    }

    fn seed_capture(service: &BakeService, ts: i64, app_name: &str, title: &str) -> i64 {
        service.storage.insert_capture(&NewCapture {
            ts,
            app_name: Some(app_name.to_string()),
            app_bundle_id: Some(format!("com.example.{app_name}")),
            win_title: Some(title.to_string()),
            event_type: EventType::Manual,
            ax_text: Some("原文内容".to_string()),
            ax_focused_role: None,
            ax_focused_id: None,
            screenshot_path: None,
            input_text: None,
            is_sensitive: false,
        }).expect("插入 capture 失败")
    }

    fn seed_knowledge(service: &BakeService, category: &str, capture_id: i64, importance: i64, occurrence_count: i64) -> i64 {
        service.storage.insert_knowledge_entry(&NewKnowledgeEntry {
            capture_id,
            summary: format!("{category}-summary-{capture_id}"),
            overview: Some("知识摘要".to_string()),
            details: Some("{}".to_string()),
            entities: r#"["模板","流程"]"#.to_string(),
            category: category.to_string(),
            importance,
            occurrence_count: Some(occurrence_count),
            observed_at: Some(1_710_000_000_000),
            event_time_start: None,
            event_time_end: None,
            history_view: true,
            content_origin: Some("historical_content".to_string()),
            activity_type: Some("reading".to_string()),
            is_self_generated: false,
            evidence_strength: Some("high".to_string()),
        }).expect("插入 knowledge 失败")
    }

    #[test]
    fn test_initialize_memories_is_idempotent() {
        let service = make_service();
        let capture_id = seed_capture(&service, 1_710_000_000_000, "Chrome", "方案页");
        seed_knowledge(&service, "meeting", capture_id, 4, 3);

        let first = service.initialize_memories(10).expect("首次初始化失败");
        assert_eq!(first.created_count, 1);
        assert_eq!(first.articles.len(), 1);
        assert_eq!(first.articles[0].open_count, 0);
        assert!(first.articles[0].last_visited_at.is_some());

        let second = service.initialize_memories(10).expect("二次初始化失败");
        assert_eq!(second.created_count, 0);
    }

    #[test]
    fn test_infer_suggested_action() {
        assert_eq!(infer_suggested_action(&["SOP".to_string()]), Some("sop".to_string()));
        assert_eq!(infer_suggested_action(&["技术方案".to_string()]), Some("template".to_string()));
    }

    #[test]
    fn test_parse_json_vec_string() {
        let values = parse_json_vec_string(r#"["a","b"]"#);
        assert_eq!(values, vec!["a", "b"]);
    }
}
