use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::api::error::ApiError;
use crate::storage::models::CaptureRecord;
use crate::storage::{
    now_ms, BakeActivityRecord, BakeDocumentRecord, BakeKnowledgeRecord, BakeMemorySourceRecord,
    BakeOverviewRecord, BakeRunRecord, NewBakeDocument, NewBakeKnowledge, NewBakeRun, NewBakeSop,
    NewTimeline, StorageError, StorageManager, TimelineRecord,
};

const BAKE_STYLE_CONFIG_KEY: &str = "bake.style.config";
const CATEGORY_BAKE_ARTICLE: &str = "bake_article";
const CATEGORY_BAKE_SOP: &str = "bake_sop";
const CATEGORY_BAKE_KNOWLEDGE: &str = "bake_knowledge";
const UNIFIED_BAKE_PIPELINE_NAME: &str = "unified";
const BAKE_GENERATION_VERSION: &str = "bake-v1";
// sidecar HTTP 调用超时：必须 ≥ ai-sidecar 内 ollama 客户端超时（当前 1200s），
// 否则会先在 core 这层断开但 sidecar 还在算，浪费一整次 LLM 推理。
const BAKE_SIDECAR_TIMEOUT_SECS: u64 = 1200;
/// 整个 bake run 的最大执行时间（含候选查询、LLM 提炼、数据库写入）。
/// 超过此时间强制标记为 failed，防止因死锁或无限等待导致 run 永久挂起。
const BAKE_RUN_MAX_TOTAL_SECS: u64 = 30 * 60;
/// 单条 timeline 在 bake 流水线里允许的最大失败次数。
/// 达到该值后，[`StorageManager::list_bake_memory_init_candidates_with_max_failures`]
/// 会把它过滤掉，避免毒丸候选反复触发整轮失败。
const MAX_BAKE_RETRY_FAILURES: i64 = 3;

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
            Some(other) => Err(ApiError::BadRequest(format!(
                "invalid bake bucket: {other}"
            ))),
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
    pub from_ts: Option<i64>,
    pub to_ts: Option<i64>,
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
    pub screenshot_source: Option<String>,
    pub url: Option<String>,
    pub webpage_title: Option<String>,
    pub is_sensitive: bool,
    pub pii_scrubbed: bool,
    pub best_text: Option<String>,
    pub summary: Option<String>,
    pub linked_timeline_id: Option<String>,
    pub linked_timeline_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeKnowledgePayload {
    pub id: String,
    pub capture_id: String,
    pub source_timeline_id: String,
    pub summary: String,
    pub overview: Option<String>,
    pub details: Option<String>,
    pub detailed_content: Option<String>,
    pub entities: Vec<String>,
    pub category: String,
    pub importance: i64,
    pub occurrence_count: i64,
    pub observed_at: Option<i64>,
    pub status: String,
    pub review_status: String,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub created_at: String,
    pub created_at_ms: i64,
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
pub struct DocumentSectionPayload {
    pub title: String,
    pub keywords: Vec<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeDocumentPayload {
    pub id: String,
    pub title: String,
    pub doc_type: String,
    pub status: String,
    pub tags: Vec<String>,
    pub applicable_tasks: Vec<String>,
    pub source_memory_ids: Vec<String>,
    pub source_capture_ids: Vec<String>,
    pub source_episode_ids: Vec<String>,
    pub linked_knowledge_ids: Vec<String>,
    pub sections: Vec<DocumentSectionPayload>,
    pub style_phrases: Vec<String>,
    pub replacement_rules: Vec<ReplacementRulePayload>,
    pub summary: Option<String>,
    pub full_content: Option<String>,
    pub prompt_hint: Option<String>,
    pub diagram_code: Option<String>,
    pub image_assets: Vec<String>,
    pub source_url: Option<String>,
    pub usage_count: i64,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub creation_mode: String,
    pub review_status: String,
    pub evidence_summary: Option<String>,
    pub generation_version: Option<String>,
    pub deleted_at: Option<i64>,
    pub created_at: String,
    pub created_at_ms: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeMemoryPayload {
    pub id: String,
    pub title: String,
    pub url: Option<String>,
    pub source_capture_id: Option<String>,
    pub source_timeline_id: Option<String>,
    pub details: Option<String>,
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
    pub capture_ids: Vec<i64>,
    #[serde(rename = "keyTimestamps")]
    pub key_timestamps: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeLinkedKnowledgeSummaryPayload {
    pub id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeSopPayload {
    pub id: String,
    pub source_capture_id: String,
    pub source_timeline_id: String,
    pub source_title: Option<String>,
    pub trigger_keywords: Vec<String>,
    pub confidence: String,
    pub extracted_problem: Option<String>,
    pub detailed_content: Option<String>,
    pub steps: Vec<String>,
    pub linked_knowledge_ids: Vec<String>,
    pub linked_knowledge_summaries: Vec<BakeLinkedKnowledgeSummaryPayload>,
    pub status: String,
    pub created_at: String,
    pub created_at_ms: i64,
    pub updated_at: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeOverviewPayload {
    pub capture_count: i64,
    pub memory_count: i64,
    pub knowledge_count: i64,
    pub template_count: i64,
    pub sop_count: i64,
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
    pub inventory_trend: Vec<BakeInventoryTrendBucketPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeInventoryTrendBucketPayload {
    pub label: String,
    pub start_ts: i64,
    pub end_ts: i64,
    pub memory_count: i64,
    pub knowledge_count: i64,
    pub template_count: i64,
    pub sop_count: i64,
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
    pub document_created_count: i64,
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
    pub source_timeline_id: i64,
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
    pub capture_url: Option<String>,
    pub capture_webpage_title: Option<String>,
    pub url_aggregated_text: Option<String>,
    pub url_aggregated_capture_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeExtractResponse {
    pub knowledge: BakeArtifactExtraction,
    #[serde(rename = "design", alias = "document")]
    pub document: BakeArtifactExtraction,
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
pub struct BakeMergeDocumentRequest {
    pub existing_document: Value,
    pub candidate: BakeExtractCandidatePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeMergeDocumentResponse {
    pub title: String,
    pub summary: Option<String>,
    pub full_content: Option<String>,
    pub evidence_summary: Option<String>,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    #[serde(default)]
    pub no_change: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeKnowledgeArtifactPayload {
    pub summary: String,
    pub overview: Option<String>,
    pub details: Option<String>,
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
pub struct BakeDocumentArtifactPayload {
    #[serde(rename = "name", alias = "title")]
    pub title: String,
    #[serde(rename = "category", alias = "doc_type")]
    pub doc_type: Option<String>,
    pub summary: Option<String>,
    pub full_content: Option<String>,
    pub details: Option<String>,
    pub prompt_hint: Option<String>,
    pub status: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub applicable_tasks: Vec<String>,
    #[serde(default, rename = "structure_sections", alias = "sections")]
    pub sections: Vec<DocumentSectionPayload>,
    #[serde(default)]
    pub style_phrases: Vec<String>,
    #[serde(default)]
    pub replacement_rules: Vec<ReplacementRulePayload>,
    pub diagram_code: Option<String>,
    pub evidence_summary: Option<String>,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub review_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BakeSopArtifactPayload {
    pub summary: String,
    pub overview: Option<String>,
    pub details: Option<String>,
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

    pub async fn preview_memory(
        &self,
        id: i64,
        trigger_reason: &str,
    ) -> Result<BakeExtractResponse, ApiError> {
        let memory = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found")))?;
        if memory.category != CATEGORY_BAKE_ARTICLE {
            return Err(ApiError::BadRequest(format!(
                "knowledge {id} is not in category {CATEGORY_BAKE_ARTICLE}"
            )));
        }

        let details = parse_details(memory.details.as_deref());
        let source_timeline_id = details
            .get("source_timeline_id")
            .or_else(|| details.get("source_knowledge_id"))
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                ApiError::BadRequest(format!("memory {id} missing source_timeline_id"))
            })?;

        let source_timeline = self
            .storage
            .get_timeline_entry(source_timeline_id)?
            .ok_or_else(|| {
                ApiError::NotFound(format!("source knowledge {source_timeline_id} not found"))
            })?;

        let capture = self
            .storage
            .get_capture(source_timeline.capture_id)?
            .ok_or_else(|| {
                ApiError::NotFound(format!("capture {} not found", source_timeline.capture_id))
            })?;

        let candidate = BakeMemorySourceRecord {
            timeline: source_timeline,
            capture_ts: capture.ts,
            capture_app_name: capture.app_name,
            capture_win_title: capture.win_title,
            capture_ax_text: capture.ax_text,
            capture_ocr_text: capture.ocr_text,
            capture_input_text: capture.input_text,
            capture_audio_text: capture.audio_text,
            capture_url: None,
            capture_webpage_title: None,
            url_aggregated_text: None,
            url_aggregated_capture_count: 0,
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
        self.storage
            .upsert_preference(BAKE_STYLE_CONFIG_KEY, &value, "user", 1.0)?;
        Ok(config.clone())
    }

    pub fn list_documents(&self) -> Result<Vec<BakeDocumentPayload>, ApiError> {
        Ok(self
            .storage
            .list_bake_documents()?
            .into_iter()
            .filter(is_current_bake_document)
            .map(map_document_record)
            .collect())
    }

    pub fn list_documents_paginated(
        &self,
        filter: BakeListFilter,
    ) -> Result<BakePagedResponse<BakeDocumentPayload>, ApiError> {
        let mut items = self
            .storage
            .list_bake_documents()?
            .into_iter()
            .filter(is_current_bake_document)
            .filter(|record| matches_document_bucket(record, filter.bucket))
            .filter(|record| {
                filter
                    .from_ts
                    .map_or(true, |from| record.updated_at >= from)
            })
            .filter(|record| filter.to_ts.map_or(true, |to| record.updated_at <= to))
            .map(map_document_record)
            .collect::<Vec<_>>();

        if let Some(query) = filter.q.as_deref() {
            let query_lower = query.to_lowercase();
            items.retain(|item| {
                item.title.to_lowercase().contains(&query_lower)
                    || item.doc_type.to_lowercase().contains(&query_lower)
                    || item
                        .prompt_hint
                        .as_deref()
                        .unwrap_or_default()
                        .to_lowercase()
                        .contains(&query_lower)
            });
        }

        let total = items.len() as i64;
        let items = items
            .into_iter()
            .skip(filter.offset)
            .take(filter.limit)
            .collect();
        Ok(BakePagedResponse {
            items,
            total,
            limit: filter.limit,
            offset: filter.offset,
        })
    }

    pub fn create_document(
        &self,
        payload: CreateOrUpdateDocumentRequest,
    ) -> Result<BakeDocumentPayload, ApiError> {
        let record = request_to_new_document(payload)?;
        let id = self.storage.insert_bake_document(&record)?;
        let created = self
            .storage
            .get_bake_document(id)?
            .ok_or_else(|| ApiError::NotFound(format!("document {id} not found after insert")))?;
        Ok(map_document_record(created))
    }

    pub fn get_document(&self, id: i64) -> Result<BakeDocumentPayload, ApiError> {
        let record = self
            .storage
            .get_bake_document(id)?
            .filter(is_current_bake_document)
            .ok_or_else(|| ApiError::NotFound(format!("document {id} not found")))?;
        Ok(map_document_record(record))
    }

    pub fn adopt_document(&self, id: i64) -> Result<BakeDocumentPayload, ApiError> {
        let mut record = self
            .storage
            .get_bake_document(id)?
            .ok_or_else(|| ApiError::NotFound(format!("document {id} not found")))?;
        record.review_status = "confirmed".to_string();
        if record.status == "draft" {
            record.status = "enabled".to_string();
        }
        let update = bake_document_record_to_new(record);
        self.storage.update_bake_document(id, &update)?;
        let updated = self
            .storage
            .get_bake_document(id)?
            .ok_or_else(|| ApiError::NotFound(format!("document {id} not found after update")))?;
        Ok(map_document_record(updated))
    }

    pub fn update_document(
        &self,
        id: i64,
        payload: CreateOrUpdateDocumentRequest,
    ) -> Result<BakeDocumentPayload, ApiError> {
        let record = request_to_new_document(payload)?;
        if !self.storage.update_bake_document(id, &record)? {
            return Err(ApiError::NotFound(format!("document {id} not found")));
        }
        let updated = self
            .storage
            .get_bake_document(id)?
            .ok_or_else(|| ApiError::NotFound(format!("document {id} not found after update")))?;
        Ok(map_document_record(updated))
    }

    pub fn toggle_document_status(&self, id: i64) -> Result<BakeDocumentPayload, ApiError> {
        let document = self
            .storage
            .toggle_bake_document_status(id)?
            .ok_or_else(|| ApiError::NotFound(format!("document {id} not found")))?;
        Ok(map_document_record(document))
    }

    pub fn delete_document(&self, id: i64) -> Result<(), ApiError> {
        if !self.storage.soft_delete_bake_document(id)? {
            return Err(ApiError::NotFound(format!("document {id} not found")));
        }
        Ok(())
    }
    pub fn list_sops(&self) -> Result<Vec<BakeSopPayload>, ApiError> {
        Ok(self
            .storage
            .list_timelines_by_category(CATEGORY_BAKE_SOP)?
            .into_iter()
            .filter(is_current_bake_entry)
            .filter(|record| matches_entry_bucket(record, None))
            .map(|record| map_sop_record_with_linked_summaries(&self.storage, record))
            .collect())
    }

    pub fn list_sops_paginated(
        &self,
        filter: BakeListFilter,
    ) -> Result<BakePagedResponse<BakeSopPayload>, ApiError> {
        let records = self.storage.list_timelines_by_category(CATEGORY_BAKE_SOP)?;
        let filtered_records = if let Some(query) = filter.q.as_deref() {
            let query_lower = query.to_lowercase();
            records
                .into_iter()
                .filter(|record| {
                    is_current_bake_entry(record)
                        && matches_entry_bucket(record, filter.bucket)
                        && filter
                            .from_ts
                            .map_or(true, |from| record.created_at_ms >= from)
                        && filter.to_ts.map_or(true, |to| record.created_at_ms <= to)
                        && (record.summary.to_lowercase().contains(&query_lower)
                            || record
                                .overview
                                .as_deref()
                                .unwrap_or_default()
                                .to_lowercase()
                                .contains(&query_lower)
                            || record
                                .details
                                .as_deref()
                                .unwrap_or_default()
                                .to_lowercase()
                                .contains(&query_lower)
                            || record.category.to_lowercase().contains(&query_lower))
                })
                .collect::<Vec<_>>()
        } else {
            records
                .into_iter()
                .filter(is_current_bake_entry)
                .filter(|record| matches_entry_bucket(record, filter.bucket))
                .filter(|record| {
                    filter
                        .from_ts
                        .map_or(true, |from| record.created_at_ms >= from)
                })
                .filter(|record| filter.to_ts.map_or(true, |to| record.created_at_ms <= to))
                .collect::<Vec<_>>()
        };
        let total = filtered_records.len() as i64;
        let items = filtered_records
            .into_iter()
            .skip(filter.offset)
            .take(filter.limit)
            .map(|record| map_sop_record_with_linked_summaries(&self.storage, record))
            .collect();
        Ok(BakePagedResponse {
            items,
            total,
            limit: filter.limit,
            offset: filter.offset,
        })
    }

    pub fn get_sop(&self, id: i64) -> Result<BakeSopPayload, ApiError> {
        let record = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("sop {id} not found")))?;
        if record.category != CATEGORY_BAKE_SOP {
            return Err(ApiError::NotFound(format!("sop {id} not found")));
        }
        Ok(map_sop_record_with_linked_summaries(&self.storage, record))
    }

    pub fn adopt_sop(&self, id: i64) -> Result<BakeSopPayload, ApiError> {
        let entry = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("sop {id} not found")))?;
        if entry.category != CATEGORY_BAKE_SOP {
            return Err(ApiError::BadRequest(format!(
                "knowledge {id} is not a bake sop"
            )));
        }
        let details = parse_details(entry.details.as_deref())
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut next_details = serde_json::Map::from_iter(details);
        next_details.insert("status".to_string(), json!("confirmed"));
        next_details.insert("review_status".to_string(), json!("confirmed"));
        let entities = entry.entities.clone();
        self.storage.update_timeline_details_system(
            id,
            &entry.summary,
            entry.overview.as_deref(),
            Some(&Value::Object(next_details).to_string()),
            &entities,
        )?;
        self.storage.set_knowledge_verified(id, true)?;
        let updated = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("sop {id} not found after update")))?;
        Ok(map_sop_record_with_linked_summaries(&self.storage, updated))
    }

    pub fn ignore_sop(&self, id: i64) -> Result<BakeSopPayload, ApiError> {
        let updated = self.update_bake_artifact_status(id, CATEGORY_BAKE_SOP, "ignored")?;
        Ok(map_sop_record_with_linked_summaries(&self.storage, updated))
    }

    pub fn delete_sop(&self, id: i64) -> Result<(), ApiError> {
        self.delete_bake_artifact(id, CATEGORY_BAKE_SOP)
    }

    pub fn list_memories(&self) -> Result<Vec<BakeMemoryPayload>, ApiError> {
        self.storage
            .list_timelines_paginated(None, 5000, 0)?
            .into_iter()
            .map(|record| self.map_memory_record_with_capture_url(record))
            .collect()
    }

    pub fn list_memories_paginated(
        &self,
        filter: BakeMemoryFilter,
    ) -> Result<BakePagedResponse<BakeMemoryPayload>, ApiError> {
        let total = self.storage.count_bake_memories_filtered(
            filter.q.as_deref(),
            filter.from_ts,
            filter.to_ts,
        )?;
        let items = self
            .storage
            .list_bake_memories_paginated(
                filter.q.as_deref(),
                filter.from_ts,
                filter.to_ts,
                filter.limit,
                filter.offset,
            )?
            .into_iter()
            .map(|record| self.map_memory_record_with_capture_url(record))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(BakePagedResponse {
            items,
            total,
            limit: filter.limit,
            offset: filter.offset,
        })
    }

    pub fn list_knowledge_paginated(
        &self,
        filter: BakeListFilter,
    ) -> Result<BakePagedResponse<BakeKnowledgePayload>, ApiError> {
        let records = self
            .storage
            .list_bake_knowledge_paginated(filter.q.as_deref(), 5000, 0)?;
        let filtered = records
            .into_iter()
            .filter(is_current_bake_entry)
            .filter(|record| matches_entry_bucket(record, filter.bucket))
            .filter(|record| {
                filter
                    .from_ts
                    .map_or(true, |from| record.created_at_ms >= from)
            })
            .filter(|record| filter.to_ts.map_or(true, |to| record.created_at_ms <= to))
            .map(map_bake_knowledge_record)
            .collect::<Vec<_>>();
        let total = filtered.len() as i64;
        let items = filtered
            .into_iter()
            .skip(filter.offset)
            .take(filter.limit)
            .collect();
        Ok(BakePagedResponse {
            items,
            total,
            limit: filter.limit,
            offset: filter.offset,
        })
    }

    pub fn get_knowledge(&self, id: i64) -> Result<BakeKnowledgePayload, ApiError> {
        let record = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("knowledge {id} not found")))?;
        if record.category != CATEGORY_BAKE_KNOWLEDGE {
            return Err(ApiError::NotFound(format!("knowledge {id} not found")));
        }
        Ok(map_bake_knowledge_record(record))
    }

    pub fn adopt_knowledge(&self, id: i64) -> Result<BakeKnowledgePayload, ApiError> {
        let updated = self.update_bake_artifact_status(id, CATEGORY_BAKE_KNOWLEDGE, "confirmed")?;
        Ok(map_bake_knowledge_record(updated))
    }

    pub fn ignore_knowledge(&self, id: i64) -> Result<BakeKnowledgePayload, ApiError> {
        let updated = self.update_bake_artifact_status(id, CATEGORY_BAKE_KNOWLEDGE, "ignored")?;
        Ok(map_bake_knowledge_record(updated))
    }

    pub fn delete_knowledge(&self, id: i64) -> Result<(), ApiError> {
        self.delete_bake_artifact(id, CATEGORY_BAKE_KNOWLEDGE)
    }

    pub fn list_capture_records_paginated(
        &self,
        filter: BakeCaptureFilter,
    ) -> Result<BakePagedResponse<BakeCapturePayload>, ApiError> {
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
        let timeline_links = self.storage.list_capture_timeline_links(&capture_ids)?;
        let items = records
            .into_iter()
            .map(|record| {
                let capture_id = record.id;
                map_capture_record(record, timeline_links.get(&capture_id))
            })
            .collect();
        Ok(BakePagedResponse {
            items,
            total,
            limit: capture_filter.limit,
            offset: capture_filter.offset,
        })
    }

    pub fn get_capture_record(&self, id: i64) -> Result<BakeCapturePayload, ApiError> {
        let record = self
            .storage
            .get_capture(id)?
            .ok_or_else(|| ApiError::NotFound(format!("capture {id} not found")))?;
        let timeline_links = self.storage.list_capture_timeline_links(&[record.id])?;
        Ok(map_capture_record(record, timeline_links.get(&id)))
    }

    pub fn initialize_memories(
        &self,
        limit: usize,
    ) -> Result<InitializeBakeMemoriesResponse, ApiError> {
        // 历史版本会在 timelines 中创建 category=bake_article 的候选壳；新流程直接写入专门的 bake_* 表。
        let skipped = self
            .storage
            .list_bake_memory_init_candidates(0, limit.saturating_mul(4).max(limit))?
            .into_iter()
            .filter(|candidate| is_high_value_candidate(&candidate.timeline))
            .take(limit)
            .count() as i64;
        let created = Vec::new();

        Ok(InitializeBakeMemoriesResponse {
            created_count: 0,
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
    ) -> Result<TimelineRecord, ApiError> {
        let entry = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("artifact {id} not found")))?;
        if entry.category != expected_category {
            return Err(ApiError::BadRequest(format!(
                "knowledge {id} is not in category {expected_category}"
            )));
        }

        let details = parse_details(entry.details.as_deref())
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut next_details = serde_json::Map::from_iter(details);
        next_details.insert("status".to_string(), json!(status));
        next_details.insert("review_status".to_string(), json!(status));
        self.storage.update_timeline_details_system(
            id,
            &entry.summary,
            entry.overview.as_deref(),
            Some(&Value::Object(next_details).to_string()),
            &entry.entities,
        )?;
        if matches!(status, "confirmed" | "auto_created") {
            self.storage.set_knowledge_verified(id, true)?;
        }
        let updated = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("artifact {id} not found after update")))?;
        Ok(updated)
    }

    fn delete_bake_artifact(&self, id: i64, expected_category: &str) -> Result<(), ApiError> {
        let entry = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("artifact {id} not found")))?;
        if entry.category != expected_category {
            return Err(ApiError::BadRequest(format!(
                "knowledge {id} is not in category {expected_category}"
            )));
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

    pub fn promote_memory_to_document(&self, id: i64) -> Result<BakeDocumentPayload, ApiError> {
        let memory = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found")))?;
        if memory.category != CATEGORY_BAKE_ARTICLE {
            return Err(ApiError::BadRequest(format!(
                "knowledge {id} is not in category {CATEGORY_BAKE_ARTICLE}"
            )));
        }

        let payload = self.map_memory_record_with_capture_url(memory.clone())?;
        let source_memory_ids = vec![id.to_string()];
        let source_capture_ids = payload
            .source_capture_id
            .clone()
            .map(|value| vec![value])
            .unwrap_or_default();
        let linked_knowledge_ids = payload
            .source_timeline_id
            .clone()
            .map(|value| vec![value])
            .unwrap_or_default();
        let structure_sections = vec![
            DocumentSectionPayload {
                title: "可复用结构".to_string(),
                keywords: payload.tags.clone(),
                notes: memory.overview.clone(),
            },
            DocumentSectionPayload {
                title: "写作参考".to_string(),
                keywords: vec!["表达风格".to_string(), "行文脉络".to_string()],
                notes: Some("从该时间线手动沉淀，后续可继续补充章节与表达规则。".to_string()),
            },
        ];
        let detailed_content = format!(
            "## 模板价值\n\n{}\n\n## 使用建议\n\n- 参考该时间线的结构和表达方式生成新的方案、设计或汇报文档。\n- 后续可继续补充章节标题、常用表达和 AI 替代词规则。",
            memory
                .overview
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&memory.summary)
        );

        let document = NewBakeDocument {
            title: memory.summary,
            doc_type: "手动沉淀".to_string(),
            status: "enabled".to_string(),
            tags: to_json_string(&payload.tags)?,
            applicable_tasks: to_json_string(&vec![
                "方案撰写".to_string(),
                "设计文档".to_string(),
                "汇报总结".to_string(),
            ])?,
            source_memory_ids: to_json_string(&source_memory_ids)?,
            source_capture_ids: to_json_string(&source_capture_ids)?,
            source_episode_ids: to_json_string(&source_memory_ids)?,
            linked_knowledge_ids: to_json_string(&linked_knowledge_ids)?,
            sections_json: to_json_string(&structure_sections)?,
            style_phrases: "[]".to_string(),
            replacement_rules: "[]".to_string(),
            summary: None,
            full_content: Some(detailed_content),
            structured_content: "{}".to_string(),
            prompt_hint: Some("参考该时间线的结构、行文脉络和表达风格生成新文档。".to_string()),
            diagram_code: None,
            image_assets: "[]".to_string(),
            source_app_name: None,
            source_win_title: None,
            source_url: payload.url.clone(),
            content_hash: None,
            language: None,
            usage_count: 0,
            match_score: None,
            match_level: None,
            creation_mode: "manual".to_string(),
            review_status: "auto_created".to_string(),
            evidence_summary: Some("由用户从收藏时间线手动沉淀为文档。".to_string()),
            generation_version: None,
            deleted_at: None,
        };
        let document_id = self.storage.insert_bake_document(&document)?;
        let created = self
            .storage
            .get_bake_document(document_id)?
            .ok_or_else(|| {
                ApiError::NotFound(format!("document {document_id} not found after insert"))
            })?;
        Ok(map_document_record(created))
    }

    pub fn promote_memory_to_sop(&self, id: i64) -> Result<BakeSopPayload, ApiError> {
        let memory = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found")))?;
        let payload = self.map_memory_record_with_capture_url(memory.clone())?;
        let details = json!({
            "source_capture_id": memory.capture_id.to_string(),
            "source_title": payload.title,
            "trigger_keywords": payload.tags,
            "confidence": "medium",
            "steps": ["确认问题类型", "查找关联知识", "输出标准说明"],
            "linked_knowledge_ids": [id.to_string()],
            "status": "auto_created"
        });
        let new_entry = NewTimeline {
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
            capture_ids: None,
            start_time: None,
            end_time: None,
            duration_minutes: None,
            frag_app_name: None,
            frag_win_title: None,
            time_range_start: None,
            time_range_end: None,
            key_timestamps: None,
        };
        let sop_id = self.storage.insert_episodic_memory(&new_entry)?;
        let created = self
            .storage
            .get_timeline_entry(sop_id)?
            .ok_or_else(|| ApiError::NotFound(format!("sop {sop_id} not found after insert")))?;
        Ok(map_sop_record_with_linked_summaries(&self.storage, created))
    }

    pub async fn run_bake_pipeline(
        &self,
        trigger_reason: &str,
        limit: usize,
    ) -> Result<BakeRunPayload, ApiError> {
        let started_at = now_ms();
        let run_id = self.storage.insert_bake_run(&NewBakeRun {
            trigger_reason: trigger_reason.to_string(),
            status: "running".to_string(),
            started_at,
        })?;

        let result = self
            .execute_bake_pipeline(run_id, trigger_reason, started_at, limit)
            .await;
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

    /// 把烤制流水线丢到独立 tokio task 跑，立即返回 run_id。
    ///
    /// 这避免了客户端（例如 ai-sidecar 的 15s urlopen 超时）关闭连接时 axum
    /// 把整个 handler future drop 掉、导致 [`Self::run_bake_pipeline`] 的
    /// match 收尾代码永远不执行、`bake_runs.status` 永远停在 `running` 的问题。
    /// 后台 task 自带 try-catch，不论 Ok/Err 都会写收尾状态。
    pub fn spawn_bake_pipeline(
        self,
        trigger_reason: String,
        limit: usize,
    ) -> Result<i64, ApiError> {
        let started_at = now_ms();
        let run_id = self.storage.insert_bake_run(&NewBakeRun {
            trigger_reason: trigger_reason.clone(),
            status: "running".to_string(),
            started_at,
        })?;

        tokio::spawn(async move {
            // 用 timeout 包裹整个 execute_bake_pipeline，防止任何原因导致永久挂起
            let result = tokio::time::timeout(
                Duration::from_secs(BAKE_RUN_MAX_TOTAL_SECS),
                self.execute_bake_pipeline(run_id, &trigger_reason, started_at, limit),
            )
            .await;

            match result {
                Ok(Ok(_)) => {
                    tracing::info!("bake run {} completed in background", run_id);
                }
                Ok(Err(err)) => {
                    let completed_at = now_ms();
                    let latency_ms = completed_at.saturating_sub(started_at);
                    let write_result = self.storage.complete_bake_run(
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
                    if let Err(write_err) = write_result {
                        tracing::error!(
                            "bake run {} failed in background; status write also failed: err={} write_err={}",
                            run_id,
                            err,
                            write_err
                        );
                    } else {
                        tracing::error!("bake run {} failed in background: {}", run_id, err);
                    }
                }
                Err(_elapsed) => {
                    let completed_at = now_ms();
                    let latency_ms = completed_at.saturating_sub(started_at);
                    tracing::error!(
                        "bake run {} timed out after {}s, forcing failed status",
                        run_id,
                        BAKE_RUN_MAX_TOTAL_SECS
                    );
                    let write_result = self.storage.complete_bake_run(
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
                        Some(&format!(
                            "bake run timed out after {}s",
                            BAKE_RUN_MAX_TOTAL_SECS
                        )),
                        Some(latency_ms),
                    );
                    if let Err(write_err) = write_result {
                        tracing::error!(
                            "bake run {} timeout cleanup failed: write_err={}",
                            run_id,
                            write_err
                        );
                    }
                }
            }
        });

        Ok(run_id)
    }

    async fn execute_bake_pipeline(
        &self,
        run_id: i64,
        trigger_reason: &str,
        started_at: i64,
        limit: usize,
    ) -> Result<BakeRunPayload, ApiError> {
        // 并行化并发度上限：LLM extract 并行，persist 串行保持正确性
        const EXTRACT_CONCURRENCY: usize = 3;

        tracing::info!("bake run {} execute_bake_pipeline start", run_id);

        // document 去重仍需全量（需要 URL 去重 + source_episode_ids JSON 解析），沿用原逻辑
        let existing_documents = self.storage.list_bake_documents()?;
        let watermark = self
            .storage
            .get_bake_watermark(UNIFIED_BAKE_PIPELINE_NAME)?;
        let mut existing_document_sources =
            collect_current_document_source_timeline_ids(&existing_documents);
        let mut existing_document_urls: std::collections::HashSet<String> = existing_documents
            .iter()
            .filter_map(|d| d.source_url.as_deref().map(normalize_doc_url))
            .filter(|s| !s.is_empty())
            .collect();
        let mut max_processed_ts = watermark
            .as_ref()
            .map(|item| item.last_processed_ts)
            .unwrap_or(0);

        let candidates = self
            .storage
            .list_bake_memory_init_candidates_with_max_failures(
                max_processed_ts,
                limit.saturating_mul(6).max(limit),
                MAX_BAKE_RETRY_FAILURES,
            )?;

        // 增量查询：只针对本批候选的 timeline_id 集合查已有 knowledge/sop，
        // 避免全量拉取 500 条导致随数据增长内存和时间开销膨胀。
        let candidate_timeline_ids: Vec<i64> = candidates.iter().map(|c| c.timeline.id).collect();
        let mut existing_knowledge_sources = self
            .storage
            .find_existing_knowledge_timeline_ids(&candidate_timeline_ids)
            .map_err(|e| ApiError::Internal(format!("查询已有 knowledge 失败: {e}")))?;
        let mut existing_sop_sources = self
            .storage
            .find_existing_sop_timeline_ids(&candidate_timeline_ids)
            .map_err(|e| ApiError::Internal(format!("查询已有 sop 失败: {e}")))?;

        // Watermark 自动回退：如果 watermark 已超过所有现有 timeline 的 updated_at_ms，
        // 导致候选列表为空（真正有 pending 的情况下），则把 watermark 重置为 0 重新扫描全量。
        // 修复：同时检查 knowledge / sop / document 三类，避免 document 候选被误判为"无 pending"。
        let candidates = if candidates.is_empty() && max_processed_ts > 0 {
            let probe = self
                .storage
                .list_bake_memory_init_candidates_with_max_failures(
                    0,
                    1,
                    MAX_BAKE_RETRY_FAILURES,
                )?;
            let probe_ids: Vec<i64> = probe.iter().map(|c| c.timeline.id).collect();
            let probe_knowledge = self
                .storage
                .find_existing_knowledge_timeline_ids(&probe_ids)
                .unwrap_or_default();
            let probe_sop = self
                .storage
                .find_existing_sop_timeline_ids(&probe_ids)
                .unwrap_or_default();
            let any_pending = probe.iter().any(|c| {
                !probe_sop.contains(&c.timeline.id)
                    && !probe_knowledge.contains(&c.timeline.id)
                    && !existing_document_sources.contains(&c.timeline.id)
            });
            if any_pending {
                tracing::info!(
                    "bake watermark reset: watermark={} 已超过所有候选，自动回退到 0 重新扫描",
                    max_processed_ts
                );
                max_processed_ts = 0;
                let full = self
                    .storage
                    .list_bake_memory_init_candidates_with_max_failures(
                        0,
                        limit.saturating_mul(6).max(limit),
                        MAX_BAKE_RETRY_FAILURES,
                    )?;
                // 重新增量查询覆盖全量候选
                let full_ids: Vec<i64> = full.iter().map(|c| c.timeline.id).collect();
                existing_knowledge_sources = self
                    .storage
                    .find_existing_knowledge_timeline_ids(&full_ids)
                    .unwrap_or_default();
                existing_sop_sources = self
                    .storage
                    .find_existing_sop_timeline_ids(&full_ids)
                    .unwrap_or_default();
                full
            } else {
                candidates
            }
        } else {
            candidates
        };

        // 过滤出需要 LLM extract 的候选，跳过低价值和已超过 watermark 的
        let mut skippable_ts_list: Vec<i64> = Vec::new();
        let mut extract_queue: Vec<BakeMemorySourceRecord> = Vec::new();

        for candidate in candidates {
            if extract_queue.len() + skippable_ts_list.len() >= limit {
                break;
            }
            let candidate_ts = candidate.timeline.updated_at_ms;
            if candidate_ts <= max_processed_ts {
                continue;
            }
            if !is_high_value_candidate(&candidate.timeline) {
                tracing::info!(
                    "bake skip: timeline_id={} importance={} evidence={:?} activity={:?} origin={:?} history_view={} self_generated={} reason=not_high_value",
                    candidate.timeline.id,
                    candidate.timeline.importance,
                    candidate.timeline.evidence_strength,
                    candidate.timeline.activity_type,
                    candidate.timeline.content_origin,
                    candidate.timeline.history_view,
                    candidate.timeline.is_self_generated,
                );
                skippable_ts_list.push(candidate_ts);
                continue;
            }
            extract_queue.push(candidate);
        }

        // 先推进所有跳过项的 watermark
        for ts in skippable_ts_list {
            let next = max_processed_ts.max(ts);
            if next != max_processed_ts {
                max_processed_ts = next;
                self.storage
                    .upsert_bake_watermark(UNIFIED_BAKE_PIPELINE_NAME, next)?;
            }
        }

        let initial_candidate_count = extract_queue.len() as i64;
        let _ = self
            .storage
            .update_bake_run_progress(run_id, initial_candidate_count, 0);

        // 并行 extract：用 tokio semaphore 限制并发度为 EXTRACT_CONCURRENCY
        // persist 保持串行（按原始顺序），保证 existing_*_sources HashSet 的正确性
        //
        // 位点预推进策略：在 spawn extract task 前立即写 watermark，确保外层整轮超时
        // kill 后下一轮不会重复处理同一批候选。失败时只记 retry_failure，watermark 已推进。
        let semaphore = Arc::new(tokio::sync::Semaphore::new(EXTRACT_CONCURRENCY));
        let trigger_reason_owned = trigger_reason.to_string();

        type ExtractResult = (
            BakeMemorySourceRecord,
            Result<BakeExtractResponse, ApiError>,
        );
        let mut extract_futures: Vec<tokio::task::JoinHandle<ExtractResult>> = Vec::new();

        for candidate in extract_queue {
            // 预推进 watermark：派出即视为已处理，超时后下一轮不重复
            let next = max_processed_ts.max(candidate.timeline.updated_at_ms);
            if next != max_processed_ts {
                max_processed_ts = next;
                self.storage
                    .upsert_bake_watermark(UNIFIED_BAKE_PIPELINE_NAME, next)?;
            }
            let sem = semaphore.clone();
            let service = self.clone();
            let reason = trigger_reason_owned.clone();
            let handle = tokio::spawn(async move {
                let _permit = sem.acquire().await.expect("semaphore closed");
                tracing::info!(
                    "bake process: timeline_id={} importance={} evidence={:?} activity={:?} category={} summary_head={:?}",
                    candidate.timeline.id,
                    candidate.timeline.importance,
                    candidate.timeline.evidence_strength,
                    candidate.timeline.activity_type,
                    candidate.timeline.category,
                    candidate.timeline.summary.chars().take(40).collect::<String>(),
                );
                let result = service.extract_candidate(&reason, &candidate).await;
                (candidate, result)
            });
            extract_futures.push(handle);
        }

        // 按顺序 await 并串行 persist（保证 HashSet 一致性 & watermark 单调）
        let mut processed_episode_count = 0_i64;
        let mut auto_created_count = 0_i64;
        let mut candidate_count = 0_i64;
        let mut discarded_count = 0_i64;
        let mut knowledge_created_count = 0_i64;
        let mut document_created_count = 0_i64;
        let mut sop_created_count = 0_i64;

        for handle in extract_futures {
            let (candidate, extract_result) = handle
                .await
                .map_err(|e| ApiError::Internal(format!("bake extract task panicked: {e}")))?;
            let candidate_ts = candidate.timeline.updated_at_ms;

            let extracted = match extract_result {
                Ok(v) => v,
                Err(err) => {
                    let count = self
                        .storage
                        .bump_bake_retry_failure(candidate.timeline.id, &err.to_string())
                        .unwrap_or(0);
                    tracing::warn!(
                        "bake extract failed: timeline_id={} failure_count={} err={}",
                        candidate.timeline.id,
                        count,
                        err
                    );
                    // watermark 已在 spawn 前预写，失败只记 retry_failure
                    continue;
                }
            };
            processed_episode_count += 1;
            let _ = self.storage.update_bake_run_progress(
                run_id,
                initial_candidate_count,
                processed_episode_count,
            );

            let candidate_result = match self
                .persist_extracted_candidate(
                    None,
                    &candidate,
                    trigger_reason,
                    extracted,
                    &mut existing_knowledge_sources,
                    &mut existing_document_sources,
                    &mut existing_document_urls,
                    &mut existing_sop_sources,
                )
                .await
            {
                Ok(r) => r,
                Err(err) => {
                    let count = self
                        .storage
                        .bump_bake_retry_failure(candidate.timeline.id, &err.to_string())
                        .unwrap_or(0);
                    tracing::warn!(
                        "bake persist failed: timeline_id={} failure_count={} err={}",
                        candidate.timeline.id,
                        count,
                        err
                    );
                    continue;
                }
            };

            auto_created_count += candidate_result.auto_created_count;
            candidate_count += candidate_result.candidate_count;
            discarded_count += candidate_result.discarded_count;
            knowledge_created_count += candidate_result.knowledge_created_count;
            document_created_count += candidate_result.document_created_count;
            sop_created_count += candidate_result.sop_created_count;
            // watermark 已在 spawn 前预写，此处无需再推进
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
            document_created_count,
            sop_created_count,
            None,
            Some(latency_ms),
        )?;
        let latest = self.storage.get_latest_bake_run()?.ok_or_else(|| {
            ApiError::NotFound(format!("bake run {run_id} not found after completion"))
        })?;
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

        let response = self
            .client
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
            let status = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let error = map_sidecar_error(status, body_text, "bake 提炼服务");
            Err(ApiError::Upstream {
                status: error.status,
                code: error.code,
                message: error.message,
            })
        }
    }

    async fn persist_extracted_candidate(
        &self,
        memory_id: Option<i64>,
        candidate: &BakeMemorySourceRecord,
        trigger_reason: &str,
        extracted: BakeExtractResponse,
        existing_knowledge_sources: &mut std::collections::HashSet<i64>,
        existing_document_sources: &mut std::collections::HashSet<i64>,
        existing_document_urls: &mut std::collections::HashSet<String>,
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
        result.apply(
            self.persist_document_artifact(
                memory_id,
                candidate,
                &extracted.document,
                existing_document_sources,
                existing_document_urls,
            )
            .await?,
        );
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
        let source_capture_ids = collect_source_capture_id_strings(&self.storage, candidate)?;
        if existing_sources.contains(&candidate.timeline.id) {
            let existing = self
                .storage
                .find_bake_knowledge_by_timeline_id(candidate.timeline.id)?;
            let Some(existing) = existing else {
                tracing::warn!(
                    "bake knowledge existing set contained timeline_id={} but no row was found",
                    candidate.timeline.id,
                );
                existing_sources.remove(&candidate.timeline.id);
                return self.persist_knowledge_artifact(
                    memory_id,
                    candidate,
                    trigger_reason,
                    extraction,
                    existing_sources,
                );
            };
            if !extraction.accepted {
                self.merge_existing_knowledge_source_captures(&existing, &source_capture_ids)?;
                tracing::info!(
                    "bake knowledge source captures merged: timeline_id={} knowledge_id={} reason=already_has_knowledge_sidecar_rejected reason_text={:?}",
                    candidate.timeline.id,
                    existing.id,
                    extraction.reason,
                );
                return Ok(CandidatePersistResult::discarded());
            }

            let payload = extraction.payload.clone().ok_or_else(|| {
                ApiError::Internal(
                    "bake sidecar 返回 knowledge.accepted=true 但缺少 payload".to_string(),
                )
            })?;
            let payload: BakeKnowledgeArtifactPayload =
                serde_json::from_value(payload).map_err(|err| {
                    ApiError::Internal(format!("解析 bake knowledge payload 失败: {err}"))
                })?;
            if let Some(memory_id) = memory_id {
                self.update_memory_match_metadata(
                    memory_id,
                    "knowledge",
                    payload.match_score,
                    payload.match_level.as_deref(),
                )?;
            }
            let review_status = resolve_review_status(
                payload.review_status.as_deref(),
                payload.match_score,
                payload.match_level.as_deref(),
            );
            self.merge_existing_knowledge_artifact(
                &existing,
                candidate,
                trigger_reason,
                &payload,
                &review_status,
                &source_capture_ids,
            )?;
            tracing::info!(
                "bake knowledge merged: timeline_id={} knowledge_id={} sidecar_review_status={:?} match_score={:?} match_level={:?} resolved_review_status={}",
                candidate.timeline.id,
                existing.id,
                payload.review_status,
                payload.match_score,
                payload.match_level,
                review_status,
            );
            return Ok(CandidatePersistResult::default());
        }
        if !extraction.accepted {
            tracing::info!(
                "bake knowledge discard: timeline_id={} reason=sidecar_rejected reason_text={:?}",
                candidate.timeline.id,
                extraction.reason,
            );
            return Ok(CandidatePersistResult::discarded());
        }

        let payload = extraction.payload.clone().ok_or_else(|| {
            ApiError::Internal(
                "bake sidecar 返回 knowledge.accepted=true 但缺少 payload".to_string(),
            )
        })?;
        let payload: BakeKnowledgeArtifactPayload =
            serde_json::from_value(payload).map_err(|err| {
                ApiError::Internal(format!("解析 bake knowledge payload 失败: {err}"))
            })?;
        if let Some(memory_id) = memory_id {
            self.update_memory_match_metadata(
                memory_id,
                "knowledge",
                payload.match_score,
                payload.match_level.as_deref(),
            )?;
        }
        let review_status = resolve_review_status(
            payload.review_status.as_deref(),
            payload.match_score,
            payload.match_level.as_deref(),
        );
        tracing::info!(
            "bake knowledge accept: timeline_id={} sidecar_review_status={:?} match_score={:?} match_level={:?} resolved_review_status={}",
            candidate.timeline.id,
            payload.review_status,
            payload.match_score,
            payload.match_level,
            review_status,
        );
        let record = build_bake_knowledge_entry(
            candidate,
            &payload,
            &review_status,
            trigger_reason,
            &source_capture_ids,
        )?;
        self.storage.insert_bake_knowledge(&record)?;
        existing_sources.insert(candidate.timeline.id);
        Ok(CandidatePersistResult::created_knowledge(
            review_status == "auto_created",
        ))
    }

    fn merge_existing_knowledge_source_captures(
        &self,
        existing: &BakeKnowledgeRecord,
        source_capture_ids: &[String],
    ) -> Result<(), ApiError> {
        let merged_capture_ids = merge_string_lists(
            parse_optional_json_vec_string(&existing.source_capture_ids),
            source_capture_ids,
        );
        let source_capture_ids_json = to_json_string(&merged_capture_ids)?;
        self.storage.update_bake_knowledge_system(
            existing.id,
            &existing.title,
            &existing.summary,
            existing.content.as_deref(),
            existing.detailed_content.as_deref(),
            &existing.entities,
            existing.importance,
            Some(&source_capture_ids_json),
        )?;
        Ok(())
    }

    fn merge_existing_knowledge_artifact(
        &self,
        existing: &BakeKnowledgeRecord,
        candidate: &BakeMemorySourceRecord,
        trigger_reason: &str,
        payload: &BakeKnowledgeArtifactPayload,
        review_status: &str,
        source_capture_ids: &[String],
    ) -> Result<(), ApiError> {
        let merged_capture_ids = merge_string_lists(
            parse_optional_json_vec_string(&existing.source_capture_ids),
            source_capture_ids,
        );
        let merged_entities =
            merge_string_lists(parse_json_vec_string(&existing.entities), &payload.entities);
        let source_capture_ids_json = to_json_string(&merged_capture_ids)?;
        let entities_json = to_json_string(&merged_entities)?;
        let merged_details = merge_optional_text(
            existing.detailed_content.as_deref(),
            payload.details.as_deref(),
        );
        let mut next_content = parse_details(existing.content.as_deref());
        if !next_content.is_object() {
            next_content = json!({});
        }
        let next_details = next_content.as_object_mut().expect("object checked");
        next_details.insert(
            "source_timeline_id".to_string(),
            json!(candidate.timeline.id),
        );
        next_details.insert(
            "source_memory_ids".to_string(),
            json!([candidate.timeline.id.to_string()]),
        );
        next_details.insert("source_capture_ids".to_string(), json!(merged_capture_ids));
        next_details.insert(
            "source_timeline_ids".to_string(),
            json!([candidate.timeline.id.to_string()]),
        );
        next_details.insert(
            "match_score".to_string(),
            option_f64_json(payload.match_score),
        );
        next_details.insert(
            "match_level".to_string(),
            option_string_json(payload.match_level.as_deref()),
        );
        next_details.insert("creation_mode".to_string(), json!("llm_bake"));
        next_details.insert("review_status".to_string(), json!(review_status));
        next_details.insert(
            "evidence_summary".to_string(),
            option_string_json(payload.evidence_summary.as_deref()),
        );
        next_details.insert(
            "generation_version".to_string(),
            json!(BAKE_GENERATION_VERSION),
        );
        next_details.insert("trigger_reason".to_string(), json!(trigger_reason));
        next_details.insert("status".to_string(), json!(review_status));
        next_details.insert(
            "source_title".to_string(),
            json!(candidate.timeline.summary.clone()),
        );
        next_details.insert("merged_from_knowledge_id".to_string(), json!(existing.id));
        next_details.insert("merged_at_ms".to_string(), json!(now_ms()));

        let title = knowledge_title_from_payload(payload);
        let summary = knowledge_summary_from_payload(payload);
        let importance = payload
            .importance
            .unwrap_or(existing.importance)
            .max(existing.importance)
            .max(1);
        self.storage.update_bake_knowledge_system(
            existing.id,
            &title,
            &summary,
            Some(&next_content.to_string()),
            merged_details.as_deref(),
            &entities_json,
            importance,
            Some(&source_capture_ids_json),
        )?;
        Ok(())
    }

    async fn persist_document_artifact(
        &self,
        memory_id: Option<i64>,
        candidate: &BakeMemorySourceRecord,
        extraction: &BakeArtifactExtraction,
        existing_sources: &mut std::collections::HashSet<i64>,
        existing_urls: &mut std::collections::HashSet<String>,
    ) -> Result<CandidatePersistResult, ApiError> {
        if existing_sources.contains(&candidate.timeline.id) {
            if extraction.accepted {
                if let Some(existing_doc) = self
                    .storage
                    .find_bake_document_by_source_memory_id(candidate.timeline.id)?
                {
                    self.merge_document_with_sidecar(candidate, extraction, &existing_doc)
                        .await?;
                    tracing::info!(
                        "bake document merged: timeline_id={} doc_id={} reason=already_has_document_source",
                        candidate.timeline.id,
                        existing_doc.id,
                    );
                    return Ok(CandidatePersistResult::created_document(false));
                }
            }
            tracing::info!(
                "bake document discard: timeline_id={} reason=already_has_document",
                candidate.timeline.id,
            );
            return Ok(CandidatePersistResult::discarded());
        }
        let candidate_url_norm = candidate
            .capture_url
            .as_deref()
            .map(normalize_doc_url)
            .filter(|s| !s.is_empty());

        // URL 已存在：查询数据库中是否有该 URL 的文档，尝试合并而不是丢弃
        if let Some(ref u) = candidate_url_norm {
            if let Some(existing_doc) = self.storage.find_document_by_source_url(u)? {
                if extraction.accepted {
                    self.merge_document_with_sidecar(candidate, extraction, &existing_doc)
                        .await?;
                    existing_sources.insert(candidate.timeline.id);
                    existing_urls.insert(u.clone());
                    tracing::info!(
                        "bake document merged: timeline_id={} url={} doc_id={}",
                        candidate.timeline.id,
                        u,
                        existing_doc.id,
                    );
                    return Ok(CandidatePersistResult::created_document(false));
                } else {
                    tracing::info!(
                        "bake document discard: timeline_id={} reason=url_already_has_document_sidecar_rejected url={}",
                        candidate.timeline.id, u,
                    );
                    return Ok(CandidatePersistResult::discarded());
                }
            }
        }

        if !extraction.accepted {
            tracing::info!(
                "bake document discard: timeline_id={} reason=sidecar_rejected reason_text={:?}",
                candidate.timeline.id,
                extraction.reason,
            );
            return Ok(CandidatePersistResult::discarded());
        }

        let payload = extraction.payload.clone().ok_or_else(|| {
            ApiError::Internal("bake sidecar 返回 design.accepted=true 但缺少 payload".to_string())
        })?;
        let payload: BakeDocumentArtifactPayload = serde_json::from_value(payload)
            .map_err(|err| ApiError::Internal(format!("解析 bake design payload 失败: {err}")))?;
        if let Some(memory_id) = memory_id {
            self.update_memory_match_metadata(
                memory_id,
                "design",
                payload.match_score,
                payload.match_level.as_deref(),
            )?;
        }
        let review_status = resolve_review_status(
            payload.review_status.as_deref(),
            payload.match_score,
            payload.match_level.as_deref(),
        );
        tracing::info!(
            "bake document accept: timeline_id={} sidecar_review_status={:?} match_score={:?} match_level={:?} resolved_review_status={}",
            candidate.timeline.id,
            payload.review_status,
            payload.match_score,
            payload.match_level,
            review_status,
        );
        let source_capture_ids = collect_source_capture_id_strings(&self.storage, candidate)?;
        let document =
            build_bake_document(candidate, &payload, &review_status, &source_capture_ids)?;
        self.storage.insert_bake_document(&document)?;
        existing_sources.insert(candidate.timeline.id);
        if let Some(u) = candidate_url_norm {
            existing_urls.insert(u);
        }
        Ok(CandidatePersistResult::created_document(
            review_status == "auto_created",
        ))
    }

    async fn merge_document_with_sidecar(
        &self,
        candidate: &BakeMemorySourceRecord,
        extraction: &BakeArtifactExtraction,
        existing_doc: &BakeDocumentRecord,
    ) -> Result<(), ApiError> {
        let existing_json = serde_json::to_value(existing_doc)
            .map_err(|e| ApiError::Internal(format!("序列化已有文档失败: {e}")))?;
        let candidate_payload = map_extract_candidate_payload(candidate);
        let request_body = BakeMergeDocumentRequest {
            existing_document: existing_json,
            candidate: candidate_payload,
        };
        let url = format!("{}/bake/merge_document", self.sidecar_url);
        let response = self
            .client
            .post(&url)
            .json(&request_body)
            .timeout(Duration::from_secs(BAKE_SIDECAR_TIMEOUT_SECS))
            .send()
            .await
            .map_err(map_sidecar_request_error)?;

        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            tracing::warn!(
                "bake merge_document sidecar error status={} body={}",
                status,
                body
            );
            // 合并失败不阻断流程，仅记录警告
            return Ok(());
        }

        let merged: BakeMergeDocumentResponse = response
            .json()
            .await
            .map_err(|e| ApiError::Internal(format!("解析 merge_document 响应失败: {e}")))?;

        // 追加当前 timeline_id 到 source_memory_ids
        let mut source_ids = parse_json_vec_string(&existing_doc.source_memory_ids);
        let tid = candidate.timeline.id.to_string();
        if !source_ids.contains(&tid) {
            source_ids.push(tid.clone());
        }
        let mut source_capture_ids = parse_json_vec_string(&existing_doc.source_capture_ids);
        for cid in collect_source_capture_id_strings(&self.storage, candidate)? {
            if !source_capture_ids.contains(&cid) {
                source_capture_ids.push(cid);
            }
        }
        let mut source_episode_ids = parse_json_vec_string(&existing_doc.source_episode_ids);
        for sid in &source_ids {
            if !source_episode_ids.contains(sid) {
                source_episode_ids.push(sid.clone());
            }
        }
        let mut linked_knowledge_ids = parse_json_vec_string(&existing_doc.linked_knowledge_ids);
        if !linked_knowledge_ids.contains(&tid) {
            linked_knowledge_ids.push(tid);
        }

        let mut update = bake_document_record_to_new(existing_doc.clone());
        if !merged.no_change {
            update.title = merged.title;
            update.summary = merged.summary.or(update.summary);
            update.full_content = merged.full_content.or(update.full_content);
            update.evidence_summary = merged.evidence_summary.or(update.evidence_summary);
            update.match_score = merged.match_score.or(update.match_score);
            update.match_level = merged.match_level.or(update.match_level);
        } else {
            tracing::info!(
                "bake document no_change: timeline_id={} doc_id={} reason=content_already_covered",
                candidate.timeline.id,
                existing_doc.id,
            );
        }
        update.source_memory_ids =
            to_json_string(&source_ids).unwrap_or(existing_doc.source_memory_ids.clone());
        update.source_capture_ids =
            to_json_string(&source_capture_ids).unwrap_or(existing_doc.source_capture_ids.clone());
        update.source_episode_ids =
            to_json_string(&source_episode_ids).unwrap_or(existing_doc.source_episode_ids.clone());
        update.linked_knowledge_ids = to_json_string(&linked_knowledge_ids)
            .unwrap_or(existing_doc.linked_knowledge_ids.clone());

        // 更新 content_hash（若 full_content 有更新）
        if update.full_content.is_some() {
            update.content_hash = update.full_content.as_ref().map(|content| {
                let mut hasher = Sha256::new();
                hasher.update(content.as_bytes());
                format!("{:x}", hasher.finalize())
            });
        }

        self.storage
            .update_bake_document(existing_doc.id, &update)?;
        Ok(())
    }

    fn persist_sop_artifact(
        &self,
        memory_id: Option<i64>,
        candidate: &BakeMemorySourceRecord,
        trigger_reason: &str,
        extraction: &BakeArtifactExtraction,
        existing_sources: &mut std::collections::HashSet<i64>,
    ) -> Result<CandidatePersistResult, ApiError> {
        if existing_sources.contains(&candidate.timeline.id) {
            tracing::info!(
                "bake sop discard: timeline_id={} reason=already_has_sop",
                candidate.timeline.id,
            );
            return Ok(CandidatePersistResult::discarded());
        }
        if !extraction.accepted {
            tracing::info!(
                "bake sop discard: timeline_id={} reason=sidecar_rejected reason_text={:?}",
                candidate.timeline.id,
                extraction.reason,
            );
            return Ok(CandidatePersistResult::discarded());
        }

        let payload = extraction.payload.clone().ok_or_else(|| {
            ApiError::Internal("bake sidecar 返回 sop.accepted=true 但缺少 payload".to_string())
        })?;
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
        let review_status = resolve_review_status(
            payload.review_status.as_deref(),
            payload.match_score,
            payload.match_level.as_deref(),
        );
        tracing::info!(
            "bake sop accept: timeline_id={} sidecar_review_status={:?} match_score={:?} match_level={:?} resolved_review_status={}",
            candidate.timeline.id,
            payload.review_status,
            payload.match_score,
            payload.match_level,
            review_status,
        );
        let source_capture_ids = collect_source_capture_id_strings(&self.storage, candidate)?;
        let sop = build_bake_sop_entry(
            candidate,
            &payload,
            &review_status,
            trigger_reason,
            &source_capture_ids,
        )?;
        self.storage.insert_bake_sop(&sop)?;
        existing_sources.insert(candidate.timeline.id);
        Ok(CandidatePersistResult::created_sop(
            review_status == "auto_created",
        ))
    }
    fn update_memory_match_metadata(
        &self,
        memory_id: i64,
        artifact_kind: &str,
        match_score: Option<f64>,
        match_level: Option<&str>,
    ) -> Result<(), ApiError> {
        let entry = self
            .storage
            .get_timeline_entry(memory_id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {memory_id} not found")))?;
        let details = parse_details(entry.details.as_deref())
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut next_details = serde_json::Map::from_iter(details);
        next_details.insert(
            format!("{artifact_kind}_match_score"),
            match_score.map_or(Value::Null, Value::from),
        );
        next_details.insert(
            format!("{artifact_kind}_match_level"),
            match_level.map_or(Value::Null, |value| Value::String(value.to_string())),
        );
        if artifact_kind == "design" {
            next_details.insert(
                "template_match_score".to_string(),
                match_score.map_or(Value::Null, Value::from),
            );
            next_details.insert(
                "template_match_level".to_string(),
                match_level.map_or(Value::Null, |value| Value::String(value.to_string())),
            );
        }
        self.storage.update_timeline_details_system(
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
        let memory_entries = self.storage.list_timelines_paginated(None, 5000, 0)?;
        let knowledge_entries = self
            .storage
            .list_bake_knowledge_paginated(None, 5000, 0)?
            .into_iter()
            .filter(is_current_bake_entry)
            .collect::<Vec<_>>();
        let templates = self
            .storage
            .list_bake_documents()?
            .into_iter()
            .filter(is_current_bake_document)
            .collect::<Vec<_>>();
        let sop_entries = self
            .storage
            .list_timelines_by_category(CATEGORY_BAKE_SOP)?
            .into_iter()
            .filter(is_current_bake_entry)
            .collect::<Vec<_>>();
        let latest_run = self.storage.get_latest_bake_run()?;
        let memory_count = self.storage.count_timelines(None)?;
        let inventory_trend = build_inventory_trend(
            &memory_entries,
            &knowledge_entries,
            &templates,
            &sop_entries,
        );

        let pending_candidates = 0;

        let mut recent_activities: Vec<BakeActivityRecord> = memory_entries
            .iter()
            .take(3)
            .map(|entry| BakeActivityRecord {
                message: format!("情节记忆《{}》已进入烤面包队列", entry.summary),
                ts: entry.updated_at_ms,
            })
            .collect();
        recent_activities.extend(knowledge_entries.iter().take(2).map(|entry| {
            BakeActivityRecord {
                message: format!("知识《{}》已由 LLM 烤面包提炼", entry.summary),
                ts: entry.updated_at_ms,
            }
        }));
        recent_activities.extend(templates.iter().take(2).map(|template| BakeActivityRecord {
            message: format!("模板《{}》状态已更新为 {}", template.title, template.status),
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
            sop_count: sop_entries.len() as i64,
            pending_candidates,
            auto_created_today: latest_run
                .as_ref()
                .map(|run| run.auto_created_count)
                .unwrap_or(0),
            candidate_today: latest_run
                .as_ref()
                .map(|run| run.candidate_count)
                .unwrap_or(0),
            discarded_today: latest_run
                .as_ref()
                .map(|run| run.discarded_count)
                .unwrap_or(0),
            last_bake_run_status: latest_run.as_ref().map(|run| run.status.clone()),
            last_bake_run_at: latest_run
                .as_ref()
                .map(|run| run.completed_at.unwrap_or(run.started_at)),
            last_trigger_reason: latest_run.as_ref().map(|run| run.trigger_reason.clone()),
            knowledge_auto_count: latest_run
                .as_ref()
                .map(|run| run.knowledge_created_count)
                .unwrap_or(0),
            template_auto_count: latest_run
                .as_ref()
                .map(|run| run.document_created_count)
                .unwrap_or(0),
            sop_auto_count: latest_run
                .as_ref()
                .map(|run| run.sop_created_count)
                .unwrap_or(0),
            recent_activities,
        };

        Ok(BakeOverviewPayload {
            capture_count: overview.capture_count,
            memory_count: overview.memory_count,
            knowledge_count: overview.knowledge_count,
            template_count: overview.template_count,
            sop_count: overview.sop_count,
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
            recent_activities: overview
                .recent_activities
                .into_iter()
                .map(|item| item.message)
                .collect(),
            inventory_trend,
        })
    }

    fn update_memory_status(&self, id: i64, status: &str) -> Result<BakeMemoryPayload, ApiError> {
        let entry = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found")))?;
        let details = parse_details(entry.details.as_deref())
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut next_details = serde_json::Map::from_iter(details);
        next_details.insert("status".to_string(), json!(status));
        self.storage.update_timeline_details_system(
            id,
            &entry.summary,
            entry.overview.as_deref(),
            Some(&Value::Object(next_details).to_string()),
            &entry.entities,
        )?;
        let updated = self
            .storage
            .get_timeline_entry(id)?
            .ok_or_else(|| ApiError::NotFound(format!("memory {id} not found after update")))?;
        self.map_memory_record_with_capture_url(updated)
    }

    fn map_memory_record_with_capture_url(
        &self,
        record: TimelineRecord,
    ) -> Result<BakeMemoryPayload, ApiError> {
        let capture_url = self
            .storage
            .get_capture(record.capture_id)?
            .and_then(|capture| normalize_optional_url(capture.url));
        Ok(map_memory_record(record, capture_url))
    }
}

#[derive(Debug, Clone, Default)]
struct CandidatePersistResult {
    auto_created_count: i64,
    candidate_count: i64,
    discarded_count: i64,
    knowledge_created_count: i64,
    document_created_count: i64,
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

    fn created_document(auto_created: bool) -> Self {
        Self {
            auto_created_count: if auto_created { 1 } else { 0 },
            candidate_count: if auto_created { 0 } else { 1 },
            document_created_count: 1,
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
        self.document_created_count += other.document_created_count;
        self.sop_created_count += other.sop_created_count;
    }
}

fn map_extract_candidate_payload(
    candidate: &BakeMemorySourceRecord,
) -> BakeExtractCandidatePayload {
    BakeExtractCandidatePayload {
        source_timeline_id: candidate.timeline.id,
        source_capture_id: candidate.timeline.capture_id,
        summary: candidate.timeline.summary.clone(),
        overview: candidate.timeline.overview.clone(),
        details: candidate.timeline.details.clone(),
        entities: parse_json_vec_string(&candidate.timeline.entities),
        importance: candidate.timeline.importance,
        occurrence_count: candidate.timeline.occurrence_count,
        observed_at: candidate.timeline.observed_at,
        event_time_start: candidate.timeline.event_time_start,
        event_time_end: candidate.timeline.event_time_end,
        history_view: candidate.timeline.history_view,
        content_origin: candidate.timeline.content_origin.clone(),
        activity_type: candidate.timeline.activity_type.clone(),
        evidence_strength: candidate.timeline.evidence_strength.clone(),
        capture_ts: candidate.capture_ts,
        capture_app_name: candidate.capture_app_name.clone(),
        capture_win_title: candidate.capture_win_title.clone(),
        capture_ax_text: candidate.capture_ax_text.clone(),
        capture_ocr_text: candidate.capture_ocr_text.clone(),
        capture_input_text: candidate.capture_input_text.clone(),
        capture_audio_text: candidate.capture_audio_text.clone(),
        capture_url: candidate.capture_url.clone(),
        capture_webpage_title: candidate.capture_webpage_title.clone(),
        url_aggregated_text: candidate.url_aggregated_text.clone(),
        url_aggregated_capture_count: candidate.url_aggregated_capture_count,
    }
}

fn map_sidecar_request_error(err: reqwest::Error) -> ApiError {
    let msg = err.to_string();
    if err.is_timeout() || msg.contains("timed out") || msg.contains("timeout") {
        tracing::warn!("bake sidecar 响应超时: {}", err);
        ApiError::Upstream {
            status: StatusCode::GATEWAY_TIMEOUT,
            code: "GATEWAY_TIMEOUT",
            message: format!(
                "bake 提炼请求超时（>{} 秒），请稍后重试",
                BAKE_SIDECAR_TIMEOUT_SECS
            ),
        }
    } else {
        tracing::warn!("无法连接到 bake sidecar: {}", err);
        ApiError::Upstream {
            status: StatusCode::BAD_GATEWAY,
            code: "BAD_GATEWAY",
            message: format!("bake 提炼服务不可用，请确认 AI Sidecar 已正常启动: {err}"),
        }
    }
}

fn map_sidecar_error(
    status: StatusCode,
    body_text: String,
    service_name: &str,
) -> BakeSidecarError {
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

fn resolve_review_status(
    _value: Option<&str>,
    _match_score: Option<f64>,
    _match_level: Option<&str>,
) -> String {
    "auto_created".to_string()
}

fn collect_current_document_source_timeline_ids(
    records: &[BakeDocumentRecord],
) -> std::collections::HashSet<i64> {
    records
        .iter()
        .filter(|record| is_current_bake_document(record))
        .flat_map(|record| {
            parse_json_vec_string(&record.source_memory_ids)
                .into_iter()
                .filter_map(|value| value.parse::<i64>().ok())
        })
        .collect()
}

fn normalize_doc_url(url: &str) -> String {
    let trimmed = url.trim();
    let no_fragment = trimmed.split('#').next().unwrap_or(trimmed);
    no_fragment.trim_end_matches('/').to_string()
}

fn normalize_optional_url(url: Option<String>) -> Option<String> {
    url.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn collect_source_capture_id_strings(
    storage: &StorageManager,
    source: &BakeMemorySourceRecord,
) -> Result<Vec<String>, ApiError> {
    let timeline_capture_ids = storage.get_timeline_capture_ids(source.timeline.id)?;
    Ok(merge_string_lists(
        source_capture_id_strings(source),
        &timeline_capture_ids
            .into_iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>(),
    ))
}

fn source_capture_id_strings(source: &BakeMemorySourceRecord) -> Vec<String> {
    let mut ids = source
        .timeline
        .capture_ids
        .as_deref()
        .map(parse_json_vec_string_lossy)
        .unwrap_or_default();
    let primary = source.timeline.capture_id.to_string();
    if !ids.contains(&primary) {
        ids.insert(0, primary);
    }
    ids
}

fn build_bake_knowledge_entry(
    source: &BakeMemorySourceRecord,
    payload: &BakeKnowledgeArtifactPayload,
    review_status: &str,
    trigger_reason: &str,
    source_capture_ids: &[String],
) -> Result<NewBakeKnowledge, ApiError> {
    let entities = if payload.entities.is_empty() {
        parse_json_vec_string(&source.timeline.entities)
    } else {
        payload.entities.clone()
    };
    let details = json!({
        "source_timeline_id": source.timeline.id,
        "source_memory_ids": [source.timeline.id.to_string()],
        "source_capture_ids": source_capture_ids,
        "source_timeline_ids": [source.timeline.id.to_string()],
        "episode_cluster_id": source.timeline.capture_id.to_string(),
        "match_score": payload.match_score,
        "match_level": payload.match_level.clone(),
        "creation_mode": "llm_bake",
        "review_status": review_status,
        "evidence_summary": payload.evidence_summary.clone(),
        "generation_version": BAKE_GENERATION_VERSION,
        "trigger_reason": trigger_reason,
        "status": review_status,
        "source_title": source.timeline.summary.clone(),
    });
    Ok(NewBakeKnowledge {
        timeline_id: source.timeline.id,
        title: knowledge_title_from_payload(payload),
        summary: knowledge_summary_from_payload(payload),
        content: Some(details.to_string()),
        detailed_content: payload.details.clone(),
        entities: to_json_string(&entities)?,
        importance: payload
            .importance
            .unwrap_or(source.timeline.importance)
            .max(1),
        source_capture_ids: Some(to_json_string(&source_capture_ids)?),
    })
}

fn build_bake_document(
    source: &BakeMemorySourceRecord,
    payload: &BakeDocumentArtifactPayload,
    review_status: &str,
    source_capture_ids: &[String],
) -> Result<NewBakeDocument, ApiError> {
    let tags = if payload.tags.is_empty() {
        parse_json_vec_string(&source.timeline.entities)
    } else {
        payload.tags.clone()
    };
    let source_memory_ids = vec![source.timeline.id.to_string()];
    let full_content = payload
        .full_content
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| payload.details.clone());

    let content_hash = full_content.as_ref().map(|content| {
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        format!("{:x}", hasher.finalize())
    });

    let structured_content = json!({
        "sections": payload.sections,
        "style_phrases": payload.style_phrases,
        "replacement_rules": payload.replacement_rules,
        "usage_notes": payload.details,
    })
    .to_string();
    Ok(NewBakeDocument {
        title: payload.title.clone(),
        doc_type: payload
            .doc_type
            .clone()
            .unwrap_or_else(|| "文档模板".to_string()),
        status: payload
            .status
            .clone()
            .filter(|status| status != "draft")
            .unwrap_or_else(|| "enabled".to_string()),
        tags: to_json_string(&tags)?,
        applicable_tasks: to_json_string(&payload.applicable_tasks)?,
        source_memory_ids: to_json_string(&source_memory_ids)?,
        source_capture_ids: to_json_string(&source_capture_ids)?,
        source_episode_ids: to_json_string(&source_memory_ids)?,
        linked_knowledge_ids: to_json_string(&source_memory_ids)?,
        sections_json: to_json_string(&payload.sections)?,
        style_phrases: to_json_string(&payload.style_phrases)?,
        replacement_rules: to_json_string(&payload.replacement_rules)?,
        summary: payload.summary.clone(),
        full_content,
        structured_content,
        prompt_hint: payload.prompt_hint.clone(),
        diagram_code: payload.diagram_code.clone(),
        image_assets: "[]".to_string(),
        source_app_name: source.capture_app_name.clone(),
        source_win_title: source.capture_win_title.clone(),
        source_url: source.capture_url.clone(),
        content_hash,
        language: None,
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
    source_capture_ids: &[String],
) -> Result<NewBakeSop, ApiError> {
    let trigger_keywords = if payload.trigger_keywords.is_empty() {
        parse_json_vec_string(&source.timeline.entities)
    } else {
        payload.trigger_keywords.clone()
    };
    let linked_knowledge_ids = if payload.linked_knowledge_ids.is_empty() {
        vec![source.timeline.id.to_string()]
    } else {
        payload.linked_knowledge_ids.clone()
    };
    let details = json!({
        "source_timeline_id": source.timeline.id,
        "source_memory_ids": [source.timeline.id.to_string()],
        "source_capture_ids": source_capture_ids,
        "match_score": payload.match_score,
        "match_level": payload.match_level.clone(),
        "creation_mode": "llm_bake",
        "review_status": review_status,
        "evidence_summary": payload.evidence_summary.clone(),
        "generation_version": BAKE_GENERATION_VERSION,
        "trigger_reason": trigger_reason,
        "source_capture_id": source.timeline.capture_id.to_string(),
        "source_title": payload.source_title.clone().unwrap_or_else(|| source.timeline.summary.clone()),
        "trigger_keywords": trigger_keywords,
        "confidence": payload.confidence.clone().unwrap_or_else(|| infer_confidence(source.timeline.importance, source.timeline.occurrence_count)),
        "extracted_problem": payload.extracted_problem.clone(),
        "steps": payload.steps,
        "linked_knowledge_ids": linked_knowledge_ids,
        "status": review_status,
    });
    Ok(NewBakeSop {
        timeline_id: source.timeline.id,
        title: payload
            .overview
            .clone()
            .unwrap_or_else(|| payload.summary.clone()),
        summary: payload.summary.clone(),
        content: Some(details.to_string()),
        detailed_content: payload.details.clone(),
        entities: source.timeline.entities.clone(),
        importance: source.timeline.importance.max(3),
        source_capture_ids: Some(to_json_string(&source_capture_ids)?),
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
        document_created_count: record.document_created_count,
        sop_created_count: record.sop_created_count,
        error_message: record.error_message,
        latency_ms: record.latency_ms,
    }
}

fn format_bake_run_activity(run: &BakeRunRecord) -> String {
    let summary = format!(
        "自动 {}，候选 {}，丢弃 {}",
        run.auto_created_count, run.candidate_count, run.discarded_count
    );
    match run.trigger_reason.as_str() {
        "knowledge_background" => format!("知识后台提炼后已自动执行分类烤面包（{}）", summary),
        "manual_debug" => format!("手动触发分类烤面包执行完成（{}）", summary),
        other => format!("分类提炼执行完成：{}（{}）", other, summary),
    }
}

fn map_capture_record(
    record: CaptureRecord,
    linked_timeline: Option<&(i64, String)>,
) -> BakeCapturePayload {
    let best_text = record.best_text().map(ToString::to_string);
    let summary = record.win_title.clone().or_else(|| {
        best_text
            .as_ref()
            .map(|text| text.chars().take(80).collect::<String>())
    });
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
        screenshot_source: record.screenshot_source,
        url: record.url,
        webpage_title: record.webpage_title,
        is_sensitive: record.is_sensitive,
        pii_scrubbed: record.pii_scrubbed,
        best_text,
        summary,
        linked_timeline_id: linked_timeline.map(|(id, _)| id.to_string()),
        linked_timeline_summary: linked_timeline.map(|(_, summary)| summary.clone()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateOrUpdateDocumentRequest {
    pub title: String,
    pub doc_type: String,
    pub status: String,
    pub tags: Vec<String>,
    pub applicable_tasks: Vec<String>,
    #[serde(default)]
    pub source_memory_ids: Vec<String>,
    #[serde(default)]
    pub source_capture_ids: Vec<String>,
    #[serde(default)]
    pub source_episode_ids: Vec<String>,
    #[serde(default)]
    pub linked_knowledge_ids: Vec<String>,
    #[serde(default)]
    pub sections: Vec<DocumentSectionPayload>,
    #[serde(default)]
    pub style_phrases: Vec<String>,
    #[serde(default)]
    pub replacement_rules: Vec<ReplacementRulePayload>,
    pub summary: Option<String>,
    pub full_content: Option<String>,
    #[serde(default)]
    pub structured_content: Option<String>,
    pub prompt_hint: Option<String>,
    pub diagram_code: Option<String>,
    #[serde(default)]
    pub image_assets: Vec<String>,
    pub source_app_name: Option<String>,
    pub source_win_title: Option<String>,
    pub source_url: Option<String>,
    pub content_hash: Option<String>,
    pub language: Option<String>,
    pub usage_count: Option<i64>,
    pub match_score: Option<f64>,
    pub match_level: Option<String>,
    pub creation_mode: Option<String>,
    pub review_status: Option<String>,
    pub evidence_summary: Option<String>,
    pub generation_version: Option<String>,
    pub deleted_at: Option<i64>,
}

fn request_to_new_document(
    payload: CreateOrUpdateDocumentRequest,
) -> Result<NewBakeDocument, ApiError> {
    Ok(NewBakeDocument {
        title: payload.title,
        doc_type: payload.doc_type,
        status: payload.status,
        tags: to_json_string(&payload.tags)?,
        applicable_tasks: to_json_string(&payload.applicable_tasks)?,
        source_memory_ids: to_json_string(&payload.source_memory_ids)?,
        source_capture_ids: to_json_string(&payload.source_capture_ids)?,
        source_episode_ids: to_json_string(&payload.source_episode_ids)?,
        linked_knowledge_ids: to_json_string(&payload.linked_knowledge_ids)?,
        sections_json: to_json_string(&payload.sections)?,
        style_phrases: to_json_string(&payload.style_phrases)?,
        replacement_rules: to_json_string(&payload.replacement_rules)?,
        summary: payload.summary,
        full_content: payload.full_content,
        structured_content: payload
            .structured_content
            .unwrap_or_else(|| "{}".to_string()),
        prompt_hint: payload.prompt_hint,
        diagram_code: payload.diagram_code,
        image_assets: to_json_string(&payload.image_assets)?,
        source_app_name: payload.source_app_name,
        source_win_title: payload.source_win_title,
        source_url: payload.source_url,
        content_hash: payload.content_hash,
        language: payload.language,
        usage_count: payload.usage_count.unwrap_or(0),
        match_score: payload.match_score,
        match_level: payload.match_level,
        creation_mode: payload
            .creation_mode
            .unwrap_or_else(|| "manual".to_string()),
        review_status: payload.review_status.unwrap_or_else(|| "draft".to_string()),
        evidence_summary: payload.evidence_summary,
        generation_version: payload.generation_version,
        deleted_at: payload.deleted_at,
    })
}

fn bake_document_record_to_new(record: BakeDocumentRecord) -> NewBakeDocument {
    NewBakeDocument {
        title: record.title,
        doc_type: record.doc_type,
        status: record.status,
        tags: record.tags,
        applicable_tasks: record.applicable_tasks,
        source_memory_ids: record.source_memory_ids,
        source_capture_ids: record.source_capture_ids,
        source_episode_ids: record.source_episode_ids,
        linked_knowledge_ids: record.linked_knowledge_ids,
        sections_json: record.sections_json,
        style_phrases: record.style_phrases,
        replacement_rules: record.replacement_rules,
        summary: record.summary,
        full_content: record.full_content,
        structured_content: record.structured_content,
        prompt_hint: record.prompt_hint,
        diagram_code: record.diagram_code,
        image_assets: record.image_assets,
        source_app_name: record.source_app_name,
        source_win_title: record.source_win_title,
        source_url: record.source_url,
        content_hash: record.content_hash,
        language: record.language,
        usage_count: record.usage_count,
        match_score: record.match_score,
        match_level: record.match_level,
        creation_mode: record.creation_mode,
        review_status: record.review_status,
        evidence_summary: record.evidence_summary,
        generation_version: record.generation_version,
        deleted_at: record.deleted_at,
    }
}

fn map_document_record(record: BakeDocumentRecord) -> BakeDocumentPayload {
    use chrono::{DateTime, Utc};
    let created_at = DateTime::<Utc>::from_timestamp(record.created_at / 1000, 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| record.created_at.to_string());
    let updated_at = DateTime::<Utc>::from_timestamp(record.updated_at / 1000, 0)
        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| record.updated_at.to_string());

    BakeDocumentPayload {
        id: record.id.to_string(),
        title: record.title,
        doc_type: record.doc_type,
        status: record.status,
        tags: parse_json_vec_string(&record.tags),
        applicable_tasks: parse_json_vec_string(&record.applicable_tasks),
        source_memory_ids: parse_json_vec_string(&record.source_memory_ids),
        source_capture_ids: parse_json_vec_string(&record.source_capture_ids),
        source_episode_ids: parse_json_vec_string(&record.source_episode_ids),
        linked_knowledge_ids: parse_json_vec_string(&record.linked_knowledge_ids),
        sections: serde_json::from_str(&record.sections_json).unwrap_or_default(),
        style_phrases: parse_json_vec_string(&record.style_phrases),
        replacement_rules: serde_json::from_str(&record.replacement_rules).unwrap_or_default(),
        summary: record.summary,
        full_content: record.full_content,
        prompt_hint: record.prompt_hint,
        diagram_code: record.diagram_code,
        image_assets: parse_json_vec_string(&record.image_assets),
        source_url: record.source_url,
        usage_count: record.usage_count,
        match_score: record.match_score,
        match_level: record.match_level,
        creation_mode: record.creation_mode,
        review_status: record.review_status,
        evidence_summary: record.evidence_summary,
        generation_version: record.generation_version,
        deleted_at: record.deleted_at,
        created_at,
        created_at_ms: record.created_at,
        updated_at,
    }
}

fn map_memory_record(record: TimelineRecord, capture_url: Option<String>) -> BakeMemoryPayload {
    let details = parse_details(record.details.as_deref());
    let tags = details
        .get("tags")
        .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
        .unwrap_or_else(|| parse_json_vec_string(&record.entities));

    let capture_ids = record
        .capture_ids
        .as_deref()
        .and_then(|s| serde_json::from_str::<Vec<i64>>(s).ok())
        .unwrap_or_default();

    BakeMemoryPayload {
        id: record.id.to_string(),
        title: record.summary,
        url: details
            .get("url")
            .and_then(Value::as_str)
            .and_then(|value| normalize_optional_url(Some(value.to_string())))
            .or(capture_url),
        source_capture_id: details
            .get("source_capture_id")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| Some(record.capture_id.to_string())),
        source_timeline_id: details
            .get("source_timeline_id")
            .or_else(|| details.get("source_knowledge_id"))
            .and_then(Value::as_i64)
            .map(|value| value.to_string()),
        details: details
            .get("description")
            .or_else(|| details.get("source_timeline_details"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| {
                record.details.as_ref().and_then(|raw| {
                    if serde_json::from_str::<Value>(raw).is_ok() {
                        None
                    } else {
                        Some(raw.clone())
                    }
                })
            }),
        summary: record.overview,
        weight: details
            .get("weight")
            .and_then(Value::as_i64)
            .unwrap_or(record.importance * 20),
        open_count: details
            .get("open_count")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        dwell_seconds: details
            .get("dwell_seconds")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        has_edit_action: details
            .get("has_edit_action")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        knowledge_ref_count: details
            .get("knowledge_ref_count")
            .and_then(Value::as_i64)
            .or(record.occurrence_count)
            .unwrap_or(0),
        status: details
            .get("status")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                if record.user_verified {
                    "confirmed".to_string()
                } else {
                    "candidate".to_string()
                }
            }),
        suggested_action: details
            .get("suggested_action")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| infer_suggested_action(&tags)),
        tags,
        last_visited_at: details
            .get("last_visited_at")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        created_at: record.created_at,
        created_at_ms: record.created_at_ms,
        knowledge_match_score: details.get("knowledge_match_score").and_then(Value::as_f64),
        knowledge_match_level: details
            .get("knowledge_match_level")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        template_match_score: details.get("template_match_score").and_then(Value::as_f64),
        template_match_level: details
            .get("template_match_level")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        sop_match_score: details.get("sop_match_score").and_then(Value::as_f64),
        sop_match_level: details
            .get("sop_match_level")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        capture_ids,
        key_timestamps: record
            .key_timestamps
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok()),
    }
}

fn map_bake_knowledge_record(record: TimelineRecord) -> BakeKnowledgePayload {
    let details = parse_details(record.details.as_deref());
    let status = extract_status_from_details(&details, record.user_verified);
    let review_status = details
        .get("review_status")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| status.clone());
    BakeKnowledgePayload {
        id: record.id.to_string(),
        capture_id: record.capture_id.to_string(),
        source_timeline_id: details
            .get("source_timeline_id")
            .or_else(|| details.get("source_knowledge_id"))
            .and_then(|value| {
                value
                    .as_i64()
                    .map(|id| id.to_string())
                    .or_else(|| value.as_str().map(ToString::to_string))
            })
            .unwrap_or_else(|| record.id.to_string()),
        summary: record.summary,
        overview: record.overview,
        details: record.details,
        detailed_content: record.detailed_content,
        entities: parse_json_vec_string(&record.entities),
        category: record.category,
        importance: record.importance,
        occurrence_count: record.occurrence_count.unwrap_or(0),
        observed_at: record.observed_at,
        status,
        review_status,
        match_score: details.get("match_score").and_then(Value::as_f64),
        match_level: details
            .get("match_level")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        created_at: record.created_at,
        created_at_ms: record.created_at_ms,
        updated_at: record.updated_at,
        updated_at_ms: record.updated_at_ms,
    }
}

fn map_sop_record_with_linked_summaries(
    storage: &StorageManager,
    record: TimelineRecord,
) -> BakeSopPayload {
    let details = parse_details(record.details.as_deref());
    let linked_knowledge_ids = details
        .get("linked_knowledge_ids")
        .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
        .unwrap_or_default();
    let linked_knowledge_summaries =
        resolve_linked_knowledge_summaries(storage, &linked_knowledge_ids);

    BakeSopPayload {
        id: record.id.to_string(),
        source_capture_id: details
            .get("source_capture_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        source_timeline_id: details
            .get("source_timeline_id")
            .or_else(|| details.get("source_knowledge_id"))
            .and_then(|value| {
                value
                    .as_i64()
                    .map(|id| id.to_string())
                    .or_else(|| value.as_str().map(ToString::to_string))
            })
            .unwrap_or_else(|| record.id.to_string()),
        source_title: details
            .get("source_title")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .or_else(|| Some(record.summary.clone())),
        trigger_keywords: details
            .get("trigger_keywords")
            .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
            .unwrap_or_else(|| parse_json_vec_string(&record.entities)),
        confidence: details
            .get("confidence")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| infer_confidence(record.importance, record.occurrence_count)),
        extracted_problem: Some(record.summary),
        detailed_content: record.detailed_content,
        steps: details
            .get("steps")
            .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
            .unwrap_or_default(),
        linked_knowledge_ids,
        linked_knowledge_summaries,
        status: details
            .get("status")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                if record.user_verified {
                    "confirmed".to_string()
                } else {
                    "candidate".to_string()
                }
            }),
        created_at: record.created_at,
        created_at_ms: record.created_at_ms,
        updated_at: record.updated_at,
        updated_at_ms: record.updated_at_ms,
    }
}

fn resolve_linked_knowledge_summaries(
    storage: &StorageManager,
    linked_knowledge_ids: &[String],
) -> Vec<BakeLinkedKnowledgeSummaryPayload> {
    linked_knowledge_ids
        .iter()
        .filter_map(|id| {
            let parsed_id = id.parse::<i64>().ok()?;
            let entry = storage.get_timeline_entry(parsed_id).ok().flatten()?;
            Some(BakeLinkedKnowledgeSummaryPayload {
                id: id.clone(),
                summary: entry.summary,
            })
        })
        .collect()
}

fn is_high_value_candidate(record: &TimelineRecord) -> bool {
    if record.is_self_generated {
        return false;
    }
    if record.importance >= 4 || record.user_verified {
        return true;
    }

    // 文档类候选（用户查看过某份文档）：直接通过，不要求 strong_evidence。
    // 是否真有可提炼的文档内容由 design 提炼阶段判断。
    if record.history_view {
        return true;
    }

    let strong_evidence = matches!(
        record.evidence_strength.as_deref(),
        Some("high") | Some("medium")
    );
    let preferred_activity = matches!(
        record.activity_type.as_deref(),
        Some("coding") | Some("reading") | Some("reviewing_history") | Some("document_reference")
    );
    let preferred_origin = matches!(
        record.content_origin.as_deref(),
        Some("historical_content") | Some("live_interaction")
    );

    strong_evidence && (preferred_activity || preferred_origin)
}

fn build_inventory_trend(
    memories: &[TimelineRecord],
    knowledge_entries: &[TimelineRecord],
    documents: &[BakeDocumentRecord],
    sops: &[TimelineRecord],
) -> Vec<BakeInventoryTrendBucketPayload> {
    const DAY_MS: i64 = 86_400_000;
    const MAX_BUCKETS: i64 = 8;

    let timestamps = memories
        .iter()
        .map(|record| record.created_at_ms)
        .chain(knowledge_entries.iter().map(|record| record.created_at_ms))
        .chain(documents.iter().map(|record| record.created_at))
        .chain(sops.iter().map(|record| record.created_at_ms))
        .filter(|ts| *ts > 0)
        .collect::<Vec<_>>();

    let Some(min_ts) = timestamps.iter().min().copied() else {
        return Vec::new();
    };
    let Some(max_ts) = timestamps.iter().max().copied() else {
        return Vec::new();
    };

    let start_day = (min_ts / DAY_MS) * DAY_MS;
    let end_day = (max_ts / DAY_MS) * DAY_MS;
    let total_days = ((end_day - start_day) / DAY_MS + 1).max(1);
    let bucket_count = total_days.min(MAX_BUCKETS).max(1);
    let days_per_bucket = ((total_days + bucket_count - 1) / bucket_count).max(1);
    let bucket_ms = days_per_bucket * DAY_MS;

    (0..bucket_count)
        .map(|index| {
            let start_ts = start_day + index * bucket_ms;
            let raw_end_ts = if index == bucket_count - 1 {
                i64::MAX
            } else {
                start_ts + bucket_ms
            };
            BakeInventoryTrendBucketPayload {
                label: format_trend_bucket_label(start_ts, bucket_ms),
                start_ts,
                end_ts: if raw_end_ts == i64::MAX {
                    start_ts + bucket_ms - 1
                } else {
                    raw_end_ts - 1
                },
                memory_count: count_records_in_bucket(
                    memories.iter().map(|record| record.created_at_ms),
                    start_ts,
                    raw_end_ts,
                ),
                knowledge_count: count_records_in_bucket(
                    knowledge_entries.iter().map(|record| record.created_at_ms),
                    start_ts,
                    raw_end_ts,
                ),
                template_count: count_records_in_bucket(
                    documents.iter().map(|record| record.created_at),
                    start_ts,
                    raw_end_ts,
                ),
                sop_count: count_records_in_bucket(
                    sops.iter().map(|record| record.created_at_ms),
                    start_ts,
                    raw_end_ts,
                ),
            }
        })
        .collect()
}

fn count_records_in_bucket<I>(timestamps: I, start_ts: i64, end_ts: i64) -> i64
where
    I: Iterator<Item = i64>,
{
    timestamps
        .filter(|ts| *ts > 0 && *ts >= start_ts && *ts < end_ts)
        .count() as i64
}

fn format_trend_bucket_label(start_ts: i64, bucket_ms: i64) -> String {
    let Some(start) = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(start_ts) else {
        return "未知".to_string();
    };
    if bucket_ms <= 86_400_000 {
        return start.format("%Y-%m-%d").to_string();
    }

    let end_ts = start_ts + bucket_ms - 86_400_000;
    let Some(end) = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(end_ts) else {
        return start.format("%Y-%m-%d").to_string();
    };
    format!("{}-{}", start.format("%Y-%m-%d"), end.format("%Y-%m-%d"))
}

fn parse_details(value: Option<&str>) -> Value {
    value
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| json!({}))
}

fn is_current_bake_entry(record: &TimelineRecord) -> bool {
    let details = parse_details(record.details.as_deref());
    !is_legacy_bake_entry_details(&details)
}

fn is_legacy_bake_entry_details(details: &Value) -> bool {
    details.get("creation_mode").and_then(Value::as_str) == Some("auto")
        && details.get("generation_version").and_then(Value::as_str)
            == Some(BAKE_GENERATION_VERSION)
}

fn is_current_bake_document(record: &BakeDocumentRecord) -> bool {
    !is_legacy_bake_document(record)
}

fn is_legacy_bake_document(record: &BakeDocumentRecord) -> bool {
    record.creation_mode == "auto"
        && record.generation_version.as_deref() == Some(BAKE_GENERATION_VERSION)
}

fn matches_document_bucket(record: &BakeDocumentRecord, bucket: Option<BakeBucket>) -> bool {
    match bucket {
        None => record.review_status != "ignored",
        Some(BakeBucket::Pending) => false,
        Some(BakeBucket::Extracted) => record.review_status != "ignored",
    }
}

fn matches_entry_bucket(record: &TimelineRecord, bucket: Option<BakeBucket>) -> bool {
    let status = extract_status(record);
    match bucket {
        None => status != "ignored",
        Some(BakeBucket::Pending) => false,
        Some(BakeBucket::Extracted) => status != "ignored",
    }
}

fn extract_status_from_details(details: &Value, user_verified: bool) -> String {
    details
        .get("status")
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            if user_verified {
                "confirmed".to_string()
            } else {
                "candidate".to_string()
            }
        })
}

fn infer_semantic_type_label(record: &CaptureRecord) -> String {
    if record
        .input_text
        .as_deref()
        .is_some_and(has_meaningful_text)
    {
        return "输入片段".to_string();
    }
    if record
        .audio_text
        .as_deref()
        .is_some_and(has_meaningful_text)
    {
        return "语音片段".to_string();
    }
    if record.screenshot_path.is_some()
        || record.ocr_text.as_deref().is_some_and(has_meaningful_text)
    {
        return "截图片段".to_string();
    }
    if record.ax_text.as_deref().is_some_and(has_meaningful_text)
        || record.ax_focused_role.is_some()
    {
        return "界面片段".to_string();
    }
    friendly_event_type_label(&record.event_type).to_string()
}

fn friendly_raw_type_label(event_type: &str, record: &CaptureRecord) -> String {
    if record
        .input_text
        .as_deref()
        .is_some_and(has_meaningful_text)
    {
        return "原始模态：输入".to_string();
    }
    if record
        .audio_text
        .as_deref()
        .is_some_and(has_meaningful_text)
    {
        return "原始模态：音频".to_string();
    }
    if record.ocr_text.as_deref().is_some_and(has_meaningful_text)
        || record.screenshot_path.is_some()
    {
        return "原始模态：OCR / 截图".to_string();
    }
    if record.ax_text.as_deref().is_some_and(has_meaningful_text)
        || record.ax_focused_role.is_some()
    {
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

fn deserialize_string_vec_mixed<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Option::<Vec<Value>>::deserialize(deserializer)?.unwrap_or_default();
    Ok(values
        .into_iter()
        .filter_map(|value| match value {
            Value::String(item) => Some(item),
            Value::Number(item) => Some(item.to_string()),
            Value::Bool(item) => Some(item.to_string()),
            _ => None,
        })
        .collect())
}

fn parse_json_vec_string(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(value).unwrap_or_default()
}

fn parse_json_vec_string_lossy(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<Value>>(value)
        .map(|values| {
            values
                .into_iter()
                .filter_map(|value| match value {
                    Value::String(item) => Some(item),
                    Value::Number(item) => Some(item.to_string()),
                    Value::Bool(item) => Some(item.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_optional_json_vec_string(value: &Option<String>) -> Vec<String> {
    value
        .as_deref()
        .map(parse_json_vec_string_lossy)
        .unwrap_or_default()
}

fn merge_string_lists(mut base: Vec<String>, extra: &[String]) -> Vec<String> {
    for item in extra {
        let item = item.trim();
        if !item.is_empty() && !base.iter().any(|value| value == item) {
            base.push(item.to_string());
        }
    }
    base
}

fn option_f64_json(value: Option<f64>) -> Value {
    value.map_or(Value::Null, Value::from)
}

fn option_string_json(value: Option<&str>) -> Value {
    value
        .map(|item| Value::String(item.to_string()))
        .unwrap_or(Value::Null)
}

fn merge_optional_text(existing: Option<&str>, incoming: Option<&str>) -> Option<String> {
    let existing = existing.map(str::trim).filter(|value| !value.is_empty());
    let incoming = incoming.map(str::trim).filter(|value| !value.is_empty());
    match (existing, incoming) {
        (Some(old), Some(new)) if old == new || old.contains(new) => Some(old.to_string()),
        (Some(old), Some(new)) if new.contains(old) => Some(new.to_string()),
        (Some(old), Some(new)) => Some(format!("{old}\n\n---\n\n{new}")),
        (Some(old), None) => Some(old.to_string()),
        (None, Some(new)) => Some(new.to_string()),
        (None, None) => None,
    }
}

fn knowledge_title_from_payload(payload: &BakeKnowledgeArtifactPayload) -> String {
    payload
        .overview
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| payload.summary.trim())
        .to_string()
}

fn knowledge_summary_from_payload(payload: &BakeKnowledgeArtifactPayload) -> String {
    payload
        .overview
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| payload.summary.clone())
}

fn parse_json_value<T>(value: &str) -> Vec<T>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_str::<Vec<T>>(value).unwrap_or_default()
}

fn to_json_string<T: Serialize>(value: &T) -> Result<String, ApiError> {
    serde_json::to_string(value)
        .map_err(|err| ApiError::Internal(format!("序列化 bake 数据失败: {err}")))
}

fn infer_suggested_action(tags: &[String]) -> Option<String> {
    if tags
        .iter()
        .any(|tag| tag.contains("SOP") || tag.contains("流程"))
    {
        Some("sop".to_string())
    } else if tags
        .iter()
        .any(|tag| tag.contains("方案") || tag.contains("设计") || tag.contains("架构"))
    {
        Some("design".to_string())
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

fn extract_status(entry: &TimelineRecord) -> String {
    let details = parse_details(entry.details.as_deref());
    extract_status_from_details(&details, entry.user_verified)
}

fn first_or_default(values: &[String], default: &str) -> String {
    values
        .first()
        .cloned()
        .unwrap_or_else(|| default.to_string())
}

fn default_style_config() -> BakeStyleConfig {
    BakeStyleConfig {
        preferred_phrases: vec![
            "整体看".to_string(),
            "这里建议".to_string(),
            "当前主要问题是".to_string(),
        ],
        replacement_rules: vec![
            ReplacementRulePayload {
                from: "综上所述".to_string(),
                to: "整体看".to_string(),
            },
            ReplacementRulePayload {
                from: "进一步优化".to_string(),
                to: "继续改进".to_string(),
            },
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
        service
            .storage
            .insert_capture(&NewCapture {
                ts,
                app_name: Some(app_name.to_string()),
                app_bundle_id: Some(format!("com.example.{app_name}")),
                win_title: Some(title.to_string()),
                event_type: EventType::Manual,
                ax_text: Some("原文内容".to_string()),
                ax_focused_role: None,
                ax_focused_id: None,
                ocr_text: None,
                screenshot_path: None,
                screenshot_source: None,
                input_text: None,
                url: None,
                webpage_title: None,
                is_sensitive: false,
                pii_scrubbed: false,
            })
            .expect("插入 capture 失败")
    }

    fn seed_knowledge(
        service: &BakeService,
        category: &str,
        capture_id: i64,
        importance: i64,
        occurrence_count: i64,
    ) -> i64 {
        service
            .storage
            .insert_timeline_entry(&NewTimeline {
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
                capture_ids: None,
                start_time: None,
                end_time: None,
                duration_minutes: None,
                frag_app_name: None,
                frag_win_title: None,
                time_range_start: None,
                time_range_end: None,
                key_timestamps: None,
            })
            .expect("插入 knowledge 失败")
    }

    fn link_captures_to_timeline(service: &BakeService, timeline_id: i64, capture_ids: &[i64]) {
        service
            .storage
            .with_conn(|conn| {
                for capture_id in capture_ids {
                    conn.execute(
                        "UPDATE captures SET timeline_id = ?1 WHERE id = ?2",
                        rusqlite::params![timeline_id, capture_id],
                    )
                    .map_err(StorageError::Sqlite)?;
                }
                Ok(())
            })
            .expect("关联 capture 到 timeline 失败");
    }

    fn make_candidate(service: &BakeService, timeline_id: i64) -> BakeMemorySourceRecord {
        let timeline = service
            .storage
            .get_timeline_entry(timeline_id)
            .expect("查询 timeline 失败")
            .expect("timeline 不存在");
        BakeMemorySourceRecord {
            timeline,
            capture_ts: 1_710_000_000_000,
            capture_app_name: Some("Code".to_string()),
            capture_win_title: Some("知识来源".to_string()),
            capture_ax_text: Some("候选文本".to_string()),
            capture_ocr_text: None,
            capture_input_text: None,
            capture_audio_text: None,
            capture_url: None,
            capture_webpage_title: None,
            url_aggregated_text: None,
            url_aggregated_capture_count: 0,
        }
    }

    #[test]
    fn test_initialize_memories_is_idempotent() {
        let service = make_service();
        let capture_id = seed_capture(&service, 1_710_000_000_000, "Chrome", "方案页");
        seed_knowledge(&service, "meeting", capture_id, 4, 3);

        let first = service.initialize_memories(10).expect("首次初始化失败");
        assert_eq!(first.created_count, 0);
        assert_eq!(first.skipped_count, 1);
        assert!(first.articles.is_empty());

        let second = service.initialize_memories(10).expect("二次初始化失败");
        assert_eq!(second.created_count, 0);
        assert_eq!(second.skipped_count, 1);
    }

    #[test]
    fn test_infer_suggested_action() {
        assert_eq!(
            infer_suggested_action(&["SOP".to_string()]),
            Some("sop".to_string())
        );
        assert_eq!(
            infer_suggested_action(&["技术方案".to_string()]),
            Some("design".to_string())
        );
    }

    #[test]
    fn test_resolve_review_status_always_auto_created() {
        assert_eq!(
            resolve_review_status(Some("candidate"), Some(0.91), Some("high")),
            "auto_created"
        );
        assert_eq!(
            resolve_review_status(Some("candidate"), Some(0.91), Some("medium")),
            "auto_created"
        );
        assert_eq!(
            resolve_review_status(Some("candidate"), Some(0.60), Some("high")),
            "auto_created"
        );
        assert_eq!(
            resolve_review_status(Some("candidate"), Some(0.72), Some("high")),
            "auto_created"
        );
        assert_eq!(
            resolve_review_status(Some("auto_created"), Some(0.95), Some("low")),
            "auto_created"
        );
    }

    #[test]
    fn test_collect_source_capture_ids_includes_new_captures_on_same_timeline() {
        let service = make_service();
        let primary = seed_capture(&service, 1_710_000_000_000, "Code", "主采集");
        let appended = seed_capture(&service, 1_710_000_010_000, "Code", "新增采集");
        let timeline_id = seed_knowledge(&service, "meeting", primary, 4, 2);
        link_captures_to_timeline(&service, timeline_id, &[primary, appended]);

        let candidate = make_candidate(&service, timeline_id);
        let ids = collect_source_capture_id_strings(&service.storage, &candidate)
            .expect("收集 source_capture_ids 失败");

        assert!(ids.contains(&primary.to_string()));
        assert!(ids.contains(&appended.to_string()));
    }

    #[test]
    fn test_build_knowledge_title_uses_overview_and_source_capture_ids() {
        let service = make_service();
        let primary = seed_capture(&service, 1_710_000_000_000, "Code", "主采集");
        let timeline_id = seed_knowledge(&service, "meeting", primary, 4, 2);
        link_captures_to_timeline(&service, timeline_id, &[primary]);
        let candidate = make_candidate(&service, timeline_id);
        let source_capture_ids = collect_source_capture_id_strings(&service.storage, &candidate)
            .expect("收集 source_capture_ids 失败");

        let payload = BakeKnowledgeArtifactPayload {
            summary: "时间线式标题".to_string(),
            overview: Some("这是提炼后的知识概述".to_string()),
            details: Some("知识详情".to_string()),
            entities: vec!["SGLang".to_string()],
            importance: Some(4),
            occurrence_count: None,
            observed_at: None,
            event_time_start: None,
            event_time_end: None,
            history_view: None,
            content_origin: None,
            activity_type: None,
            evidence_strength: None,
            evidence_summary: None,
            match_score: Some(0.9),
            match_level: Some("high".to_string()),
            review_status: Some("auto_created".to_string()),
        };

        let record = build_bake_knowledge_entry(
            &candidate,
            &payload,
            "auto_created",
            "test",
            &source_capture_ids,
        )
        .expect("构建知识失败");

        assert_eq!(record.title, "这是提炼后的知识概述");
        assert_eq!(record.summary, "这是提炼后的知识概述");
        assert_eq!(
            parse_optional_json_vec_string(&record.source_capture_ids),
            vec![primary.to_string()]
        );
    }

    #[test]
    fn test_existing_knowledge_is_merged_with_new_timeline_captures() {
        let service = make_service();
        let primary = seed_capture(&service, 1_710_000_000_000, "Code", "主采集");
        let appended = seed_capture(&service, 1_710_000_010_000, "Code", "新增采集");
        let timeline_id = seed_knowledge(&service, "meeting", primary, 4, 2);
        link_captures_to_timeline(&service, timeline_id, &[primary, appended]);
        let existing_id = service
            .storage
            .insert_bake_knowledge(&NewBakeKnowledge {
                timeline_id,
                title: "旧知识".to_string(),
                summary: "旧摘要".to_string(),
                content: Some(r#"{"status":"auto_created"}"#.to_string()),
                detailed_content: Some("旧详情".to_string()),
                entities: r#"["旧实体"]"#.to_string(),
                importance: 3,
                source_capture_ids: Some(to_json_string(&vec![primary.to_string()]).unwrap()),
            })
            .expect("插入旧知识失败");
        let candidate = make_candidate(&service, timeline_id);
        let extraction = BakeArtifactExtraction {
            accepted: true,
            reason: None,
            payload: Some(json!({
                "summary": "新知识标题",
                "overview": "新知识概述",
                "details": "新详情",
                "entities": ["新实体"],
                "importance": 5,
                "match_score": 0.91,
                "match_level": "high",
                "review_status": "auto_created"
            })),
        };
        let mut existing_sources = std::collections::HashSet::from([timeline_id]);

        let result = service
            .persist_knowledge_artifact(
                None,
                &candidate,
                "test",
                &extraction,
                &mut existing_sources,
            )
            .expect("合并知识失败");

        assert_eq!(result.knowledge_created_count, 0);
        assert_eq!(service.storage.count_bake_knowledge().unwrap(), 1);
        let updated = service
            .storage
            .get_bake_knowledge(existing_id)
            .unwrap()
            .unwrap();
        assert_eq!(updated.title, "新知识概述");
        assert_eq!(updated.importance, 5);
        let source_ids = parse_optional_json_vec_string(&updated.source_capture_ids);
        assert!(source_ids.contains(&primary.to_string()));
        assert!(source_ids.contains(&appended.to_string()));
        let details = updated.detailed_content.unwrap();
        assert!(details.contains("旧详情"));
        assert!(details.contains("新详情"));
    }
}
