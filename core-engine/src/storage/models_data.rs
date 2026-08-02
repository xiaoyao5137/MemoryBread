use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataSnapshotRecord {
    pub id: i64,
    pub source_id: i64,
    pub collected_at: i64,
    pub observed_at: Option<i64>,
    pub collector: String,
    pub content_text: String,
    pub structured_data: Value,
    pub content_hash: String,
    pub freshness_ttl_seconds: i64,
    pub provenance: Value,
    pub source_capture_ids: Vec<i64>,
    pub source_timeline_ids: Vec<i64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataSourceRecord {
    pub id: i64,
    pub title: String,
    pub source_kind: String,
    pub source_url: Option<String>,
    pub access_mode: String,
    pub refresh_policy: String,
    pub realtime_level: String,
    pub source_app_name: Option<String>,
    pub source_window_title: Option<String>,
    pub tags: Vec<String>,
    pub first_seen_at: i64,
    pub last_seen_at: i64,
    pub last_collected_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub last_error_code: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub latest_snapshot: Option<DataSnapshotRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataSearchResult {
    pub source_id: i64,
    pub title: String,
    pub source_kind: String,
    pub source_url: Option<String>,
    pub access_mode: String,
    pub refresh_policy: String,
    pub observed_at: Option<i64>,
    pub collected_at: Option<i64>,
    pub freshness_class: String,
    pub freshness_score: f64,
    pub relevance_score: f64,
    pub final_score: f64,
    pub refresh_required: bool,
    pub can_use: bool,
    pub content_excerpt: Option<String>,
    pub structured_data: Option<Value>,
    pub provenance: Option<Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DataExtractionSummary {
    pub scanned_count: usize,
    pub source_created_count: usize,
    pub source_updated_count: usize,
    pub snapshot_created_count: usize,
    pub skipped_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreationEvidenceAssetRecord {
    pub id: String,
    pub run_id: String,
    pub session_id: String,
    pub history_id: Option<i64>,
    pub source_id: Option<i64>,
    pub data_snapshot_id: Option<i64>,
    pub source_url: String,
    pub page_title: String,
    pub captured_at: i64,
    #[serde(skip_serializing)]
    pub image_path: String,
    pub mime_type: String,
    pub width: i64,
    pub height: i64,
    pub content_hash: String,
    pub screenshot_source: String,
    pub validation_status: String,
    pub validation: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreationEvidenceAssetView {
    pub id: String,
    pub run_id: String,
    pub session_id: String,
    pub history_id: Option<i64>,
    pub source_id: Option<i64>,
    pub data_snapshot_id: Option<i64>,
    pub source_url: String,
    pub page_title: String,
    pub captured_at: i64,
    pub image_url: String,
    pub mime_type: String,
    pub width: i64,
    pub height: i64,
    pub content_hash: String,
    pub screenshot_source: String,
    pub validation_status: String,
    pub validation: Value,
}

impl From<CreationEvidenceAssetRecord> for CreationEvidenceAssetView {
    fn from(record: CreationEvidenceAssetRecord) -> Self {
        let image_url = format!("/api/creation/evidence/{}/image", record.id);
        Self {
            id: record.id,
            run_id: record.run_id,
            session_id: record.session_id,
            history_id: record.history_id,
            source_id: record.source_id,
            data_snapshot_id: record.data_snapshot_id,
            source_url: record.source_url,
            page_title: record.page_title,
            captured_at: record.captured_at,
            image_url,
            mime_type: record.mime_type,
            width: record.width,
            height: record.height,
            content_hash: record.content_hash,
            screenshot_source: record.screenshot_source,
            validation_status: record.validation_status,
            validation: record.validation,
        }
    }
}
