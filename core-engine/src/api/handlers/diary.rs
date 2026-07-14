//! 日记 API 处理器

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

#[derive(Debug, Deserialize)]
pub struct DiaryQuery {
    /// 日记周期类型: daily/weekly/monthly/yearly。兼容旧查询参数 type。
    #[serde(rename = "type")]
    pub type_alias: Option<String>,
    pub period_type: Option<String>,
    /// 精确查询某一天/某周期结束日期的日记。兼容 date 别名。
    pub diary_date: Option<String>,
    pub date: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct DiaryResponse {
    pub id: i64,
    pub period_type: String,
    pub period_start: String,
    pub period_end: String,
    pub diary_date: String,
    pub content: serde_json::Value,
    pub source_timeline_ids: Vec<i64>,
    pub source_diary_ids: Vec<i64>,
    pub generation_status: String,
    pub is_system_generated: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl From<DiaryRecord> for DiaryResponse {
    fn from(record: DiaryRecord) -> Self {
        let content = serde_json::from_str(&record.content).unwrap_or_else(|_| {
            serde_json::json!({
                "title": record.diary_date,
                "markdown": record.content,
            })
        });

        Self {
            id: record.id,
            period_type: record.period_type,
            period_start: record.period_start,
            period_end: record.period_end,
            diary_date: record.diary_date,
            content,
            source_timeline_ids: parse_id_array(&record.source_timeline_ids),
            source_diary_ids: parse_id_array(&record.source_diary_ids),
            generation_status: record.generation_status,
            is_system_generated: record.is_system_generated,
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct UpdateDiaryRequest {
    pub content: serde_json::Value,
}

pub async fn list_diaries(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DiaryQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = query.limit.unwrap_or(50);
    let period_type = query.period_type.or(query.type_alias);
    let diary_date = query.diary_date.or(query.date);

    let records = if let Some(diary_date) = diary_date {
        let period_type = period_type.unwrap_or_else(|| "daily".to_string());
        state
            .storage
            .get_diary_by_date(&period_type, &diary_date)
            .map_err(|e| ApiError::Internal(e.to_string()))?
            .into_iter()
            .collect()
    } else {
        state
            .storage
            .list_diaries(period_type.as_deref(), limit)
            .map_err(|e| ApiError::Internal(e.to_string()))?
    };

    let diaries: Vec<DiaryResponse> = records.into_iter().map(Into::into).collect();
    Ok(Json(diaries))
}

pub async fn get_diary(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let record = state
        .storage
        .get_diary(id)
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .ok_or_else(|| ApiError::NotFound(format!("日记 {} 不存在", id)))?;

    Ok(Json(DiaryResponse::from(record)))
}

pub async fn update_diary(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(req): Json<UpdateDiaryRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let content_str = serde_json::to_string(&req.content)
        .map_err(|e| ApiError::BadRequest(format!("JSON 格式错误: {}", e)))?;

    state
        .storage
        .update_diary_content(id, &content_str)
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_latest_diary(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DiaryQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let period_type = query
        .period_type
        .or(query.type_alias)
        .unwrap_or_else(|| "daily".to_string());

    let record = state
        .storage
        .get_latest_diary(&period_type)
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .ok_or_else(|| ApiError::NotFound(format!("暂无 {} 日记", period_type)))?;

    Ok(Json(DiaryResponse::from(record)))
}

fn parse_id_array(raw: &str) -> Vec<i64> {
    serde_json::from_str::<Vec<i64>>(raw).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::models::NewDiaryEntry;

    #[test]
    fn diary_response_parses_content_and_sources() {
        let response = DiaryResponse::from(DiaryRecord {
            id: 1,
            period_type: "daily".to_string(),
            period_start: "2026-07-07".to_string(),
            period_end: "2026-07-07".to_string(),
            diary_date: "2026-07-07".to_string(),
            content: r#"{"title":"工作日记","work_outputs":["完成了 API"]}"#.to_string(),
            source_timeline_ids: "[10,11]".to_string(),
            source_diary_ids: "[]".to_string(),
            generation_status: "ready".to_string(),
            is_system_generated: true,
            created_at: "now".to_string(),
            updated_at: "now".to_string(),
        });

        assert_eq!(response.content["title"], "工作日记");
        assert_eq!(response.source_timeline_ids, vec![10, 11]);
    }

    #[test]
    fn parse_id_array_ignores_invalid_json() {
        assert!(parse_id_array("not-json").is_empty());
    }

    #[test]
    fn diary_query_accepts_date_alias() {
        let query: DiaryQuery =
            serde_json::from_value(serde_json::json!({"type":"daily","date":"2026-07-07"}))
                .unwrap();

        assert_eq!(query.type_alias.as_deref(), Some("daily"));
        assert_eq!(query.date.as_deref(), Some("2026-07-07"));
    }

    #[allow(dead_code)]
    fn _sample_entry() -> NewDiaryEntry {
        NewDiaryEntry {
            period_type: "daily".to_string(),
            period_start: "2026-07-07".to_string(),
            period_end: "2026-07-07".to_string(),
            diary_date: "2026-07-07".to_string(),
            content: "{}".to_string(),
            source_timeline_ids: "[]".to_string(),
            source_diary_ids: "[]".to_string(),
            generation_status: "ready".to_string(),
            is_system_generated: true,
        }
    }
}
