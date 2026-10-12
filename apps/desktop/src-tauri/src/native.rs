//! Native desktop integrations kept separate from the control-center supervisor.
//!
//! The Forge UI is served by the local kernel, so deep links cross the native/web
//! boundary through a small browser event contract instead of importing provider
//! logic into this shell.

use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use auto_launch::{AutoLaunch, AutoLaunchBuilder};
use serde::Serialize;
use tauri::menu::{CheckMenuItem, MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const DEEP_LINK_SCHEME: &str = "ccswitch";
pub const DEEP_LINK_EVENT: &str = "forge:ccswitch-deeplink";
pub const DEEP_LINK_QUEUE: &str = "__FORGE_CCSWITCH_DEEPLINKS__";
const MAX_PENDING_DEEP_LINKS: usize = 32;
const MAX_DEEP_LINK_BYTES: usize = 256 * 1024;
const TRAY_ID: &str = "514cc-console";
const AUTO_LAUNCH_APP_NAME: &str = "514cc Console";
pub const PET_OVERLAY_LABEL: &str = "pet-overlay";
const PET_OVERLAY_SIZE: (f64, f64) = (300.0, 280.0);
/// 「鼠标移入自动隐藏」时的整窗透明度。上游用 0.0f（完全透明，mouse.c:35），
/// 这里留一点余量，免得用户以为桌宠崩了找不到。
const HOVER_HIDDEN_OPACITY: f64 = 0.06;
static LIGHTWEIGHT_MODE: AtomicBool = AtomicBool::new(false);
/// 内核 base origin（握手成功后由 supervisor 写入一次），猫窗 URL 由此构造。
static PET_OVERLAY_ORIGIN: OnceLock<String> = OnceLock::new();
static PET_WINDOW_OPERATION: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCapability {
    pub enabled: bool,
    pub reason: &'static str,
    pub endpoint: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeCapabilities {
    pub tray: bool,
    pub close_to_tray: bool,
    pub auto_launch_configurable: bool,
    pub deep_link_scheme: &'static str,
    pub deep_link_event: &'static str,
    pub updater: UpdaterCapability,
    pub lightweight_mode: bool,
    pub lightweight_strategy: &'static str,
    pub restart: bool,
    pub clipboard: bool,
    pub theme: bool,
    pub portable_mode: bool,
}

pub struct NativeState {
    pending_deep_links: Mutex<VecDeque<String>>,
}

impl Default for NativeState {
    fn default() -> Self {
        Self {
            pending_deep_links: Mutex::new(VecDeque::new()),
        }
    }
}

impl NativeState {
    fn enqueue(&self, url: String) -> Result<(), String> {
        let mut pending = self
            .pending_deep_links
            .lock()
            .map_err(|_| "native deep-link queue lock poisoned".to_string())?;
        if pending.len() >= MAX_PENDING_DEEP_LINKS {
            return Err(format!(
                "native deep-link queue is full (max {MAX_PENDING_DEEP_LINKS})"
            ));
        }
        pending.push_back(url);
        Ok(())
    }

    fn take_all(&self) -> Result<Vec<String>, String> {
        let mut pending = self
            .pending_deep_links
            .lock()
            .map_err(|_| "native deep-link queue lock poisoned".to_string())?;
        Ok(pending.drain(..).collect())
    }

    fn restore_front(&self, urls: Vec<String>) -> Result<(), String> {
        let mut pending = self
            .pending_deep_links
            .lock()
            .map_err(|_| "native deep-link queue lock poisoned".to_string())?;
        for url in urls.into_iter().rev() {
            pending.push_front(url);
        }
        Ok(())
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.pending_deep_links
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }
}

pub fn native_capabilities_value() -> NativeCapabilities {
    NativeCapabilities {
        tray: true,
        close_to_tray: true,
        auto_launch_configurable: true,
        deep_link_scheme: DEEP_LINK_SCHEME,
        deep_link_event: DEEP_LINK_EVENT,
        updater: UpdaterCapability {
            enabled: false,
            reason: "disabled_no_signed_514cc_release_endpoint",
            endpoint: None,
        },
        lightweight_mode: true,
        lightweight_strategy: "hide_webview_keep_kernel",
        restart: true,
        clipboard: true,
        theme: true,
        portable_mode: crate::desktop_layout::is_bundled(),
    }
}

#[tauri::command]
pub fn get_native_capabilities() -> NativeCapabilities {
    native_capabilities_value()
}

fn auto_launch_controller() -> Result<AutoLaunch, String> {
    let exe_path = std::env::current_exe()
        .map_err(|error| format!("failed to resolve current executable: {error}"))?;

    #[cfg(target_os = "macos")]
    let app_path = macos_bundle_path(&exe_path).unwrap_or(exe_path);
    #[cfg(not(target_os = "macos"))]
    let app_path = exe_path;

    AutoLaunchBuilder::new()
        .set_app_name(AUTO_LAUNCH_APP_NAME)
        .set_app_path(&app_path.to_string_lossy())
        .build()
        .map_err(|error| format!("failed to initialize auto launch: {error}"))
}

#[cfg(target_os = "macos")]
fn macos_bundle_path(exe_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let path = exe_path.to_string_lossy();
    let app_position = path.find(".app/Contents/MacOS/")?;
    Some(std::path::PathBuf::from(&path[..app_position + 4]))
}

pub fn get_auto_launch_status_value() -> Result<bool, String> {
    auto_launch_controller()?
        .is_enabled()
        .map_err(|error| format!("failed to read auto-launch status: {error}"))
}

fn apply_auto_launch_change<E, D, Q>(
    enabled: bool,
    enable: E,
    disable: D,
    query: Q,
) -> Result<bool, String>
where
    E: FnOnce() -> Result<(), String>,
    D: FnOnce() -> Result<(), String>,
    Q: FnOnce() -> Result<bool, String>,
{
    if enabled {
        enable()?;
    } else {
        disable()?;
    }
    query()
}

pub fn set_auto_launch_value(enabled: bool) -> Result<bool, String> {
    let controller = auto_launch_controller()?;
    apply_auto_launch_change(
        enabled,
        || {
            controller
                .enable()
                .map_err(|error| format!("failed to enable auto launch: {error}"))
        },
        || {
            controller
                .disable()
                .map_err(|error| format!("failed to disable auto launch: {error}"))
        },
        || {
            controller
                .is_enabled()
                .map_err(|error| format!("failed to verify auto-launch status: {error}"))
        },
    )
}

#[tauri::command]
pub fn get_auto_launch_status() -> Result<bool, String> {
    get_auto_launch_status_value()
}

#[tauri::command]
pub fn set_auto_launch(enabled: bool) -> Result<bool, String> {
    set_auto_launch_value(enabled)
}

#[tauri::command]
pub fn restart_app(app: AppHandle) -> Result<bool, String> {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        app.restart();
    });
    Ok(true)
}

#[tauri::command]
pub fn is_portable_mode() -> bool {
    crate::desktop_layout::is_bundled()
}

fn write_clipboard_with(program: &str, args: &[&str], text: &str) -> Result<(), String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to launch clipboard helper {program}: {error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "clipboard helper stdin is unavailable".to_string())?
        .write_all(text.as_bytes())
        .map_err(|error| format!("failed to write clipboard payload: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("failed to wait for clipboard helper: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "clipboard helper failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[tauri::command]
pub fn copy_text_to_clipboard(text: String) -> Result<bool, String> {
    if text.len() > 1024 * 1024 {
        return Err("clipboard text exceeds 1 MiB".to_string());
    }
    #[cfg(target_os = "windows")]
    write_clipboard_with(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::In.ReadToEnd() | Set-Clipboard",
        ],
        &text,
    )?;
    #[cfg(target_os = "macos")]
    write_clipboard_with("pbcopy", &[], &text)?;
    #[cfg(all(unix, not(target_os = "macos")))]
    if write_clipboard_with("wl-copy", &[], &text).is_err() {
        write_clipboard_with("xclip", &["-selection", "clipboard"], &text)?;
    }
    Ok(true)
}

#[tauri::command]
pub fn set_window_theme(window: WebviewWindow, theme: String) -> Result<bool, String> {
    let value = match theme.to_ascii_lowercase().as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        "system" | "auto" => None,
        _ => return Err("theme must be light, dark, or system".to_string()),
    };
    window.set_theme(value).map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn update_tray_menu(app: AppHandle) -> Result<bool, String> {
    Ok(app.tray_by_id(TRAY_ID).is_some())
}

pub fn show_forge_window(app: &AppHandle) -> Result<(), String> {
    LIGHTWEIGHT_MODE.store(false, Ordering::Release);
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    #[cfg(target_os = "windows")]
    window
        .set_skip_taskbar(false)
        .map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub fn enter_lightweight_mode_value(app: &AppHandle) -> Result<bool, String> {
    hide_forge_window(app)?;
    LIGHTWEIGHT_MODE.store(true, Ordering::Release);
    Ok(true)
}

pub fn exit_lightweight_mode_value(app: &AppHandle) -> Result<bool, String> {
    LIGHTWEIGHT_MODE.store(false, Ordering::Release);
    show_forge_window(app)?;
    Ok(false)
}

#[tauri::command]
pub fn enter_lightweight_mode(app: AppHandle) -> Result<bool, String> {
    enter_lightweight_mode_value(&app)
}

#[tauri::command]
pub fn exit_lightweight_mode(app: AppHandle) -> Result<bool, String> {
    exit_lightweight_mode_value(&app)
}

#[tauri::command]
pub fn is_lightweight_mode() -> bool {
    LIGHTWEIGHT_MODE.load(Ordering::Acquire)
}

// ---------------------------------------------------------------- 桌宠悬浮窗（pet-overlay）

/// supervisor 在内核握手成功后记录 base origin（无 fragment）；猫窗 URL 由它构造。
pub fn set_pet_overlay_origin(origin: String) {
    let _ = PET_OVERLAY_ORIGIN.set(origin);
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PetOverlayGeometry {
    x: i32,
    y: i32,
    #[serde(default = "default_pet_scale")]
    scale: f64,
}

fn default_pet_scale() -> f64 { 1.0 }

fn pet_geometry_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("pet-overlay.json"))
        .map_err(|error| format!("failed to resolve app data dir: {error}"))
}

fn load_pet_geometry(app: &AppHandle) -> Option<PetOverlayGeometry> {
    let raw = std::fs::read_to_string(pet_geometry_path(app).ok()?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 保存猫窗位置；失败静默（装饰性功能，绝不影响主流程）。
fn save_pet_overlay_geometry(app: &AppHandle, x: i32, y: i32, scale: f64) {
    let Some(path) = pet_geometry_path(app).ok() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = serde_json::to_string(&PetOverlayGeometry { x, y, scale }).unwrap_or_default();
    let _ = std::fs::write(path, payload);
}

/// 窗口事件路径的保存入口（CloseRequested 时调用）。
pub fn save_pet_overlay_geometry_for_window(window: &WebviewWindow) {
    if let Ok(position) = window.outer_position() {
        let scale = window.inner_size().ok().zip(window.scale_factor().ok())
            .map(|(size, dpi)| (f64::from(size.width) / dpi / PET_OVERLAY_SIZE.0).clamp(0.6, 1.8))
            .unwrap_or(1.0);
        save_pet_overlay_geometry(window.app_handle(), position.x, position.y, scale);
    }
}

fn clamp_pet_position(app: &AppHandle, x: i32, y: i32, scale: f64) -> (i32, i32) {
    let monitor = app.available_monitors().ok().and_then(|monitors| {
        monitors.into_iter().find(|monitor| {
            let p = monitor.position();
            let s = monitor.size();
            i64::from(x) >= i64::from(p.x) && i64::from(y) >= i64::from(p.y)
                && i64::from(x) < i64::from(p.x) + i64::from(s.width)
                && i64::from(y) < i64::from(p.y) + i64::from(s.height)
        })
    }).or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return (x, y);
    };
    let position = &monitor.work_area().position;
    let size = &monitor.work_area().size;
    let (monitor_x, monitor_y) = (position.x, position.y);
    let (monitor_w, monitor_h) = (size.width as i32, size.height as i32);
    let dpi = monitor.scale_factor();
    let margin = (16.0 * dpi) as i32;
    let max_x = monitor_x + monitor_w - (PET_OVERLAY_SIZE.0 * scale * dpi).ceil() as i32 - margin;
    let max_y = monitor_y + monitor_h - (PET_OVERLAY_SIZE.1 * scale * dpi).ceil() as i32 - margin;
    (
        x.clamp(monitor_x + margin, max_x.max(monitor_x + margin)),
        y.clamp(monitor_y + margin, max_y.max(monitor_y + margin)),
    )
}

fn default_pet_position(app: &AppHandle, scale: f64) -> (i32, i32) {
    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return (120, 120);
    };
    let position = monitor.position();
    let size = monitor.size();
    let dpi = monitor.scale_factor();
    clamp_pet_position(app,
        position.x + size.width as i32 - ((PET_OVERLAY_SIZE.0 * scale + 48.0) * dpi).ceil() as i32,
        position.y + size.height as i32 - ((PET_OVERLAY_SIZE.1 * scale + 96.0) * dpi).ceil() as i32,
        scale)
}

pub fn set_pet_overlay_value(app: &AppHandle, visible: bool) -> Result<bool, String> {
    set_pet_overlay_scaled(app, visible, None)
}

pub fn publish_pet_visibility(app: &AppHandle, visible: bool) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.eval(format!("window.dispatchEvent(new CustomEvent('514cc:pet-visibility',{{detail:{{visible:{visible}}}}}))"));
    }
}

fn set_pet_overlay_scaled(app: &AppHandle, visible: bool, scale: Option<f64>) -> Result<bool, String> {
    let _operation = PET_WINDOW_OPERATION.lock().map_err(|_| "pet window operation lock poisoned")?;
    let scale = scale.filter(|value| value.is_finite()).map(|value| value.clamp(0.6, 1.8));
    if !visible {
        if let Some(window) = app.get_webview_window(PET_OVERLAY_LABEL) {
            save_pet_overlay_geometry_for_window(&window);
            window.destroy().map_err(|error| error.to_string())?;
        }
        publish_pet_visibility(app, false);
        return Ok(false);
    }
    if let Some(window) = app.get_webview_window(PET_OVERLAY_LABEL) {
        if let Some(scale) = scale {
            window.set_size(tauri::LogicalSize::new(PET_OVERLAY_SIZE.0 * scale, PET_OVERLAY_SIZE.1 * scale)).map_err(|error| error.to_string())?;
            if let Ok(position) = window.outer_position() {
                let (x, y) = clamp_pet_position(app, position.x, position.y, scale);
                window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|error| error.to_string())?;
            }
        }
        window.show().map_err(|error| error.to_string())?;
        publish_pet_visibility(app, true);
        return Ok(true);
    }
    let origin = PET_OVERLAY_ORIGIN
        .get()
        .ok_or_else(|| "kernel origin is unavailable before handshake".to_string())?;
    let url: tauri::Url = format!("{origin}/pet")
        .parse()
        .map_err(|error| format!("invalid pet overlay url: {error}"))?;
    let saved = load_pet_geometry(app);
    let scale = scale.or_else(|| saved.as_ref().map(|geometry| geometry.scale))
        .filter(|value| value.is_finite()).unwrap_or(1.0).clamp(0.6, 1.8);
    let (x, y) = match saved {
        Some(geometry) => clamp_pet_position(app, geometry.x, geometry.y, scale),
        None => default_pet_position(app, scale),
    };
    let window = WebviewWindowBuilder::new(app, PET_OVERLAY_LABEL, WebviewUrl::External(url))
        .title("514 Pet")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .shadow(false)
        .inner_size(PET_OVERLAY_SIZE.0 * scale, PET_OVERLAY_SIZE.1 * scale)
        .visible(false)
        .build()
        .map_err(|error| format!("failed to build pet overlay window: {error}"))?;
    // 圆角：上游 BongoCat 默认开，靠 GL 侧 alpha 命中实现；这里只走 Tauri 的原生能力
    // （Windows 11 无边框窗口自带圆角），不额外引 GDI region —— region 裁剪会与
    // 命中判定互相打架（region 外的像素根本收不到事件）。
    let prepare = || -> tauri::Result<()> {
        window.set_position(tauri::PhysicalPosition::new(x, y))?;
        // 默认点击穿透；互动模式由猫页切换。
        window.set_ignore_cursor_events(true)?;
        window.show()?;
        // 窗口几何缓存：鼠标移入检测要按**窗口矩形**判，不能靠页面事件
        // （透明区域上页面收不到 pointerenter）。建窗时就填一次，页面后续再更新。
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            *PET_WINDOW_RECT.lock().unwrap_or_else(|p| p.into_inner()) = Some((
                position.x, position.y, size.width as i32, size.height as i32,
            ));
        }
        Ok(())
    };
    if let Err(error) = prepare() {
        let _ = window.destroy();
        return Err(error.to_string());
    }
    publish_pet_visibility(app, true);
    Ok(true)
}

#[tauri::command]
pub async fn set_pet_overlay(app: AppHandle, visible: bool, scale: Option<f64>) -> Result<bool, String> {
    // WebView2 construction must not block a synchronous IPC/event callback.
    tauri::async_runtime::spawn_blocking(move || set_pet_overlay_scaled(&app, visible, scale))
        .await.map_err(|error| error.to_string())?
}

pub fn pet_overlay_visible(app: &AppHandle) -> bool {
    app.get_webview_window(PET_OVERLAY_LABEL)
        .map(|window| window.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// 是否处于「鼠标移入自动隐藏」（上游 hide_on_hover）。由桌宠页写入。
static PET_HOVER_HIDDEN: AtomicBool = AtomicBool::new(false);
/// 窗口整体透明度（0~1）。`None` 表示恢复不透明。
static PET_WINDOW_OPACITY: Mutex<Option<f64>> = Mutex::new(None);
/// 桌宠窗几何缓存（物理像素），供鼠标移入检测使用。
static PET_WINDOW_RECT: Mutex<Option<(i32, i32, i32, i32)>> = Mutex::new(None);

/// 整窗透明度（0~1）。
///
/// **为什么必须走 Win32**：Tauri 2.11 的 `WebviewWindow` 没有 `set_opacity`。
/// **为什么必须整窗而不是 CSS**：桌宠页里 `body.style.opacity` 只影响**绘制内容**，
/// 透明窗口未绘制的区域照样是窗口、照样吃掉鼠标事件 —— 视觉上"看不见"，行为上仍然
/// 挡着桌面。上游 BongoCat 的 hide_on_hover 也是走平台层的窗口透明度
/// （`bongo_cat_platform_set_opacity`，mouse.c:35），不是渲染层的 alpha。
///
/// 分层窗口需要 `WS_EX_LAYERED`；Tauri 建透明窗时通常已带上，这里再补一次以防万一。
#[cfg(target_os = "windows")]
fn apply_window_opacity(window: &WebviewWindow, value: f64) -> Result<(), String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE,
        LWA_ALPHA, WS_EX_LAYERED,
    };
    let hwnd: HWND = window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    if style & (WS_EX_LAYERED as isize) == 0 {
        unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED as isize) };
    }
    let alpha = (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    let applied = unsafe { SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) };
    if applied == 0 {
        return Err("SetLayeredWindowAttributes failed".to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_window_opacity(_window: &WebviewWindow, _value: f64) -> Result<(), String> {
    // 非 Windows 暂不实现 —— 目标平台是 Windows。返回 Ok 让调用方无分支。
    Ok(())
}

/// 记录桌宠页报上来的悬停状态，并施加整窗透明度。
///
/// **为什么不能只在前端做**：`body` 的 pointerenter 只在窗口**已经在接收鼠标事件**
/// 时才会触发，而窗口在「透明区域」上是穿透的 —— 鼠标划过模型旁边的空白，页面收不到
/// 任何事件，也就永远不知道该隐藏。必须由原生侧按**窗口矩形**判断光标进出。
#[tauri::command]
pub fn set_pet_overlay_hover(app: AppHandle, hidden: bool) -> Result<bool, String> {
    PET_HOVER_HIDDEN.store(hidden, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(PET_OVERLAY_LABEL) {
        let configured = PET_WINDOW_OPACITY.lock().unwrap_or_else(|p| p.into_inner()).unwrap_or(1.0);
        apply_window_opacity(&window, if hidden { HOVER_HIDDEN_OPACITY } else { configured })?;
    }
    Ok(true)
}

/// 桌宠窗的整窗透明度。`None` 表示恢复不透明（1.0）。
/// 与 `set_ignore_cursor_events` 是两件事，互不替代。
#[tauri::command]
pub fn set_pet_overlay_opacity(app: AppHandle, opacity: Option<f64>) -> Result<bool, String> {
    let value = opacity
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.05, 1.0))
        .unwrap_or(1.0);
    *PET_WINDOW_OPACITY.lock().unwrap_or_else(|p| p.into_inner()) = opacity.map(|_| value);
    // 移入隐藏优先：它是更低的那个值，不能被一次配置下发顶回不透明。
    if PET_HOVER_HIDDEN.load(Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window(PET_OVERLAY_LABEL) {
            apply_window_opacity(&window, HOVER_HIDDEN_OPACITY)?;
        }
        return Ok(true);
    }
    if let Some(window) = app.get_webview_window(PET_OVERLAY_LABEL) {
        apply_window_opacity(&window, value)?;
    }
    Ok(true)
}

/// 记录桌宠窗当前位置（物理像素）。桌宠页在每次移动/缩放后回报。
#[tauri::command]
pub fn set_pet_overlay_rect(_app: AppHandle, x: i32, y: i32, width: i32, height: i32) -> Result<bool, String> {
    *PET_WINDOW_RECT.lock().unwrap_or_else(|p| p.into_inner()) = Some((x, y, width, height));
    Ok(true)
}

/// 光标是否落在桌宠窗矩形内。用**全局光标位置**而不是页面事件 ——
/// 透明区域上页面收不到事件，这正是需要原生判断的原因。
#[tauri::command]
pub fn pet_pointer_inside(app: AppHandle) -> Result<bool, String> {
    let Some((x, y, width, height)) = *PET_WINDOW_RECT.lock().unwrap_or_else(|p| p.into_inner()) else {
        return Ok(false);
    };
    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    let (cx, cy) = (cursor.x as i32, cursor.y as i32);
    Ok(cx >= x && cy >= y && cx < x + width && cy < y + height)
}

pub fn hide_forge_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    window.hide().map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    window
        .set_skip_taskbar(true)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn toggle_forge_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    match window.is_visible() {
        Ok(true) => hide_forge_window(app),
        Ok(false) => show_forge_window(app),
        Err(error) => Err(error.to_string()),
    }
}

pub fn install_tray(app: &AppHandle) -> Result<(), String> {
    let show_item = MenuItem::with_id(app, "show_main", "显示 Forge", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let hide_item = MenuItem::with_id(app, "hide_main", "隐藏到托盘", true, None::<&str>)
        .map_err(|error| error.to_string())?;

    let auto_launch_status = get_auto_launch_status_value();
    let auto_launch_available = auto_launch_status.is_ok();
    let auto_launch_enabled = auto_launch_status.unwrap_or(false);
    let auto_launch_label = if auto_launch_available {
        "开机自启"
    } else {
        "开机自启（状态不可用）"
    };
    let auto_launch_item = CheckMenuItem::with_id(
        app,
        "auto_launch",
        auto_launch_label,
        auto_launch_available,
        auto_launch_enabled,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let lightweight_item = CheckMenuItem::with_id(
        app,
        "lightweight_mode",
        "轻量模式",
        true,
        is_lightweight_mode(),
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let pet_item = MenuItem::with_id(
        app,
        "pet_overlay_toggle",
        "宠物猫 显示/隐藏",
        true,
        None::<&str>,
    )
    .map_err(|error| error.to_string())?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|error| error.to_string())?;

    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .item(&hide_item)
        .separator()
        .item(&auto_launch_item)
        .item(&lightweight_item)
        .separator()
        .item(&pet_item)
        .separator()
        .item(&quit_item)
        .build()
        .map_err(|error| error.to_string())?;

    let remembered_auto_launch =
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(auto_launch_enabled));
    let remembered_for_menu = remembered_auto_launch.clone();
    let auto_launch_for_menu = auto_launch_item.clone();
    let lightweight_for_menu = lightweight_item.clone();
    let lightweight_for_tray = lightweight_item.clone();

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("514cc Console")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show_main" => {
                if let Err(error) = exit_lightweight_mode_value(app) {
                    eprintln!("failed to show Forge from tray: {error}");
                }
                let _ = lightweight_for_menu.set_checked(false);
            }
            "hide_main" => {
                if let Err(error) = hide_forge_window(app) {
                    eprintln!("failed to hide Forge from tray: {error}");
                }
            }
            "auto_launch" => {
                use std::sync::atomic::Ordering;
                let previous = remembered_for_menu.load(Ordering::SeqCst);
                match set_auto_launch_value(!previous) {
                    Ok(actual) => {
                        remembered_for_menu.store(actual, Ordering::SeqCst);
                        if let Err(error) = auto_launch_for_menu.set_checked(actual) {
                            eprintln!("failed to update auto-launch tray check: {error}");
                        }
                    }
                    Err(error) => {
                        let _ = auto_launch_for_menu.set_checked(previous);
                        eprintln!("failed to change auto-launch setting: {error}");
                    }
                }
            }
            "lightweight_mode" => {
                let result = if is_lightweight_mode() {
                    exit_lightweight_mode_value(app)
                } else {
                    enter_lightweight_mode_value(app)
                };
                match result {
                    Ok(actual) => {
                        let _ = lightweight_for_menu.set_checked(actual);
                    }
                    Err(error) => {
                        let _ = lightweight_for_menu.set_checked(is_lightweight_mode());
                        eprintln!("failed to change lightweight mode: {error}");
                    }
                }
            }
            "pet_overlay_toggle" => {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(error) = set_pet_overlay_value(&app, !pet_overlay_visible(&app)) {
                        eprintln!("failed to toggle pet overlay from tray: {error}");
                    }
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                if let Err(error) = toggle_forge_window(tray.app_handle()) {
                    eprintln!("failed to toggle Forge from tray: {error}");
                }
                let _ = lightweight_for_tray.set_checked(is_lightweight_mode());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn validate_ccswitch_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty deep link".to_string());
    }
    if trimmed.len() > MAX_DEEP_LINK_BYTES {
        return Err(format!(
            "deep link exceeds {MAX_DEEP_LINK_BYTES} byte native limit"
        ));
    }
    let parsed: tauri::Url = trimmed
        .parse()
        .map_err(|error| format!("invalid deep link URL: {error}"))?;
    if parsed.scheme() != DEEP_LINK_SCHEME {
        return Err("deep link scheme must be ccswitch".to_string());
    }
    if parsed.host_str() != Some("v1") || parsed.path() != "/import" {
        return Err("deep link target must be ccswitch://v1/import".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some() {
        return Err("deep link authority must not contain credentials or a port".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("deep link fragments are not accepted".to_string());
    }
    Ok(trimmed.to_string())
}

pub fn accept_deep_link(app: &AppHandle, raw: &str, source: &str) -> bool {
    let url = match validate_ccswitch_url(raw) {
        Ok(url) => url,
        Err(error) => {
            if raw.trim_start().starts_with("ccswitch:") {
                eprintln!("rejected ccswitch deep link from {source}: {error}");
                return true;
            }
            return false;
        }
    };

    let state = app.state::<NativeState>();
    if let Err(error) = state.enqueue(url) {
        eprintln!("failed to queue ccswitch deep link from {source}: {error}");
        return true;
    }
    if let Err(error) = show_forge_window(app) {
        eprintln!("failed to show Forge for deep link from {source}: {error}");
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = flush_pending_deep_links(&window) {
            eprintln!("deep link remains queued after {source}: {error}");
        }
    }
    true
}

fn deep_link_dispatch_script(urls: &[String]) -> Result<String, String> {
    let payload = serde_json::to_string(urls)
        .map_err(|error| format!("failed to serialize deep-link payload: {error}"))?;
    Ok(format!(
        r#"(() => {{
  const urls = {payload};
  const queue = Array.isArray(globalThis.{DEEP_LINK_QUEUE})
    ? globalThis.{DEEP_LINK_QUEUE}
    : [];
  globalThis.{DEEP_LINK_QUEUE} = queue;
  for (const url of urls) {{
    const detail = Object.freeze({{ url, source: "native-desktop" }});
    queue.push(detail);
    globalThis.dispatchEvent(new CustomEvent("{DEEP_LINK_EVENT}", {{ detail }}));
  }}
}})();"#
    ))
}

pub fn flush_pending_deep_links(window: &WebviewWindow) -> Result<usize, String> {
    let state = window.state::<NativeState>();
    let urls = state.take_all()?;
    if urls.is_empty() {
        return Ok(0);
    }
    let count = urls.len();
    let script = deep_link_dispatch_script(&urls)?;
    if let Err(error) = window.eval(script) {
        state.restore_front(urls)?;
        return Err(format!("failed to dispatch deep links to Forge: {error}"));
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::{
        apply_auto_launch_change, deep_link_dispatch_script, is_portable_mode,
        native_capabilities_value, validate_ccswitch_url, NativeState, DEEP_LINK_EVENT,
        DEEP_LINK_QUEUE, MAX_PENDING_DEEP_LINKS,
    };

    #[test]
    fn accepts_ccswitch_v1_import_links_without_interpreting_provider_secrets() {
        let raw = "ccswitch://v1/import?resource=provider&app=codex&apiKey=secret";
        assert_eq!(validate_ccswitch_url(raw).unwrap(), raw);
        assert!(validate_ccswitch_url(
            "ccswitch://v1/import?resource=mcp&apps=claude%2Ccodex&config=e30="
        )
        .is_ok());
    }

    #[test]
    fn rejects_untrusted_deep_link_targets_and_oversized_payloads() {
        for raw in [
            "https://v1/import?resource=provider",
            "ccswitch://v2/import?resource=provider",
            "ccswitch://v1/export?resource=provider",
            "ccswitch://user@v1/import?resource=provider",
            "ccswitch://v1:42/import?resource=provider",
            "ccswitch://v1/import?resource=provider#ignored",
        ] {
            assert!(
                validate_ccswitch_url(raw).is_err(),
                "unexpectedly accepted {raw}"
            );
        }
        assert!(validate_ccswitch_url(&format!(
            "ccswitch://v1/import?config={}",
            "a".repeat(super::MAX_DEEP_LINK_BYTES)
        ))
        .is_err());
    }

    #[test]
    fn native_inbox_is_fifo_and_bounded() {
        let state = NativeState::default();
        state.enqueue("first".into()).unwrap();
        state.enqueue("second".into()).unwrap();
        assert_eq!(state.take_all().unwrap(), vec!["first", "second"]);

        for index in 0..MAX_PENDING_DEEP_LINKS {
            state.enqueue(format!("{index}")).unwrap();
        }
        assert!(state.enqueue("overflow".into()).is_err());
        assert_eq!(state.len(), MAX_PENDING_DEEP_LINKS);
    }

    #[test]
    fn browser_bridge_uses_stable_queue_and_event_contract_with_json_escaping() {
        let urls = vec!["ccswitch://v1/import?name=\"quoted\"&value=\\path".to_string()];
        let script = deep_link_dispatch_script(&urls).unwrap();
        assert!(script.contains(DEEP_LINK_QUEUE));
        assert!(script.contains(DEEP_LINK_EVENT));
        assert!(script.contains("\\\"quoted\\\""));
        assert!(script.contains("\\\\path"));
        assert!(!script.contains("name=\"quoted\""));
    }

    #[test]
    fn updater_is_honestly_disabled_without_borrowing_upstream_trust_material() {
        let capabilities = native_capabilities_value();
        assert!(!capabilities.updater.enabled);
        assert_eq!(capabilities.updater.endpoint, None);
        assert!(capabilities.lightweight_mode);
        assert!(capabilities.restart);
        assert!(capabilities.clipboard);
        assert!(capabilities.theme);
        assert!(!capabilities.portable_mode);
        assert!(!is_portable_mode());
        assert_eq!(
            capabilities.lightweight_strategy,
            "hide_webview_keep_kernel"
        );
        assert_eq!(
            capabilities.updater.reason,
            "disabled_no_signed_514cc_release_endpoint"
        );
    }

    #[test]
    fn auto_launch_change_calls_only_the_requested_mutation_then_verifies() {
        let enable_calls = AtomicUsize::new(0);
        let disable_calls = AtomicUsize::new(0);
        let query_calls = AtomicUsize::new(0);
        assert_eq!(
            apply_auto_launch_change(
                true,
                || {
                    enable_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                || {
                    disable_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                || {
                    query_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                },
            ),
            Ok(true)
        );
        assert_eq!(enable_calls.load(Ordering::SeqCst), 1);
        assert_eq!(disable_calls.load(Ordering::SeqCst), 0);
        assert_eq!(query_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn tauri_config_registers_ccswitch_but_has_no_updater_endpoint() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid tauri config");
        assert_eq!(
            config["plugins"]["deep-link"]["desktop"]["schemes"][0],
            "ccswitch"
        );
        assert!(config["plugins"].get("updater").is_none());
        assert_ne!(
            config["bundle"].get("createUpdaterArtifacts"),
            Some(&serde_json::Value::Bool(true))
        );
    }

    /// 桌宠窗**自己调用**的 native 命令 —— 它们不在主窗口名单里，必须由
    /// `capabilities/pet-window.json` 授权，否则桌宠页一调就 403。
    /// 与 `kernel_access.rs` 的 pet-only 判定是同一条契约，两处都要对得上。
    /// 单一真源是 `pet-owned-commands.txt`（build.rs 也读它来生成权限）。
    const PET_OWNED_COMMANDS: &[&str] = &[
        "set_pet_overlay_rect",
        "pet_pointer_inside",
        "set_pet_overlay_hover",
    ];

    #[test]
    fn pet_owned_command_list_matches_its_own_file() {
        let declared = include_str!("pet-owned-commands.txt")
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        assert_eq!(
            declared, PET_OWNED_COMMANDS,
            "pet-owned-commands.txt 是权限生成的输入，必须与本表逐条一致"
        );
    }

    #[test]
    fn remote_native_capability_is_exact_and_matches_the_invoke_handler() {
        let commands = include_str!("native-command-names.txt")
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>();
        let expected_permissions = commands
            .iter()
            .map(|command| format!("allow-{}", command.replace('_', "-")))
            .collect::<Vec<_>>();

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/ccswitch-native.json"))
                .expect("valid native capability");
        assert_eq!(capability["identifier"], "ccswitch-native-bridge");
        assert_eq!(capability["local"], false);
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert_eq!(capability["remote"]["urls"], serde_json::json!([]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(expected_permissions)
        );

        // 主窗口名单必须与能力文件逐条一致（顺序也一致）。
        // 桌宠独占的命令**不得**出现在这里 —— 否则主窗口也能设桌宠透明度，
        // 而「谁在管这个值」就说不清了。
        for command in PET_OWNED_COMMANDS {
            assert!(
                !commands.contains(command),
                "{command} 是桌宠独占命令，不该进主窗口名单"
            );
        }

        // 桌宠窗能力文件必须恰好覆盖它自己要用的命令（核心权限另行列出）。
        let pet: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/pet-window.json"))
                .expect("valid pet capability");
        assert_eq!(pet["windows"], serde_json::json!(["pet-overlay"]));
        let pet_permissions = pet["permissions"]
            .as_array()
            .expect("pet permissions")
            .iter()
            .map(|value| value.as_str().expect("permission name").to_string())
            .collect::<Vec<_>>();
        for command in PET_OWNED_COMMANDS {
            assert!(
                pet_permissions.contains(&format!("allow-{}", command.replace('_', "-"))),
                "pet-window 能力缺少 {command} 的授权，桌宠页调用会 403"
            );
        }

        let main_source = include_str!("main.rs");
        let handler = main_source
            .split_once(".invoke_handler(tauri::generate_handler![")
            .and_then(|(_, rest)| rest.split_once("])"))
            .map(|(handler, _)| handler)
            .expect("native invoke handler block");
        let registered = handler
            .lines()
            .filter_map(|line| line.trim().strip_prefix("native::"))
            .map(|line| line.trim_end_matches(',').to_string())
            .collect::<Vec<_>>();
        // invoke_handler 注册的是**全部**命令（两个窗口共用同一张表），
        // 所以它 = 主窗口名单 ∪ 桌宠独占名单。
        // 比集合不比顺序 —— 注册顺序没有语义，而"少注册一条"才是要抓的漂移。
        let mut expected = commands.iter().map(|value| value.to_string()).collect::<Vec<_>>();
        expected.extend(PET_OWNED_COMMANDS.iter().map(|value| value.to_string()));
        expected.sort();
        let mut registered = registered;
        registered.sort();
        assert_eq!(registered, expected);
    }
}
