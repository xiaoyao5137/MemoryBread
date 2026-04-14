//! GET /captures?from=&to=&app=&q=&limit= — 查询采集记录

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    api::{error::ApiError, state::AppState},
    storage::{
        models::CaptureRecord,
        repo::capture::CaptureFilter,
    },
};

/// 查询参数
#[derive(Deserialize, Debug, Default)]
pub struct CapturesQuery {
    /// 起始时间戳（毫秒）
    pub from:  Option<i64>,
    /// 结束时间戳（毫秒）
    pub to:    Option<i64>,
    /// 应用名精确过滤
    pub app:   Option<String>,
    /// 全文检索关键词（FTS5）
    pub q:     Option<String>,
    /// 最大返回数量（默认 50，最大 500）
    pub limit: Option<usize>,
    /// 分页偏移
    pub offset: Option<usize>,
}

/// 查询响应体
#[derive(Serialize)]
pub struct CapturesResponse {
    pub total:    usize,
    pub captures: Vec<CaptureRecord>,
}

pub async fn list_captures(
    State(state): State<Arc<AppState>>,
    Query(params): Query<CapturesQuery>,
) -> Result<Json<CapturesResponse>, ApiError> {
    let limit = params.limit.unwrap_or(50).min(500);
    let offset = params.offset.unwrap_or(0);

    let storage = state.storage.clone();

    if let Some(q) = params.q.filter(|s| !s.is_empty()) {
        let total = tokio::task::spawn_blocking({
            let storage = storage.clone();
            let q = q.clone();
            move || storage.count_search_captures(&q)
        })
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?? as usize;

        let rows = tokio::task::spawn_blocking(move || {
            storage.search_captures_paginated(&q, limit, offset)
        })
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))??;

        return Ok(Json(CapturesResponse { total, captures: rows }));
    }

    let mut filter = CaptureFilter::new();
    filter.app_name = params.app;
    filter.from_ts  = params.from;
    filter.to_ts    = params.to;
    filter.limit    = limit;
    filter.offset   = offset;

    let total = tokio::task::spawn_blocking({
        let storage = storage.clone();
        let filter = CaptureFilter {
            from_ts: filter.from_ts,
            to_ts: filter.to_ts,
            app_name: filter.app_name.clone(),
            query: filter.query.clone(),
            capture_id: filter.capture_id,
            exclude_sensitive: filter.exclude_sensitive,
            limit: filter.limit,
            offset: filter.offset,
        };
        move || storage.count_captures(&filter)
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))?? as usize;

    let rows = tokio::task::spawn_blocking(move || {
        storage.list_captures(&filter)
    })
    .await
    .map_err(|e| ApiError::Internal(e.to_string()))??;

    Ok(Json(CapturesResponse { total, captures: rows }))
}
