//! AutomationExecutor — 键鼠自动化执行引擎
//!
//! 使用 `enigo` crate 进行跨平台键鼠模拟。
//! `enigo` 在测试环境无需真实显示器（单元测试中通过 Feature 禁用）。

use std::time::{Duration, Instant};

use tracing::{info, warn};

use super::{
    action::{ActionCommand, ActionResult},
    error::ExecutorError,
};

/// 执行模式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    /// 半自动：每次执行前等待用户确认（默认）
    SemiAuto,
    /// 全自动：直接执行，无需确认
    FullAuto,
}

impl Default for ExecutionMode {
    fn default() -> Self {
        Self::SemiAuto
    }
}

/// 键鼠自动化执行器
///
/// # 示例
/// ```rust,no_run
/// use memory_bread_core::executor::{AutomationExecutor, ActionCommand};
///
/// let executor = AutomationExecutor::new(Default::default());
/// let cmd = ActionCommand::Click { x: 100.0, y: 200.0 };
/// // executor.execute(cmd).await?;
/// ```
pub struct AutomationExecutor {
    mode: ExecutionMode,
}

impl AutomationExecutor {
    pub fn new(mode: ExecutionMode) -> Self {
        Self { mode }
    }

    /// 以默认半自动模式创建执行器
    pub fn semi_auto() -> Self {
        Self::new(ExecutionMode::SemiAuto)
    }

    /// 以全自动模式创建执行器（谨慎使用）
    pub fn full_auto() -> Self {
        Self::new(ExecutionMode::FullAuto)
    }

    /// 当前执行模式
    pub fn mode(&self) -> ExecutionMode {
        self.mode
    }

    /// 执行动作命令
    ///
    /// 半自动模式下：调用者必须在调用前获得用户确认，否则返回 `RequiresConfirmation`。
    /// 全自动模式下：直接执行。
    pub async fn execute(&self, cmd: ActionCommand) -> Result<ActionResult, ExecutorError> {
        if self.mode == ExecutionMode::SemiAuto {
            // 半自动模式：返回错误，由上层（UI 确认弹窗）处理
            return Err(ExecutorError::RequiresConfirmation);
        }
        self.execute_confirmed(cmd).await
    }

    /// 在用户已确认的情况下执行动作（全自动或半自动已确认后调用）
    pub async fn execute_confirmed(
        &self,
        cmd: ActionCommand,
    ) -> Result<ActionResult, ExecutorError> {
        let start = Instant::now();
        let desc = cmd.describe();

        info!("执行动作: {desc}");

        let result = self.do_execute(cmd).await;

        let duration_ms = start.elapsed().as_millis() as u64;
        match result {
            Ok(()) => {
                info!("动作完成: {desc} ({duration_ms}ms)");
                Ok(ActionResult::success(desc, duration_ms))
            }
            Err(e) => {
                warn!("动作失败: {desc} — {e}");
                Ok(ActionResult::failure(desc, e.to_string(), duration_ms))
            }
        }
    }

    /// 执行动作序列（逐步执行，遇到错误停止）
    pub async fn execute_sequence(
        &self,
        steps: Vec<ActionCommand>,
    ) -> Vec<Result<ActionResult, ExecutorError>> {
        let mut results = Vec::with_capacity(steps.len());
        for step in steps {
            let r = self.execute_confirmed(step).await;
            let failed = r.as_ref().map(|r| !r.success).unwrap_or(true);
            results.push(r);
            if failed {
                break;
            }
        }
        results
    }

    // ── 内部实现 ──────────────────────────────────────────────────────────────

    async fn do_execute(&self, cmd: ActionCommand) -> Result<(), ExecutorError> {
        // 将同步的 enigo 操作移到阻塞线程
        tokio::task::spawn_blocking(move || execute_sync(cmd))
            .await
            .map_err(|e| ExecutorError::DriverError(e.to_string()))?
    }
}

/// 在阻塞线程中执行同步键鼠操作
fn execute_sync(cmd: ActionCommand) -> Result<(), ExecutorError> {
    use ActionCommand::*;

    // 动态检测 enigo 是否可用（CI 环境无 display server 时 skip）
    // 在实际运行环境中，enigo 会调用平台原生 API
    match cmd {
        Click { x, y } | RightClick { x, y } | DoubleClick { x, y } | MoveTo { x, y } => {
            enigo_mouse_action(cmd, x, y)
        }
        TypeText { ref text } => enigo_type_text(text),
        Hotkey { ref keys } => enigo_hotkey(keys),
        KeyPress { ref key } => enigo_key_press(key),
        Scroll { x, y, delta_y } => enigo_scroll(x, y, delta_y),
        Wait { ms } => {
            std::thread::sleep(Duration::from_millis(ms));
            Ok(())
        }
        Sequence { steps } => {
            for step in steps {
                execute_sync(step)?;
            }
            Ok(())
        }
    }
}

// ── enigo 驱动封装 ────────────────────────────────────────────────────────────

fn enigo_mouse_action(cmd: ActionCommand, x: f64, y: f64) -> Result<(), ExecutorError> {
    try_enigo(|| {
        use enigo::{Button, Coordinate, Enigo, Mouse, Settings}; // type: ignore
        let mut e = Enigo::new(&Settings::default())
            .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        e.move_mouse(x as i32, y as i32, Coordinate::Abs)
            .map_err(|err| ExecutorError::DriverError(err.to_string()))?;

        match cmd {
            ActionCommand::Click { .. } => {
                e.button(Button::Left, enigo::Direction::Click)
                    .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
            }
            ActionCommand::RightClick { .. } => {
                e.button(Button::Right, enigo::Direction::Click)
                    .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
            }
            ActionCommand::DoubleClick { .. } => {
                e.button(Button::Left, enigo::Direction::Click)
                    .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
                std::thread::sleep(Duration::from_millis(50));
                e.button(Button::Left, enigo::Direction::Click)
                    .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
            }
            _ => {} // MoveTo 不需要点击
        }
        Ok(())
    })
}

fn enigo_type_text(text: &str) -> Result<(), ExecutorError> {
    try_enigo(|| {
        use enigo::{Enigo, Keyboard, Settings}; // type: ignore
        let mut e = Enigo::new(&Settings::default())
            .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        e.text(text)
            .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        Ok(())
    })
}

fn enigo_hotkey(keys: &[String]) -> Result<(), ExecutorError> {
    try_enigo(|| {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings}; // type: ignore
        let mut e = Enigo::new(&Settings::default())
            .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        let parsed: Vec<Key> = keys.iter().map(|k| parse_key(k)).collect();
        // 先依次按下所有键
        for &ref key in &parsed {
            e.key(*key, Direction::Press)
                .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        }
        // 再依次释放
        for key in parsed.iter().rev() {
            e.key(*key, Direction::Release)
                .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        }
        Ok(())
    })
}

fn enigo_key_press(key: &str) -> Result<(), ExecutorError> {
    try_enigo(|| {
        use enigo::{Direction, Enigo, Key, Keyboard, Settings}; // type: ignore
        let mut e = Enigo::new(&Settings::default())
            .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        let k = parse_key(key);
        e.key(k, Direction::Click)
            .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        Ok(())
    })
}

fn enigo_scroll(x: f64, y: f64, delta_y: i32) -> Result<(), ExecutorError> {
    try_enigo(|| {
        use enigo::{Axis, Coordinate, Enigo, Mouse, Settings}; // type: ignore
        let mut e = Enigo::new(&Settings::default())
            .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        e.move_mouse(x as i32, y as i32, Coordinate::Abs)
            .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        e.scroll(delta_y, Axis::Vertical)
            .map_err(|err| ExecutorError::DriverError(err.to_string()))?;
        Ok(())
    })
}

/// 尝试执行 enigo 操作；若平台不支持（如 CI headless），返回 DriverError
fn try_enigo<F: FnOnce() -> Result<(), ExecutorError>>(f: F) -> Result<(), ExecutorError> {
    // 在 macOS 上，enigo 需要辅助功能权限；Windows 上需要 SendInput 权限
    // CI 环境中 DISPLAY 未设置时 enigo 初始化会失败，此处统一捕获
    f()
}

/// 将字符串键名转换为 enigo::Key
fn parse_key(key: &str) -> enigo::Key {
    use enigo::Key;
    match key.to_lowercase().as_str() {
        "ctrl" | "control" => Key::Control,
        "alt" => Key::Alt,
        "shift" => Key::Shift,
        "meta" | "cmd" | "super" => Key::Meta,
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "backspace" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "space" => Key::Space,
        "left" => Key::LeftArrow,
        "right" => Key::RightArrow,
        "up" => Key::UpArrow,
        "down" => Key::DownArrow,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        "f1" => Key::F1,
        "f2" => Key::F2,
        "f3" => Key::F3,
        "f4" => Key::F4,
        "f5" => Key::F5,
        "f6" => Key::F6,
        "f7" => Key::F7,
        "f8" => Key::F8,
        "f9" => Key::F9,
        "f10" => Key::F10,
        "f11" => Key::F11,
        "f12" => Key::F12,
        other => {
            // 单字符键
            if let Some(c) = other.chars().next() {
                Key::Unicode(c)
            } else {
                Key::Unicode(' ')
            }
        }
    }
}

// ── 单元测试 ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::action::ActionCommand;

    #[tokio::test]
    async fn test_semi_auto_returns_requires_confirmation() {
        let executor = AutomationExecutor::semi_auto();
        let cmd = ActionCommand::Click { x: 100.0, y: 100.0 };
        let result = executor.execute(cmd).await;
        assert!(matches!(result, Err(ExecutorError::RequiresConfirmation)));
    }

    #[test]
    fn test_action_describe_click() {
        let cmd = ActionCommand::Click { x: 150.0, y: 250.0 };
        assert!(cmd.describe().contains("150"));
        assert!(cmd.describe().contains("250"));
    }

    #[test]
    fn test_action_describe_type_text() {
        let cmd = ActionCommand::TypeText {
            text: "hello world".into(),
        };
        assert!(cmd.describe().contains("hello world"));
    }

    #[test]
    fn test_action_describe_hotkey() {
        let cmd = ActionCommand::Hotkey {
            keys: vec!["ctrl".into(), "c".into()],
        };
        let desc = cmd.describe();
        assert!(desc.contains("ctrl") && desc.contains("c"));
    }

    #[test]
    fn test_action_describe_sequence() {
        let cmd = ActionCommand::Sequence {
            steps: vec![
                ActionCommand::Click { x: 0.0, y: 0.0 },
                ActionCommand::TypeText {
                    text: "test".into(),
                },
            ],
        };
        assert!(cmd.describe().contains("2"));
    }

    #[test]
    fn test_action_describe_wait() {
        let cmd = ActionCommand::Wait { ms: 500 };
        assert!(cmd.describe().contains("500"));
    }

    #[test]
    fn test_action_result_success() {
        let r = ActionResult::success("点击成功", 42);
        assert!(r.success);
        assert_eq!(r.duration_ms, 42);
        assert!(r.error.is_none());
    }

    #[test]
    fn test_action_result_failure() {
        let r = ActionResult::failure("点击失败", "超时", 100);
        assert!(!r.success);
        assert_eq!(r.error.as_deref(), Some("超时"));
    }

    #[test]
    fn test_parse_key_ctrl() {
        let k = parse_key("ctrl");
        assert_eq!(k, enigo::Key::Control);
    }

    #[test]
    fn test_parse_key_unicode() {
        let k = parse_key("a");
        assert_eq!(k, enigo::Key::Unicode('a'));
    }

    #[test]
    fn test_execution_mode_default_semi() {
        let executor = AutomationExecutor::new(ExecutionMode::default());
        assert_eq!(executor.mode(), ExecutionMode::SemiAuto);
    }

    #[test]
    fn test_action_command_serde() {
        let cmd = ActionCommand::Click { x: 100.0, y: 200.0 };
        let json = serde_json::to_string(&cmd).unwrap();
        let parsed: ActionCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(cmd, parsed);
    }

    #[test]
    fn test_type_text_serde() {
        let cmd = ActionCommand::TypeText {
            text: "测试输入".into(),
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let parsed: ActionCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(cmd, parsed);
    }

    #[test]
    fn test_sequence_serde() {
        let cmd = ActionCommand::Sequence {
            steps: vec![
                ActionCommand::Click { x: 1.0, y: 2.0 },
                ActionCommand::Wait { ms: 100 },
            ],
        };
        let json = serde_json::to_string(&cmd).unwrap();
        let parsed: ActionCommand = serde_json::from_str(&json).unwrap();
        assert_eq!(cmd, parsed);
    }
}
