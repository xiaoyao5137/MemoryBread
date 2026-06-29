//! 共享应用状态（通过 axum State extractor 注入每个 handler）

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::AtomicU64, Arc, Mutex},
};

use crate::storage::StorageManager;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct DebugLogSpec {
    pub key: String,
    pub label: String,
    pub dir: PathBuf,
    pub file_name: String,
}

impl DebugLogSpec {
    pub fn new(
        key: impl Into<String>,
        label: impl Into<String>,
        dir: PathBuf,
        file_name: impl Into<String>,
    ) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            dir,
            file_name: file_name.into(),
        }
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(&self.file_name)
    }
}

fn default_debug_log_specs() -> Vec<DebugLogSpec> {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let log_dir = PathBuf::from(home).join(".memory-bread").join("logs");

    vec![
        DebugLogSpec::new(
            "core",
            "core.log · Core Engine",
            log_dir.clone(),
            "core.log",
        ),
        DebugLogSpec::new(
            "sidecar",
            "sidecar.log · AI Sidecar",
            log_dir.clone(),
            "sidecar.log",
        ),
        DebugLogSpec::new(
            "model_api",
            "model_api.log · Model API",
            log_dir.clone(),
            "model_api.log",
        ),
        DebugLogSpec::new(
            "bake_extract_errors",
            "bake_extract_errors.log · Bake 提炼错误",
            log_dir.clone(),
            "bake_extract_errors.log",
        ),
        DebugLogSpec::new("ui", "ui.log · Desktop UI", log_dir, "ui.log"),
    ]
}

#[derive(Debug, Clone, Serialize)]
pub struct RagJobRecord {
    pub id: String,
    pub status: String,
    pub result: Option<Value>,
    pub error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

/// 所有 Handler 共享的应用状态。
///
/// 使用 `Arc<AppState>` 确保零拷贝跨线程共享。
#[derive(Clone)]
pub struct AppState {
    pub storage: StorageManager,
    pub sidecar_url: String,
    pub debug_log_specs: Vec<DebugLogSpec>,
    pub rag_jobs: Arc<Mutex<HashMap<String, RagJobRecord>>>,
    pub rag_job_seq: Arc<AtomicU64>,
}

impl AppState {
    pub fn new(storage: StorageManager) -> Arc<Self> {
        let sidecar_url =
            std::env::var("SIDECAR_URL").unwrap_or_else(|_| "http://127.0.0.1:7071".to_string());
        Arc::new(Self {
            storage,
            sidecar_url,
            debug_log_specs: default_debug_log_specs(),
            rag_jobs: Arc::new(Mutex::new(HashMap::new())),
            rag_job_seq: Arc::new(AtomicU64::new(1)),
        })
    }
}
