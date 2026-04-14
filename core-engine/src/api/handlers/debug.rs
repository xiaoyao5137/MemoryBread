//! 调试相关的 HTTP 处理器
//!
//! 提供：
//! - GET /api/vector/status - 向量化状态
//! - GET /api/stats - 系统统计信息
//! - GET /api/debug/log-files - 关键日志列表
//! - GET /api/debug/log-files/:key - 关键日志内容预览

use std::{
    sync::Arc,
    time::UNIX_EPOCH,
};

use axum::{extract::{Path as AxumPath, State}, Json};
use serde::{Deserialize, Serialize};

use crate::api::{error::ApiError, state::{AppState, DebugLogSpec}};

const MAX_LOG_BYTES: usize = 128 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// 向量化状态
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct VectorStatusItem {
    pub capture_id: i64,
    pub vectorized: bool,
    pub point_id:   Option<String>,
}

#[derive(Debug, Serialize)]
pub struct VectorStatusResponse {
    pub items: Vec<VectorStatusItem>,
}

#[derive(Debug, Serialize)]
pub struct DebugLogFileItem {
    pub key:         String,
    pub label:       String,
    pub exists:      bool,
    pub size_bytes:  u64,
    pub modified_at: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct DebugLogFilesResponse {
    pub items: Vec<DebugLogFileItem>,
}

#[derive(Debug, Serialize)]
pub struct DebugLogContentResponse {
    pub key:              String,
    pub label:            String,
    pub content:          String,
    pub truncated:        bool,
    pub total_size_bytes: u64,
    pub returned_bytes:   usize,
    pub modified_at:      Option<i64>,
}

fn modified_at_ms(metadata: &std::fs::Metadata) -> Option<i64> {
    metadata.modified().ok()
        .and_then(|ts| ts.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn log_file_item(spec: &DebugLogSpec) -> Result<DebugLogFileItem, ApiError> {
    let path = spec.path();
    match std::fs::metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Err(ApiError::Internal(format!("调试日志目标不是普通文件: {}", path.display())));
            }
            Ok(DebugLogFileItem {
                key: spec.key.clone(),
                label: spec.label.clone(),
                exists: true,
                size_bytes: metadata.len(),
                modified_at: modified_at_ms(&metadata),
            })
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(DebugLogFileItem {
            key: spec.key.clone(),
            label: spec.label.clone(),
            exists: false,
            size_bytes: 0,
            modified_at: None,
        }),
        Err(err) => Err(ApiError::Internal(format!("读取调试日志元信息失败: {}: {err}", path.display()))),
    }
}

fn resolve_log_spec<'a>(state: &'a AppState, key: &str) -> Result<&'a DebugLogSpec, ApiError> {
    state.debug_log_specs
        .iter()
        .find(|spec| spec.key == key)
        .ok_or_else(|| ApiError::NotFound(format!("未找到关键日志: {key}")))
}

fn read_log_tail(spec: &DebugLogSpec, max_bytes: usize) -> Result<(String, bool, u64, usize), ApiError> {
    let allowed_dir = spec.dir.canonicalize()
        .map_err(|err| ApiError::Internal(format!("解析日志目录失败: {}: {err}", spec.dir.display())))?;
    let path = spec.path();
    let canonical_path = path.canonicalize()
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => ApiError::NotFound(format!("关键日志不存在: {}", spec.label)),
            _ => ApiError::Internal(format!("解析调试日志路径失败: {}: {err}", path.display())),
        })?;

    if !canonical_path.starts_with(&allowed_dir) {
        return Err(ApiError::Internal(format!(
            "调试日志路径越界: {}",
            canonical_path.display()
        )));
    }

    let metadata = std::fs::metadata(&canonical_path)
        .map_err(|err| ApiError::Internal(format!("读取调试日志元信息失败: {}: {err}", canonical_path.display())))?;
    if !metadata.is_file() {
        return Err(ApiError::Internal(format!("调试日志目标不是普通文件: {}", canonical_path.display())));
    }

    let bytes = std::fs::read(&canonical_path)
        .map_err(|err| ApiError::Internal(format!("读取调试日志失败: {}: {err}", canonical_path.display())))?;
    let total_size_bytes = bytes.len() as u64;
    let start = bytes.len().saturating_sub(max_bytes);
    let truncated = start > 0;
    let tail = &bytes[start..];
    let content = String::from_utf8_lossy(tail).to_string();
    Ok((content, truncated, total_size_bytes, tail.len()))
}

/// GET /api/vector/status
///
/// 返回最近 50 条采集记录的向量化状态。
pub async fn vector_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<VectorStatusResponse>, ApiError> {
    let storage = &state.storage;

    // 获取最近 50 条采集记录
    let captures = storage
        .list_recent(50, 0)
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    let mut items = Vec::new();

    for cap in captures {
        // 查询该 capture_id 是否已向量化
        let vector_record = storage
            .get_by_capture_id(cap.id)
            .ok();

        items.push(VectorStatusItem {
            capture_id: cap.id,
            vectorized: vector_record.is_some(),
            point_id:   vector_record.and_then(|v| Some(v.qdrant_point_id)),
        });
    }

    Ok(Json(VectorStatusResponse { items }))
}

/// GET /api/debug/log-files
///
/// 返回允许查看的关键日志白名单与元信息。
pub async fn debug_log_files(
    State(state): State<Arc<AppState>>,
) -> Result<Json<DebugLogFilesResponse>, ApiError> {
    let mut items = Vec::with_capacity(state.debug_log_specs.len());
    for spec in &state.debug_log_specs {
        items.push(log_file_item(spec)?);
    }
    Ok(Json(DebugLogFilesResponse { items }))
}

/// GET /api/debug/log-files/:key
///
/// 返回指定关键日志的尾部内容预览。
pub async fn debug_log_content(
    State(state): State<Arc<AppState>>,
    AxumPath(key): AxumPath<String>,
) -> Result<Json<DebugLogContentResponse>, ApiError> {
    let spec = resolve_log_spec(&state, &key)?;
    let path = spec.path();
    let metadata = std::fs::metadata(&path)
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => ApiError::NotFound(format!("关键日志不存在: {}", spec.label)),
            _ => ApiError::Internal(format!("读取调试日志元信息失败: {}: {err}", path.display())),
        })?;

    if !metadata.is_file() {
        return Err(ApiError::Internal(format!("调试日志目标不是普通文件: {}", path.display())));
    }

    let (content, truncated, total_size_bytes, returned_bytes) = read_log_tail(spec, MAX_LOG_BYTES)?;

    Ok(Json(DebugLogContentResponse {
        key: spec.key.clone(),
        label: spec.label.clone(),
        content,
        truncated,
        total_size_bytes,
        returned_bytes,
        modified_at: modified_at_ms(&metadata),
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 系统统计
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SystemStatsResponse {
    pub total_captures:   i64,
    pub total_vectorized: i64,
    pub db_size_mb:       f64,
    pub last_capture_ts:  Option<i64>,
}

/// GET /api/stats
///
/// 返回系统统计信息。
pub async fn system_stats(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SystemStatsResponse>, ApiError> {
    let storage = &state.storage;

    // 统计总采集数
    let total_captures = storage
        .count()
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    // 统计已向量化数量
    let total_vectorized = storage
        .count_vectorized()
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    // 获取最后一条采集记录的时间戳
    let last_capture = storage
        .list_recent(1, 0)
        .ok()
        .and_then(|caps| caps.first().map(|c| c.ts));

    // 获取数据库文件大小
    let db_path = storage.db_path();
    let db_size_mb = std::fs::metadata(&db_path)
        .map(|m| m.len() as f64 / 1024.0 / 1024.0)
        .unwrap_or(0.0);

    Ok(Json(SystemStatsResponse {
        total_captures,
        total_vectorized,
        db_size_mb,
        last_capture_ts: last_capture,
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 清空提炼队列
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ClearExtractionQueueResponse {
    pub cleared: i64,
}

/// POST /api/debug/clear-extraction-queue
///
/// 在 knowledge_entries 插入一条占位记录，然后将所有 knowledge_id IS NULL 的
/// capture 指向该占位记录，从而跳过知识提炼处理。
pub async fn clear_extraction_queue(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ClearExtractionQueueResponse>, ApiError> {
    let cleared = state.storage
        .with_conn_async(|conn| {
            // 1. 找一个待处理 capture 的 id 用于满足外键约束
            let first_capture_id: Option<i64> = conn.query_row(
                "SELECT id FROM captures WHERE knowledge_id IS NULL LIMIT 1",
                [],
                |r| r.get(0),
            ).ok();

            let Some(capture_id) = first_capture_id else {
                return Ok(0i64); // 队列为空
            };

            // 2. 插入占位 knowledge_entry
            conn.execute(
                "INSERT INTO knowledge_entries (capture_id, summary, overview, importance, is_self_generated)
                 VALUES (?, '[SKIPPED]', '队列清空占位记录', 0, 1)",
                rusqlite::params![capture_id],
            ).map_err(|e| crate::storage::StorageError::Sqlite(e))?;

            let skip_id = conn.last_insert_rowid();

            // 3. 批量将待处理 captures 指向该占位记录
            let n = conn.execute(
                "UPDATE captures SET knowledge_id = ? WHERE knowledge_id IS NULL",
                rusqlite::params![skip_id],
            ).map_err(|e| crate::storage::StorageError::Sqlite(e))?;

            Ok(n as i64)
        })
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;

    Ok(Json(ClearExtractionQueueResponse { cleared }))
}
