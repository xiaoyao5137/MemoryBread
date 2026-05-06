//! 事件监听器 — 定时触发采集
//!
//! 这是一个简化版本，使用定时器定期触发采集。
//! 未来可以扩展为监听真实的系统事件（应用切换、鼠标点击等）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::interval;
use tracing::{debug, info, warn};

use super::CaptureEvent;

/// 事件监听器配置
#[derive(Debug, Clone)]
pub struct ListenerConfig {
    /// 定时采集间隔（秒）
    pub interval_secs: u64,
    /// 运行时开关（可被外部控制）
    pub enabled: Arc<AtomicBool>,
    /// 空闲阈值（秒），超过此时间无操作则暂停采集
    pub idle_threshold_secs: u64,
}

impl Default for ListenerConfig {
    fn default() -> Self {
        Self {
            interval_secs: 60, // 改为 60 秒（降低频率）
            enabled: Arc::new(AtomicBool::new(true)),
            idle_threshold_secs: 300, // 5 分钟无操作暂停
        }
    }
}

/// 启动事件监听器
///
/// 定期向 `tx` 发送 `CaptureEvent::Periodic` 事件
pub async fn start_listener(config: ListenerConfig, tx: mpsc::Sender<CaptureEvent>) {
    info!(
        "启动事件监听器，采集间隔: {} 秒，空闲阈值: {} 秒",
        config.interval_secs, config.idle_threshold_secs
    );

    let mut ticker = interval(Duration::from_secs(config.interval_secs));

    loop {
        ticker.tick().await;

        // 检查是否启用
        if !config.enabled.load(Ordering::Relaxed) {
            debug!("采集已暂停，等待 5 秒后重试");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }

        // 检查系统空闲时间
        if let Ok(idle_secs) = get_system_idle_time() {
            if idle_secs > config.idle_threshold_secs {
                debug!("系统空闲 {} 秒，跳过本次采集", idle_secs);
                continue;
            }
        }

        debug!("触发定时采集事件");

        // 发送采集事件（带超时保护）
        match tokio::time::timeout(Duration::from_secs(5), tx.send(CaptureEvent::Periodic)).await {
            Ok(Ok(_)) => {}
            Ok(Err(_)) => {
                info!("采集引擎已关闭，停止监听器");
                break;
            }
            Err(_) => {
                warn!("发送采集事件超时（5 秒），跳过本次");
            }
        }
    }
}

/// 获取系统空闲时间（秒）
///
/// macOS: 使用 ioreg 查询 HIDIdleTime
/// 其他平台: 返回 Err
#[cfg(target_os = "macos")]
fn get_system_idle_time() -> Result<u64, ()> {
    use std::process::Command;

    let output = Command::new("ioreg")
        .args(&["-c", "IOHIDSystem"])
        .output()
        .map_err(|_| ())?;

    if !output.status.success() {
        return Err(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("HIDIdleTime") {
            if let Some(ns_str) = line.split('=').nth(1) {
                let ns: u64 = ns_str.trim().parse().map_err(|_| ())?;
                return Ok(ns / 1_000_000_000); // 纳秒转秒
            }
        }
    }
    Err(())
}

#[cfg(not(target_os = "macos"))]
fn get_system_idle_time() -> Result<u64, ()> {
    Err(())
}
