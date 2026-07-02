use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use image::{codecs::jpeg::JpegEncoder, imageops, DynamicImage, Rgba, RgbaImage};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

static QUITTING: AtomicBool = AtomicBool::new(false);
const FLOATING_ASSIST_LABEL: &str = "floating-assist";

struct TrayMenuState {
    capture: CheckMenuItem<tauri::Wry>,
    floating_assist: CheckMenuItem<tauri::Wry>,
    autostart: CheckMenuItem<tauri::Wry>,
}

#[derive(Debug, Serialize)]
struct FloatingAssistOcrResult {
    text: String,
    confidence: f64,
    screenshot_path: String,
    width: u32,
    height: u32,
}

#[derive(Debug, Serialize)]
struct FloatingAssistDragOrigin {
    offset_x: f64,
    offset_y: f64,
}

#[derive(Debug, Serialize)]
struct IpcRequest {
    id: String,
    ts: i64,
    task: IpcTask,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum IpcTask {
    Ocr {
        capture_id: i64,
        screenshot_path: String,
    },
}

#[derive(Debug, Deserialize)]
struct IpcResponse {
    status: String,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct IpcOcrResult {
    text: String,
    confidence: f64,
}

struct FloatingAssistScreenCapture {
    preview_path: PathBuf,
    ocr_paths: Vec<PathBuf>,
    width: u32,
    height: u32,
}

trait ReadWrite: Read + Write {}
impl<T: Read + Write> ReadWrite for T {}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn ensure_floating_assist_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(FLOATING_ASSIST_LABEL) {
        return Ok(window);
    }

    WebviewWindowBuilder::new(
        app,
        FLOATING_ASSIST_LABEL,
        WebviewUrl::App("index.html?view=floating-assist".into()),
    )
    .title("记忆面包悬浮球")
    .inner_size(42.0, 42.0)
    .min_inner_size(40.0, 40.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .accept_first_mouse(true)
    .content_protected(true)
    .skip_taskbar(true)
    .visible(false)
    .position(960.0, 140.0)
    .build()
    .map_err(|error| error.to_string())
}

fn set_floating_assist_visible_inner(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let window = ensure_floating_assist_window(app)?;
    if enabled {
        let _ = window.set_size(LogicalSize::new(42.0, 42.0));
        let _ = window.set_position(LogicalPosition::new(80.0, 140.0));
        window.show().map_err(|error| error.to_string())?;
        let _ = window.set_always_on_top(true);
        let _ = app.emit("floating-assist-reset", ());
    } else {
        window.hide().map_err(|error| error.to_string())?;
    }
    app.state::<TrayMenuState>()
        .floating_assist
        .set_checked(enabled)
        .map_err(|error| error.to_string())?;
    let _ = app.emit("tray-floating-assist-changed", enabled);
    Ok(())
}

fn floating_assist_temp_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "无法定位用户目录".to_string())?;
    let dir = PathBuf::from(home)
        .join(".memory-bread")
        .join("floating-screenshots");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn save_rgba_jpeg(path: PathBuf, image: RgbaImage) -> Result<PathBuf, String> {
    let rgb = DynamicImage::ImageRgba8(image).into_rgb8();
    let file = fs::File::create(&path).map_err(|error| error.to_string())?;
    let mut encoder = JpegEncoder::new_with_quality(file, 82);
    encoder
        .encode_image(&DynamicImage::ImageRgb8(rgb))
        .map_err(|error| error.to_string())?;
    Ok(path)
}

fn capture_all_screens_for_floating_assist() -> Result<FloatingAssistScreenCapture, String> {
    let monitors = xcap::Monitor::all()
        .map_err(|error| format!("无法读取屏幕列表，请确认已授予屏幕录制权限：{error}"))?;
    if monitors.is_empty() {
        return Err("未发现可用显示器".to_string());
    }

    let timestamp = now_ms();
    let temp_dir = floating_assist_temp_dir()?;
    let mut captures = Vec::with_capacity(monitors.len());
    let mut ocr_paths = Vec::with_capacity(monitors.len());
    for (index, monitor) in monitors.into_iter().enumerate() {
        let x = monitor
            .x()
            .map_err(|error| format!("读取显示器位置失败：{error}"))?;
        let y = monitor
            .y()
            .map_err(|error| format!("读取显示器位置失败：{error}"))?;
        let image = monitor
            .capture_image()
            .map_err(|error| format!("截图失败，请确认已授予屏幕录制权限：{error}"))?;
        let ocr_path = temp_dir.join(format!("{timestamp}-monitor-{index}.jpg"));
        ocr_paths.push(save_rgba_jpeg(ocr_path, image.clone())?);
        captures.push((x, y, image));
    }

    let min_x = captures
        .iter()
        .map(|(x, _, _)| *x as i64)
        .min()
        .unwrap_or(0);
    let min_y = captures
        .iter()
        .map(|(_, y, _)| *y as i64)
        .min()
        .unwrap_or(0);
    let max_x = captures
        .iter()
        .map(|(x, _, image)| *x as i64 + image.width() as i64)
        .max()
        .unwrap_or(0);
    let max_y = captures
        .iter()
        .map(|(_, y, image)| *y as i64 + image.height() as i64)
        .max()
        .unwrap_or(0);
    let width = u32::try_from(max_x - min_x).map_err(|_| "多显示器截图宽度过大".to_string())?;
    let height = u32::try_from(max_y - min_y).map_err(|_| "多显示器截图高度过大".to_string())?;
    let mut canvas = RgbaImage::from_pixel(width, height, Rgba([255, 252, 247, 255]));
    for (x, y, image) in captures {
        imageops::overlay(&mut canvas, &image, x as i64 - min_x, y as i64 - min_y);
    }

    let preview_path = save_rgba_jpeg(temp_dir.join(format!("{timestamp}.jpg")), canvas)?;
    Ok(FloatingAssistScreenCapture {
        preview_path,
        ocr_paths,
        width,
        height,
    })
}

fn run_floating_assist_ocr(paths: &[PathBuf]) -> Result<IpcOcrResult, String> {
    let mut parts = Vec::new();
    let mut confidence_sum = 0.0;
    let mut confidence_count = 0usize;
    let mut last_error = None;

    for (index, path) in paths.iter().enumerate() {
        let path_text = path.to_string_lossy().to_string();
        match send_sidecar_ocr(&path_text) {
            Ok(result) => {
                let text = result.text.trim();
                if !text.is_empty() {
                    parts.push(format!("显示器 {}:\n{}", index + 1, text));
                }
                confidence_sum += result.confidence;
                confidence_count += 1;
            }
            Err(error) => {
                last_error = Some(error);
            }
        }
    }

    if parts.is_empty() {
        if let Some(error) = last_error {
            return Err(error);
        }
    }

    Ok(IpcOcrResult {
        text: parts.join("\n\n"),
        confidence: if confidence_count > 0 {
            confidence_sum / confidence_count as f64
        } else {
            0.0
        },
    })
}

#[cfg(unix)]
fn connect_ipc_stream() -> Result<Box<dyn ReadWrite>, String> {
    use std::os::unix::net::UnixStream;

    let stream = UnixStream::connect("/tmp/memory-bread-sidecar.sock")
        .map_err(|error| format!("无法连接 OCR sidecar：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    Ok(Box::new(stream))
}

#[cfg(windows)]
fn connect_ipc_stream() -> Result<Box<dyn ReadWrite>, String> {
    use std::net::TcpStream;

    let stream = TcpStream::connect("127.0.0.1:17071")
        .map_err(|error| format!("无法连接 OCR sidecar：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(20)))
        .map_err(|error| error.to_string())?;
    Ok(Box::new(stream))
}

#[cfg(not(any(unix, windows)))]
fn connect_ipc_stream() -> Result<Box<dyn ReadWrite>, String> {
    Err("当前平台暂不支持悬浮球 OCR IPC".to_string())
}

fn send_ipc_payload(payload: &[u8]) -> Result<IpcResponse, String> {
    let mut stream = connect_ipc_stream()?;
    let length = (payload.len() as u32).to_be_bytes();
    stream
        .write_all(&length)
        .map_err(|error| error.to_string())?;
    stream
        .write_all(payload)
        .map_err(|error| error.to_string())?;
    stream.flush().map_err(|error| error.to_string())?;

    let mut length_buf = [0u8; 4];
    stream
        .read_exact(&mut length_buf)
        .map_err(|error| error.to_string())?;
    let response_length = u32::from_be_bytes(length_buf) as usize;
    if response_length > 16 * 1024 * 1024 {
        return Err(format!("OCR sidecar 响应过大：{} 字节", response_length));
    }
    let mut response_buf = vec![0u8; response_length];
    stream
        .read_exact(&mut response_buf)
        .map_err(|error| error.to_string())?;
    serde_json::from_slice(&response_buf).map_err(|error| error.to_string())
}

fn send_sidecar_ocr(path: &str) -> Result<IpcOcrResult, String> {
    let request = IpcRequest {
        id: uuid::Uuid::new_v4().to_string(),
        ts: now_ms(),
        task: IpcTask::Ocr {
            capture_id: 0,
            screenshot_path: path.to_string(),
        },
    };
    let payload = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    let response = send_ipc_payload(&payload)?;
    if response.status != "ok" {
        return Err(response
            .error
            .unwrap_or_else(|| "OCR sidecar 返回未知错误".to_string()));
    }
    let result = response
        .result
        .ok_or_else(|| "OCR sidecar 响应缺少 result".to_string())?;
    serde_json::from_value(result).map_err(|error| error.to_string())
}

fn start_script_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("start.sh")
}

/// 退出 App 后再由独立脚本停止启动器和所有后台服务，避免脚本先杀掉当前进程。
fn schedule_full_shutdown() {
    let script = start_script_path();
    if !script.is_file() {
        eprintln!("未找到全组件停止脚本: {}", script.display());
        return;
    }

    let result = Command::new("/bin/bash")
        .arg(script)
        .arg("stop-after-app")
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    if let Err(error) = result {
        eprintln!("启动全组件停止脚本失败: {error}");
    }
}

fn schedule_backend_startup() {
    let script = start_script_path();
    if !script.is_file() {
        eprintln!("未找到全组件启动脚本: {}", script.display());
        return;
    }

    if let Err(error) = Command::new("/bin/bash")
        .arg(script)
        .arg("start-backends")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        eprintln!("启动后台服务失败: {error}");
    }
}

#[tauri::command]
fn set_capture_menu_state(app: AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<TrayMenuState>()
        .capture
        .set_checked(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_floating_assist_menu_state(app: AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<TrayMenuState>()
        .floating_assist
        .set_checked(enabled)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_floating_assist_visible(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_floating_assist_visible_inner(&app, enabled)
}

#[tauri::command]
fn set_floating_assist_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let window = ensure_floating_assist_window(&app)?;
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn begin_floating_assist_drag(app: AppHandle) -> Result<FloatingAssistDragOrigin, String> {
    let window = ensure_floating_assist_window(&app)?;
    let window_position = window.outer_position().map_err(|error| error.to_string())?;
    let cursor_position = app.cursor_position().map_err(|error| error.to_string())?;
    Ok(FloatingAssistDragOrigin {
        offset_x: cursor_position.x - f64::from(window_position.x),
        offset_y: cursor_position.y - f64::from(window_position.y),
    })
}

#[tauri::command]
fn update_floating_assist_drag(app: AppHandle, offset_x: f64, offset_y: f64) -> Result<(), String> {
    let window = ensure_floating_assist_window(&app)?;
    let cursor_position = app.cursor_position().map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            (cursor_position.x - offset_x).round() as i32,
            (cursor_position.y - offset_y).round() as i32,
        ))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_floating_assist_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let window = ensure_floating_assist_window(&app)?;
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_floating_assist_image_data_url(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|error| format!("读取截屏失败：{error}"))?;
    let encoded = general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/jpeg;base64,{encoded}"))
}

#[tauri::command]
fn open_floating_assist_reference(app: AppHandle, detail: serde_json::Value) -> Result<(), String> {
    show_main_window(&app);
    app.emit("floating-assist-open-reference", detail)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn capture_screen_ocr_for_floating_assist(
    app: AppHandle,
) -> Result<FloatingAssistOcrResult, String> {
    let floating_window = app.get_webview_window(FLOATING_ASSIST_LABEL);
    if let Some(window) = floating_window.as_ref() {
        let _ = window.set_content_protected(true);
        let _ = window.set_always_on_top(true);

        let capture_result = tauri::async_runtime::spawn_blocking(|| {
            let capture = capture_all_screens_for_floating_assist()?;
            let result = run_floating_assist_ocr(&capture.ocr_paths)?;
            Ok::<_, String>((capture, result))
        })
        .await
        .map_err(|error| format!("悬浮球截图任务失败：{error}"));

        let _ = window.show();
        let _ = window.set_always_on_top(true);

        let (capture, result) = capture_result??;
        let screenshot_path = capture.preview_path.to_string_lossy().to_string();
        return Ok(FloatingAssistOcrResult {
            text: result.text,
            confidence: result.confidence,
            screenshot_path,
            width: capture.width,
            height: capture.height,
        });
    }

    let (capture, result) = tauri::async_runtime::spawn_blocking(|| {
        let capture = capture_all_screens_for_floating_assist()?;
        let result = run_floating_assist_ocr(&capture.ocr_paths)?;
        Ok::<_, String>((capture, result))
    })
    .await
    .map_err(|error| format!("悬浮球截图任务失败：{error}"))??;
    let screenshot_path = capture.preview_path.to_string_lossy().to_string();
    Ok(FloatingAssistOcrResult {
        text: result.text,
        confidence: result.confidence,
        screenshot_path,
        width: capture.width,
        height: capture.height,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--autostart"]),
        ))
        .invoke_handler(tauri::generate_handler![
            set_capture_menu_state,
            set_floating_assist_menu_state,
            set_floating_assist_visible,
            set_floating_assist_position,
            begin_floating_assist_drag,
            update_floating_assist_drag,
            set_floating_assist_size,
            read_floating_assist_image_data_url,
            open_floating_assist_reference,
            capture_screen_ocr_for_floating_assist,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let main_panel = MenuItem::with_id(app, "main-panel", "主面板", true, None::<&str>)?;
            let capture =
                CheckMenuItem::with_id(app, "capture", "打开/关闭采集", true, true, None::<&str>)?;
            let floating_assist = CheckMenuItem::with_id(
                app,
                "floating-assist",
                "打开/关闭悬浮球",
                true,
                false,
                None::<&str>,
            )?;
            let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "开机默认启动",
                true,
                autostart_enabled,
                None::<&str>,
            )?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &main_panel,
                    &capture,
                    &floating_assist,
                    &autostart,
                    &settings,
                    &separator,
                    &quit,
                ],
            )?;

            app.manage(TrayMenuState {
                capture: capture.clone(),
                floating_assist: floating_assist.clone(),
                autostart: autostart.clone(),
            });

            let _ = ensure_floating_assist_window(app.handle());

            let mut tray = TrayIconBuilder::with_id("memory-bread")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("记忆面包")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "main-panel" => show_main_window(app),
                    "capture" => {
                        let enabled = app
                            .state::<TrayMenuState>()
                            .capture
                            .is_checked()
                            .unwrap_or(true);
                        let _ = app.emit("tray-capture-changed", enabled);
                    }
                    "floating-assist" => {
                        let enabled = app
                            .state::<TrayMenuState>()
                            .floating_assist
                            .is_checked()
                            .unwrap_or(false);
                        if let Err(error) = set_floating_assist_visible_inner(app, enabled) {
                            eprintln!("更新悬浮球状态失败: {error}");
                            let _ = app
                                .state::<TrayMenuState>()
                                .floating_assist
                                .set_checked(!enabled);
                        }
                    }
                    "autostart" => {
                        let state = app.state::<TrayMenuState>();
                        let requested = state.autostart.is_checked().unwrap_or(false);
                        let result = if requested {
                            app.autolaunch().enable()
                        } else {
                            app.autolaunch().disable()
                        };
                        if let Err(error) = result {
                            eprintln!("更新开机启动状态失败: {error}");
                            let _ = state.autostart.set_checked(!requested);
                        }
                    }
                    "settings" => {
                        show_main_window(app);
                        let _ = app.emit("tray-navigate-settings", ());
                    }
                    "quit" => {
                        QUITTING.store(true, Ordering::SeqCst);
                        schedule_full_shutdown();
                        app.exit(0);
                    }
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon_as_template(true);
            }
            tray.build(app)?;

            if std::env::args().any(|argument| argument == "--autostart") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
                schedule_backend_startup();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
