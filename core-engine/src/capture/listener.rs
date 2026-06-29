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
    Normal,   // < 70%
    High,     // 70-85%
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
            interval_secs: 60, // 默认 60 秒
            enabled: Arc::new(AtomicBool::new(true)),
            idle_threshold_secs: 300, // 5 分钟无操作暂停
        }
    }
}

const MAX_BACKOFF_SECS: u64 = 300;
const LOW_MEMORY_THRESHOLD_MB: u64 = 500;

/// 启动事件监听器（自适应采集策略）
///
/// 三联门禁（任一命中 → 跳过本次 + 下次 tick 间隔翻倍至 300s 上限）：
/// 1. 显示器睡眠（ioreg IODisplayWrangler.CurrentPowerState < 4）
/// 2. 可用内存 < 500MB
/// 3. AX 调用熔断中（连续超时 5 次后的 30s 冷却期）
///
/// 未命中且当前 interval > base 时，按 (current + base) / 2 收敛回 base。
pub async fn start_listener(config: ListenerConfig, tx: mpsc::Sender<CaptureEvent>) {
    info!(
        "启动自适应事件监听器，基础间隔 {}s，回退上限 {}s",
        config.interval_secs, MAX_BACKOFF_SECS
    );

    let base_interval = config.interval_secs.max(1);
    let mut current_interval = base_interval;
    let mut ticker = interval(Duration::from_secs(current_interval));

    loop {
        ticker.tick().await;

        if !config.enabled.load(Ordering::Relaxed) {
            debug!("采集已暂停，等待 5 秒后重试");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        }

        // ── 三联门禁 ──────────────────────────────────────────────────────────
        let asleep = is_display_asleep_async().await;
        let avail_mb = get_available_memory_mb_async().await;
        let mem_blocked = avail_mb
            .map(|mb| mb < LOW_MEMORY_THRESHOLD_MB)
            .unwrap_or(false);
        let ax_tripped = super::ax::is_circuit_breaker_tripped();

        if asleep || mem_blocked || ax_tripped {
            let new_interval = current_interval
                .saturating_mul(2)
                .min(MAX_BACKOFF_SECS)
                .max(base_interval);
            warn!(
                asleep,
                avail_mb = ?avail_mb,
                ax_tripped,
                from = current_interval,
                to = new_interval,
                "门禁命中，跳过本次采集并延长 tick"
            );
            if new_interval != current_interval {
                current_interval = new_interval;
                ticker = interval(Duration::from_secs(current_interval));
                ticker.tick().await; // 消费 ticker 重建后立即触发的首 tick
            }
            continue;
        }

        // ── 决定下一次 tick 间隔 ──────────────────────────────────────────────
        // 门禁未命中时把 ticker 拉回去；同时考虑内存压力等级的 target。
        let pressure = get_memory_pressure_async().await;
        let pressure_target = match pressure {
            MemoryPressure::Normal => base_interval,
            MemoryPressure::High => (base_interval.saturating_mul(3)).min(MAX_BACKOFF_SECS),
            MemoryPressure::Critical => (base_interval.saturating_mul(5)).min(MAX_BACKOFF_SECS),
        };

        // 收敛目标：取压力 target 与 (current+base)/2 的较大者，避免在压力下被收敛压回 base。
        let converged = ((current_interval + base_interval) / 2).max(base_interval);
        let next_interval = pressure_target.max(converged).min(MAX_BACKOFF_SECS);

        if next_interval != current_interval {
            info!(
                pressure = ?pressure,
                from = current_interval,
                to = next_interval,
                "调整 tick 间隔"
            );
            current_interval = next_interval;
            ticker = interval(Duration::from_secs(current_interval));
            ticker.tick().await;
        }

        // 系统空闲时间检测
        if let Ok(idle_secs) = get_system_idle_time_async().await {
            if idle_secs > config.idle_threshold_secs {
                debug!("系统空闲 {} 秒，跳过本次采集", idle_secs);
                continue;
            }
        }

        debug!(
            "触发定时采集事件 (内存压力: {:?}, interval: {}s)",
            pressure, current_interval
        );

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

/// 获取系统内存压力等级（异步版本）
async fn get_memory_pressure_async() -> MemoryPressure {
    tokio::task::spawn_blocking(get_memory_pressure)
        .await
        .unwrap_or(MemoryPressure::Normal)
}

/// 获取系统空闲时间（异步版本）
async fn get_system_idle_time_async() -> Result<u64, ()> {
    tokio::task::spawn_blocking(get_system_idle_time)
        .await
        .map_err(|_| ())?
}

/// 检测显示器是否睡眠（异步版本，1 秒超时）
async fn is_display_asleep_async() -> bool {
    match tokio::time::timeout(
        Duration::from_secs(1),
        tokio::task::spawn_blocking(is_display_asleep),
    )
    .await
    {
        Ok(Ok(v)) => v,
        _ => false, // 超时或 panic 时 fail-open
    }
}

/// 获取可用内存（异步版本，1 秒超时）
async fn get_available_memory_mb_async() -> Option<u64> {
    match tokio::time::timeout(
        Duration::from_secs(1),
        tokio::task::spawn_blocking(get_available_memory_mb),
    )
    .await
    {
        Ok(Ok(Ok(mb))) => Some(mb),
        _ => None,
    }
}

/// 获取系统内存压力等级
#[cfg(target_os = "macos")]
fn get_memory_pressure() -> MemoryPressure {
    use std::process::Command;

    if let Some(pressure) = get_memory_pressure_from_memory_pressure() {
        return pressure;
    }

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
    let mut pages_compressed = 0u64; // 压缩内存
    let mut pages_speculative = 0u64;

    for line in stdout.lines() {
        if line.starts_with("Pages free:") {
            pages_free = parse_vm_stat_value(line);
        } else if line.starts_with("Pages active:") {
            pages_active = parse_vm_stat_value(line);
        } else if line.starts_with("Pages inactive:") {
            pages_inactive = parse_vm_stat_value(line);
        } else if line.starts_with("Pages speculative:") {
            pages_speculative = parse_vm_stat_value(line);
        } else if line.starts_with("Pages wired down:") {
            pages_wired = parse_vm_stat_value(line);
        } else if line.starts_with("Pages occupied by compressor:") {
            // compressor 实际物理占用（已压缩后的 RAM）。
            // 不要用 "Pages stored in compressor:"，那是压缩前的逻辑页数，
            // 在重压力下会高于物理总页数，导致 usage 溢出 100%。
            pages_compressed = parse_vm_stat_value(line);
        }
    }

    // vm_stat 不直接给出物理总页数；compressor 会占用真实物理页，必须进入分母，
    // 否则 used_pages 可能大于 total_pages，导致长期误判为 Critical。
    let total_pages = pages_free
        + pages_speculative
        + pages_active
        + pages_inactive
        + pages_wired
        + pages_compressed;
    if total_pages == 0 {
        return MemoryPressure::Normal;
    }

    let used_pages = pages_active + pages_wired + pages_compressed;
    let usage_percent = (used_pages * 100) / total_pages;

    match usage_percent {
        0..=69 => MemoryPressure::Normal, // < 70%
        70..=84 => MemoryPressure::High,  // 70-85%
        _ => MemoryPressure::Critical,    // >= 85%
    }
}

#[cfg(target_os = "macos")]
fn get_memory_pressure_from_memory_pressure() -> Option<MemoryPressure> {
    use std::process::Command;

    let output = Command::new("memory_pressure").output().ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let free_percent = stdout.lines().find_map(|line| {
        let prefix = "System-wide memory free percentage:";
        let value = line
            .trim()
            .strip_prefix(prefix)?
            .trim()
            .trim_end_matches('%');
        value.parse::<u64>().ok()
    })?;

    match free_percent {
        0..=14 => Some(MemoryPressure::Critical),
        15..=29 => Some(MemoryPressure::High),
        _ => Some(MemoryPressure::Normal),
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
/// macOS: 使用 ioreg 命令（低频调用安全）
/// 其他平台: 返回 Err
#[cfg(target_os = "macos")]
fn get_system_idle_time() -> Result<u64, ()> {
    use std::process::Command;

    // 使用 ioreg 查询 HIDIdleTime（单位：纳秒）
    // 注意：此方法仅在低频调用（>= 60 秒间隔）时安全
    let output = Command::new("ioreg")
        .args(["-c", "IOHIDSystem", "-d", "1"])
        .output()
        .map_err(|_| ())?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    for line in stdout.lines() {
        if line.contains("HIDIdleTime") {
            // 格式: "HIDIdleTime" = 12345678901234
            if let Some(value_str) = line.split('=').nth(1) {
                let value_str = value_str.trim();
                if let Ok(idle_ns) = value_str.parse::<u64>() {
                    return Ok(idle_ns / 1_000_000_000); // 纳秒转秒
                }
            }
        }
    }

    Err(())
}

#[cfg(not(target_os = "macos"))]
fn get_system_idle_time() -> Result<u64, ()> {
    Err(())
}

/// 获取可用内存（MB）
///
/// macOS 上「可用」= free + inactive。inactive 是可被回收且未压缩的页，
/// 内核在压力下会优先复用它们，所以从用户视角应计入"可用"。
#[cfg(target_os = "macos")]
fn get_available_memory_mb() -> Result<u64, ()> {
    use std::process::Command;

    let output = Command::new("vm_stat").output().map_err(|_| ())?;
    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut pages_free = 0u64;
    let mut pages_inactive = 0u64;
    let mut page_size = 4096u64;

    for line in stdout.lines() {
        if line.contains("page size of") {
            if let Some(size_str) = line.split_whitespace().last() {
                page_size = size_str.parse().unwrap_or(4096);
            }
        } else if line.starts_with("Pages free:") {
            pages_free = parse_vm_stat_value(line);
        } else if line.starts_with("Pages inactive:") {
            pages_inactive = parse_vm_stat_value(line);
        }
    }

    Ok(((pages_free + pages_inactive) * page_size) / (1024 * 1024))
}

#[cfg(not(target_os = "macos"))]
fn get_available_memory_mb() -> Result<u64, ()> {
    Err(())
}

/// 检测显示器是否处于睡眠/关闭状态。
///
/// macOS：通过 ioreg 查询 IODisplayWrangler 的 IOPowerManagement.CurrentPowerState：
/// - 4 = 亮屏；< 4 = 已变暗或关闭
///
/// 失败时返回 false（fail-open，避免误屏蔽采集）。
#[cfg(target_os = "macos")]
fn is_display_asleep() -> bool {
    use std::process::Command;

    let output = match Command::new("ioreg")
        .args([
            "-r",
            "-k",
            "IOPowerManagement",
            "-n",
            "IODisplayWrangler",
            "-d",
            "1",
        ])
        .output()
    {
        Ok(o) => o,
        Err(_) => return false,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        // 形如:  | "IOPowerManagement" = {"CurrentPowerState"=4,...}
        if let Some(idx) = line.find("CurrentPowerState") {
            let tail = &line[idx..];
            if let Some(eq_idx) = tail.find('=') {
                let after = &tail[eq_idx + 1..];
                let num: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(state) = num.parse::<u32>() {
                    return state < 4;
                }
            }
        }
    }
    false
}

#[cfg(not(target_os = "macos"))]
fn is_display_asleep() -> bool {
    false
}
