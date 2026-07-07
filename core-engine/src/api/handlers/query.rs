//! POST /query — RAG 语义查询
//!
//! 通过 HTTP 调用 ai-sidecar 的 RAG 服务进行智能问答

use crate::api::{
    error::ApiError,
    state::{AppState, RagJobRecord},
};
use crate::storage::models::NewRagSession;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::{atomic::Ordering, Arc},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Deserialize)]
pub struct RagQueryRequest {
    pub query: String,
    #[serde(default = "default_top_k")]
    pub top_k: usize,
    #[serde(default)]
    pub creation_model: Option<String>,
    #[serde(default)]
    pub creation_api_key: Option<String>,
    #[serde(default)]
    pub creation_base_url: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub screenshot_path: Option<String>,
    #[serde(default)]
    pub screenshot_width: Option<u32>,
    #[serde(default)]
    pub screenshot_height: Option<u32>,
    #[serde(default)]
    pub ocr_text: Option<String>,
}

fn default_top_k() -> usize {
    5
}

#[derive(Serialize, Deserialize, Clone)]
pub struct RagContext {
    pub capture_id: i64,
    #[serde(default)]
    pub doc_key: Option<String>,
    pub text: String,
    pub score: f64,
    pub source: String,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub knowledge_id: Option<i64>,
    #[serde(default)]
    pub artifact_id: Option<i64>,
    #[serde(default)]
    pub document_id: Option<i64>,
    #[serde(default)]
    pub app_name: Option<String>,
    #[serde(default)]
    pub win_title: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub doc_type: Option<String>,
    #[serde(default)]
    pub time: Option<serde_json::Value>,
    #[serde(default)]
    pub observed_at: Option<serde_json::Value>,
    #[serde(default)]
    pub event_time_start: Option<serde_json::Value>,
    #[serde(default)]
    pub event_time_end: Option<serde_json::Value>,
    #[serde(default)]
    pub start_time: Option<serde_json::Value>,
    #[serde(default)]
    pub end_time: Option<serde_json::Value>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub activity_type: Option<String>,
    #[serde(default)]
    pub content_origin: Option<String>,
    #[serde(default)]
    pub history_view: Option<bool>,
    #[serde(default)]
    pub evidence_strength: Option<String>,
    #[serde(default)]
    pub importance: Option<i64>,
    #[serde(default)]
    pub source_timeline_ids: Option<Vec<String>>,
    #[serde(default)]
    pub linked_knowledge_ids: Option<Vec<String>>,
    #[serde(default)]
    pub screenshot_path: Option<String>,
    #[serde(default)]
    pub screenshot_width: Option<u32>,
    #[serde(default)]
    pub screenshot_height: Option<u32>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct RagQueryResponse {
    pub answer: String,
    pub contexts: Vec<RagContext>,
    pub model: String,
    #[serde(default)]
    pub done_reason: Option<String>,
    #[serde(default)]
    pub output_truncated: bool,
}

#[derive(Serialize)]
pub struct RagJobCreateResponse {
    pub job_id: String,
    pub status: String,
}

#[derive(Serialize)]
pub struct RagJobStatusResponse {
    pub id: String,
    pub status: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn api_error_message(error: &ApiError) -> String {
    match error {
        ApiError::Upstream { message, .. } => message.clone(),
        ApiError::BadRequest(message) => message.clone(),
        ApiError::NotFound(message) => message.clone(),
        ApiError::Internal(message) => message.clone(),
        ApiError::Storage(_) => "数据库操作失败".to_string(),
    }
}

fn set_rag_job(
    state: &Arc<AppState>,
    job_id: &str,
    status: &str,
    result: Option<serde_json::Value>,
    error: Option<String>,
) {
    if let Ok(mut jobs) = state.rag_jobs.lock() {
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = status.to_string();
            job.result = result;
            job.error = error;
            job.updated_at_ms = now_ms();
        }
    }
}

fn creation_model_name(id: &str) -> &str {
    match id {
        "mbcd-plus-v1" => "claude-opus-4-8",
        "mbcd-std-v1" => "qwen3.5:4b",
        "claude-opus-4-8" => "claude-opus-4-8",
        "qwen-3-5-4b" => "qwen3.5:4b",
        _ => id,
    }
}

fn enrich_creation_model_from_preferences(
    state: &Arc<AppState>,
    mut body: RagQueryRequest,
) -> RagQueryRequest {
    if body.creation_model.is_some() {
        return body;
    }

    let pref = state
        .storage
        .get_preference_value("creation.models")
        .ok()
        .flatten();
    let Some(raw) = pref else {
        return body;
    };

    let Ok(models) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return body;
    };
    let Some(items) = models.as_array() else {
        return body;
    };

    let selected = items.iter().find(|item| {
        item.get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    });
    let Some(selected) = selected else {
        return body;
    };

    let Some(id) = selected.get("id").and_then(|value| value.as_str()) else {
        return body;
    };
    let api_key = selected
        .get("apiKey")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string());

    if id != "mbcd-std-v1" && api_key.is_none() {
        return body;
    }

    body.creation_model = Some(creation_model_name(id).to_string());
    body.creation_api_key = api_key;
    body.creation_base_url = selected
        .get("baseUrl")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string());
    body
}

/// 创建异步 RAG 查询任务，避免前端长连接等待时被 WebView 中断。
pub async fn create_rag_job(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RagQueryRequest>,
) -> Result<Json<RagJobCreateResponse>, ApiError> {
    if body.query.trim().is_empty() {
        return Err(ApiError::BadRequest("缺少 query 参数".to_string()));
    }
    let body = enrich_creation_model_from_preferences(&state, body);

    let seq = state.rag_job_seq.fetch_add(1, Ordering::Relaxed);
    let job_id = format!("rag-{}-{}", now_ms(), seq);
    let created_at_ms = now_ms();
    let record = RagJobRecord {
        id: job_id.clone(),
        status: "pending".to_string(),
        result: None,
        error: None,
        created_at_ms,
        updated_at_ms: created_at_ms,
    };

    {
        let mut jobs = state
            .rag_jobs
            .lock()
            .map_err(|_| ApiError::Internal("RAG 任务状态锁异常".to_string()))?;
        jobs.insert(job_id.clone(), record);
    }

    let state_for_task = state.clone();
    let job_id_for_task = job_id.clone();
    let sidecar_url = state.sidecar_url.clone();
    tokio::spawn(async move {
        set_rag_job(&state_for_task, &job_id_for_task, "running", None, None);
        match call_rag_service(&sidecar_url, body).await {
            Ok(result) => {
                let value = serde_json::to_value(result).ok();
                set_rag_job(&state_for_task, &job_id_for_task, "succeeded", value, None);
            }
            Err(error) => {
                set_rag_job(
                    &state_for_task,
                    &job_id_for_task,
                    "failed",
                    None,
                    Some(api_error_message(&error)),
                );
            }
        }
    });

    Ok(Json(RagJobCreateResponse {
        job_id,
        status: "pending".to_string(),
    }))
}

/// 查询异步 RAG 任务状态。
pub async fn get_rag_job(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> Result<Json<RagJobStatusResponse>, ApiError> {
    let jobs = state
        .rag_jobs
        .lock()
        .map_err(|_| ApiError::Internal("RAG 任务状态锁异常".to_string()))?;
    let job = jobs
        .get(&job_id)
        .ok_or_else(|| ApiError::NotFound("咨询任务不存在或已过期".to_string()))?;

    Ok(Json(RagJobStatusResponse {
        id: job.id.clone(),
        status: job.status.clone(),
        result: job.result.clone(),
        error: job.error.clone(),
        created_at_ms: job.created_at_ms,
        updated_at_ms: job.updated_at_ms,
    }))
}

#[derive(Deserialize)]
pub struct RagHistoryParams {
    #[serde(default = "default_history_limit")]
    pub limit: usize,
}

fn default_history_limit() -> usize {
    20
}

fn legacy_capture_context(capture_id: i64) -> RagContext {
    RagContext {
        capture_id,
        doc_key: Some(format!("capture:{capture_id}")),
        text: format!("历史咨询关联的采集记录 #{capture_id}"),
        score: 0.0,
        source: "capture".to_string(),
        source_type: Some("capture".to_string()),
        knowledge_id: None,
        artifact_id: None,
        document_id: None,
        app_name: None,
        win_title: None,
        url: None,
        source_url: None,
        title: None,
        doc_type: None,
        time: None,
        observed_at: None,
        event_time_start: None,
        event_time_end: None,
        start_time: None,
        end_time: None,
        summary: None,
        overview: None,
        category: None,
        activity_type: None,
        content_origin: None,
        history_view: None,
        evidence_strength: None,
        importance: None,
        source_timeline_ids: None,
        linked_knowledge_ids: None,
        screenshot_path: None,
        screenshot_width: None,
        screenshot_height: None,
    }
}

fn parse_saved_contexts(raw: Option<&str>) -> Vec<RagContext> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            if item.is_object() {
                serde_json::from_value::<RagContext>(item.clone()).ok()
            } else {
                item.as_i64().map(legacy_capture_context)
            }
        })
        .collect()
}

#[derive(Serialize)]
pub struct RagHistoryResponse {
    pub items: Vec<RagHistoryItem>,
}

#[derive(Serialize)]
pub struct RagHistoryItem {
    pub id: i64,
    pub ts: i64,
    pub query: String,
    pub answer: String,
    pub contexts: Vec<RagContext>,
    pub context_count: usize,
    pub latency_ms: Option<i64>,
    pub model: Option<String>,
}

#[derive(Deserialize)]
pub struct SaveRagHistoryRequest {
    pub query: String,
    pub answer: String,
    #[serde(default)]
    pub contexts: Vec<RagContext>,
    #[serde(default)]
    pub latency_ms: Option<i64>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub scene_type: Option<String>,
}

#[derive(Serialize)]
pub struct SaveRagHistoryResponse {
    pub id: i64,
}

pub async fn save_rag_history(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveRagHistoryRequest>,
) -> Result<Json<SaveRagHistoryResponse>, ApiError> {
    if req.query.trim().is_empty() {
        return Err(ApiError::BadRequest("缺少 query 参数".to_string()));
    }
    let contexts = serde_json::to_string(&req.contexts)
        .map_err(|e| ApiError::Internal(format!("序列化咨询参考失败: {e}")))?;
    let scene_type = match req.scene_type.as_deref().or(req.source.as_deref()) {
        Some("floating_assist") => "floating_assist",
        _ => "monitor",
    };
    let session = NewRagSession {
        ts: now_ms(),
        scene_type: Some(scene_type.to_string()),
        user_query: req.query,
        retrieved_ids: Some(contexts),
        prompt_used: None,
        llm_response: Some(req.answer),
        latency_ms: req.latency_ms,
        model: req.model,
    };
    let storage = state.storage.clone();
    let id = tokio::task::spawn_blocking(move || storage.insert_rag_session(&session))
        .await
        .map_err(|e| ApiError::Internal(format!("保存咨询记录失败: {e}")))??;
    Ok(Json(SaveRagHistoryResponse { id }))
}

/// 最近咨询记录：供咨询页回看历史问答。
pub async fn rag_history(
    State(state): State<Arc<AppState>>,
    Query(params): Query<RagHistoryParams>,
) -> Result<Json<RagHistoryResponse>, ApiError> {
    let limit = params.limit.clamp(1, 100);
    let storage = state.storage.clone();
    let records = tokio::task::spawn_blocking(move || storage.list_rag_sessions(limit, 0))
        .await
        .map_err(|e| ApiError::Internal(format!("读取咨询记录失败: {e}")))??;

    let items = records
        .into_iter()
        .map(|record| {
            let contexts = parse_saved_contexts(record.retrieved_ids.as_deref());
            let context_count = contexts.len();
            RagHistoryItem {
                id: record.id,
                ts: record.ts,
                query: record.user_query,
                answer: record.llm_response.unwrap_or_default(),
                contexts,
                context_count,
                latency_ms: record.latency_ms,
                model: record.model,
            }
        })
        .collect();

    Ok(Json(RagHistoryResponse { items }))
}

/// RAG 查询实现：调用 ai-sidecar 的 RAG 服务
pub async fn rag_query(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RagQueryRequest>,
) -> Result<Json<RagQueryResponse>, ApiError> {
    let body = enrich_creation_model_from_preferences(&state, body);
    let rag_response = call_rag_service(&state.sidecar_url, body).await?;
    Ok(Json(rag_response))
}

pub async fn rag_references(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RagQueryRequest>,
) -> Result<Json<RagQueryResponse>, ApiError> {
    if body.query.trim().is_empty() {
        return Err(ApiError::BadRequest("缺少 query 参数".to_string()));
    }
    let rag_response = call_rag_endpoint(&state.sidecar_url, "references", body, 90).await?;
    Ok(Json(rag_response))
}

async fn call_rag_service(
    sidecar_url: &str,
    body: RagQueryRequest,
) -> Result<RagQueryResponse, ApiError> {
    call_rag_endpoint(sidecar_url, "query", body, 360).await
}

async fn call_rag_endpoint(
    sidecar_url: &str,
    endpoint: &str,
    body: RagQueryRequest,
    timeout_secs: u64,
) -> Result<RagQueryResponse, ApiError> {
    let client = reqwest::Client::new();
    let rag_service_url = format!("{}/{}", sidecar_url, endpoint);

    let request_body = serde_json::json!({
        "query": body.query,
        "top_k": body.top_k,
        "creation_model": body.creation_model,
        "creation_api_key": body.creation_api_key,
        "creation_base_url": body.creation_base_url,
        "source": body.source,
        "screenshot_path": body.screenshot_path,
        "screenshot_width": body.screenshot_width,
        "screenshot_height": body.screenshot_height,
        "ocr_text": body.ocr_text,
    });

    let response = client
        .post(&rag_service_url)
        .json(&request_body)
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .send()
        .await
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("timed out") || msg.contains("timeout") {
                tracing::warn!("RAG 服务响应超时: {}", e);
                ApiError::Upstream {
                    status: StatusCode::GATEWAY_TIMEOUT,
                    code: "GATEWAY_TIMEOUT",
                    message: "AI 正在处理其他任务，请稍候再试".to_string(),
                }
            } else {
                tracing::warn!("无法连接到 RAG 服务: {}", e);
                ApiError::Upstream {
                    status: StatusCode::BAD_GATEWAY,
                    code: "BAD_GATEWAY",
                    message: format!("RAG 服务不可用，请确认 AI Sidecar 已正常启动: {}", e),
                }
            }
        })?;

    if response.status().is_success() {
        let rag_response = response
            .json::<RagQueryResponse>()
            .await
            .map_err(|e| ApiError::Internal(format!("解析 RAG 响应失败: {}", e)))?;
        Ok(rag_response)
    } else {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        tracing::warn!("RAG 服务返回错误 status={} body={}", status, body_text);

        let (mapped_status, code) = match status.as_u16() {
            400 | 422 => (StatusCode::BAD_REQUEST, "BAD_REQUEST"),
            502 => (StatusCode::BAD_GATEWAY, "BAD_GATEWAY"),
            503 => (StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE"),
            504 => (StatusCode::GATEWAY_TIMEOUT, "GATEWAY_TIMEOUT"),
            code if code >= 500 => (StatusCode::BAD_GATEWAY, "BAD_GATEWAY"),
            _ => (StatusCode::BAD_GATEWAY, "BAD_GATEWAY"),
        };

        // 尝试解析 JSON 错误体，提取友好消息
        let message = if let Ok(json_err) = serde_json::from_str::<serde_json::Value>(&body_text) {
            if let Some(msg) = json_err.get("message").and_then(|v| v.as_str()) {
                msg.to_string()
            } else if let Some(err) = json_err.get("error").and_then(|v| v.as_str()) {
                err.to_string()
            } else {
                format!("RAG 服务返回错误 ({})", status)
            }
        } else if body_text.trim().is_empty() {
            format!("RAG 服务返回错误 ({})", status)
        } else {
            body_text
        };

        Err(ApiError::Upstream {
            status: mapped_status,
            code,
            message,
        })
    }
}
