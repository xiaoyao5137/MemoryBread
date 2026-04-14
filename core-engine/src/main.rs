//! 记忆面包 Core Engine — 二进制入口

use std::path::PathBuf;
use std::time::Duration;

use tokio::sync::mpsc;
use memory_bread_core::{
    api::{server::start_server, state::AppState},
    capture::{start_listener, CaptureConfig, CaptureEngine, ListenerConfig},
    monitor::ResourceMonitor,
    scheduler::Scheduler,
    storage::{db::current_ts_ms, StorageManager},
};

fn parse_capture_interval_secs(storage: &StorageManager) -> u64 {
    storage
        .get_preference("privacy.capture_interval_sec")
        .ok()
        .flatten()
        .and_then(|p| p.value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(30)
}

fn parse_screenshot_keep_days(storage: &StorageManager) -> i64 {
    storage
        .get_preference("privacy.screenshot_keep_days")
        .ok()
        .flatten()
        .and_then(|p| p.value.parse::<i64>().ok())
        .map(|value| value.max(1))
        .unwrap_or(90)
}

fn screenshot_captures_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home)
        .join(".memory-bread")
        .join("captures")
}

async fn run_screenshot_cleanup_loop(storage: StorageManager) {
    let captures_dir = screenshot_captures_dir();
    tracing::info!(path = %captures_dir.display(), "启动截图自动清理后台任务");

    tokio::time::sleep(Duration::from_secs(60)).await;

    loop {
        let keep_days = parse_screenshot_keep_days(&storage);
        let cutoff = current_ts_ms() - keep_days * 24 * 60 * 60 * 1000;

        match storage.run_screenshot_purge(cutoff, &captures_dir) {
            Ok((deleted, freed_bytes)) => {
                tracing::info!(keep_days, deleted, freed_bytes, "截图自动清理完成");
            }
            Err(error) => {
                tracing::warn!(keep_days, %error, "截图自动清理失败");
            }
        }

        tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    tracing_subscriber::fmt()
        .with_target(false)
        .with_level(true)
        .init();

    tracing::info!("记忆面包 Core Engine 启动中...");

    // 数据库路径
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let db_path = PathBuf::from(home)
        .join(".memory-bread")
        .join("memory-bread.db");

    // 初始化存储
    tracing::info!("初始化数据库: {}", db_path.display());
    let storage = StorageManager::open(&db_path)?;

    // 创建应用状态
    let state = AppState::new(storage.clone());

    // 启动采集引擎
    tracing::info!("启动采集引擎...");
    let capture_config = CaptureConfig::default();
    let (tx, rx) = mpsc::channel(100);
    let capture_engine = CaptureEngine::new(storage.clone(), capture_config);

    // 在后台运行采集引擎
    tokio::spawn(async move {
        if let Err(e) = capture_engine.run(rx).await {
            tracing::error!("采集引擎错误: {}", e);
        }
    });

    // 启动事件监听器
    tracing::info!("启动事件监听器...");
    let interval_secs = parse_capture_interval_secs(&storage);
    let mut listener_config = ListenerConfig::default();
    listener_config.interval_secs = interval_secs;
    let enabled = listener_config.enabled.clone();

    tokio::spawn(async move {
        start_listener(listener_config, tx).await;
    });

    // 启动资源监控器
    tracing::info!("启动资源监控器...");
    tokio::spawn(async move {
        ResourceMonitor::new(enabled).start().await;
    });

    // 启动定时任务调度器
    tracing::info!("启动定时任务调度器...");
    let scheduler = std::sync::Arc::new(Scheduler::new(storage.clone()));
    tokio::spawn(async move {
        scheduler.run().await;
    });

    // 启动截图自动清理任务
    tracing::info!("启动截图自动清理任务...");
    let cleanup_storage = storage.clone();
    tokio::spawn(async move {
        run_screenshot_cleanup_loop(cleanup_storage).await;
    });

    // 启动 API 服务器
    let addr = "127.0.0.1:7070";
    tracing::info!("启动 REST API 服务器: http://{}", addr);
    start_server(state, addr).await?;

    Ok(())
}
