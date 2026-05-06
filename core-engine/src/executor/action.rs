//! 动作命令定义与结果类型

use serde::{Deserialize, Serialize};

/// 可执行的动作命令类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ActionCommand {
    /// 鼠标点击（左键）
    Click { x: f64, y: f64 },
    /// 鼠标右键点击
    RightClick { x: f64, y: f64 },
    /// 双击
    DoubleClick { x: f64, y: f64 },
    /// 鼠标移动（不点击）
    MoveTo { x: f64, y: f64 },
    /// 输入文本（在当前焦点元素）
    TypeText { text: String },
    /// 按下组合键（如 ["ctrl", "c"]）
    Hotkey { keys: Vec<String> },
    /// 键盘按键（单键）
    KeyPress { key: String },
    /// 滚动
    Scroll {
        x: f64,
        y: f64,
        /// 正数向上，负数向下
        delta_y: i32,
    },
    /// 等待（毫秒）
    Wait { ms: u64 },
    /// 顺序执行多个动作（宏）
    Sequence { steps: Vec<ActionCommand> },
}

/// 动作执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionResult {
    /// 是否执行成功
    pub success: bool,
    /// 动作描述（人类可读）
    pub description: String,
    /// 实际执行时长（毫秒）
    pub duration_ms: u64,
    /// 错误信息（失败时）
    pub error: Option<String>,
}

impl ActionResult {
    pub fn success(description: impl Into<String>, duration_ms: u64) -> Self {
        Self {
            success: true,
            description: description.into(),
            duration_ms,
            error: None,
        }
    }

    pub fn failure(
        description: impl Into<String>,
        error: impl Into<String>,
        duration_ms: u64,
    ) -> Self {
        Self {
            success: false,
            description: description.into(),
            duration_ms,
            error: Some(error.into()),
        }
    }
}

impl ActionCommand {
    /// 返回人类可读的动作描述
    pub fn describe(&self) -> String {
        match self {
            ActionCommand::Click { x, y } => format!("左键单击 ({x:.0}, {y:.0})"),
            ActionCommand::RightClick { x, y } => format!("右键点击 ({x:.0}, {y:.0})"),
            ActionCommand::DoubleClick { x, y } => format!("双击 ({x:.0}, {y:.0})"),
            ActionCommand::MoveTo { x, y } => format!("移动鼠标到 ({x:.0}, {y:.0})"),
            ActionCommand::TypeText { text } => {
                format!("输入文字: \"{}\"", &text[..text.len().min(20)])
            }
            ActionCommand::Hotkey { keys } => format!("快捷键: {}", keys.join("+")),
            ActionCommand::KeyPress { key } => format!("按键: {key}"),
            ActionCommand::Scroll { x, y, delta_y } => {
                format!("滚动 ({x:.0}, {y:.0}) delta={delta_y}")
            }
            ActionCommand::Wait { ms } => format!("等待 {ms}ms"),
            ActionCommand::Sequence { steps } => format!("序列 ({} 步)", steps.len()),
        }
    }
}
