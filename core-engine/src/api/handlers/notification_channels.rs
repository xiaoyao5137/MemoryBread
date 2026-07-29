use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;

use crate::{
    api::{error::ApiError, state::AppState},
    scheduler::{
        models::{NewNotificationChannel, UpdateNotificationChannel},
        notification_repo::NotificationChannelRepo,
    },
};

const CHANNEL_TYPES: &[&str] = &["feishu", "dingtalk", "wecom", "webhook"];

pub async fn list_notification_channels(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, ApiError> {
    let channels = NotificationChannelRepo::list(&state.storage)?;
    Ok(Json(
        serde_json::json!({ "channels": channels, "total": channels.len() }),
    ))
}

pub async fn create_notification_channel(
    State(state): State<Arc<AppState>>,
    Json(mut body): Json<NewNotificationChannel>,
) -> Result<impl IntoResponse, ApiError> {
    body.name = normalize_name(&body.name)?;
    body.channel_type = normalize_channel_type(&body.channel_type)?;
    body.webhook_url = normalize_webhook_url(&body.webhook_url)?;
    let id = NotificationChannelRepo::create(&state.storage, &body, Utc::now().timestamp_millis())?;
    let channel = NotificationChannelRepo::get(&state.storage, id)?
        .ok_or_else(|| ApiError::NotFound("消息渠道不存在".into()))?;
    Ok((StatusCode::CREATED, Json(channel)))
}

pub async fn update_notification_channel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(mut body): Json<UpdateNotificationChannel>,
) -> Result<impl IntoResponse, ApiError> {
    if let Some(name) = body.name.as_deref() {
        body.name = Some(normalize_name(name)?);
    }
    if let Some(channel_type) = body.channel_type.as_deref() {
        body.channel_type = Some(normalize_channel_type(channel_type)?);
    }
    if let Some(webhook_url) = body.webhook_url.as_deref() {
        body.webhook_url = Some(normalize_webhook_url(webhook_url)?);
    }
    let updated =
        NotificationChannelRepo::update(&state.storage, id, &body, Utc::now().timestamp_millis())?;
    if !updated {
        return Err(ApiError::NotFound("消息渠道不存在".into()));
    }
    let channel = NotificationChannelRepo::get(&state.storage, id)?
        .ok_or_else(|| ApiError::NotFound("消息渠道不存在".into()))?;
    Ok(Json(channel))
}

pub async fn delete_notification_channel(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let deleted = NotificationChannelRepo::delete(&state.storage, id)?;
    if !deleted {
        return Err(ApiError::NotFound("消息渠道不存在".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

fn normalize_name(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if !(1..=40).contains(&value.chars().count()) {
        return Err(ApiError::BadRequest("渠道名称需要 1 到 40 个字符".into()));
    }
    Ok(value.to_string())
}

fn normalize_channel_type(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_ascii_lowercase();
    if !CHANNEL_TYPES.contains(&value.as_str()) {
        return Err(ApiError::BadRequest("不支持的消息渠道类型".into()));
    }
    Ok(value)
}

fn normalize_webhook_url(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.len() > 1000
        || value.chars().any(char::is_whitespace)
        || !value.starts_with("https://")
    {
        return Err(ApiError::BadRequest(
            "Webhook 地址必须是有效的 HTTPS 地址".into(),
        ));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_insecure_webhook_url() {
        assert!(normalize_webhook_url("http://example.com/hook").is_err());
    }

    #[test]
    fn accepts_supported_channel_type() {
        assert_eq!(
            normalize_channel_type(" Feishu ").expect("valid channel"),
            "feishu"
        );
    }
}
