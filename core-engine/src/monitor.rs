//! 系统资源监控模块
//!
//! 监控 CPU 和内存使用情况，超过阈值时自动暂停采集。

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use sysinfo::System;
use tokio::time::interval;
use tracing::{info, warn};

const CORE_CPU_ENTER_PERCENT: f64 = 80.0;
const CORE_CPU_RELEASE_PERCENT: f64 = 60.0;
const SYSTEM_CPU_ENTER_PERCENT: f64 = 70.0;
const SYSTEM_CPU_RELEASE_PERCENT: f64 = 55.0;
const WINDOW_SERVER_CPU_ENTER_PERCENT: f64 = 35.0;
const WINDOW_SERVER_CPU_RELEASE_PERCENT: f64 = 25.0;

#[derive(Debug, Default)]
struct SystemPressureInner {
    core_cpu_tenths: AtomicU32,
    system_cpu_tenths: AtomicU32,
    window_server_cpu_tenths: AtomicU32,
    under_pressure: AtomicBool,
}

/// 资源监控器与采集监听器之间共享的轻量压力快照。
///
/// 数值使用 0.1% 定点数存入原子变量，避免在采集热路径上加锁。
#[derive(Debug, Clone, Default)]
pub struct SystemPressureState {
    inner: Arc<SystemPressureInner>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SystemPressureSnapshot {
    pub core_cpu_percent: f64,
    pub system_cpu_percent: f64,
    pub window_server_cpu_percent: f64,
    pub under_pressure: bool,
}

impl SystemPressureState {
    fn encode_percent(value: f64) -> u32 {
        (value.clamp(0.0, 10_000.0) * 10.0).round() as u32
    }

    fn decode_percent(value: u32) -> f64 {
        value as f64 / 10.0
    }

    pub fn update(
        &self,
        core_cpu_percent: f64,
        system_cpu_percent: f64,
        window_server_cpu_percent: f64,
    ) {
        self.inner
            .core_cpu_tenths
            .store(Self::encode_percent(core_cpu_percent), Ordering::Relaxed);
        self.inner
            .system_cpu_tenths
            .store(Self::encode_percent(system_cpu_percent), Ordering::Relaxed);
        self.inner.window_server_cpu_tenths.store(
            Self::encode_percent(window_server_cpu_percent),
            Ordering::Relaxed,
        );

        // 进入与退出使用不同阈值，避免负载在边界附近时频繁启停采集。
        let was_under_pressure = self.inner.under_pressure.load(Ordering::Relaxed);
        let under_pressure = if was_under_pressure {
            core_cpu_percent >= CORE_CPU_RELEASE_PERCENT
                || system_cpu_percent >= SYSTEM_CPU_RELEASE_PERCENT
                || window_server_cpu_percent >= WINDOW_SERVER_CPU_RELEASE_PERCENT
        } else {
            core_cpu_percent >= CORE_CPU_ENTER_PERCENT
                || system_cpu_percent >= SYSTEM_CPU_ENTER_PERCENT
                || window_server_cpu_percent >= WINDOW_SERVER_CPU_ENTER_PERCENT
        };
        self.inner
            .under_pressure
            .store(under_pressure, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> SystemPressureSnapshot {
        SystemPressureSnapshot {
            core_cpu_percent: Self::decode_percent(
                self.inner.core_cpu_tenths.load(Ordering::Relaxed),
            ),
            system_cpu_percent: Self::decode_percent(
                self.inner.system_cpu_tenths.load(Ordering::Relaxed),
            ),
            window_server_cpu_percent: Self::decode_percent(
                self.inner.window_server_cpu_tenths.load(Ordering::Relaxed),
            ),
            under_pressure: self.inner.under_pressure.load(Ordering::Relaxed),
        }
    }
}

/// 资源监控器
pub struct ResourceMonitor {
    /// 提供给采集监听器的系统压力状态。
    pressure: SystemPressureState,
    /// 内存使用阈值（MB）
    memory_threshold: u64,
}

impl ResourceMonitor {
    /// 创建资源监控器
    pub fn new(pressure: SystemPressureState) -> Self {
        Self {
            pressure,
            memory_threshold: 500,
        }
    }

    /// 启动监控循环（每 5 秒检查一次，与前台上下文观察周期对齐）
    pub async fn start(self) {
        let mut sys = System::new_all();
        let mut ticker = interval(Duration::from_secs(5));

        info!("资源监控器已启动");

        loop {
            ticker.tick().await;
            sys.refresh_all();

            // 使用 vm_stat 获取真实内存（包含压缩内存）
            let mem_percent = get_real_memory_usage();

            let mut cpu_process: f64 = 0.0;
            let mut mem_process_mb: u64 = 0;

            if let Ok(pid) = sysinfo::get_current_pid() {
                if let Some(process) = sys.process(pid) {
                    cpu_process = process.cpu_usage() as f64;
                    mem_process_mb = process.memory() / 1024 / 1024;
                }
            }

            // 全局 CPU（所有核平均）
            let cpu_total: f64 = sys.cpus().iter().map(|c| c.cpu_usage() as f64).sum::<f64>()
                / sys.cpus().len().max(1) as f64;
            let window_server_cpu = get_window_server_cpu_usage(&sys);

            self.pressure
                .update(cpu_process, cpu_total, window_server_cpu);
            let pressure = self.pressure.snapshot();
            if pressure.under_pressure {
                warn!(
                    core_cpu = pressure.core_cpu_percent,
                    system_cpu = pressure.system_cpu_percent,
                    window_server_cpu = pressure.window_server_cpu_percent,
                    "系统或 WindowServer 压力偏高，采集监听器将执行退避"
                );
            }

            if mem_process_mb > self.memory_threshold {
                warn!("内存使用过高 ({} MB)，建议清理旧数据", mem_process_mb);
            }

            info!(
                "资源使用: CPU {:.1}%, 内存 {} MB, 系统 CPU {:.1}%, WindowServer CPU {:.1}%, 系统内存 {:.1}%",
                cpu_process, mem_process_mb, cpu_total, window_server_cpu, mem_percent
            );
        }
    }
}

fn get_window_server_cpu_usage(sys: &System) -> f64 {
    let sysinfo_value: f64 = sys
        .processes()
        .values()
        .filter(|process| process.name() == "WindowServer")
        .map(|process| process.cpu_usage() as f64)
        .sum();

    #[cfg(target_os = "macos")]
    {
        // macOS 上普通用户进程的 sysinfo 列表可能不包含系统级 WindowServer。
        // ps 能稳定读取其 CPU；失败时仍回退到 sysinfo 的结果。
        std::process::Command::new("ps")
            .args(["-axo", "%cpu=,comm="])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| parse_window_server_cpu(&String::from_utf8_lossy(&output.stdout)))
            .filter(|value| *value > 0.0)
            .unwrap_or(sysinfo_value)
    }

    #[cfg(not(target_os = "macos"))]
    {
        sysinfo_value
    }
}

#[cfg(target_os = "macos")]
fn parse_window_server_cpu(output: &str) -> f64 {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let cpu = fields.next()?.parse::<f64>().ok()?;
            let command = fields.next()?;
            (command.rsplit('/').next() == Some("WindowServer")).then_some(cpu)
        })
        .sum()
}

/// 获取真实内存使用率（包含压缩内存）
#[cfg(target_os = "macos")]
fn get_real_memory_usage() -> f64 {
    use std::process::Command;

    let output = match Command::new("vm_stat").output() {
        Ok(o) => o,
        Err(_) => return 0.0,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);

    let mut pages_active = 0u64;
    let mut pages_wired = 0u64;
    let mut pages_compressed = 0u64;
    let mut pages_free = 0u64;
    let mut pages_inactive = 0u64;

    for line in stdout.lines() {
        if line.starts_with("Pages active:") {
            pages_active = parse_vm_value(line);
        } else if line.starts_with("Pages wired down:") {
            pages_wired = parse_vm_value(line);
        } else if line.starts_with("Pages stored in compressor:") {
            pages_compressed = parse_vm_value(line);
        } else if line.starts_with("Pages free:") {
            pages_free = parse_vm_value(line);
        } else if line.starts_with("Pages inactive:") {
            pages_inactive = parse_vm_value(line);
        }
    }

    let total = pages_active + pages_wired + pages_free + pages_inactive;
    if total == 0 {
        return 0.0;
    }

    // macOS 内存模型：compressed 是从 inactive 压缩出来的，不应重复计入
    let used = pages_active + pages_wired;
    (used as f64 / total as f64) * 100.0
}

#[cfg(not(target_os = "macos"))]
fn get_real_memory_usage() -> f64 {
    0.0
}

fn parse_vm_value(line: &str) -> u64 {
    line.split(':')
        .nth(1)
        .and_then(|s| s.trim().trim_end_matches('.').parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_pressure_enters_on_window_server_and_uses_hysteresis() {
        let state = SystemPressureState::default();
        state.update(5.0, 20.0, WINDOW_SERVER_CPU_ENTER_PERCENT + 1.0);
        assert!(state.snapshot().under_pressure);

        state.update(5.0, 20.0, WINDOW_SERVER_CPU_RELEASE_PERCENT + 1.0);
        assert!(state.snapshot().under_pressure);

        state.update(5.0, 20.0, WINDOW_SERVER_CPU_RELEASE_PERCENT - 1.0);
        assert!(!state.snapshot().under_pressure);
    }

    #[test]
    fn system_pressure_enters_on_total_cpu() {
        let state = SystemPressureState::default();
        state.update(5.0, SYSTEM_CPU_ENTER_PERCENT + 1.0, 5.0);

        let snapshot = state.snapshot();
        assert!(snapshot.under_pressure);
        assert_eq!(snapshot.system_cpu_percent, SYSTEM_CPU_ENTER_PERCENT + 1.0);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_window_server_cpu_from_ps_output() {
        let output = "  0.0 /sbin/launchd\n 42.7 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer\n";
        assert_eq!(parse_window_server_cpu(output), 42.7);
    }
}
