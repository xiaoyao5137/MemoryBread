//! POST /pii/scrub — PII 脱敏（stub，由 ai-sidecar/pii 实现后替换）

use axum::Json;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub struct PiiScrubRequest {
    pub text: String,
    pub capture_id: Option<i64>,
}

#[derive(Serialize)]
pub struct PiiScrubResponse {
    pub text: String,
    pub redacted_count: usize,
    pub redacted_types: Vec<String>,
}

/// 占位实现：后续通过 IPC 调用 ai-sidecar/pii 模块。
pub async fn pii_scrub(Json(body): Json<PiiScrubRequest>) -> Json<PiiScrubResponse> {
    // stub：原样返回文本，count=0
    let _ = body.capture_id;
    Json(PiiScrubResponse {
        text: body.text,
        redacted_count: 0,
        redacted_types: vec![],
    })
}
