use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use crate::{
    api::{error::ApiError, state::AppState},
    services::bake_service::{
        BakeBucket,
        BakeMemoryFilter,
        BakeMemoryPayload,
        BakeCaptureFilter,
        BakeCapturePayload,
        BakeKnowledgePayload,
        BakeListFilter,
        BakeOverviewPayload,
        BakePagedResponse,
        BakeRunPayload,
        BakeService,
        BakeSopPayload,
        BakeStyleConfig,
        BakeTemplatePayload,
        BakeExtractResponse,
        CreateOrUpdateTemplateRequest,
        InitializeBakeMemoriesResponse,
    },
};

#[derive(serde::Deserialize)]
pub struct BakePaginationQuery {
    pub q: Option<String>,
    pub bucket: Option<String>,
    pub from: Option<i64>,
    pub to: Option<i64>,
    pub source_capture_id: Option<i64>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(serde::Serialize)]
pub struct BakeTemplatesResponse {
    pub items: Vec<BakeTemplatePayload>,
    pub total: i64,
    pub limit: usize,
    pub offset: usize,
}

#[derive(serde::Serialize)]
pub struct BakeMemoriesResponse {
    pub articles: Vec<BakeMemoryPayload>,
    pub memories: Vec<BakeMemoryPayload>,
    pub total: i64,
    pub limit: usize,
    pub offset: usize,
}

#[derive(serde::Serialize)]
pub struct BakeKnowledgeResponse {
    pub items: Vec<BakeKnowledgePayload>,
    pub total: i64,
    pub limit: usize,
    pub offset: usize,
}

#[derive(serde::Serialize)]
pub struct BakeCapturesResponse {
    pub items: Vec<BakeCapturePayload>,
    pub total: i64,
    pub limit: usize,
    pub offset: usize,
}

#[derive(serde::Serialize)]
pub struct BakeSopsResponse {
    pub items: Vec<BakeSopPayload>,
    pub total: i64,
    pub limit: usize,
    pub offset: usize,
}

#[derive(serde::Deserialize)]
pub struct InitializeBakeMemoriesRequest {
    pub limit: Option<usize>,
}

#[derive(serde::Deserialize)]
pub struct RunBakeRequest {
    pub trigger_reason: Option<String>,
    pub limit: Option<usize>,
}

pub async fn get_bake_style_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BakeStyleConfig>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let config = tokio::task::spawn_blocking(move || service.get_style_config())
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(config))
}

pub async fn update_bake_style_config(
    State(state): State<Arc<AppState>>,
    Json(body): Json<BakeStyleConfig>,
) -> Result<Json<BakeStyleConfig>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let config = tokio::task::spawn_blocking(move || service.save_style_config(&body))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(config))
}

pub async fn list_bake_templates(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BakePaginationQuery>,
) -> Result<Json<BakeTemplatesResponse>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let offset = params.offset.unwrap_or(0);
    let bucket = BakeBucket::from_query(params.bucket.as_deref())?;
    let filter = BakeListFilter {
        q: params.q.filter(|value| !value.trim().is_empty()),
        bucket,
        limit,
        offset,
    };
    let response: BakePagedResponse<BakeTemplatePayload> = tokio::task::spawn_blocking(move || service.list_templates_paginated(filter))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(BakeTemplatesResponse {
        items: response.items,
        total: response.total,
        limit: response.limit,
        offset: response.offset,
    }))
}

pub async fn create_bake_template(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateOrUpdateTemplateRequest>,
) -> Result<Json<BakeTemplatePayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let template = tokio::task::spawn_blocking(move || service.create_template(body))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(template))
}

pub async fn update_bake_template(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<CreateOrUpdateTemplateRequest>,
) -> Result<Json<BakeTemplatePayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let template = tokio::task::spawn_blocking(move || service.update_template(id, body))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(template))
}

pub async fn toggle_bake_template_status(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BakeTemplatePayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let template = tokio::task::spawn_blocking(move || service.toggle_template_status(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(template))
}

pub async fn delete_bake_template(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    tokio::task::spawn_blocking(move || service.delete_template(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_bake_sops(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BakePaginationQuery>,
) -> Result<Json<BakeSopsResponse>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let offset = params.offset.unwrap_or(0);
    let bucket = BakeBucket::from_query(params.bucket.as_deref())?;
    let filter = BakeListFilter {
        q: params.q.filter(|value| !value.trim().is_empty()),
        bucket,
        limit,
        offset,
    };
    let response: BakePagedResponse<BakeSopPayload> = tokio::task::spawn_blocking(move || service.list_sops_paginated(filter))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(BakeSopsResponse {
        items: response.items,
        total: response.total,
        limit: response.limit,
        offset: response.offset,
    }))
}

pub async fn adopt_bake_sop(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BakeSopPayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let candidate = tokio::task::spawn_blocking(move || service.adopt_sop(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(candidate))
}

pub async fn ignore_bake_sop(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BakeSopPayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let candidate = tokio::task::spawn_blocking(move || service.ignore_sop(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(candidate))
}

pub async fn delete_bake_sop(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    tokio::task::spawn_blocking(move || service.delete_sop(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_bake_memories(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BakePaginationQuery>,
) -> Result<Json<BakeMemoriesResponse>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let offset = params.offset.unwrap_or(0);
    let filter = BakeMemoryFilter {
        q: params.q.filter(|value| !value.trim().is_empty()),
        from_ts: params.from,
        to_ts: params.to,
        limit,
        offset,
    };
    let response: BakePagedResponse<BakeMemoryPayload> = tokio::task::spawn_blocking(move || service.list_memories_paginated(filter))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(BakeMemoriesResponse {
        articles: response.items.clone(),
        memories: response.items,
        total: response.total,
        limit: response.limit,
        offset: response.offset,
    }))
}

pub async fn list_bake_knowledge(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BakePaginationQuery>,
) -> Result<Json<BakeKnowledgeResponse>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let offset = params.offset.unwrap_or(0);
    let bucket = BakeBucket::from_query(params.bucket.as_deref())?;
    let filter = BakeListFilter {
        q: params.q.filter(|value| !value.trim().is_empty()),
        bucket,
        limit,
        offset,
    };
    let response: BakePagedResponse<BakeKnowledgePayload> = tokio::task::spawn_blocking(move || service.list_knowledge_paginated(filter))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(BakeKnowledgeResponse {
        items: response.items,
        total: response.total,
        limit: response.limit,
        offset: response.offset,
    }))
}

pub async fn ignore_bake_knowledge(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BakeKnowledgePayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let knowledge = tokio::task::spawn_blocking(move || service.ignore_knowledge(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(knowledge))
}

pub async fn delete_bake_knowledge(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    tokio::task::spawn_blocking(move || service.delete_knowledge(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_bake_captures(
    State(state): State<Arc<AppState>>,
    Query(params): Query<BakePaginationQuery>,
) -> Result<Json<BakeCapturesResponse>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let offset = params.offset.unwrap_or(0);
    let filter = BakeCaptureFilter {
        q: params.q.filter(|value| !value.trim().is_empty()),
        from_ts: params.from,
        to_ts: params.to,
        source_capture_id: params.source_capture_id,
        limit,
        offset,
    };
    let response: BakePagedResponse<BakeCapturePayload> = tokio::task::spawn_blocking(move || service.list_capture_records_paginated(filter))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(BakeCapturesResponse {
        items: response.items,
        total: response.total,
        limit: response.limit,
        offset: response.offset,
    }))
}

pub async fn get_bake_capture(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BakeCapturePayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let capture = tokio::task::spawn_blocking(move || service.get_capture_record(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(capture))
}

pub async fn get_bake_capture_screenshot(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Response, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let capture = tokio::task::spawn_blocking(move || service.get_capture_record(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;

    let relative_path = capture
        .screenshot_path
        .ok_or_else(|| ApiError::NotFound(format!("capture {id} has no screenshot")))?;

    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let full_path = std::path::PathBuf::from(home)
        .join(".memory-bread")
        .join("captures")
        .join(&relative_path);

    let bytes = tokio::fs::read(&full_path)
        .await
        .map_err(|err| ApiError::NotFound(format!("failed to read screenshot {relative_path}: {err}")))?;

    Ok((
        StatusCode::OK,
        [(header::CONTENT_TYPE, "image/jpeg")],
        bytes,
    ).into_response())
}

pub async fn initialize_bake_memories(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InitializeBakeMemoriesRequest>,
) -> Result<Json<InitializeBakeMemoriesResponse>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let limit = body.limit.unwrap_or(20).clamp(1, 100);
    let result = tokio::task::spawn_blocking(move || service.initialize_memories(limit))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(result))
}

pub async fn ignore_bake_memory(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BakeMemoryPayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let memory = tokio::task::spawn_blocking(move || service.ignore_memory(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(memory))
}

pub async fn promote_bake_memory_to_template(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BakeTemplatePayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let template = tokio::task::spawn_blocking(move || service.promote_memory_to_template(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(template))
}

pub async fn promote_bake_memory_to_sop(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BakeSopPayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let sop = tokio::task::spawn_blocking(move || service.promote_memory_to_sop(id))
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(sop))
}

pub async fn run_bake_pipeline(
    State(state): State<Arc<AppState>>,
    Json(body): Json<RunBakeRequest>,
) -> Result<Json<BakeRunPayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let trigger_reason = body.trigger_reason.unwrap_or_else(|| "manual_debug".to_string());
    let limit = body.limit.unwrap_or(20).clamp(1, 100);
    let result = service.run_bake_pipeline(&trigger_reason, limit).await?;
    Ok(Json(result))
}

pub async fn get_bake_memory_preview(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<BakeExtractResponse>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let result = service.preview_memory(id, "manual_preview").await?;
    Ok(Json(result))
}

pub async fn get_bake_overview(
    State(state): State<Arc<AppState>>,
) -> Result<Json<BakeOverviewPayload>, ApiError> {
    let service = BakeService::new(state.storage.clone(), state.sidecar_url.clone());
    let overview = tokio::task::spawn_blocking(move || service.get_overview())
        .await
        .map_err(|err| ApiError::Internal(err.to_string()))??;
    Ok(Json(overview))
}
