//! 共享应用状态（通过 axum State extractor 注入每个 handler）

use std::{path::PathBuf, sync::Arc};

use crate::storage::StorageManager;

#[derive(Debug, Clone)]
pub struct DebugLogSpec {
    pub key:       String,
    pub label:     String,
    pub dir:       PathBuf,
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
    let log_dir = PathBuf::from(home)
        .join(".memory-bread")
        .join("logs");

    vec![
        DebugLogSpec::new("core", "core.log · Core Engine", log_dir.clone(), "core.log"),
        DebugLogSpec::new("sidecar", "sidecar.log · AI Sidecar", log_dir.clone(), "sidecar.log"),
        DebugLogSpec::new("model_api", "model_api.log · Model API", log_dir.clone(), "model_api.log"),
        DebugLogSpec::new("ui", "ui.log · Desktop UI", log_dir, "ui.log"),
    ]
}

/// 所有 Handler 共享的应用状态。
///
/// 使用 `Arc<AppState>` 确保零拷贝跨线程共享。
#[derive(Clone)]
pub struct AppState {
    pub storage:         StorageManager,
    pub sidecar_url:     String,
    pub debug_log_specs: Vec<DebugLogSpec>,
}

impl AppState {
    pub fn new(storage: StorageManager) -> Arc<Self> {
        let sidecar_url = std::env::var("SIDECAR_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:7071".to_string());
        Arc::new(Self {
            storage,
            sidecar_url,
            debug_log_specs: default_debug_log_specs(),
        })
    }
}
