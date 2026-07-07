use axum::{
    extract::State,
    http::StatusCode,
    response::{sse::Event, Sse},
    Json,
};
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use std::{convert::Infallible, sync::Arc, time::Duration};
use tracing::{error, info};

use crate::api::state::AppState;

#[derive(Debug, Deserialize)]
pub struct GenerateRequest {
    pub user_prompt: String,
    #[serde(default)]
    pub design_ids: Vec<i64>,
    #[serde(default)]
    pub timeline_ids: Vec<i64>,
    #[serde(default)]
    pub capture_ids: Vec<i64>,
    #[serde(default)]
    pub doc_type: String,
    #[serde(default)]
    pub audience: String,
    #[serde(default = "default_output_format")]
    pub output_format: String,
    #[serde(default = "default_true")]
    pub inherit_format: bool,
    #[serde(default = "default_true")]
    pub enable_rag: bool,
    #[serde(default)]
    pub enable_web_search: bool,
    #[serde(default)]
    pub enable_image_generation: bool,
    #[serde(default = "default_content_weight")]
    pub content_weight: f64,
    #[serde(default = "default_quality_weight")]
    pub quality_weight: f64,
    #[serde(default = "default_completeness_weight")]
    pub completeness_weight: f64,
    #[serde(default = "default_usage_weight")]
    pub usage_weight: f64,
    #[serde(default = "default_format_weight")]
    pub format_weight: f64,
    #[serde(default = "default_freshness_weight")]
    pub freshness_weight: f64,
    #[serde(default = "default_max_references")]
    pub max_references: i64,
    #[serde(default)]
    pub creation_model: Option<String>,
    #[serde(default)]
    pub creation_api_key: Option<String>,
    #[serde(default)]
    pub creation_base_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct CreationPayload {
    user_prompt: String,
    design_templates: Vec<serde_json::Value>,
    timeline_context: Option<String>,
    capture_context: Option<String>,
    doc_type: String,
    audience: String,
    output_format: String,
    inherit_format: bool,
    enable_rag: bool,
    enable_web_search: bool,
    enable_image_generation: bool,
    content_weight: f64,
    quality_weight: f64,
    completeness_weight: f64,
    usage_weight: f64,
    format_weight: f64,
    freshness_weight: f64,
    max_references: i64,
    creation_model: Option<String>,
    creation_api_key: Option<String>,
    creation_base_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct ReferencePayload {
    user_prompt: String,
    doc_type: String,
    audience: String,
    inherit_format: bool,
    enable_rag: bool,
    content_weight: f64,
    quality_weight: f64,
    completeness_weight: f64,
    usage_weight: f64,
    format_weight: f64,
    freshness_weight: f64,
    max_references: i64,
}

pub async fn generate_document(
    State(state): State<Arc<AppState>>,
    Json(mut req): Json<GenerateRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, String)> {
    info!("创作请求: prompt={}", req.user_prompt);
    enrich_creation_model_from_preferences(&state, &mut req);

    // 1. 查询文档模板
    let templates = state.storage.get_document_templates(Some(5)).map_err(
        |e: crate::storage::error::StorageError| {
            error!("查询文档模板失败: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        },
    )?;

    let design_templates: Vec<serde_json::Value> = templates
        .into_iter()
        .map(|t| {
            serde_json::json!({
                "title": t.title,
                "doc_type": t.doc_type,
                "sections_json": t.sections_json,
                "style_phrases": t.style_phrases,
            })
        })
        .collect();

    // 2. 构建时间线上下文（简化版）
    let timeline_context = if !req.timeline_ids.is_empty() {
        Some(format!("时间线 IDs: {:?}", req.timeline_ids))
    } else {
        None
    };

    // 3. 构建采集记录上下文（简化版）
    let capture_context = if !req.capture_ids.is_empty() {
        Some(format!("采集记录 IDs: {:?}", req.capture_ids))
    } else {
        None
    };

    // 4. 调用 ai-sidecar creation 服务
    let payload = CreationPayload {
        user_prompt: req.user_prompt,
        design_templates,
        timeline_context,
        capture_context,
        doc_type: req.doc_type,
        audience: req.audience,
        output_format: req.output_format,
        inherit_format: req.inherit_format,
        enable_rag: req.enable_rag,
        enable_web_search: req.enable_web_search,
        enable_image_generation: req.enable_image_generation,
        content_weight: req.content_weight,
        quality_weight: req.quality_weight,
        completeness_weight: req.completeness_weight,
        usage_weight: req.usage_weight,
        format_weight: req.format_weight,
        freshness_weight: req.freshness_weight,
        max_references: req.max_references,
        creation_model: req.creation_model,
        creation_api_key: req.creation_api_key,
        creation_base_url: req.creation_base_url,
    };

    let client = reqwest::Client::new();
    let response = client
        .post("http://127.0.0.1:8001/creation/generate")
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            error!("调用 ai-sidecar 失败: {}", e);
            (StatusCode::BAD_GATEWAY, format!("AI 服务不可用: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        error!("ai-sidecar 返回错误: {} - {}", status, body);
        return Err((StatusCode::BAD_GATEWAY, format!("AI 服务错误: {}", body)));
    }

    // 5. 转发 SSE 流
    let stream = async_stream::stream! {
        let mut bytes_stream = response.bytes_stream();
        use futures::StreamExt;
        let mut buffer = String::new();

        while let Some(chunk) = bytes_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                        buffer.push_str(&text);
                        while let Some(newline_index) = buffer.find('\n') {
                            let line = buffer[..newline_index].trim_end_matches('\r').to_string();
                            buffer.drain(..=newline_index);
                            if line.starts_with("data: ") {
                                let content = &line[6..];
                                yield Ok(Event::default().data(content));
                            }
                        }
                    }
                }
                Err(e) => {
                    error!("流式读取错误: {}", e);
                    let payload = serde_json::json!({ "error": format!("AI 流式响应中断: {}", e) }).to_string();
                    yield Ok(Event::default().data(payload));
                    break;
                }
            }
        }
        let line = buffer.trim();
        if line.starts_with("data: ") {
            let content = &line[6..];
            yield Ok(Event::default().data(content));
        }
    };

    Ok(Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

pub async fn preview_references(
    Json(req): Json<GenerateRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let payload = ReferencePayload {
        user_prompt: req.user_prompt,
        doc_type: req.doc_type,
        audience: req.audience,
        inherit_format: req.inherit_format,
        enable_rag: req.enable_rag,
        content_weight: req.content_weight,
        quality_weight: req.quality_weight,
        completeness_weight: req.completeness_weight,
        usage_weight: req.usage_weight,
        format_weight: req.format_weight,
        freshness_weight: req.freshness_weight,
        max_references: req.max_references,
    };

    let client = reqwest::Client::new();
    let response = client
        .post("http://127.0.0.1:8001/creation/references")
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            error!("调用 ai-sidecar 参考资料预览失败: {}", e);
            (StatusCode::BAD_GATEWAY, format!("AI 服务不可用: {}", e))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        error!("ai-sidecar 参考资料预览返回错误: {} - {}", status, body);
        return Err((StatusCode::BAD_GATEWAY, format!("AI 服务错误: {}", body)));
    }

    let body = response.json::<serde_json::Value>().await.map_err(|e| {
        error!("解析参考资料预览响应失败: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            format!("AI 服务响应格式错误: {}", e),
        )
    })?;

    Ok(Json(body))
}

fn default_true() -> bool {
    true
}

fn default_output_format() -> String {
    "markdown".to_string()
}

fn default_content_weight() -> f64 {
    0.45
}

fn default_quality_weight() -> f64 {
    0.15
}

fn default_completeness_weight() -> f64 {
    0.15
}

fn default_usage_weight() -> f64 {
    0.10
}

fn default_format_weight() -> f64 {
    0.10
}

fn default_freshness_weight() -> f64 {
    0.05
}

fn default_max_references() -> i64 {
    6
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

fn enrich_creation_model_from_preferences(state: &Arc<AppState>, req: &mut GenerateRequest) {
    if req.creation_model.is_some() {
        return;
    }

    let Some(raw) = state
        .storage
        .get_preference_value("creation.models")
        .ok()
        .flatten()
    else {
        return;
    };
    let Ok(models) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let Some(items) = models.as_array() else {
        return;
    };
    let Some(selected) = items.iter().find(|item| {
        item.get("enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    }) else {
        return;
    };
    let Some(id) = selected.get("id").and_then(|value| value.as_str()) else {
        return;
    };
    let api_key = selected
        .get("apiKey")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string());

    if id != "mbcd-std-v1" && api_key.is_none() {
        return;
    }

    req.creation_model = Some(creation_model_name(id).to_string());
    req.creation_api_key = api_key;
    req.creation_base_url = selected
        .get("baseUrl")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string());
}

#[derive(Debug, Deserialize)]
pub struct SaveHistoryRequest {
    pub prompt: String,
    pub generated_content: String,
    pub doc_type: Option<String>,
    pub audience: Option<String>,
    pub reference_count: i64,
    #[serde(default)]
    pub references: Vec<serde_json::Value>,
    pub model: Option<String>,
    #[serde(default)]
    pub latency_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct SaveHistoryResponse {
    pub id: i64,
}

pub async fn save_history(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveHistoryRequest>,
) -> Result<Json<SaveHistoryResponse>, (StatusCode, String)> {
    let id = state
        .storage
        .with_conn(|conn| {
            let references_json = serde_json::to_string(&req.references)?;
            crate::storage::repo::creation_history::insert(
                conn,
                &req.prompt,
                &req.generated_content,
                req.doc_type.as_deref(),
                req.audience.as_deref(),
                req.reference_count,
                Some(&references_json),
                req.model.as_deref(),
                req.latency_ms,
            )
            .map_err(Into::into)
        })
        .map_err(|e| {
            error!("保存创作记录失败: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    Ok(Json(SaveHistoryResponse { id }))
}

pub async fn list_history(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Vec<crate::storage::repo::creation_history::CreationHistory>>, (StatusCode, String)>
{
    let histories = state
        .storage
        .with_conn(|conn| {
            crate::storage::repo::creation_history::list_recent(conn, 50).map_err(Into::into)
        })
        .map_err(|e| {
            error!("查询创作记录失败: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    Ok(Json(histories))
}
