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

/// 内存压力等级
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MemoryPressure {
    Normal,  // < 70%
    High,    // 70-85%
    Critical, // > 85%
}

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
            interval_secs: 60, // 默认 60 秒，根据内存压力动态调整
            enabled: Arc::new(AtomicBool::new(true)),
            idle_threshold_secs: 300, // 5 分钟无操作暂停
        }
    }
}

/// 启动事件监听器（自适应采集策略）
///
/// 根据系统内存压力动态调整采集间隔：
/// - 正常 (< 70%): 60 秒
/// - 高压 (70-85%): 180 秒
/// - 危险 (> 85%): 300 秒
pub async fn start_listener(config: ListenerConfig, tx: mpsc::Sender<CaptureEvent>) {
    info!(
        "启动自适应事件监听器，基础间隔: {} 秒",
        config.interval_secs
    );

    let base_interval = config.interval_secs;
    let mut current_interval = base_interval;
    let mut ticker = interval(Duration::from_secs(current_interval));

    loop {
        ticker.tick().await;

        // 检查是否启用
        if !config.enabled.load(Ordering::Relaxed) {
            debug!("采集已暂停，等待 5 秒后重试");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }

        // 动态调整采集间隔
        let pressure = get_memory_pressure();
        let new_interval = match pressure {
            MemoryPressure::Normal => base_interval,
            MemoryPressure::High => base_interval * 3,
            MemoryPressure::Critical => base_interval * 5,
        };

        if new_interval != current_interval {
            info!(
                "内存压力 {:?}，调整采集间隔: {} → {} 秒",
                pressure, current_interval, new_interval
            );
            current_interval = new_interval;
            ticker = interval(Duration::from_secs(current_interval));
            ticker.tick().await; // 消费初始 tick
            continue;
        }

        // 检查系统空闲时间
        if let Ok(idle_secs) = get_system_idle_time() {
            if idle_secs > config.idle_threshold_secs {
                debug!("系统空闲 {} 秒，跳过本次采集", idle_secs);
                continue;
            }
        }

        // 危险内存压力下跳过采集
        if pressure == MemoryPressure::Critical {
            warn!("内存压力危险 (> 85%)，跳过本次采集");
            continue;
        }

        debug!("触发定时采集事件 (内存压力: {:?})", pressure);

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

/// 获取系统内存压力等级
#[cfg(target_os = "macos")]
fn get_memory_pressure() -> MemoryPressure {
    use std::process::Command;

    let output = match Command::new("vm_stat").output() {
        Ok(o) => o,
        Err(_) => return MemoryPressure::Normal,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    // 解析 vm_stat 输出
    let mut pages_free = 0u64;
    let mut pages_active = 0u64;
    let mut pages_inactive = 0u64;
    let mut pages_wired = 0u64;
    let mut page_size = 4096u64;

    for line in stdout.lines() {
        if line.contains("page size of") {
            if let Some(size_str) = line.split_whitespace().last() {
                page_size = size_str.parse().unwrap_or(4096);
            }
        } else if line.starts_with("Pages free:") {
            pages_free = parse_vm_stat_value(line);
        } else if line.starts_with("Pages active:") {
            pages_active = parse_vm_stat_value(line);
        } else if line.starts_with("Pages inactive:") {
            pages_inactive = parse_vm_stat_value(line);
        } else if line.starts_with("Pages wired down:") {
            pages_wired = parse_vm_stat_value(line);
        }
    }

    let total_pages = pages_free + pages_active + pages_inactive + pages_wired;
    if total_pages == 0 {
        return MemoryPressure::Normal;
    }

    let used_pages = pages_active + pages_wired;
    let usage_percent = (used_pages * 100) / total_pages;

    match usage_percent {
        0..=69 => MemoryPressure::Normal,
        70..=84 => MemoryPressure::High,
        _ => MemoryPressure::Critical,
    }
}

#[cfg(target_os = "macos")]
fn parse_vm_stat_value(line: &str) -> u64 {
    line.split(':')
        .nth(1)
        .and_then(|s| s.trim().trim_end_matches('.').parse().ok())
        .unwrap_or(0)
}

#[cfg(not(target_os = "macos"))]
fn get_memory_pressure() -> MemoryPressure {
    MemoryPressure::Normal
}

/// 获取系统空闲时间（秒）
///
/// macOS: 禁用 ioreg 调用（可能导致系统不稳定），始终返回 0
/// 其他平台: 返回 Err
#[cfg(target_os = "macos")]
fn get_system_idle_time() -> Result<u64, ()> {
    // FIXME: ioreg 高频调用会导致 IOHIDSystem 驱动负载过高，可能触发系统死机
    // 临时禁用空闲检测，后续改用 CGEventSource API
    Ok(0)
}

#[cfg(not(target_os = "macos"))]
fn get_system_idle_time() -> Result<u64, ()> {
    Err(())
}
