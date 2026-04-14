//! Accessibility Tree 信息抓取
//!
//! macOS：通过 `osascript` 调用 System Events 获取前台应用名 / 窗口标题。
//! 未来可升级为直接调用 AXUIElement API（需要 Accessibility 权限）。
//!
//! 其他平台：返回 None，由调用方降级到 OCR。

const EXTRACTED_TEXT_MAX_CHARS: usize = 5_000;
const GENERIC_FOCUS_MIN_CHARS: usize = 24;
const GENERIC_WINDOW_MIN_CHARS: usize = 48;
const GENERIC_STATIC_ITEM_LIMIT: usize = 80;
const GENERIC_ALL_UI_ITEM_LIMIT: usize = 140;

/// 从 Accessibility Tree 抓取到的前台应用信息
#[derive(Debug, Clone, Default)]
pub struct AXInfo {
    /// 前台应用名称，如 "Feishu"
    pub app_name:       Option<String>,
    /// macOS Bundle ID，如 "com.feishu.feishu"
    pub app_bundle_id:  Option<String>,
    /// 窗口标题
    pub win_title:      Option<String>,
    /// 当前焦点元素的 AX Role，如 "AXTextField"（用于密码框检测）
    pub focused_role:   Option<String>,
    /// 当前焦点元素的标识符（用于执行器精确定位）
    pub focused_id:     Option<String>,
    /// 从 AX Tree 提取的文本内容（最优路径，失败则降级 OCR）
    pub extracted_text: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextExtractor {
    Generic,
    Chrome,
    Safari,
    WeChat,
}

impl TextExtractor {
    fn as_str(self) -> &'static str {
        match self {
            Self::Generic => "generic",
            Self::Chrome => "chrome",
            Self::Safari => "safari",
            Self::WeChat => "wechat",
        }
    }
}

#[derive(Debug, Clone)]
struct ExtractedText {
    source: TextExtractor,
    text:   String,
}

fn fallback_extractor_for_context(
    bundle_id: Option<&str>,
    app_name: Option<&str>,
) -> Option<TextExtractor> {
    match bundle_id {
        Some("com.google.Chrome") | Some("com.google.Chrome.canary") => {
            return Some(TextExtractor::Chrome)
        }
        Some("com.apple.Safari") => return Some(TextExtractor::Safari),
        Some("com.tencent.xinWeChat") => return Some(TextExtractor::WeChat),
        _ => {}
    }

    match app_name {
        Some("Google Chrome") | Some("Google Chrome Canary") => Some(TextExtractor::Chrome),
        Some("Safari") => Some(TextExtractor::Safari),
        Some("WeChat") | Some("微信") => Some(TextExtractor::WeChat),
        _ => None,
    }
}

fn parse_keyed_quoted_value(raw: &str, key: &str) -> Option<String> {
    raw.lines().find_map(|line| {
        let line = line.trim();
        let prefix = format!("\"{key}\"=\"");
        line.strip_prefix(&prefix)
            .and_then(|value| value.strip_suffix('"'))
            .map(ToString::to_string)
            .filter(|value| !value.is_empty())
    })
}

fn normalize_whitespace(raw: &str) -> String {
    raw.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn normalize_for_comparison(raw: &str) -> String {
    normalize_whitespace(raw).to_lowercase()
}

fn is_code_symbol(ch: char) -> bool {
    matches!(
        ch,
        '{'
            | '}'
            | '('
            | ')'
            | '['
            | ']'
            | '<'
            | '>'
            | '.'
            | ','
            | ';'
            | ':'
            | '_'
            | '-'
            | '='
            | '+'
            | '*'
            | '/'
            | '\\'
            | '|'
            | '&'
            | '!'
            | '?'
            | '#'
            | '@'
            | '$'
            | '%'
            | '^'
            | '~'
            | '`'
            | '"'
            | '\''
    )
}

fn sanitize_extracted_text(raw: &str, win_title: Option<&str>) -> Option<String> {
    let normalized = normalize_whitespace(raw);
    if normalized.is_empty() {
        return None;
    }

    let char_count = normalized.chars().count();
    if char_count < 12 {
        return None;
    }

    let non_whitespace_count = normalized.chars().filter(|ch| !ch.is_whitespace()).count();
    if non_whitespace_count == 0 {
        return None;
    }

    let meaningful_count = normalized
        .chars()
        .filter(|ch| !ch.is_whitespace() && (ch.is_alphanumeric() || is_code_symbol(*ch)))
        .count();
    if (meaningful_count as f32 / non_whitespace_count as f32) < 0.55 {
        return None;
    }

    let normalized_cmp = normalize_for_comparison(&normalized);
    if let Some(title) = win_title {
        let title_cmp = normalize_for_comparison(title);
        if !title_cmp.is_empty() {
            if normalized_cmp == title_cmp {
                return None;
            }

            if let Some(remaining) = normalized_cmp.strip_prefix(&title_cmp) {
                if remaining.trim().chars().count() < 8 {
                    return None;
                }
            }
        }
    }

    let tokens: Vec<&str> = normalized.split_whitespace().collect();
    if !tokens.is_empty() {
        let short_token_count = tokens.iter().filter(|token| token.chars().count() <= 4).count();
        if tokens.len() <= 6 && short_token_count == tokens.len() && char_count < 24 {
            return None;
        }
    }

    Some(normalized)
}

/// 获取当前前台应用的 AX 信息（同步版本，已废弃）。
///
/// 失败（无权限 / AX 不支持 / 超时）时返回 None，由调用方降级到 OCR。
#[deprecated(note = "使用 get_frontmost_info_async 替代")]
pub fn get_frontmost_info() -> Option<AXInfo> {
    #[cfg(all(target_os = "macos", not(test)))]
    {
        macos_impl::get_frontmost_info_macos()
    }
    #[cfg(any(not(target_os = "macos"), test))]
    {
        None
    }
}

/// 异步获取当前前台应用的 AX 信息（带超时保护）。
///
/// 使用 spawn_blocking 避免阻塞 tokio 运行时，基础上下文与文本提取分阶段超时。
pub async fn get_frontmost_info_async() -> Option<AXInfo> {
    #[cfg(all(target_os = "macos", not(test)))]
    {
        use std::time::Duration;
        use tracing::{debug, warn};

        let basic_task = tokio::task::spawn_blocking(macos_impl::get_frontmost_basic_info_macos);
        let mut info = match tokio::time::timeout(Duration::from_millis(4000), basic_task).await {
            Ok(Ok(Some(info))) => {
                debug!(
                    app = ?info.app_name,
                    bundle_id = ?info.app_bundle_id,
                    win_title = ?info.win_title,
                    "AX 基础上下文获取成功"
                );
                info
            }
            Ok(Ok(None)) => {
                warn!("AX 基础上下文获取失败");
                return None;
            }
            Ok(Err(e)) => {
                warn!("AX 基础上下文任务失败: {}", e);
                return None;
            }
            Err(_) => {
                warn!("AX 基础上下文获取超时（4000ms）");
                return None;
            }
        };

        let app_name = info.app_name.clone();
        let bundle_id = info.app_bundle_id.clone();
        let win_title = info.win_title.clone();
        let fallback = fallback_extractor_for_context(bundle_id.as_deref(), app_name.as_deref());
        debug!(
            app = ?app_name,
            bundle_id = ?bundle_id,
            fallback = fallback.map(|extractor| extractor.as_str()),
            "AX 文本提取策略已确定：generic-first"
        );

        let text_task = tokio::task::spawn_blocking(move || {
            macos_impl::extract_ax_text_for_context(
                app_name.as_deref(),
                bundle_id.as_deref(),
                win_title.as_deref(),
            )
        });

        match tokio::time::timeout(Duration::from_millis(1200), text_task).await {
            Ok(Ok(Some(result))) => {
                debug!(
                    source = result.source.as_str(),
                    text_len = result.text.len(),
                    "AX 文本提取成功"
                );
                info.extracted_text = Some(result.text);
            }
            Ok(Ok(None)) => {
                debug!("AX 文本提取为空或未通过质量门槛，等待 OCR 兜底");
            }
            Ok(Err(e)) => {
                warn!("AX 文本提取任务失败: {}", e);
            }
            Err(_) => {
                warn!("AX 文本提取超时（1200ms）");
            }
        }

        Some(info)
    }
    #[cfg(any(not(target_os = "macos"), test))]
    {
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// macOS 实现
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(all(target_os = "macos", not(test)))]
mod macos_impl {
    use super::{
        fallback_extractor_for_context,
        parse_keyed_quoted_value,
        sanitize_extracted_text,
        AXInfo,
        ExtractedText,
        TextExtractor,
        EXTRACTED_TEXT_MAX_CHARS,
        GENERIC_ALL_UI_ITEM_LIMIT,
        GENERIC_FOCUS_MIN_CHARS,
        GENERIC_STATIC_ITEM_LIMIT,
        GENERIC_WINDOW_MIN_CHARS,
    };
    use std::{
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };
    use tracing::{debug, warn};

    fn run_osascript(script: &str, stage: &str) -> Result<String, String> {
        let output = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map_err(|e| format!("启动 osascript 失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let status = output.status.code().map_or_else(|| "signal".to_string(), |c| c.to_string());
            return Err(format!("stage={stage} exit={status} stderr={stderr}"));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn run_osascript_with_timeout(
        script: &str,
        stage: &str,
        timeout: Duration,
    ) -> Result<String, String> {
        let mut child = Command::new("osascript")
            .arg("-e")
            .arg(script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("启动 osascript 失败: {e}"))?;

        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => {
                    let output = child
                        .wait_with_output()
                        .map_err(|e| format!("等待 osascript 输出失败: {e}"))?;
                    if !output.status.success() {
                        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                        let status = output.status.code().map_or_else(|| "signal".to_string(), |c| c.to_string());
                        return Err(format!("stage={stage} exit={status} stderr={stderr}"));
                    }
                    return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
                }
                Ok(None) => {
                    if start.elapsed() >= timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!("stage={stage} timeout={}ms", timeout.as_millis()));
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(format!("stage={stage} try_wait_failed: {e}")),
            }
        }
    }

    fn run_lsappinfo(args: &[&str], stage: &str) -> Result<String, String> {
        let output = Command::new("lsappinfo")
            .args(args)
            .output()
            .map_err(|e| format!("启动 lsappinfo 失败: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let status = output.status.code().map_or_else(|| "signal".to_string(), |c| c.to_string());
            return Err(format!("stage={stage} exit={status} stderr={stderr}"));
        }

        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    pub fn get_frontmost_info_macos() -> Option<AXInfo> {
        let mut info = get_frontmost_basic_info_macos()?;
        let app_name = info.app_name.clone();
        let app_bundle_id = info.app_bundle_id.clone();
        let win_title = info.win_title.clone();
        info.extracted_text = extract_ax_text_for_context(
            app_name.as_deref(),
            app_bundle_id.as_deref(),
            win_title.as_deref(),
        )
        .map(|result| result.text);
        Some(info)
    }

    pub fn get_frontmost_basic_info_macos() -> Option<AXInfo> {
        let front = match run_lsappinfo(&["front"], "front_context") {
            Ok(raw) => raw,
            Err(err) => {
                warn!("AX front app 查询失败: {}", err);
                return None;
            }
        };

        let asn = front.trim();
        if asn.is_empty() {
            warn!(raw = %front, "AX front app 查询未返回 ASN");
            return None;
        }

        let info_raw =
            match run_lsappinfo(&["info", "-only", "bundleID", "-only", "name", asn], "front_context_info") {
                Ok(raw) => raw,
                Err(err) => {
                    warn!(asn = %asn, "AX front app 信息查询失败: {}", err);
                    return None;
                }
            };

        let app_name = parse_keyed_quoted_value(&info_raw, "LSDisplayName");
        let app_bundle_id = parse_keyed_quoted_value(&info_raw, "CFBundleIdentifier");

        if app_name.is_none() {
            warn!(raw = %info_raw, "AX front app 信息未返回有效 app_name");
            return None;
        }

        let basic_script = r#"
            tell application "System Events"
                set front_process to first application process whose frontmost is true
                set win_title to ""
                try
                    set win_title to name of front window of front_process
                end try
                return win_title
            end tell
        "#;

        let win_title = match run_osascript_with_timeout(
            basic_script,
            "front_window_title",
            Duration::from_millis(1200),
        ) {
            Ok(raw) => {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
            Err(err) => {
                debug!(asn = %asn, "AX 窗口标题脚本失败，继续使用 app 基础信息: {}", err);
                None
            }
        };

        Some(AXInfo {
            app_name,
            app_bundle_id,
            win_title,
            ..Default::default()
        })
    }

    pub fn extract_ax_text_for_context(
        app_name: Option<&str>,
        bundle_id: Option<&str>,
        win_title: Option<&str>,
    ) -> Option<ExtractedText> {
        debug!(
            app = ?app_name,
            bundle_id = ?bundle_id,
            "开始 AX generic-first 文本提取"
        );

        if let Some(text) = extract_generic_text().and_then(|raw| sanitize_extracted_text(&raw, win_title)) {
            return Some(ExtractedText {
                source: TextExtractor::Generic,
                text,
            });
        }

        let fallback = fallback_extractor_for_context(bundle_id, app_name)?;
        debug!(
            app = ?app_name,
            bundle_id = ?bundle_id,
            fallback = fallback.as_str(),
            "generic 未命中质量门槛，尝试 fallback"
        );

        let fallback_text = match fallback {
            TextExtractor::Generic => None,
            TextExtractor::Chrome => extract_chrome_text(),
            TextExtractor::Safari => extract_safari_text(),
            TextExtractor::WeChat => extract_wechat_text(),
        }?;

        let text = sanitize_extracted_text(&fallback_text, win_title)?;
        Some(ExtractedText {
            source: fallback,
            text,
        })
    }

    /// 提取 Chrome 浏览器的页面文本
    fn extract_chrome_text() -> Option<String> {
        let script = format!(
            r#"
            tell application "Google Chrome"
                if (count of windows) > 0 then
                    set front_win to front window
                    if (count of tabs of front_win) > 0 then
                        set active_tab to active tab of front_win
                        try
                            set page_text to execute active_tab javascript "
                                (function() {{
                                    var title = document.title;
                                    var body = document.body;
                                    if (!body) return title;

                                    var clone = body.cloneNode(true);
                                    var scripts = clone.getElementsByTagName('script');
                                    var styles = clone.getElementsByTagName('style');
                                    for (var i = scripts.length - 1; i >= 0; i--) {{
                                        scripts[i].remove();
                                    }}
                                    for (var i = styles.length - 1; i >= 0; i--) {{
                                        styles[i].remove();
                                    }}

                                    var text = clone.innerText || clone.textContent || '';
                                    text = text.replace(/\\s+/g, ' ').trim();
                                    if (text.length > {max_chars}) {{
                                        text = text.substring(0, {max_chars}) + '...';
                                    }}
                                    return title + '\\n\\n' + text;
                                }})()
                            "
                            return page_text
                        end try
                    end if
                end if
            end tell
            return ""
        "#,
            max_chars = EXTRACTED_TEXT_MAX_CHARS,
        );

        match run_osascript(&script, "chrome_text") {
            Ok(text) if !text.is_empty() => Some(text),
            Ok(_) => None,
            Err(err) => {
                debug!("Chrome AX 文本提取失败: {}", err);
                None
            }
        }
    }

    /// 提取 Safari 浏览器的页面文本
    fn extract_safari_text() -> Option<String> {
        let script = format!(
            r#"
            tell application "Safari"
                if (count of windows) > 0 then
                    set front_win to front window
                    if (count of tabs of front_win) > 0 then
                        set active_tab to current tab of front_win
                        try
                            set page_text to do JavaScript "
                                (function() {{
                                    var title = document.title;
                                    var body = document.body;
                                    if (!body) return title;
                                    var text = body.innerText || body.textContent || '';
                                    text = text.replace(/\\s+/g, ' ').trim();
                                    if (text.length > {max_chars}) {{
                                        text = text.substring(0, {max_chars}) + '...';
                                    }}
                                    return title + '\\n\\n' + text;
                                }})()
                            " in active_tab
                            return page_text
                        end try
                    end if
                end if
            end tell
            return ""
        "#,
            max_chars = EXTRACTED_TEXT_MAX_CHARS,
        );

        match run_osascript(&script, "safari_text") {
            Ok(text) if !text.is_empty() => Some(text),
            Ok(_) => None,
            Err(err) => {
                debug!("Safari AX 文本提取失败: {}", err);
                None
            }
        }
    }

    /// 提取 WeChat 的聊天文本（作为 fallback，仅做聊天正文聚合）
    fn extract_wechat_text() -> Option<String> {
        let script = format!(
            r#"
            tell application "System Events"
                set front_process to first application process whose frontmost is true
                if name of front_process is not "WeChat" and name of front_process is not "微信" then
                    return ""
                end if

                set text_content to ""
                try
                    set front_win to front window of front_process
                    set static_items to entire contents of front_win whose role is in {{"AXStaticText", "AXTextArea", "AXTextField"}}
                    set item_count to count of static_items
                    if item_count > {limit} then set item_count to {limit}

                    repeat with idx from 1 to item_count
                        try
                            set ui_elem to item idx of static_items
                            if value of ui_elem is not missing value then
                                set val to value of ui_elem as string
                                if val is not "" then
                                    set text_content to text_content & val & linefeed
                                end if
                            end if
                        end try
                        if (length of text_content) > {max_chars} then exit repeat
                    end repeat
                end try

                if (length of text_content) > {max_chars} then
                    return text 1 thru {max_chars} of text_content
                end if
                return text_content
            end tell
        "#,
            limit = GENERIC_ALL_UI_ITEM_LIMIT,
            max_chars = EXTRACTED_TEXT_MAX_CHARS,
        );

        match run_osascript(&script, "wechat_text") {
            Ok(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
            Ok(_) => None,
            Err(err) => {
                debug!("WeChat AX 文本提取失败: {}", err);
                None
            }
        }
    }

    /// 通用文本提取（generic-first，低成本优先 + 有预算宽扫）
    fn extract_generic_text() -> Option<String> {
        let script = format!(
            r#"
            tell application "System Events"
                set front_process to first application process whose frontmost is true
                set text_content to ""
                set focus_text to ""
                try
                    set front_win to front window of front_process

                    try
                        set focused_elem to focused UI element of front_process
                        try
                            if value of focused_elem is not missing value then
                                set focus_text to value of focused_elem as string
                            end if
                        end try
                        if focus_text is "" then
                            try
                                set focus_text to description of focused_elem as string
                            end try
                        end if
                    end try

                    if (length of focus_text) ≥ {focus_min_chars} then
                        set text_content to focus_text
                    end if

                    if (length of text_content) < {window_min_chars} then
                        try
                            set static_items to entire contents of front_win whose role is in {{"AXStaticText", "AXTextArea", "AXTextField"}}
                            set item_count to count of static_items
                            if item_count > {static_limit} then set item_count to {static_limit}

                            repeat with idx from 1 to item_count
                                try
                                    set ui_elem to item idx of static_items
                                    if value of ui_elem is not missing value then
                                        set val to value of ui_elem as string
                                        if val is not "" then
                                            set text_content to text_content & linefeed & val
                                        end if
                                    end if
                                end try
                                if (length of text_content) > {max_chars} then exit repeat
                            end repeat
                        end try
                    end if

                    if (length of text_content) < {window_min_chars} then
                        try
                            set all_ui to entire contents of front_win
                            set item_count to count of all_ui
                            if item_count > {all_limit} then set item_count to {all_limit}

                            repeat with idx from 1 to item_count
                                try
                                    set ui_elem to item idx of all_ui
                                    if value of ui_elem is not missing value then
                                        set val to value of ui_elem as string
                                        if val is not "" then
                                            set text_content to text_content & linefeed & val
                                        end if
                                    end if
                                end try
                                if (length of text_content) > {max_chars} then exit repeat
                            end repeat
                        end try
                    end if
                end try

                if (length of text_content) > {max_chars} then
                    return text 1 thru {max_chars} of text_content
                end if
                return text_content
            end tell
        "#,
            focus_min_chars = GENERIC_FOCUS_MIN_CHARS,
            window_min_chars = GENERIC_WINDOW_MIN_CHARS,
            static_limit = GENERIC_STATIC_ITEM_LIMIT,
            all_limit = GENERIC_ALL_UI_ITEM_LIMIT,
            max_chars = EXTRACTED_TEXT_MAX_CHARS,
        );

        match run_osascript(&script, "generic_text") {
            Ok(text) if !text.is_empty() => Some(text),
            Ok(_) => None,
            Err(err) => {
                debug!("generic AX 文本提取失败: {}", err);
                None
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ax_info_default() {
        let info = AXInfo::default();
        assert!(info.app_name.is_none());
        assert!(info.win_title.is_none());
        assert!(info.extracted_text.is_none());
    }

    #[test]
    fn test_ax_info_partial_construction() {
        let info = AXInfo {
            app_name:     Some("Feishu".into()),
            win_title:    Some("工作群".into()),
            focused_role: Some("AXTextField".into()),
            ..Default::default()
        };
        assert_eq!(info.app_name.as_deref(), Some("Feishu"));
        assert_eq!(info.win_title.as_deref(), Some("工作群"));
        assert_eq!(info.focused_role.as_deref(), Some("AXTextField"));
        assert!(info.extracted_text.is_none());
    }

    #[test]
    fn test_get_frontmost_returns_none_in_test() {
        let result = get_frontmost_info();
        assert!(result.is_none(), "测试环境应返回 None");
    }

    #[test]
    fn test_ax_info_clone() {
        let info = AXInfo {
            app_name: Some("VSCode".into()),
            ..Default::default()
        };
        let cloned = info.clone();
        assert_eq!(info.app_name, cloned.app_name);
    }

    #[test]
    fn test_parse_keyed_quoted_value() {
        let raw = "\"CFBundleIdentifier\"=\"com.microsoft.VSCode\"\n\"LSDisplayName\"=\"Code\"";
        assert_eq!(
            parse_keyed_quoted_value(raw, "CFBundleIdentifier").as_deref(),
            Some("com.microsoft.VSCode")
        );
        assert_eq!(
            parse_keyed_quoted_value(raw, "LSDisplayName").as_deref(),
            Some("Code")
        );
        assert!(parse_keyed_quoted_value(raw, "MissingKey").is_none());
    }

    #[test]
    fn test_fallback_extractor_prefers_bundle_id() {
        assert_eq!(
            fallback_extractor_for_context(Some("com.google.Chrome"), Some("Whatever")),
            Some(TextExtractor::Chrome)
        );
        assert_eq!(
            fallback_extractor_for_context(Some("com.apple.Safari"), Some("Whatever")),
            Some(TextExtractor::Safari)
        );
        assert_eq!(
            fallback_extractor_for_context(Some("com.tencent.xinWeChat"), Some("Whatever")),
            Some(TextExtractor::WeChat)
        );
    }

    #[test]
    fn test_vscode_no_longer_maps_to_special_extractor() {
        assert_eq!(
            fallback_extractor_for_context(Some("com.microsoft.VSCode"), Some("Code")),
            None
        );
        assert_eq!(fallback_extractor_for_context(None, Some("Visual Studio Code")), None);
    }

    #[test]
    fn test_sanitize_extracted_text_rejects_short_or_title_only_text() {
        assert_eq!(sanitize_extracted_text("保存 取消", Some("设置")), None);
        assert_eq!(sanitize_extracted_text("Investigate OCR memory f — gzdz", Some("Investigate OCR memory f — gzdz")), None);
    }

    #[test]
    fn test_sanitize_extracted_text_accepts_meaningful_content() {
        let text = "fn process_event(event: CaptureEvent) -> Result<Option<i64>, CaptureError> { let has_ax_text = true; }";
        assert_eq!(
            sanitize_extracted_text(text, Some("engine.rs")),
            Some(normalize_whitespace(text))
        );
    }

    #[test]
    fn test_sanitize_extracted_text_rejects_low_information_token_list() {
        assert_eq!(sanitize_extracted_text("文件 编辑 选择 视图 运行", Some("Code")), None);
    }
}
