//! 菜单栏运行状态：统一控制采集和自动提炼。

use std::sync::{atomic::Ordering, Arc};

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};

use crate::api::{error::ApiError, state::AppState};

const CAPTURE_ENABLED_KEY: &str = "runtime.capture_enabled";

#[derive(Debug, Serialize)]
pub struct RuntimeStatusResponse {
    pub capture_enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRuntimeStatusRequest {
    pub capture_enabled: bool,
}

pub async fn get_runtime_status(State(state): State<Arc<AppState>>) -> Json<RuntimeStatusResponse> {
    Json(RuntimeStatusResponse {
        capture_enabled: state.is_capture_enabled(),
    })
}

pub async fn update_runtime_status(
    State(state): State<Arc<AppState>>,
    Json(body): Json<UpdateRuntimeStatusRequest>,
) -> Result<Json<RuntimeStatusResponse>, ApiError> {
    let enabled = body.capture_enabled;
    let storage = state.storage.clone();

    tokio::task::spawn_blocking(move || {
        storage.upsert_preference(
            CAPTURE_ENABLED_KEY,
            if enabled { "true" } else { "false" },
            "user",
            1.0,
        )
    })
    .await
    .map_err(|error| ApiError::Internal(error.to_string()))??;

    state.capture_enabled.store(enabled, Ordering::Relaxed);
    tracing::info!(enabled, "采集与自动提炼运行状态已更新");

    Ok(Json(RuntimeStatusResponse {
        capture_enabled: enabled,
    }))
}
