//! 知识库 API 处理器
//!
//! 提供知识条目的查询、验证、删除等功能

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::api::{error::ApiError, state::AppState};

const FALLBACK_NOISE_OVERVIEW_PREFIX: &str = "低价值工作片段（";

/// 知识条目
#[derive(Debug, Serialize, Deserialize)]
pub struct KnowledgeEntry {
    pub id: i64,
    pub capture_id: i64,
    pub summary: String,
    pub overview: Option<String>,
    pub details: Option<String>,
    pub entities: Vec<String>,
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

/// 查询参数
#[derive(Debug, Deserialize)]
pub struct KnowledgeQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
    pub category: Option<String>,
}

fn default_limit() -> i64 {
    50
}

/// 知识条目列表响应
#[derive(Debug, Serialize)]
pub struct KnowledgeListResponse {
    pub entries: Vec<KnowledgeEntry>,
    pub total: i64,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ExtractKnowledgeRequest {
    pub limit: Option<usize>,
    #[serde(default)]
    pub force_finalize_tail: bool,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ExtractKnowledgeResponse {
    pub status: String,
    pub message: String,
    pub fetched_count: usize,
    pub processed_count: usize,
    pub remaining_estimate: usize,
    pub force_finalize_tail: bool,
    pub reason: Option<String>,
}

/// POST /api/knowledge/extract - 触发一次真实 knowledge 提炼
pub async fn extract_knowledge(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ExtractKnowledgeRequest>,
) -> Result<Json<ExtractKnowledgeResponse>, ApiError> {
    let client = reqwest::Client::new();
    let upstream_url = format!("{}/knowledge/extract", state.sidecar_url);

    let response = client
        .post(&upstream_url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("timed out") || msg.contains("timeout") {
                ApiError::Internal("知识提炼执行超时，请稍后刷新知识列表确认结果".to_string())
            } else {
                ApiError::Internal(format!("知识提炼服务不可用，请确认 AI Sidecar 已正常启动: {e}"))
            }
        })?;

    if response.status().is_success() {
        let payload = response
            .json::<ExtractKnowledgeResponse>()
            .await
            .map_err(|e| ApiError::Internal(format!("解析知识提炼响应失败: {e}")))?;
        Ok(Json(payload))
    } else {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        tracing::warn!("knowledge extract upstream error status={} body={}", status, body_text);

        let (mapped_status, code) = match status.as_u16() {
            400 | 422 => (StatusCode::BAD_REQUEST, "BAD_REQUEST"),
            502 => (StatusCode::BAD_GATEWAY, "BAD_GATEWAY"),
            503 => (StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE"),
            504 => (StatusCode::GATEWAY_TIMEOUT, "GATEWAY_TIMEOUT"),
            code if code >= 500 => (StatusCode::BAD_GATEWAY, "BAD_GATEWAY"),
            _ => (StatusCode::BAD_GATEWAY, "BAD_GATEWAY"),
        };

        let message = if body_text.trim().is_empty() {
            format!("知识提炼服务返回错误 ({status})")
        } else {
            format!("知识提炼服务返回错误 ({status})：{body_text}")
        };

        Err(ApiError::Upstream {
            status: mapped_status,
            code,
            message,
        })
    }
}

/// GET /api/knowledge - 获取知识条目列表
pub async fn list_knowledge(
    State(state): State<Arc<AppState>>,
    Query(params): Query<KnowledgeQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let result = state.storage.with_conn_async(move |conn| {
        // 参数化查询，避免 SQL 注入
        let (entries, total) = if let Some(ref category) = params.category {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                 occurrence_count, observed_at, event_time_start, event_time_end,
                 history_view, content_origin, activity_type, is_self_generated,
                 evidence_strength, user_verified, user_edited, created_at, updated_at,
                 CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                 CAST(strftime('%s', updated_at) AS INTEGER) * 1000
                 FROM knowledge_entries WHERE category = ?1
                   AND summary NOT LIKE ?2
                 ORDER BY created_at DESC LIMIT ?3 OFFSET ?4"
            ).map_err(|e| crate::storage::StorageError::Sqlite(e))?;

            let entries = stmt
                .query_map(rusqlite::params![category, format!("{}%", FALLBACK_NOISE_OVERVIEW_PREFIX), params.limit, params.offset], |row: &rusqlite::Row| {
                    let entities_json: String = row.get(5).unwrap_or_default();
                    let entities: Vec<String> = serde_json::from_str(&entities_json).unwrap_or_default();
                    Ok(KnowledgeEntry {
                        id: row.get(0)?, capture_id: row.get(1)?,
                        summary: row.get(2)?, overview: row.get(3).ok(),
                        details: row.get(4).ok(), entities,
                        category: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        importance: row.get::<_, Option<i64>>(7)?.unwrap_or(3),
                        occurrence_count: row.get(8).ok(),
                        observed_at: row.get(9).ok().flatten(),
                        event_time_start: row.get(10).ok().flatten(),
                        event_time_end: row.get(11).ok().flatten(),
                        history_view: row.get::<_, Option<bool>>(12)?.unwrap_or(false),
                        content_origin: row.get(13).ok().flatten(),
                        activity_type: row.get(14).ok().flatten(),
                        is_self_generated: row.get::<_, Option<bool>>(15)?.unwrap_or(false),
                        evidence_strength: row.get(16).ok().flatten(),
                        user_verified: row.get::<_, Option<bool>>(17)?.unwrap_or(false),
                        user_edited: row.get::<_, Option<bool>>(18)?.unwrap_or(false),
                        created_at: row.get(19)?, updated_at: row.get(20)?,
                        created_at_ms: row.get::<_, Option<i64>>(21)?.unwrap_or(0),
                        updated_at_ms: row.get::<_, Option<i64>>(22)?.unwrap_or(0),
                    })
                })
                .map_err(|e| crate::storage::StorageError::Sqlite(e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| crate::storage::StorageError::Sqlite(e))?;

            let total: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM knowledge_entries WHERE category = ?1 AND summary NOT LIKE ?2",
                    rusqlite::params![category, format!("{}%", FALLBACK_NOISE_OVERVIEW_PREFIX)],
                    |row| row.get(0),
                )
                .map_err(|e| crate::storage::StorageError::Sqlite(e))?;

            (entries, total)
        } else {
            let mut stmt = conn.prepare(
                "SELECT id, capture_id, summary, overview, details, entities, category, importance,
                 occurrence_count, observed_at, event_time_start, event_time_end,
                 history_view, content_origin, activity_type, is_self_generated,
                 evidence_strength, user_verified, user_edited, created_at, updated_at,
                 CAST(strftime('%s', created_at) AS INTEGER) * 1000,
                 CAST(strftime('%s', updated_at) AS INTEGER) * 1000
                 FROM knowledge_entries
                 WHERE summary NOT LIKE ?1
                 ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
            ).map_err(|e| crate::storage::StorageError::Sqlite(e))?;

            let entries = stmt
                .query_map(rusqlite::params![format!("{}%", FALLBACK_NOISE_OVERVIEW_PREFIX), params.limit, params.offset], |row: &rusqlite::Row| {
                    let entities_json: String = row.get(5).unwrap_or_default();
                    let entities: Vec<String> = serde_json::from_str(&entities_json).unwrap_or_default();
                    Ok(KnowledgeEntry {
                        id: row.get(0)?, capture_id: row.get(1)?,
                        summary: row.get(2)?, overview: row.get(3).ok(),
                        details: row.get(4).ok(), entities,
                        category: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                        importance: row.get::<_, Option<i64>>(7)?.unwrap_or(3),
                        occurrence_count: row.get(8).ok(),
                        observed_at: row.get(9).ok().flatten(),
                        event_time_start: row.get(10).ok().flatten(),
                        event_time_end: row.get(11).ok().flatten(),
                        history_view: row.get::<_, Option<bool>>(12)?.unwrap_or(false),
                        content_origin: row.get(13).ok().flatten(),
                        activity_type: row.get(14).ok().flatten(),
                        is_self_generated: row.get::<_, Option<bool>>(15)?.unwrap_or(false),
                        evidence_strength: row.get(16).ok().flatten(),
                        user_verified: row.get::<_, Option<bool>>(17)?.unwrap_or(false),
                        user_edited: row.get::<_, Option<bool>>(18)?.unwrap_or(false),
                        created_at: row.get(19)?, updated_at: row.get(20)?,
                        created_at_ms: row.get::<_, Option<i64>>(21)?.unwrap_or(0),
                        updated_at_ms: row.get::<_, Option<i64>>(22)?.unwrap_or(0),
                    })
                })
                .map_err(|e| crate::storage::StorageError::Sqlite(e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| crate::storage::StorageError::Sqlite(e))?;

            let total: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM knowledge_entries WHERE summary NOT LIKE ?1",
                    [format!("{}%", FALLBACK_NOISE_OVERVIEW_PREFIX)],
                    |row| row.get(0),
                )
                .map_err(|e| crate::storage::StorageError::Sqlite(e))?;

            (entries, total)
        };

        Ok(KnowledgeListResponse { entries, total })
    }).await?;

    Ok(Json(result))
}

/// POST /api/knowledge/:id/verify - 验证知识条目
pub async fn verify_knowledge(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    state.storage.with_conn_async(move |conn| {
        conn.execute(
            "UPDATE knowledge_entries SET user_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [id],
        ).map_err(|e| crate::storage::StorageError::Sqlite(e))?;
        Ok(())
    }).await?;
    Ok(StatusCode::OK)
}

/// DELETE /api/knowledge/:id - 删除知识条目
pub async fn delete_knowledge(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    state.storage.with_conn_async(move |conn| {
        conn.execute("DELETE FROM knowledge_entries WHERE id = ?", [id])
            .map_err(|e| crate::storage::StorageError::Sqlite(e))?;
        Ok(())
    }).await?;
    Ok(StatusCode::OK)
}
