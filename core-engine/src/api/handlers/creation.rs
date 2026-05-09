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
}

#[derive(Debug, Serialize)]
struct CreationPayload {
    user_prompt: String,
    design_templates: Vec<serde_json::Value>,
    timeline_context: Option<String>,
    capture_context: Option<String>,
}

pub async fn generate_document(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GenerateRequest>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, (StatusCode, String)> {
    info!("创作请求: prompt={}", req.user_prompt);

    // 1. 查询设计模板
    let templates = state
        .storage
        .get_design_templates(Some(5))
        .map_err(|e| {
            error!("查询设计模板失败: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
        })?;

    let design_templates: Vec<serde_json::Value> = templates
        .into_iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "structure_sections": t.structure_sections,
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
    };

    let client = reqwest::Client::new();
    let response = client
        .post("http://localhost:8001/creation/generate")
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            error!("调用 ai-sidecar 失败: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                format!("AI 服务不可用: {}", e),
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        error!("ai-sidecar 返回错误: {} - {}", status, body);
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("AI 服务错误: {}", body),
        ));
    }

    // 5. 转发 SSE 流
    let stream = async_stream::stream! {
        let mut bytes_stream = response.bytes_stream();
        use futures::StreamExt;

        while let Some(chunk) = bytes_stream.next().await {
            match chunk {
                Ok(bytes) => {
                    if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                        for line in text.lines() {
                            if line.starts_with("data: ") {
                                let content = &line[6..];
                                yield Ok(Event::default().data(content));
                            }
                        }
                    }
                }
                Err(e) => {
                    error!("流式读取错误: {}", e);
                    break;
                }
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}
