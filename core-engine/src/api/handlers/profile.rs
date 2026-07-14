//! 旧用户画像 API 处理器
//!
//! 产品语言已改为“日记”。本模块保留 `/api/profiles` 兼容旧客户端，
//! 内部读写与 `/api/diaries` 相同的 diaries 表。

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    api::{error::ApiError, state::AppState},
    storage::models::DiaryRecord,
};

/// 查询参数
#[derive(Debug, Deserialize)]
pub struct ProfileQuery {
    /// 快照类型: daily/weekly/monthly/yearly
    #[serde(rename = "type")]
    pub snapshot_type: Option<String>,
    /// 限制返回数量
    pub limit: Option<usize>,
}

/// 兼容旧画像响应字段
#[derive(Debug, Serialize)]
pub struct ProfileResponse {
    pub id: i64,
    pub snapshot_type: String,
    pub snapshot_date: String,
    pub content: serde_json::Value,
    pub is_system_generated: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl From<DiaryRecord> for ProfileResponse {
    fn from(record: DiaryRecord) -> Self {
        let content = serde_json::from_str(&record.content).unwrap_or(serde_json::json!({}));
        Self {
            id: record.id,
            snapshot_type: record.period_type,
            snapshot_date: record.diary_date,
            content,
            is_system_generated: record.is_system_generated,
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

/// 更新日记请求（兼容旧字段名）
#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub content: serde_json::Value,
}

/// GET /api/profiles - 获取日记列表（兼容旧画像路径）
pub async fn list_profiles(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProfileQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = query.limit.unwrap_or(50);
    let snapshot_type = query.snapshot_type.as_deref();

    let records = state
        .storage
        .list_diaries(snapshot_type, limit)
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let profiles: Vec<ProfileResponse> = records.into_iter().map(Into::into).collect();

    Ok(Json(profiles))
}

/// GET /api/profiles/:id - 获取单篇日记（兼容旧画像路径）
pub async fn get_profile(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let record = state
        .storage
        .get_diary(id)
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .ok_or_else(|| ApiError::NotFound(format!("日记 {} 不存在", id)))?;

    Ok(Json(ProfileResponse::from(record)))
}

/// PUT /api/profiles/:id - 更新日记内容（兼容旧画像路径）
pub async fn update_profile(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateProfileRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let content_str = serde_json::to_string(&req.content)
        .map_err(|e| ApiError::BadRequest(format!("JSON 格式错误: {}", e)))?;

    state
        .storage
        .update_diary_content(id, &content_str)
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/profiles/latest - 获取最新日记（兼容旧画像路径）
pub async fn get_latest_profile(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProfileQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let snapshot_type = query.snapshot_type.as_deref().unwrap_or("daily");

    let record = state
        .storage
        .get_latest_diary(snapshot_type)
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .ok_or_else(|| ApiError::NotFound(format!("暂无 {} 日记", snapshot_type)))?;

    Ok(Json(ProfileResponse::from(record)))
}
