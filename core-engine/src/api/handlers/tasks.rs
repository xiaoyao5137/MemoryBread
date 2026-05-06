//! 定时任务 API 处理器

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::api::{error::ApiError, state::AppState};
use crate::scheduler::{
    models::{NewScheduledTask, UpdateScheduledTask},
    repo::TaskRepo,
};

/// POST /api/tasks - 创建任务
pub async fn create_task(
    State(state): State<Arc<AppState>>,
    Json(body): Json<NewScheduledTask>,
) -> Result<impl IntoResponse, ApiError> {
    // 验证 cron 表达式
    use std::str::FromStr;
    cron::Schedule::from_str(&body.cron_expression)
        .map_err(|e| ApiError::BadRequest(format!("cron 表达式无效: {e}")))?;

    let now_ms = Utc::now().timestamp_millis();
    let id = TaskRepo::create(&state.storage, &body, now_ms)?;
    let task = TaskRepo::get(&state.storage, id)?.ok_or(ApiError::NotFound("task".into()))?;
    Ok((StatusCode::CREATED, Json(task)))
}

/// GET /api/tasks - 列出所有任务
pub async fn list_tasks(State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, ApiError> {
    let tasks = TaskRepo::list_all(&state.storage)?;
    Ok(Json(
        serde_json::json!({ "tasks": tasks, "total": tasks.len() }),
    ))
}

/// GET /api/tasks/:id - 获取单个任务
pub async fn get_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let task = TaskRepo::get(&state.storage, id)?.ok_or(ApiError::NotFound("task".into()))?;
    Ok(Json(task))
}

/// PUT /api/tasks/:id - 更新任务
pub async fn update_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<UpdateScheduledTask>,
) -> Result<impl IntoResponse, ApiError> {
    // 如果更新了 cron 表达式，验证合法性
    if let Some(ref expr) = body.cron_expression {
        use std::str::FromStr;
        cron::Schedule::from_str(expr)
            .map_err(|e| ApiError::BadRequest(format!("cron 表达式无效: {e}")))?;
    }

    let now_ms = Utc::now().timestamp_millis();
    let updated = TaskRepo::update(&state.storage, id, &body, now_ms)?;
    if !updated {
        return Err(ApiError::NotFound("task".into()));
    }

    // 如果更新了 cron，重置 next_run_at
    if body.cron_expression.is_some() {
        TaskRepo::set_next_run(&state.storage, id, 0)?;
    }

    let task = TaskRepo::get(&state.storage, id)?.ok_or(ApiError::NotFound("task".into()))?;
    Ok(Json(task))
}

/// DELETE /api/tasks/:id - 删除任务
pub async fn delete_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let deleted = TaskRepo::delete(&state.storage, id)?;
    if !deleted {
        return Err(ApiError::NotFound("task".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/tasks/:id/executions - 查询执行历史
pub async fn list_executions(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Query(params): Query<ExecutionQuery>,
) -> Result<impl IntoResponse, ApiError> {
    let limit = params.limit.unwrap_or(20).min(100);
    let executions = TaskRepo::list_executions(&state.storage, id, limit)?;
    Ok(Json(serde_json::json!({ "executions": executions })))
}

/// POST /api/tasks/:id/trigger - 手动立即触发任务
pub async fn trigger_task(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    // 确认任务存在
    TaskRepo::get(&state.storage, id)?.ok_or(ApiError::NotFound("task".into()))?;

    // 异步触发（不等待结果）
    let sidecar_url = state.sidecar_url.clone();
    tokio::spawn(async move {
        let client = reqwest::Client::new();
        let _ = client
            .post(format!("{}/tasks/execute", sidecar_url))
            .json(&serde_json::json!({ "task_id": id }))
            .timeout(std::time::Duration::from_secs(300))
            .send()
            .await;
    });

    Ok(Json(
        serde_json::json!({ "message": "任务已触发", "task_id": id }),
    ))
}

#[derive(Debug, Deserialize)]
pub struct ExecutionQuery {
    pub limit: Option<i64>,
}
