use std::{fs, path::PathBuf, process::Command, sync::Arc, time::Duration};

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    api::{error::ApiError, state::AppState},
    storage::{
        repo::creation_evidence::NewCreationEvidenceAsset, CreationEvidenceAssetView,
        DataExtractionSummary, DataSearchResult, DataSourceRecord, StorageError,
    },
};
use uuid::Uuid;

const MAX_SCRAPED_CHARS: usize = 80_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowserScriptKind {
    Chromium,
    Safari,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BrowserAdapter {
    id: &'static str,
    app_name: &'static str,
    process_name: &'static str,
    script_kind: BrowserScriptKind,
}

const BROWSER_ADAPTERS: &[BrowserAdapter] = &[
    BrowserAdapter {
        id: "chrome",
        app_name: "Google Chrome",
        process_name: "Google Chrome",
        script_kind: BrowserScriptKind::Chromium,
    },
    BrowserAdapter {
        id: "chrome_canary",
        app_name: "Google Chrome Canary",
        process_name: "Google Chrome Canary",
        script_kind: BrowserScriptKind::Chromium,
    },
    BrowserAdapter {
        id: "edge",
        app_name: "Microsoft Edge",
        process_name: "Microsoft Edge",
        script_kind: BrowserScriptKind::Chromium,
    },
    BrowserAdapter {
        id: "brave",
        app_name: "Brave Browser",
        process_name: "Brave Browser",
        script_kind: BrowserScriptKind::Chromium,
    },
    BrowserAdapter {
        id: "chromium",
        app_name: "Chromium",
        process_name: "Chromium",
        script_kind: BrowserScriptKind::Chromium,
    },
    BrowserAdapter {
        id: "vivaldi",
        app_name: "Vivaldi",
        process_name: "Vivaldi",
        script_kind: BrowserScriptKind::Chromium,
    },
    BrowserAdapter {
        id: "safari",
        app_name: "Safari",
        process_name: "Safari",
        script_kind: BrowserScriptKind::Safari,
    },
];

#[derive(Debug, Deserialize)]
pub struct DataListQuery {
    pub q: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct DataListResponse {
    pub items: Vec<DataSourceRecord>,
    pub total: i64,
    pub pending_items: Vec<DataSourceRecord>,
    pub pending_total: i64,
    pub limit: usize,
    pub offset: usize,
}

#[derive(Debug, Deserialize)]
pub struct ExtractDataRequest {
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct DataSearchRequest {
    pub query: String,
    #[serde(default)]
    pub need_fresh: bool,
    pub as_of_ms: Option<i64>,
    pub limit: Option<usize>,
}

#[derive(Debug, Serialize)]
pub struct DataSearchResponse {
    pub schema_version: &'static str,
    pub query: String,
    pub results: Vec<DataSearchResult>,
}

#[derive(Debug, Deserialize)]
pub struct RefreshDataSourceRequest {
    #[serde(default = "default_scrape_mode")]
    pub mode: String,
    #[serde(default = "default_browser_preference")]
    pub browser_preference: String,
    #[serde(default)]
    pub capture_evidence: bool,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WebpageScrapeResponse {
    pub schema_version: &'static str,
    pub source_id: i64,
    pub collector: String,
    pub browser: Option<String>,
    pub interaction_mode: String,
    pub collected_at: i64,
    pub title: String,
    pub url: String,
    pub content_text: String,
    pub structured_data: Value,
    pub content_hash: String,
    pub evidence: Option<CreationEvidenceAssetView>,
}

#[derive(Debug, Deserialize)]
pub struct ValidateEvidenceRequest {
    pub status: String,
    #[serde(default)]
    pub validation: Value,
}

#[derive(Debug)]
struct PendingEvidenceCapture {
    id: String,
    run_id: String,
    session_id: String,
    full_path: PathBuf,
}

#[derive(Debug)]
struct BrowserScreenshot {
    relative_path: String,
    width: i64,
    height: i64,
    content_hash: String,
}

#[derive(Debug)]
struct ScrapeResult {
    collector: &'static str,
    browser: Option<&'static str>,
    interaction_mode: &'static str,
    title: String,
    url: String,
    content_text: String,
    structured_data: Value,
    screenshot: Option<BrowserScreenshot>,
}

#[derive(Debug)]
pub struct DataToolError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

impl DataToolError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
}

impl IntoResponse for DataToolError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error": self.code, "message": self.message})),
        )
            .into_response()
    }
}

pub async fn list_data_sources(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DataListQuery>,
) -> Result<Json<DataListResponse>, ApiError> {
    let limit = params.limit.unwrap_or(20).clamp(1, 100);
    let offset = params.offset.unwrap_or(0);
    let query = params.q.filter(|value| !value.trim().is_empty());
    let storage = state.storage.clone();
    let (items, total, pending_items, pending_total) = tokio::task::spawn_blocking(move || {
        let (items, total) = storage.list_data_sources(query.as_deref(), limit, offset)?;
        let (pending_items, pending_total) =
            storage.list_pending_data_sources(query.as_deref(), 100)?;
        Ok::<_, StorageError>((items, total, pending_items, pending_total))
    })
    .await
    .map_err(|error| ApiError::Internal(error.to_string()))??;
    Ok(Json(DataListResponse {
        items,
        total,
        pending_items,
        pending_total,
        limit,
        offset,
    }))
}

pub async fn get_data_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<Json<DataSourceRecord>, ApiError> {
    let storage = state.storage.clone();
    let source = tokio::task::spawn_blocking(move || storage.get_data_source(id))
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))??
        .ok_or_else(|| ApiError::NotFound("数据源不存在".to_string()))?;
    Ok(Json(source))
}

pub async fn delete_data_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let storage = state.storage.clone();
    let deleted = tokio::task::spawn_blocking(move || storage.delete_data_source(id))
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))??;
    if !deleted {
        return Err(ApiError::NotFound("数据不存在或已删除".to_string()));
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn extract_data_sources(
    State(state): State<Arc<AppState>>,
    Json(body): Json<ExtractDataRequest>,
) -> Result<Json<DataExtractionSummary>, ApiError> {
    let storage = state.storage.clone();
    let limit = body.limit.unwrap_or(1000).clamp(1, 5000);
    let summary = tokio::task::spawn_blocking(move || storage.extract_data_candidates(limit))
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))??;
    Ok(Json(summary))
}

pub async fn search_data(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DataSearchRequest>,
) -> Result<Json<DataSearchResponse>, ApiError> {
    let query = body.query.trim().to_string();
    if query.is_empty() {
        return Err(ApiError::BadRequest("数据检索词不能为空".to_string()));
    }
    let storage = state.storage.clone();
    let need_fresh = body.need_fresh;
    let as_of_ms = body.as_of_ms.unwrap_or_else(now_ms);
    let limit = body.limit.unwrap_or(6).clamp(1, 20);
    let search_query = query.clone();
    let results = tokio::task::spawn_blocking(move || {
        storage.search_data_sources(&search_query, need_fresh, as_of_ms, limit)
    })
    .await
    .map_err(|error| ApiError::Internal(error.to_string()))??;
    Ok(Json(DataSearchResponse {
        schema_version: "memorybread.data-search.v1",
        query,
        results,
    }))
}

pub async fn refresh_data_source(
    State(state): State<Arc<AppState>>,
    Path(id): Path<i64>,
    Json(body): Json<RefreshDataSourceRequest>,
) -> Result<Json<WebpageScrapeResponse>, DataToolError> {
    let mode = body.mode.trim().to_lowercase();
    if !matches!(mode.as_str(), "auto" | "browser" | "http") {
        return Err(DataToolError::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "网页采集模式无效",
        ));
    }
    let browser_preference = body.browser_preference.trim().to_lowercase();
    if browser_preference != "auto"
        && !BROWSER_ADAPTERS
            .iter()
            .any(|adapter| adapter.id == browser_preference)
    {
        return Err(DataToolError::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "浏览器偏好无效或当前不受支持",
        ));
    }
    let evidence_capture = if body.capture_evidence {
        Some(prepare_evidence_capture(
            body.run_id.as_deref(),
            body.session_id.as_deref(),
        )?)
    } else {
        None
    };
    let storage = state.storage.clone();
    let source = tokio::task::spawn_blocking(move || storage.get_data_source(id))
        .await
        .map_err(|_| internal_scrape_error())?
        .map_err(|_| internal_scrape_error())?
        .ok_or_else(|| {
            DataToolError::new(
                StatusCode::NOT_FOUND,
                "DATA_SOURCE_NOT_FOUND",
                "数据源不存在或已停用",
            )
        })?;
    let url = source.source_url.clone().ok_or_else(|| {
        DataToolError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "DATA_SOURCE_URL_MISSING",
            "该数据源没有可刷新的网页地址",
        )
    })?;
    validate_scrape_url(&url)?;

    let scrape_in_browser = || {
        scrape_browser_async(
            url.clone(),
            browser_preference.clone(),
            source.source_app_name.clone(),
            evidence_capture
                .as_ref()
                .map(|capture| capture.full_path.clone()),
        )
    };

    let scrape_result = match mode.as_str() {
        _ if evidence_capture.is_some() => scrape_in_browser().await,
        "browser" => scrape_in_browser().await,
        "http" => scrape_http(&url).await,
        _ if source.access_mode == "browser_session" => match scrape_in_browser().await {
            Ok(result) => Ok(result),
            Err(browser_error) => match scrape_http(&url).await {
                Ok(result) => Ok(result),
                Err(_) => Err(browser_error),
            },
        },
        _ => match scrape_http(&url).await {
            Ok(result) => Ok(result),
            Err(_) => scrape_in_browser().await,
        },
    };

    let result = match scrape_result {
        Ok(result) => result,
        Err(error) => {
            cleanup_pending_evidence(evidence_capture.as_ref());
            let storage = state.storage.clone();
            let error_code = error.code.to_string();
            let _ = tokio::task::spawn_blocking(move || {
                storage.mark_data_source_error(id, &error_code)
            })
            .await;
            return Err(error);
        }
    };
    if result.content_text.trim().is_empty() {
        cleanup_pending_evidence(evidence_capture.as_ref());
        return Err(DataToolError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "SCRAPE_EMPTY",
            "页面没有可采纳的数据正文或表格",
        ));
    }

    let collected_at = now_ms();
    let content_hash = format!(
        "{:x}",
        Sha256::digest(format!("{}\n{}", result.content_text, result.structured_data).as_bytes())
    );
    let storage = state.storage.clone();
    let collector = result.collector.to_string();
    let title = result.title.clone();
    let content = result.content_text.clone();
    let structured = result.structured_data.clone();
    let snapshot_result = tokio::task::spawn_blocking(move || {
        storage.save_data_snapshot(
            id,
            &collector,
            Some(&title),
            &content,
            &structured,
            collected_at,
        )
    })
    .await;
    if !matches!(snapshot_result, Ok(Ok(_))) {
        cleanup_pending_evidence(evidence_capture.as_ref());
        return Err(internal_scrape_error());
    }

    let evidence = if let (Some(capture), Some(screenshot)) =
        (evidence_capture.as_ref(), result.screenshot.as_ref())
    {
        let storage = state.storage.clone();
        let asset = NewCreationEvidenceAsset {
            id: capture.id.clone(),
            run_id: capture.run_id.clone(),
            session_id: capture.session_id.clone(),
            source_id: id,
            // 证据归属本次创作运行；数据面板的快照会被下一次采集原位覆盖，
            // 因此不把历史证据强绑定到那条可变快照记录。
            data_snapshot_id: None,
            source_url: result.url.clone(),
            page_title: result.title.clone(),
            captured_at: collected_at,
            image_path: screenshot.relative_path.clone(),
            mime_type: "image/jpeg".to_string(),
            width: screenshot.width,
            height: screenshot.height,
            content_hash: screenshot.content_hash.clone(),
            screenshot_source: "browser_window".to_string(),
        };
        match tokio::task::spawn_blocking(move || storage.save_creation_evidence_asset(&asset))
            .await
        {
            Ok(Ok(asset)) => Some(asset.into()),
            _ => {
                cleanup_pending_evidence(evidence_capture.as_ref());
                return Err(internal_scrape_error());
            }
        }
    } else {
        None
    };

    Ok(Json(WebpageScrapeResponse {
        schema_version: "memorybread.webpage-scrape.v1",
        source_id: id,
        collector: result.collector.to_string(),
        browser: result.browser.map(ToString::to_string),
        interaction_mode: result.interaction_mode.to_string(),
        collected_at,
        title: result.title,
        url: result.url,
        content_text: result.content_text,
        structured_data: result.structured_data,
        content_hash,
        evidence,
    }))
}

pub async fn get_creation_evidence_image(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let storage = state.storage.clone();
    let asset = tokio::task::spawn_blocking(move || storage.get_creation_evidence_asset(&id))
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))??
        .ok_or_else(|| ApiError::NotFound("创作证据不存在".to_string()))?;
    let path = evidence_dir().join(&asset.image_path);
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| ApiError::NotFound("创作证据图片不存在".to_string()))?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.mime_type)
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .body(Body::from(bytes))
        .map_err(|error| ApiError::Internal(error.to_string()))
}

pub async fn validate_creation_evidence(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<ValidateEvidenceRequest>,
) -> Result<Json<CreationEvidenceAssetView>, ApiError> {
    let status = body.status.trim().to_lowercase();
    if !matches!(status.as_str(), "verified" | "rejected") {
        return Err(ApiError::BadRequest(
            "证据校验状态只能是 verified 或 rejected".to_string(),
        ));
    }
    let storage = state.storage.clone();
    let validation = body.validation;
    let asset = tokio::task::spawn_blocking(move || {
        storage.validate_creation_evidence_asset(&id, &status, &validation)
    })
    .await
    .map_err(|error| ApiError::Internal(error.to_string()))??
    .ok_or_else(|| ApiError::NotFound("创作证据不存在".to_string()))?;
    Ok(Json(asset.into()))
}

async fn scrape_browser_async(
    url: String,
    browser_preference: String,
    source_app_name: Option<String>,
    evidence_path: Option<PathBuf>,
) -> Result<ScrapeResult, DataToolError> {
    tokio::task::spawn_blocking(move || {
        scrape_with_browser(
            &url,
            Some(browser_preference.as_str()),
            source_app_name.as_deref(),
            evidence_path.as_deref(),
        )
    })
    .await
    .map_err(|_| internal_scrape_error())?
}

fn scrape_with_browser(
    url: &str,
    browser_preference: Option<&str>,
    source_app_name: Option<&str>,
    evidence_path: Option<&std::path::Path>,
) -> Result<ScrapeResult, DataToolError> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (url, browser_preference, source_app_name, evidence_path);
        return Err(DataToolError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "BROWSER_ATTACH_UNAVAILABLE",
            "当前系统暂不支持附加本机浏览器会话",
        ));
    }

    #[cfg(target_os = "macos")]
    {
        let adapter = browser_candidates(browser_preference, source_app_name)
            .into_iter()
            .find(|adapter| browser_is_running(*adapter))
            .ok_or_else(|| {
                DataToolError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "BROWSER_ATTACH_UNAVAILABLE",
                    "请先打开并登录受支持的浏览器",
                )
            })?;
        let javascript = browser_extraction_javascript();
        let readiness_javascript = browser_readiness_javascript();
        let evidence_path_string = evidence_path.map(|path| path.to_string_lossy().into_owned());
        let script = match adapter.script_kind {
            BrowserScriptKind::Chromium => build_chromium_scrape_script(
                adapter,
                url,
                &readiness_javascript,
                &javascript,
                evidence_path_string.as_deref(),
            ),
            BrowserScriptKind::Safari => build_safari_scrape_script(
                adapter,
                url,
                &readiness_javascript,
                &javascript,
                evidence_path_string.as_deref(),
            ),
        };
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|_| {
                DataToolError::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "BROWSER_ATTACH_UNAVAILABLE",
                    "无法附加本机浏览器会话",
                )
            })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
            if browser_scripting_is_disabled(&stderr) {
                return Err(DataToolError::new(
                    StatusCode::PRECONDITION_FAILED,
                    "BROWSER_SCRIPTING_DISABLED",
                    "请允许浏览器执行来自 Apple Events 的 JavaScript",
                ));
            }
            return Err(DataToolError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "BROWSER_ATTACH_UNAVAILABLE",
                "浏览器登录会话暂时不可用",
            ));
        }
        let payload: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
            DataToolError::new(
                StatusCode::BAD_GATEWAY,
                "SCRAPE_FAILED",
                "浏览器返回的页面数据无法解析",
            )
        })?;
        let title = payload
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("数据报表");
        let final_url = payload.get("url").and_then(Value::as_str).unwrap_or(url);
        let content_text = payload.get("text").and_then(Value::as_str).unwrap_or("");
        if looks_like_auth_page(title, final_url, content_text) {
            return Err(DataToolError::new(
                StatusCode::UNAUTHORIZED,
                "SCRAPE_AUTH_REQUIRED",
                "请先在对应浏览器中完成页面登录",
            ));
        }
        let screenshot =
            evidence_path
                .map(read_browser_screenshot)
                .transpose()?
                .map(|mut screenshot| {
                    screenshot.relative_path = evidence_path_string
                        .as_deref()
                        .and_then(|value| std::path::Path::new(value).file_name())
                        .and_then(|value| value.to_str())
                        .unwrap_or_default()
                        .to_string();
                    screenshot
                });
        Ok(ScrapeResult {
            collector: "browser_attach",
            browser: Some(adapter.id),
            interaction_mode: if screenshot.is_some() {
                "temporary_foreground_tab"
            } else {
                "background_tab"
            },
            title: clip_text(title, 240),
            url: redact_url_credentials(final_url).unwrap_or_else(|| url.to_string()),
            content_text: clip_text(content_text, MAX_SCRAPED_CHARS),
            structured_data: payload
                .get("structured_data")
                .cloned()
                .unwrap_or_else(|| json!({})),
            screenshot,
        })
    }
}

fn evidence_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".memory-bread")
        .join("creation-evidence")
}

fn cleanup_pending_evidence(capture: Option<&PendingEvidenceCapture>) {
    if let Some(capture) = capture {
        let _ = fs::remove_file(&capture.full_path);
    }
}

fn prepare_evidence_capture(
    run_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<PendingEvidenceCapture, DataToolError> {
    let run_id = run_id.map(str::trim).filter(|value| !value.is_empty());
    let session_id = session_id.map(str::trim).filter(|value| !value.is_empty());
    let (Some(run_id), Some(session_id)) = (run_id, session_id) else {
        return Err(DataToolError::new(
            StatusCode::BAD_REQUEST,
            "EVIDENCE_CONTEXT_REQUIRED",
            "创作截图需要 run_id 与 session_id",
        ));
    };
    let id = Uuid::new_v4().to_string();
    let relative_path = format!("{id}.jpg");
    let directory = evidence_dir();
    fs::create_dir_all(&directory).map_err(|_| internal_scrape_error())?;
    Ok(PendingEvidenceCapture {
        id,
        run_id: clip_text(run_id, 128),
        session_id: clip_text(session_id, 128),
        full_path: directory.join(&relative_path),
    })
}

fn read_browser_screenshot(path: &std::path::Path) -> Result<BrowserScreenshot, DataToolError> {
    let bytes = fs::read(path).map_err(|_| {
        DataToolError::new(
            StatusCode::BAD_GATEWAY,
            "SCREENSHOT_FAILED",
            "报表页面已读取，但通用浏览器截图失败",
        )
    })?;
    let (width, height) = image::image_dimensions(path).map_err(|_| {
        DataToolError::new(
            StatusCode::BAD_GATEWAY,
            "SCREENSHOT_FAILED",
            "浏览器截图文件无法解析",
        )
    })?;
    Ok(BrowserScreenshot {
        relative_path: String::new(),
        width: width.into(),
        height: height.into(),
        content_hash: format!("{:x}", Sha256::digest(&bytes)),
    })
}

fn browser_candidates(
    browser_preference: Option<&str>,
    source_app_name: Option<&str>,
) -> Vec<BrowserAdapter> {
    let preference = browser_preference.unwrap_or("auto").trim().to_lowercase();
    if preference != "auto" {
        return BROWSER_ADAPTERS
            .iter()
            .copied()
            .filter(|adapter| adapter.id == preference)
            .collect();
    }

    let hinted = browser_id_for_app_name(source_app_name.unwrap_or_default());
    let mut candidates = Vec::with_capacity(BROWSER_ADAPTERS.len());
    if let Some(hinted_id) = hinted {
        if let Some(adapter) = BROWSER_ADAPTERS
            .iter()
            .copied()
            .find(|adapter| adapter.id == hinted_id)
        {
            candidates.push(adapter);
        }
    }
    candidates.extend(
        BROWSER_ADAPTERS
            .iter()
            .copied()
            .filter(|adapter| Some(adapter.id) != hinted),
    );
    candidates
}

fn browser_id_for_app_name(app_name: &str) -> Option<&'static str> {
    let name = app_name.trim().to_lowercase();
    if name.contains("canary") {
        Some("chrome_canary")
    } else if name.contains("chrome") {
        Some("chrome")
    } else if name.contains("edge") {
        Some("edge")
    } else if name.contains("brave") {
        Some("brave")
    } else if name.contains("chromium") {
        Some("chromium")
    } else if name.contains("vivaldi") {
        Some("vivaldi")
    } else if name == "safari" {
        Some("safari")
    } else {
        None
    }
}

fn browser_is_running(adapter: BrowserAdapter) -> bool {
    Command::new("pgrep")
        .args(["-x", adapter.process_name])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn browser_extraction_javascript() -> String {
    format!(
        r#"(function() {{
            var clean = function(v) {{ return String(v || '').replace(/\s+/g, ' ').trim(); }};
            var rawText = String(document.body ? (document.body.innerText || document.body.textContent) : '');
            var text = rawText.split(/\r?\n/).map(clean).filter(Boolean).join('\n');
            if (text.length > {max_chars}) text = text.substring(0, {max_chars});
            var tables = Array.prototype.slice.call(document.querySelectorAll('table'), 0, 20).map(function(table) {{
                return Array.prototype.slice.call(table.querySelectorAll('tr'), 0, 200).map(function(row) {{
                    return Array.prototype.slice.call(row.querySelectorAll('th,td'), 0, 40).map(function(cell) {{ return clean(cell.innerText || cell.textContent); }});
                }}).filter(function(row) {{ return row.some(Boolean); }});
            }}).filter(function(table) {{ return table.length > 0; }});
            var labels = Array.prototype.slice.call(document.querySelectorAll('[aria-label]'), 0, 500)
                .map(function(node) {{ return clean(node.getAttribute('aria-label')); }})
                .filter(function(label) {{ return /\d/.test(label); }}).slice(0, 200);
            var textBlocks = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,dt,dd'), 0, 800)
                .map(function(node) {{ return clean(node.innerText || node.textContent); }})
                .filter(function(value) {{ return value.length >= 6 && value.length <= 500; }})
                .slice(0, 500);
            return JSON.stringify({{title: clean(document.title), url: location.href, text: text, structured_data: {{tables: tables, metric_labels: labels, text_blocks: textBlocks}}}});
        }})()"#,
        max_chars = MAX_SCRAPED_CHARS,
    )
}

fn browser_readiness_javascript() -> String {
    "(function(){var text=String(document.body ? (document.body.innerText || document.body.textContent || '') : '').replace(/\\s+/g,' ').trim();return text.length;})()".to_string()
}

fn build_chromium_scrape_script(
    adapter: BrowserAdapter,
    url: &str,
    readiness_javascript: &str,
    javascript: &str,
    evidence_path: Option<&str>,
) -> String {
    if let Some(evidence_path) = evidence_path {
        return build_chromium_evidence_script(
            adapter,
            url,
            readiness_javascript,
            javascript,
            evidence_path,
        );
    }
    format!(
        r#"
        tell application "{app_name}"
            if (count of windows) is 0 then error "BROWSER_ATTACH_UNAVAILABLE"
            set target_window to last window
            set original_active_index to active tab index of target_window
            set report_tab to missing value
            try
                set report_tab to make new tab at end of tabs of target_window with properties {{URL:"about:blank"}}
                set active tab index of target_window to original_active_index
                set URL of report_tab to "{url}"
                repeat 80 times
                    if loading of report_tab is false then exit repeat
                    delay 0.25
                end repeat
                set last_text_length to 0
                set stable_read_count to 0
                repeat 36 times
                    set current_text_length to execute report_tab javascript "{readiness_javascript}"
                    if current_text_length is greater than or equal to 500 then
                        if current_text_length is last_text_length then
                            set stable_read_count to stable_read_count + 1
                        else
                            set stable_read_count to 0
                        end if
                        if stable_read_count is greater than or equal to 3 then exit repeat
                    end if
                    set last_text_length to current_text_length
                    delay 0.5
                end repeat
                set payload to execute report_tab javascript "{javascript}"
                try
                    if active tab of target_window is not report_tab then close report_tab
                end try
                return payload
            on error error_message
                try
                    if report_tab is not missing value then
                        if active tab of target_window is not report_tab then close report_tab
                    end if
                end try
                error error_message
            end try
        end tell
        "#,
        app_name = adapter.app_name,
        url = escape_applescript_string(url),
        readiness_javascript = escape_applescript_string(readiness_javascript),
        javascript = escape_applescript_string(javascript),
    )
}

fn build_safari_scrape_script(
    adapter: BrowserAdapter,
    url: &str,
    readiness_javascript: &str,
    javascript: &str,
    evidence_path: Option<&str>,
) -> String {
    if let Some(evidence_path) = evidence_path {
        return build_safari_evidence_script(
            adapter,
            url,
            readiness_javascript,
            javascript,
            evidence_path,
        );
    }
    format!(
        r#"
        tell application "{app_name}"
            if (count of windows) is 0 then error "BROWSER_ATTACH_UNAVAILABLE"
            set target_window to last window
            set original_tab to current tab of target_window
            set report_tab to missing value
            try
                set report_tab to make new tab at end of tabs of target_window with properties {{URL:"about:blank"}}
                set current tab of target_window to original_tab
                set URL of report_tab to "{url}"
                repeat 80 times
                    try
                        if (do JavaScript "document.readyState" in report_tab) is "complete" then exit repeat
                    end try
                    delay 0.25
                end repeat
                set last_text_length to 0
                set stable_read_count to 0
                repeat 36 times
                    set current_text_length to do JavaScript "{readiness_javascript}" in report_tab
                    if current_text_length is greater than or equal to 500 then
                        if current_text_length is last_text_length then
                            set stable_read_count to stable_read_count + 1
                        else
                            set stable_read_count to 0
                        end if
                        if stable_read_count is greater than or equal to 3 then exit repeat
                    end if
                    set last_text_length to current_text_length
                    delay 0.5
                end repeat
                set payload to do JavaScript "{javascript}" in report_tab
                try
                    if current tab of target_window is not report_tab then close report_tab
                end try
                return payload
            on error error_message
                try
                    if report_tab is not missing value then
                        if current tab of target_window is not report_tab then close report_tab
                    end if
                end try
                error error_message
            end try
        end tell
        "#,
        app_name = adapter.app_name,
        url = escape_applescript_string(url),
        readiness_javascript = escape_applescript_string(readiness_javascript),
        javascript = escape_applescript_string(javascript),
    )
}

fn build_chromium_evidence_script(
    adapter: BrowserAdapter,
    url: &str,
    readiness_javascript: &str,
    javascript: &str,
    evidence_path: &str,
) -> String {
    format!(
        r#"
        tell application "System Events"
            set previous_front_app to name of first application process whose frontmost is true
        end tell
        set captured_error to ""
        tell application "{app_name}"
            if (count of windows) is 0 then error "BROWSER_ATTACH_UNAVAILABLE"
            set target_window to front window
            set original_active_index to active tab index of target_window
            set report_tab to missing value
            try
                set report_tab to make new tab at end of tabs of target_window with properties {{URL:"about:blank"}}
                set active tab index of target_window to (count of tabs of target_window)
                set URL of report_tab to "{url}"
                activate
                repeat 80 times
                    if loading of report_tab is false then exit repeat
                    delay 0.25
                end repeat
                set last_text_length to 0
                set stable_read_count to 0
                repeat 36 times
                    set current_text_length to execute report_tab javascript "{readiness_javascript}"
                    if current_text_length is greater than or equal to 500 then
                        if current_text_length is last_text_length then
                            set stable_read_count to stable_read_count + 1
                        else
                            set stable_read_count to 0
                        end if
                        if stable_read_count is greater than or equal to 3 then exit repeat
                    end if
                    set last_text_length to current_text_length
                    delay 0.5
                end repeat
                set payload to execute report_tab javascript "{javascript}"
                delay 0.5
                set browser_window_id to id of target_window as text
                do shell script "/usr/sbin/screencapture -x -o -t jpg -l" & browser_window_id & " " & quoted form of "{evidence_path}"
                close report_tab
                set active tab index of target_window to original_active_index
            on error error_message
                try
                    if report_tab is not missing value then close report_tab
                    set active tab index of target_window to original_active_index
                end try
                set captured_error to error_message
            end try
        end tell
        tell application "System Events"
            try
                set frontmost of first application process whose name is previous_front_app to true
            end try
        end tell
        if captured_error is not "" then error captured_error
        return payload
        "#,
        app_name = adapter.app_name,
        url = escape_applescript_string(url),
        readiness_javascript = escape_applescript_string(readiness_javascript),
        javascript = escape_applescript_string(javascript),
        evidence_path = escape_applescript_string(evidence_path),
    )
}

fn build_safari_evidence_script(
    adapter: BrowserAdapter,
    url: &str,
    readiness_javascript: &str,
    javascript: &str,
    evidence_path: &str,
) -> String {
    format!(
        r#"
        tell application "System Events"
            set previous_front_app to name of first application process whose frontmost is true
        end tell
        set captured_error to ""
        tell application "{app_name}"
            if (count of windows) is 0 then error "BROWSER_ATTACH_UNAVAILABLE"
            set target_window to front window
            set original_tab to current tab of target_window
            set report_tab to missing value
            try
                set report_tab to make new tab at end of tabs of target_window with properties {{URL:"about:blank"}}
                set current tab of target_window to report_tab
                set URL of report_tab to "{url}"
                activate
                repeat 80 times
                    try
                        if (do JavaScript "document.readyState" in report_tab) is "complete" then exit repeat
                    end try
                    delay 0.25
                end repeat
                set last_text_length to 0
                set stable_read_count to 0
                repeat 36 times
                    set current_text_length to do JavaScript "{readiness_javascript}" in report_tab
                    if current_text_length is greater than or equal to 500 then
                        if current_text_length is last_text_length then
                            set stable_read_count to stable_read_count + 1
                        else
                            set stable_read_count to 0
                        end if
                        if stable_read_count is greater than or equal to 3 then exit repeat
                    end if
                    set last_text_length to current_text_length
                    delay 0.5
                end repeat
                set payload to do JavaScript "{javascript}" in report_tab
                delay 0.5
                set browser_window_id to id of target_window as text
                do shell script "/usr/sbin/screencapture -x -o -t jpg -l" & browser_window_id & " " & quoted form of "{evidence_path}"
                close report_tab
                set current tab of target_window to original_tab
            on error error_message
                try
                    if report_tab is not missing value then close report_tab
                    set current tab of target_window to original_tab
                end try
                set captured_error to error_message
            end try
        end tell
        tell application "System Events"
            try
                set frontmost of first application process whose name is previous_front_app to true
            end try
        end tell
        if captured_error is not "" then error captured_error
        return payload
        "#,
        app_name = adapter.app_name,
        url = escape_applescript_string(url),
        readiness_javascript = escape_applescript_string(readiness_javascript),
        javascript = escape_applescript_string(javascript),
        evidence_path = escape_applescript_string(evidence_path),
    )
}

fn browser_scripting_is_disabled(stderr: &str) -> bool {
    stderr.contains("javascript")
        && (stderr.contains("apple")
            || stderr.contains("turned off")
            || stderr.contains("disabled")
            || stderr.contains("develop menu"))
}

async fn scrape_http(url: &str) -> Result<ScrapeResult, DataToolError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|_| internal_scrape_error())?;
    let response = client
        .get(url)
        .header("User-Agent", "MemoryBreadDataTool/1.0")
        .send()
        .await
        .map_err(|_| internal_scrape_error())?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(DataToolError::new(
            StatusCode::UNAUTHORIZED,
            "SCRAPE_AUTH_REQUIRED",
            "页面需要在受支持浏览器中完成登录",
        ));
    }
    if !response.status().is_success() {
        return Err(internal_scrape_error());
    }
    let final_url = response.url().to_string();
    let html = response.text().await.map_err(|_| internal_scrape_error())?;
    let title = extract_html_title(&html).unwrap_or_else(|| "数据报表".to_string());
    let content_text = html_to_text(&html, MAX_SCRAPED_CHARS);
    if looks_like_auth_page(&title, &final_url, &content_text) {
        return Err(DataToolError::new(
            StatusCode::UNAUTHORIZED,
            "SCRAPE_AUTH_REQUIRED",
            "页面需要在受支持浏览器中完成登录",
        ));
    }
    if content_text.is_empty() {
        return Err(DataToolError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "SCRAPE_EMPTY",
            "页面没有可采纳的数据正文",
        ));
    }
    Ok(ScrapeResult {
        collector: "direct_http",
        browser: None,
        interaction_mode: "none",
        title,
        url: redact_url_credentials(&final_url).unwrap_or_else(|| url.to_string()),
        content_text,
        structured_data: json!({"extraction": "html_text"}),
        screenshot: None,
    })
}

fn validate_scrape_url(url: &str) -> Result<(), DataToolError> {
    let parsed = reqwest::Url::parse(url).map_err(|_| {
        DataToolError::new(StatusCode::BAD_REQUEST, "BAD_REQUEST", "数据源 URL 无效")
    })?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(DataToolError::new(
            StatusCode::BAD_REQUEST,
            "BAD_REQUEST",
            "只允许不含凭据的 HTTP 或 HTTPS URL",
        ));
    }
    Ok(())
}

fn redact_url_credentials(url: &str) -> Option<String> {
    let mut parsed = reqwest::Url::parse(url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let filtered_pairs = parsed
        .query_pairs()
        .filter(|(key, _)| !is_sensitive_query_key(key))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if parsed.query().is_some() {
        parsed.set_query(None);
        if !filtered_pairs.is_empty() {
            parsed.query_pairs_mut().extend_pairs(&filtered_pairs);
        }
    }
    if parsed
        .fragment()
        .map(|fragment| {
            let lowered = fragment.to_lowercase();
            lowered.contains("access_token=")
                || lowered.contains("id_token=")
                || lowered.contains("api_key=")
                || lowered.contains("signature=")
        })
        .unwrap_or(false)
    {
        parsed.set_fragment(None);
    }
    Some(parsed.to_string())
}

fn is_sensitive_query_key(key: &str) -> bool {
    let key = key.to_lowercase();
    matches!(
        key.as_str(),
        "token"
            | "access_token"
            | "id_token"
            | "refresh_token"
            | "api_key"
            | "apikey"
            | "authorization"
            | "password"
            | "passwd"
            | "secret"
            | "signature"
            | "sig"
            | "credential"
            | "oauth_code"
    ) || key.ends_with("_token")
        || key.contains("signature")
        || key.contains("credential")
}

fn escape_applescript_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let content_start = lower[start..].find('>')? + start + 1;
    let end = lower[content_start..].find("</title>")? + content_start;
    Some(decode_entities(html[content_start..end].trim()))
}

fn html_to_text(html: &str, max_chars: usize) -> String {
    let lower = html.to_lowercase();
    let mut output = String::new();
    let mut index = 0;
    let bytes = html.as_bytes();
    while index < bytes.len() && output.chars().count() < max_chars {
        if lower[index..].starts_with("<script") {
            if let Some(end) = lower[index..].find("</script>") {
                index += end + "</script>".len();
                continue;
            }
        }
        if lower[index..].starts_with("<style") {
            if let Some(end) = lower[index..].find("</style>") {
                index += end + "</style>".len();
                continue;
            }
        }
        if bytes[index] == b'<' {
            if let Some(end) = html[index..].find('>') {
                output.push('\n');
                index += end + 1;
                continue;
            }
        }
        let ch = html[index..].chars().next().unwrap_or_default();
        output.push(ch);
        index += ch.len_utf8().max(1);
    }
    let decoded = decode_entities(&output);
    decoded
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(max_chars)
        .collect()
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn looks_like_auth_page(title: &str, url: &str, content: &str) -> bool {
    let evidence = format!("{title}\n{url}\n{}", clip_text(content, 2000)).to_lowercase();
    [
        "sign in",
        "log in",
        "login",
        "登录",
        "扫码登录",
        "统一身份认证",
        "sso",
        "oauth",
    ]
    .iter()
    .any(|marker| evidence.contains(marker))
}

fn clip_text(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.trim().to_string();
    }
    value.chars().take(max_chars).collect::<String>() + "…"
}

fn internal_scrape_error() -> DataToolError {
    DataToolError::new(
        StatusCode::BAD_GATEWAY,
        "SCRAPE_FAILED",
        "网页采集暂时失败，请保留旧快照并稍后重试",
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

impl From<StorageError> for DataToolError {
    fn from(_: StorageError) -> Self {
        internal_scrape_error()
    }
}

fn default_scrape_mode() -> String {
    "auto".to_string()
}

fn default_browser_preference() -> String {
    "auto".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_html_extraction_removes_scripts_and_decodes_text() {
        let html = "<html><head><title>周报 &amp; 看板</title><script>secret()</script></head><body><h1>GMV</h1><p>本周 120 万</p></body></html>";
        assert_eq!(extract_html_title(html).as_deref(), Some("周报 & 看板"));
        let text = html_to_text(html, 1000);
        assert!(text.contains("GMV"));
        assert!(text.contains("本周 120 万"));
        assert!(!text.contains("secret"));
    }

    #[test]
    fn scrape_url_rejects_file_and_embedded_credentials() {
        assert!(validate_scrape_url("https://example.com/report").is_ok());
        assert!(validate_scrape_url("file:///tmp/report").is_err());
        assert!(validate_scrape_url("https://user:pass@example.com/report").is_err());
    }

    #[test]
    fn scrape_response_url_redacts_tokens_but_keeps_business_filters() {
        assert_eq!(
            redact_url_credentials(
                "https://bi.example.com/report?team=a&access_token=secret#chart"
            )
            .as_deref(),
            Some("https://bi.example.com/report?team=a#chart")
        );
    }

    #[test]
    fn auth_page_detection_handles_common_sso_pages() {
        assert!(looks_like_auth_page(
            "统一身份认证",
            "https://sso.example.com/login",
            "请扫码登录"
        ));
        assert!(!looks_like_auth_page(
            "经营数据看板",
            "https://bi.example.com/dashboard",
            "本周订单 1200"
        ));
    }

    #[test]
    fn browser_candidates_prefer_the_source_browser_and_allow_explicit_choice() {
        let automatic = browser_candidates(Some("auto"), Some("Microsoft Edge"));
        assert_eq!(automatic.first().map(|item| item.id), Some("edge"));
        assert_eq!(automatic.len(), BROWSER_ADAPTERS.len());

        let explicit = browser_candidates(Some("safari"), Some("Google Chrome"));
        assert_eq!(
            explicit.iter().map(|item| item.id).collect::<Vec<_>>(),
            vec!["safari"]
        );
    }

    #[test]
    fn browser_scripts_keep_the_temporary_tab_in_the_background() {
        let javascript = browser_extraction_javascript();
        let readiness_javascript = browser_readiness_javascript();
        let chromium = build_chromium_scrape_script(
            BROWSER_ADAPTERS[0],
            "https://example.com",
            &readiness_javascript,
            &javascript,
            None,
        );
        let safari = build_safari_scrape_script(
            *BROWSER_ADAPTERS.last().unwrap(),
            "https://example.com",
            &readiness_javascript,
            &javascript,
            None,
        );

        assert!(chromium.contains("last window"));
        assert!(chromium.contains("set active tab index of target_window to original_active_index"));
        assert!(chromium
            .contains("if active tab of target_window is not report_tab then close report_tab"));
        assert!(safari.contains("set current tab of target_window to original_tab"));
        assert!(safari
            .contains("if current tab of target_window is not report_tab then close report_tab"));
        assert!(chromium.contains("stable_read_count"));
        assert!(safari.contains("stable_read_count"));
    }

    #[test]
    fn evidence_scripts_capture_the_browser_window_and_restore_focus() {
        let javascript = browser_extraction_javascript();
        let readiness_javascript = browser_readiness_javascript();
        let chromium = build_chromium_scrape_script(
            BROWSER_ADAPTERS[0],
            "https://example.com/dashboard",
            &readiness_javascript,
            &javascript,
            Some("/tmp/memorybread-evidence.jpg"),
        );
        let safari = build_safari_scrape_script(
            *BROWSER_ADAPTERS.last().unwrap(),
            "https://example.com/dashboard",
            &readiness_javascript,
            &javascript,
            Some("/tmp/memorybread-evidence.jpg"),
        );

        for script in [&chromium, &safari] {
            assert!(script.contains("screencapture -x -o -t jpg -l"));
            assert!(script.contains("previous_front_app"));
            assert!(script.contains("close report_tab"));
            assert!(script.contains("frontmost of first application process"));
        }
        assert!(chromium.contains("set active tab index of target_window to original_active_index"));
        assert!(safari.contains("set current tab of target_window to original_tab"));

        #[cfg(target_os = "macos")]
        {
            let output_dir = tempfile::tempdir().unwrap();
            for (index, script) in [&chromium, &safari].into_iter().enumerate() {
                let output_path = output_dir.path().join(format!("evidence-{index}.scpt"));
                let output = Command::new("/usr/bin/osacompile")
                    .args(["-e", script, "-o"])
                    .arg(&output_path)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "evidence AppleScript did not compile: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
    }
}
