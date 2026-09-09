// 514cc Console 桌面壳（Tauri 2）
// 架构（烛 R1 评审后重构）：单一 supervisor 线程独占内核 Child 全生命周期；
// 窗口激活/取消由共享原子阶段协调，外部事件先发布取消意图再通知 supervisor。
// 任何退出路径统一走 taskkill /T 杀整棵进程树 + wait() 回收，堵孤儿 node 与
// 僵尸进程。UI 全部由内核 Web 面板提供。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop_layout;
mod kernel_access;
mod native;

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, TryLockError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{
    webview::PageLoadEvent, AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_deep_link::DeepLinkExt;

const KERNEL_PORT: u16 = 51400;
// 启动看门狗放宽：冷盘 + 杀软扫描下 node 首启可能远超 15~30s（LO 反馈"有几率闪退"
// 的一条诱因就是健康机器假设）。宁可多等，不可误杀。
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const WINDOW_READY_TIMEOUT: Duration = Duration::from_secs(25);
const WINDOW_READY_DELIVERY_GRACE: Duration = Duration::from_secs(2);
/// 内核在打印握手行之前死亡的自动重启次数上限（端口竞态/瞬时资源锁场景自愈）。
const KERNEL_START_RETRIES: u8 = 2;
// 内核 stdout 握手行的固定前缀（apps/control-center/server.mjs 的启动横幅）。
const URL_PREFIX: &str = "514cc Control Center: ";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

enum Event {
    UrlFound(Url),
    StdoutEof,
    WindowActivated(Result<(), String>),
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum WindowLaunchPhase {
    Pending = 0,
    Activating = 1,
    Live = 2,
    Cancelling = 3,
    Cancelled = 4,
}

struct WindowLaunchState {
    phase: AtomicU8,
    cancellation_requested: AtomicBool,
    activation_in_progress: AtomicBool,
    visibility_epoch: AtomicU64,
    rollback_epoch: AtomicU64,
    visibility_gate: Mutex<()>,
}

impl WindowLaunchState {
    fn new() -> Self {
        Self {
            phase: AtomicU8::new(WindowLaunchPhase::Pending as u8),
            cancellation_requested: AtomicBool::new(false),
            activation_in_progress: AtomicBool::new(false),
            visibility_epoch: AtomicU64::new(0),
            rollback_epoch: AtomicU64::new(u64::MAX),
            visibility_gate: Mutex::new(()),
        }
    }
}

struct ActivationOwner<'a> {
    state: &'a WindowLaunchState,
    active: bool,
}

impl<'a> ActivationOwner<'a> {
    fn new(state: &'a WindowLaunchState) -> Self {
        state.activation_in_progress.store(true, Ordering::SeqCst);
        Self {
            state,
            active: true,
        }
    }

    fn release(&mut self) {
        if self.active {
            self.state
                .activation_in_progress
                .store(false, Ordering::SeqCst);
            if window_phase(self.state) == WindowLaunchPhase::Cancelling
                && rollback_covers_current_visibility(self.state)
            {
                set_window_phase(self.state, WindowLaunchPhase::Cancelled);
            }
            self.active = false;
        }
    }
}

impl Drop for ActivationOwner<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

fn window_phase(state: &WindowLaunchState) -> WindowLaunchPhase {
    match state.phase.load(Ordering::SeqCst) {
        value if value == WindowLaunchPhase::Pending as u8 => WindowLaunchPhase::Pending,
        value if value == WindowLaunchPhase::Activating as u8 => WindowLaunchPhase::Activating,
        value if value == WindowLaunchPhase::Live as u8 => WindowLaunchPhase::Live,
        value if value == WindowLaunchPhase::Cancelling as u8 => WindowLaunchPhase::Cancelling,
        _ => WindowLaunchPhase::Cancelled,
    }
}

fn set_window_phase(state: &WindowLaunchState, phase: WindowLaunchPhase) {
    state.phase.store(phase as u8, Ordering::SeqCst);
}

fn mark_window_cancelling(state: &WindowLaunchState) -> WindowLaunchPhase {
    loop {
        let current = window_phase(state);
        if matches!(
            current,
            WindowLaunchPhase::Cancelling | WindowLaunchPhase::Cancelled
        ) {
            return current;
        }
        if state
            .phase
            .compare_exchange(
                current as u8,
                WindowLaunchPhase::Cancelling as u8,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .is_ok()
        {
            return current;
        }
    }
}

fn rollback_covers_current_visibility(state: &WindowLaunchState) -> bool {
    let epoch = state.visibility_epoch.load(Ordering::SeqCst);
    epoch % 2 == 0 && state.rollback_epoch.load(Ordering::SeqCst) == epoch
}

fn dispatch_visibility_rollback<R>(state: &WindowLaunchState, rollback: R) -> Result<(), String>
where
    R: FnOnce() -> Result<(), String>,
{
    let before = state.visibility_epoch.load(Ordering::SeqCst);
    let result = rollback();
    if result.is_ok() {
        let after = state.visibility_epoch.load(Ordering::SeqCst);
        // 奇数 epoch 表示 show 尚未返回；跨 epoch 的 hide 也可能早于迟到 show，不能作凭证。
        if before == after && after % 2 == 0 {
            state.rollback_epoch.store(after, Ordering::SeqCst);
        }
    }
    result
}

fn rollback_activation<R>(
    state: &WindowLaunchState,
    rollback: R,
    activation_error: Option<String>,
) -> Result<bool, String>
where
    R: FnOnce() -> Result<(), String>,
{
    set_window_phase(state, WindowLaunchPhase::Cancelling);
    match dispatch_visibility_rollback(state, rollback) {
        Ok(()) => {
            set_window_phase(state, WindowLaunchPhase::Cancelled);
            match activation_error {
                Some(error) => Err(error),
                None => Ok(false),
            }
        }
        Err(rollback_error) => Err(match activation_error {
            Some(error) => format!(
                "{error}; window rollback after activation failure also failed: {rollback_error}"
            ),
            None => format!(
                "window activation was cancelled but visibility rollback failed: {rollback_error}"
            ),
        }),
    }
}

/// PageLoad 回调的唯一可见性提交点。show/verify 在可见性门内执行，释放门后再以
/// CAS 提交 Live；取消可无等待地把 Activating 改为 Cancelling，使迟到提交必然失败。
fn activate_window<S, V, R>(
    state: &WindowLaunchState,
    show: S,
    verify: V,
    rollback: R,
) -> Result<bool, String>
where
    S: FnOnce() -> Result<(), String>,
    V: FnOnce() -> Result<(), String>,
    R: FnOnce() -> Result<(), String>,
{
    if window_phase(state) != WindowLaunchPhase::Pending
        || state.cancellation_requested.load(Ordering::SeqCst)
    {
        return Ok(false);
    }
    let visibility = match state.visibility_gate.try_lock() {
        Ok(visibility) => visibility,
        Err(TryLockError::WouldBlock) => return Ok(false),
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
    };
    if window_phase(state) != WindowLaunchPhase::Pending
        || state.cancellation_requested.load(Ordering::SeqCst)
    {
        return Ok(false);
    }
    set_window_phase(state, WindowLaunchPhase::Activating);
    let mut activation_owner = ActivationOwner::new(state);

    if state.cancellation_requested.load(Ordering::SeqCst)
        || window_phase(state) != WindowLaunchPhase::Activating
    {
        set_window_phase(state, WindowLaunchPhase::Cancelled);
        return Ok(false);
    }
    state.visibility_epoch.fetch_add(1, Ordering::SeqCst);
    let show_result = show();
    state.visibility_epoch.fetch_add(1, Ordering::SeqCst);
    if let Err(error) = show_result {
        return rollback_activation(state, rollback, Some(error));
    }
    if state.cancellation_requested.load(Ordering::SeqCst)
        || window_phase(state) != WindowLaunchPhase::Activating
    {
        return rollback_activation(state, rollback, None);
    }
    if let Err(error) = verify() {
        return rollback_activation(state, rollback, Some(error));
    }
    if state.cancellation_requested.load(Ordering::SeqCst)
        || window_phase(state) != WindowLaunchPhase::Activating
    {
        return rollback_activation(state, rollback, None);
    }

    // 先宣布不再可能执行 show，再放开门；无门 canceller 此后即可安全提交终态。
    activation_owner.release();
    drop(visibility);
    if state
        .phase
        .compare_exchange(
            WindowLaunchPhase::Activating as u8,
            WindowLaunchPhase::Live as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .is_ok()
    {
        return Ok(true);
    }

    if window_phase(state) == WindowLaunchPhase::Cancelled {
        return Ok(false);
    }
    let _visibility = match state.visibility_gate.try_lock() {
        Ok(visibility) => visibility,
        // 取消 owner 已持门执行 hide；由它提交 Cancelled，激活方不得等待。
        Err(TryLockError::WouldBlock) => return Ok(false),
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
    };
    if window_phase(state) == WindowLaunchPhase::Cancelled {
        return Ok(false);
    }
    rollback_activation(state, rollback, None)
}

fn cancel_window_launch<R>(state: &WindowLaunchState, rollback: R) -> Result<bool, String>
where
    R: FnOnce() -> Result<(), String>,
{
    state.cancellation_requested.store(true, Ordering::SeqCst);
    let visibility = match state.visibility_gate.try_lock() {
        Ok(visibility) => Some(visibility),
        Err(TryLockError::WouldBlock) => None,
        Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
    };
    let previous = mark_window_cancelling(state);
    let changed = previous != WindowLaunchPhase::Cancelled;

    match dispatch_visibility_rollback(state, rollback) {
        Ok(()) => {
            // 门可能由另一个 canceller 持有。只要已无激活 owner，任一成功派发 hide
            // 的取消者都可提交终态；仍在激活时则由 owner 做最后一次回滚并提交。
            if visibility.is_some() || !state.activation_in_progress.load(Ordering::SeqCst) {
                set_window_phase(state, WindowLaunchPhase::Cancelled);
            }
            Ok(changed)
        }
        Err(error) => {
            if changed {
                Err(format!("window cancellation rollback failed: {error}"))
            } else {
                Err(format!("window cancellation retry failed: {error}"))
            }
        }
    }
}

fn cancel_after_kernel_eof<R>(
    state: &WindowLaunchState,
    handshake_seen: bool,
    rollback: R,
) -> Result<bool, String>
where
    R: FnOnce() -> Result<(), String>,
{
    if !handshake_seen {
        return Ok(false);
    }
    cancel_window_launch(state, rollback)
}

fn hide_main_window(app: &AppHandle) -> Result<(), String> {
    match app.get_webview_window("main") {
        Some(window) => window.hide().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

fn cancel_main_window(app: &AppHandle, state: &WindowLaunchState, context: &str) -> bool {
    kernel_access::revoke(app);
    match cancel_window_launch(state, || hide_main_window(app)) {
        Ok(changed) => changed,
        Err(error) => {
            eprintln!("{context}: {error}");
            false
        }
    }
}

fn repo_root() -> PathBuf {
    desktop_layout::current().workspace_root.clone()
}

/// 挑一个当前空闲的 127.0.0.1 端口。写死 KERNEL_PORT 的历史问题：僵尸内核 / dev
/// server / taskkill 放弃追踪后的残留都会占住端口，让本次内核 EADDRINUSE 秒死，
/// 用户看到的就是闪退。动态端口从构造上消掉这一类冲突（TOCTOU 窗口在本地回环
/// 上可忽略）。拿不到临时端口时回退固定端口。
fn pick_free_kernel_port() -> u16 {
    match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(_) => KERNEL_PORT,
        },
        Err(_) => KERNEL_PORT,
    }
}

fn kernel_stderr_log_path() -> PathBuf {
    boot_dir().join("kernel-stderr.log")
}

/// 启动反馈窗（splash）：内核握手前用户面前什么都没有（冷启 + 杀软扫描可能 10s+），
/// 感官上就是"点了没反应"。壳一启动就展示极小的 frameless 占位窗（dist/index.html，
/// frontendDist 内置资源，不依赖内核），主窗口 Live 后由 supervisor 关闭；
/// 失败路径统一在 supervisor 收尾/ app.exit 时随应用销毁，不额外维护生命周期。
fn show_splash_window(app: &AppHandle) {
    let built = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("index.html".into()))
        .title("514cc Console")
        .decorations(false)
        .resizable(false)
        .inner_size(380.0, 220.0)
        .center()
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .build();
    match built {
        Ok(_) => boot_log("splash window shown"),
        Err(error) => boot_log(&format!("splash window failed (non-fatal): {error}")),
    }
}

fn close_splash_window(app: &AppHandle) {
    if let Some(splash) = app.get_webview_window("splash") {
        if let Err(error) = splash.close() {
            eprintln!("failed to close splash window: {error}");
        }
    }
}

fn show_fatal_error(title: &str, message: &str) {
    eprintln!("{title}: {message}");
    #[cfg(windows)]
    {
        // GUI 子系统进程的 stderr 没人看；致命启动失败必须可见，否则就是"无声闪退"。
        use std::os::windows::ffi::OsStrExt;
        let wide = |s: &str| -> Vec<u16> {
            std::ffi::OsStr::new(s)
                .encode_wide()
                .chain(Some(0))
                .collect()
        };
        let text = wide(message);
        let caption = wide(title);
        #[link(name = "user32")]
        extern "system" {
            fn MessageBoxW(hwnd: usize, text: *const u16, caption: *const u16, utype: u32) -> i32;
        }
        const MB_ICONERROR: u32 = 0x10;
        unsafe { MessageBoxW(0, text.as_ptr(), caption.as_ptr(), MB_ICONERROR) };
    }
    let _ = title;
}

/// 解析 node 可执行路径。桌面壳从快捷方式/资源管理器启动时，PATH 常不含 fnm/node，
/// 仅写 `node` 会 spawn 失败并秒退——这是 LO 反馈「没看到启动」的主因之一。
fn resolve_node_binary() -> PathBuf {
    if let Some(node) = &desktop_layout::current().node {
        return node.clone();
    }
    if let Ok(path) = std::env::var("CC_NODE") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return candidate;
        }
    }
    #[cfg(windows)]
    {
        if let Ok(output) = Command::new("where.exe").arg("node").output() {
            if output.status.success() {
                if let Some(line) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let candidate = PathBuf::from(line.trim());
                    if candidate.is_file() {
                        return candidate;
                    }
                }
            }
        }
        // 本机常见落点（LO 环境实测：Dprogress 全局 node；fnm 多壳路径不稳定）
        for candidate in [
            r"C:\Dprogress\nodejs\node.exe",
            r"C:\Program Files\nodejs\node.exe",
            r"C:\Program Files (x86)\nodejs\node.exe",
        ] {
            let path = PathBuf::from(candidate);
            if path.is_file() {
                return path;
            }
        }
    }
    PathBuf::from("node")
}

fn boot_dir() -> PathBuf {
    let dir = desktop_layout::current().log_root.clone();
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn boot_log_path() -> PathBuf {
    boot_dir().join("desktop-boot.log")
}

fn boot_log(message: &str) {
    use std::io::Write;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let text = format!("[{stamp}] {message}\n");
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(boot_log_path())
    {
        let _ = file.write_all(text.as_bytes());
    }
    eprintln!("{message}");
}

fn spawn_kernel(port: u16) -> std::io::Result<Child> {
    let cc_dir = desktop_layout::current().kernel_dir.clone();
    let node = resolve_node_binary();
    boot_log(&format!(
        "spawn_kernel port={port} node={} cwd={}",
        node.display(),
        cc_dir.display()
    ));
    // 与 package.json `npm start` 对齐：Node 22 需 --experimental-sqlite（sessions 读 Cursor 等源）
    let mut cmd = Command::new(&node);
    cmd.arg("--experimental-sqlite")
        .arg(cc_dir.join("server.mjs"))
        .current_dir(&cc_dir)
        .env("CONTROL_CENTER_PORT", port.to_string())
        .env("CONTROL_CENTER_REPO_ROOT", repo_root())
        .env(
            "CONTROL_CENTER_DATA_DIR",
            &desktop_layout::current().data_root,
        )
        .env("CC_ROOT", repo_root())
        .stdout(Stdio::piped());
    // stderr 直接落文件：内核启动期崩溃/端口占用必须留痕可诊断。历史做法 Stdio::null()
    // 把死因吞掉；piped-不读会在缓冲满后卡死子进程，也不可用。
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(kernel_stderr_log_path())
    {
        Ok(file) => {
            cmd.stderr(Stdio::from(file));
            boot_log(&format!(
                "kernel stderr -> {}",
                kernel_stderr_log_path().display()
            ));
        }
        Err(_) => {
            cmd.stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// 严格解析握手行：固定前缀 + http + 127.0.0.1 + 本次启动传入的期望端口 + 非空认证片段。
/// 当前内核使用单次 bootstrap nonce；保留 token 兼容，避免旧内核无法被新版壳启动。
/// 尾随文本按空白截断，不把整行交给 URL 解析器。
fn parse_kernel_url(line: &str, expected_port: u16) -> Option<Url> {
    let rest = line.strip_prefix(URL_PREFIX)?;
    let raw = rest.split_whitespace().next()?;
    let url: Url = raw.parse().ok()?;
    let valid = url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(expected_port)
        && url.fragment().is_some_and(|fragment| {
            ["bootstrap=", "token="].iter().any(|prefix| {
                fragment
                    .strip_prefix(prefix)
                    .is_some_and(|value| !value.is_empty())
            })
        });
    valid.then_some(url)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc, Barrier};
    use std::time::Duration;

    use super::{
        activate_window, cancel_after_kernel_eof, cancel_window_launch, parse_kernel_url,
        window_phase, WindowLaunchPhase, WindowLaunchState, KERNEL_PORT,
    };

    #[test]
    fn accepts_current_bootstrap_and_legacy_token_urls() {
        assert!(parse_kernel_url(
            "514cc Control Center: http://127.0.0.1:51400/#bootstrap=single-use-nonce",
            KERNEL_PORT,
        )
        .is_some());
        assert!(parse_kernel_url(
            "514cc Control Center: http://127.0.0.1:51400/#token=legacy-bearer",
            KERNEL_PORT,
        )
        .is_some());
    }

    #[test]
    fn validates_against_the_expected_dynamic_port() {
        let line = "514cc Control Center: http://127.0.0.1:59122/#bootstrap=nonce";
        assert!(parse_kernel_url(line, 59122).is_some());
        assert!(parse_kernel_url(line, 51401).is_none());
        assert!(parse_kernel_url(line, KERNEL_PORT).is_none());
    }

    #[test]
    fn rejects_empty_or_untrusted_handshake_urls() {
        for line in [
            "514cc Control Center: http://127.0.0.1:51400/#bootstrap=",
            "514cc Control Center: http://127.0.0.1:51400/#token=",
            "514cc Control Center: http://127.0.0.1:51400/#other=value",
            "514cc Control Center: http://127.0.0.1/#bootstrap=nonce",
            "514cc Control Center: http://localhost:51400/#bootstrap=nonce",
            "514cc Control Center: http://127.0.0.1:51401/#bootstrap=nonce",
            "514cc Control Center: http://127.0.0.1:51400@evil.example/#bootstrap=nonce",
            "514cc Control Center: https://127.0.0.1:51400/#bootstrap=nonce",
            "prefix 514cc Control Center: http://127.0.0.1:51400/#bootstrap=nonce",
        ] {
            assert!(
                parse_kernel_url(line, KERNEL_PORT).is_none(),
                "unexpectedly accepted {line}"
            );
        }
    }

    #[test]
    fn cancelled_window_launch_rejects_late_readiness() {
        let state = WindowLaunchState::new();
        let visibility_calls = AtomicUsize::new(0);

        assert_eq!(cancel_window_launch(&state, || Ok(())), Ok(true));
        assert_eq!(
            activate_window(
                &state,
                || {
                    visibility_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                || Ok(()),
                || Ok(()),
            ),
            Ok(false)
        );
        assert_eq!(visibility_calls.load(Ordering::SeqCst), 0);
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
    }

    #[test]
    fn pre_handshake_eof_keeps_retry_pending_but_post_handshake_eof_cancels() {
        let state = WindowLaunchState::new();
        assert_eq!(
            cancel_after_kernel_eof(&state, false, || panic!("no window to hide")),
            Ok(false)
        );
        assert_eq!(window_phase(&state), WindowLaunchPhase::Pending);
        assert_eq!(
            activate_window(&state, || Ok(()), || Ok(()), || Ok(())),
            Ok(true)
        );
        assert_eq!(window_phase(&state), WindowLaunchPhase::Live);
        assert_eq!(cancel_after_kernel_eof(&state, true, || Ok(())), Ok(true));
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
        assert_eq!(
            activate_window(&state, || Ok(()), || Ok(()), || Ok(())),
            Ok(false)
        );
    }

    #[test]
    fn readiness_claim_has_one_owner_and_runs_visibility_once() {
        let state = WindowLaunchState::new();
        let visibility_calls = AtomicUsize::new(0);
        assert_eq!(
            activate_window(
                &state,
                || {
                    visibility_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                || Ok(()),
                || Ok(())
            ),
            Ok(true)
        );
        assert_eq!(
            activate_window(
                &state,
                || {
                    visibility_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
                || Ok(()),
                || Ok(())
            ),
            Ok(false)
        );
        assert_eq!(visibility_calls.load(Ordering::SeqCst), 1);
        assert_eq!(window_phase(&state), WindowLaunchPhase::Live);
    }

    #[test]
    fn failed_visibility_verification_rolls_back_and_cancels_launch() {
        let state = WindowLaunchState::new();
        let visible = AtomicBool::new(false);
        let rollback_calls = AtomicUsize::new(0);

        assert_eq!(
            activate_window(
                &state,
                || {
                    visible.store(true, Ordering::SeqCst);
                    Ok(())
                },
                || Err("visibility verification failed".into()),
                || {
                    rollback_calls.fetch_add(1, Ordering::SeqCst);
                    visible.store(false, Ordering::SeqCst);
                    Ok(())
                }
            ),
            Err("visibility verification failed".into())
        );
        assert!(!visible.load(Ordering::SeqCst));
        assert_eq!(rollback_calls.load(Ordering::SeqCst), 1);
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
    }

    #[test]
    fn cancellation_after_activation_claim_cannot_leave_a_late_show_visible() {
        let state = Arc::new(WindowLaunchState::new());
        let show_entered = Arc::new(Barrier::new(2));
        let release_show = Arc::new(Barrier::new(2));
        let visible = Arc::new(AtomicBool::new(false));
        let rollback_calls = Arc::new(AtomicUsize::new(0));

        let state_for_worker = state.clone();
        let entered_for_worker = show_entered.clone();
        let release_for_worker = release_show.clone();
        let visible_for_worker = visible.clone();
        let rollback_for_worker = rollback_calls.clone();
        let worker = std::thread::spawn(move || {
            activate_window(
                &state_for_worker,
                || {
                    entered_for_worker.wait();
                    release_for_worker.wait();
                    visible_for_worker.store(true, Ordering::SeqCst);
                    Ok(())
                },
                || Ok(()),
                || {
                    rollback_for_worker.fetch_add(1, Ordering::SeqCst);
                    visible_for_worker.store(false, Ordering::SeqCst);
                    Ok(())
                },
            )
        });

        show_entered.wait();
        assert_eq!(window_phase(&state), WindowLaunchPhase::Activating);
        let state_for_cancel = state.clone();
        let visible_for_cancel = visible.clone();
        let canceller = std::thread::spawn(move || {
            cancel_window_launch(&state_for_cancel, || {
                visible_for_cancel.store(false, Ordering::SeqCst);
                Ok(())
            })
        });
        while !state.cancellation_requested.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        release_show.wait();

        assert_eq!(
            worker.join().expect("activation worker panicked"),
            Ok(false)
        );
        assert!(matches!(
            canceller.join().expect("cancellation worker panicked"),
            Ok(false) | Ok(true)
        ));
        assert!(!visible.load(Ordering::SeqCst));
        assert_eq!(rollback_calls.load(Ordering::SeqCst), 1);
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
    }

    #[test]
    fn cancellation_does_not_wait_for_activation_visibility_gate() {
        let state = Arc::new(WindowLaunchState::new());
        let show_entered = Arc::new(Barrier::new(2));
        let release_show = Arc::new(Barrier::new(2));
        let rollback_calls = Arc::new(AtomicUsize::new(0));

        let state_for_activation = state.clone();
        let entered_for_activation = show_entered.clone();
        let release_for_activation = release_show.clone();
        let rollback_for_activation = rollback_calls.clone();
        let activation = std::thread::spawn(move || {
            activate_window(
                &state_for_activation,
                || {
                    entered_for_activation.wait();
                    release_for_activation.wait();
                    Ok(())
                },
                || Ok(()),
                || {
                    rollback_for_activation.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                },
            )
        });

        show_entered.wait();
        let (done_tx, done_rx) = mpsc::channel();
        let state_for_cancel = state.clone();
        let rollback_for_cancel = rollback_calls.clone();
        let canceller = std::thread::spawn(move || {
            let result = cancel_window_launch(&state_for_cancel, || {
                rollback_for_cancel.fetch_add(1, Ordering::SeqCst);
                Ok(())
            });
            let _ = done_tx.send(result.clone());
            result
        });

        assert!(done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("cancellation blocked on the activation visibility gate")
            .is_ok());
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelling);
        release_show.wait();

        assert_eq!(
            activation.join().expect("activation worker panicked"),
            Ok(false)
        );
        assert!(canceller
            .join()
            .expect("cancellation worker panicked")
            .is_ok());
        assert_eq!(rollback_calls.load(Ordering::SeqCst), 2);
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
    }

    #[test]
    fn successful_concurrent_canceller_finalizes_after_other_hide_fails() {
        let state = Arc::new(WindowLaunchState::new());
        assert_eq!(
            activate_window(&state, || Ok(()), || Ok(()), || Ok(())),
            Ok(true)
        );

        let first_hide_entered = Arc::new(Barrier::new(2));
        let release_first_hide = Arc::new(Barrier::new(2));
        let state_for_first = state.clone();
        let entered_for_first = first_hide_entered.clone();
        let release_for_first = release_first_hide.clone();
        let first = std::thread::spawn(move || {
            cancel_window_launch(&state_for_first, || {
                entered_for_first.wait();
                release_for_first.wait();
                Err("first hide failed".into())
            })
        });

        first_hide_entered.wait();
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelling);
        assert_eq!(cancel_window_launch(&state, || Ok(())), Ok(true));
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);

        release_first_hide.wait();
        assert!(first
            .join()
            .expect("first cancellation worker panicked")
            .is_err());
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
    }

    #[test]
    fn successful_canceller_handoff_survives_activation_rollback_failure() {
        let state = Arc::new(WindowLaunchState::new());
        let owner_hide_entered = Arc::new(Barrier::new(2));
        let release_owner_hide = Arc::new(Barrier::new(2));

        let state_for_activation = state.clone();
        let entered_for_activation = owner_hide_entered.clone();
        let release_for_activation = release_owner_hide.clone();
        let activation = std::thread::spawn(move || {
            activate_window(
                &state_for_activation,
                || Ok(()),
                || Err("visibility verification failed".into()),
                || {
                    entered_for_activation.wait();
                    release_for_activation.wait();
                    Err("activation owner hide failed".into())
                },
            )
        });

        owner_hide_entered.wait();
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelling);
        assert_eq!(cancel_window_launch(&state, || Ok(())), Ok(true));
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelling);

        release_owner_hide.wait();
        assert!(activation
            .join()
            .expect("activation worker panicked")
            .is_err());
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
    }

    #[test]
    fn hide_during_show_cannot_finalize_after_late_show_and_failed_owner_hide() {
        let state = Arc::new(WindowLaunchState::new());
        let show_entered = Arc::new(Barrier::new(2));
        let release_show = Arc::new(Barrier::new(2));

        let state_for_activation = state.clone();
        let entered_for_activation = show_entered.clone();
        let release_for_activation = release_show.clone();
        let activation = std::thread::spawn(move || {
            activate_window(
                &state_for_activation,
                || {
                    entered_for_activation.wait();
                    release_for_activation.wait();
                    Ok(())
                },
                || Ok(()),
                || Err("activation owner hide failed".into()),
            )
        });

        show_entered.wait();
        assert_eq!(cancel_window_launch(&state, || Ok(())), Ok(true));
        release_show.wait();
        assert!(activation
            .join()
            .expect("activation worker panicked")
            .is_err());
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelling);

        assert_eq!(cancel_window_launch(&state, || Ok(())), Ok(true));
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
    }

    #[test]
    fn cancellation_after_show_before_live_rolls_visibility_back() {
        let state = Arc::new(WindowLaunchState::new());
        let verification_entered = Arc::new(Barrier::new(2));
        let release_verification = Arc::new(Barrier::new(2));
        let visible = Arc::new(AtomicBool::new(false));

        let state_for_worker = state.clone();
        let entered_for_worker = verification_entered.clone();
        let release_for_worker = release_verification.clone();
        let visible_for_worker = visible.clone();
        let worker = std::thread::spawn(move || {
            activate_window(
                &state_for_worker,
                || {
                    visible_for_worker.store(true, Ordering::SeqCst);
                    Ok(())
                },
                || {
                    entered_for_worker.wait();
                    release_for_worker.wait();
                    Ok(())
                },
                || {
                    visible_for_worker.store(false, Ordering::SeqCst);
                    Ok(())
                },
            )
        });

        verification_entered.wait();
        assert!(visible.load(Ordering::SeqCst));
        let state_for_cancel = state.clone();
        let visible_for_cancel = visible.clone();
        let canceller = std::thread::spawn(move || {
            cancel_window_launch(&state_for_cancel, || {
                visible_for_cancel.store(false, Ordering::SeqCst);
                Ok(())
            })
        });
        while !state.cancellation_requested.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        release_verification.wait();

        assert_eq!(
            worker.join().expect("activation worker panicked"),
            Ok(false)
        );
        assert!(canceller
            .join()
            .expect("cancellation worker panicked")
            .is_ok());
        assert!(!visible.load(Ordering::SeqCst));
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
    }

    #[test]
    fn cancellation_after_live_before_receipt_hides_the_window() {
        let state = WindowLaunchState::new();
        let visible = AtomicBool::new(false);

        assert_eq!(
            activate_window(
                &state,
                || {
                    visible.store(true, Ordering::SeqCst);
                    Ok(())
                },
                || Ok(()),
                || {
                    visible.store(false, Ordering::SeqCst);
                    Ok(())
                },
            ),
            Ok(true)
        );
        assert_eq!(window_phase(&state), WindowLaunchPhase::Live);
        assert_eq!(
            cancel_window_launch(&state, || {
                visible.store(false, Ordering::SeqCst);
                Ok(())
            }),
            Ok(true)
        );
        assert!(!visible.load(Ordering::SeqCst));
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
    }

    #[test]
    fn failed_hide_stays_cancelling_until_a_retry_succeeds() {
        let state = WindowLaunchState::new();

        assert!(activate_window(
            &state,
            || Ok(()),
            || Err("hwnd failed".into()),
            || Err("hide failed".into()),
        )
        .is_err());
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelling);
        assert_eq!(cancel_window_launch(&state, || Ok(())), Ok(true));
        assert_eq!(window_phase(&state), WindowLaunchPhase::Cancelled);
    }
}

/// 有界回收：try_wait 轮询 + 硬截止。true = 已回收。
/// try_wait 出错时如实打印并按"未回收"返回（状态未知走安全方向，烛 R3）。
fn reap_within(child: &mut Child, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Err(e) => {
                eprintln!("try_wait failed ({e}); kernel state unknown");
                return false;
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

/// 统一清理：杀整棵进程树 + 全程有界（烛 R2/R3：任何一步都不无界阻塞）。
/// Windows 无 SIGTERM 等价物，taskkill /T /F 杀树（内核会 spawn 健康探测子进程，
/// 只杀直接 child 会留孤儿）。taskkill 以 fire-and-forget 方式 spawn——不等它退出，
/// 它自身卡死也不阻塞我们（极端下泄漏一个系统工具进程，交 OS，好过壳挂死）。
/// 5s 内核未死 → 回退 child.kill() 再给 2s → 仍未死如实放弃交 OS。
/// 内核 instance-lock 有 stale 回收（强杀后重启已实测可恢复），强杀不破坏下次启动。
fn kill_kernel_tree(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return; // 已死已回收
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn(); // 不 status()：等待 taskkill 本身就是无界阻塞点（烛 R3）
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    if !reap_within(child, Duration::from_secs(5)) {
        eprintln!("kernel tree not down after taskkill budget; falling back to direct kill");
        let _ = child.kill();
        if !reap_within(child, Duration::from_secs(2)) {
            // 如实语义（烛 R4）：Windows 不会自动杀孤儿进程——这里是"停止追踪并退出"，
            // 不是"OS 会收拾"。极端场景（taskkill 且 kill 全失败）内核可能残留，日志留痕。
            eprintln!("kernel still alive after all bounded attempts; giving up tracking");
        }
    }
}

/// 启动内核 stdout 读线程；返回 false 表示线程无法创建（调用方负责清理与退出）。
/// 抓到握手行后继续读到 EOF——EOF 即内核死亡信号（运行期监督，不再轮询 try_wait）。
/// 每次内核启动（含握手前死亡后的重试）都要以当次端口重建读线程。
fn start_stdout_reader(
    app: &AppHandle,
    tx: &Sender<Event>,
    window_launch_state: Arc<WindowLaunchState>,
    stdout: Option<std::process::ChildStdout>,
    expected_port: u16,
) -> bool {
    let Some(stdout) = stdout else {
        eprintln!("kernel stdout unavailable");
        return false;
    };
    let tx_reader = tx.clone();
    let app_for_reader = app.clone();
    let spawned = std::thread::Builder::new()
        .name("514cc-kernel-stdout".into())
        .spawn(move || {
            let mut url_sent = false;
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if !url_sent {
                    if let Some(url) = parse_kernel_url(&line, expected_port) {
                        url_sent = true;
                        boot_log("kernel URL ready (bootstrap credential omitted)");
                        if tx_reader.send(Event::UrlFound(url)).is_err() {
                            return;
                        }
                    } else if line.contains("514cc Control Center:") {
                        boot_log("kernel banner rejected by URL parser");
                    }
                }
            }
            if url_sent {
                kernel_access::revoke(&app_for_reader);
            }
            if let Err(error) = cancel_after_kernel_eof(&window_launch_state, url_sent, || {
                hide_main_window(&app_for_reader)
            }) {
                eprintln!("failed to hide main window after kernel stdout EOF: {error}");
            }
            let _ = tx_reader.send(Event::StdoutEof);
        })
        .is_ok();
    if !spawned {
        eprintln!("failed to spawn kernel stdout reader thread");
    }
    spawned
}

/// 实例锁文件结构（与 kernel 端 instance-lock.mjs 写入的 JSON 对齐）。
#[derive(Deserialize)]
struct LockOwner {
    pid: u32,
    #[serde(default)]
    image: String,
}

/// A shared lock is not proof of desktop process ownership. The kernel's
/// instance-lock service attests stale owners; live or unknown owners are kept.
fn inspect_kernel_lock() {
    let lock_path = repo_root()
        .join(".ai-shared")
        .join("control-center")
        .join("control-center.lock");
    let content = match std::fs::read_to_string(&lock_path) {
        Ok(c) => c,
        Err(_) => return, // 无锁文件 = 无孤儿
    };
    let owner: LockOwner = match serde_json::from_str(&content) {
        Ok(o) => o,
        Err(_) => {
            boot_log("malformed lock file; deferring recovery to kernel instance-lock");
            return;
        }
    };
    boot_log(&format!(
        "existing lock (PID {}, image {}); ownership verification delegated to kernel",
        owner.pid, owner.image
    ));
}

/// supervisor：独占 Child，事件驱动。返回前保证内核树已清理（有界）。
/// exit_requested：主线程在 RunEvent::ExitRequested 时提早置位的共享退出意图——
/// 早于 Exit 阶段的 Shutdown 消息，堵"内核死亡与关窗竞速导致误记异常退出码"（烛 R3）。
fn supervisor(
    app: AppHandle,
    tx: Sender<Event>,
    rx: Receiver<Event>,
    exit_requested: Arc<AtomicBool>,
    window_launch_state: Arc<WindowLaunchState>,
) {
    inspect_kernel_lock();
    // 每次内核启动都挑当次空闲端口（重试时再换新端口），从构造上避开僵尸/残留进程的端口占用。
    let mut kernel_port = pick_free_kernel_port();
    let mut retries_left = KERNEL_START_RETRIES;
    let mut child = match spawn_kernel(kernel_port) {
        Ok(c) => {
            boot_log("kernel process spawned");
            c
        }
        Err(e) => {
            boot_log(&format!(
                "kernel spawn failed: {e}. Check node on PATH / CC_NODE / CC_ROOT."
            ));
            show_fatal_error(
                "514cc Console 启动失败",
                &format!(
                    "无法启动 514cc 内核 node={node} cwd={cwd}\n错误：{e}\n请检查 CC_NODE 环境变量或 desktop-boot.log。",
                    node = resolve_node_binary().display(),
                    cwd = repo_root().join("apps").join("control-center").display(),
                ),
            );
            app.exit(1);
            return;
        }
    };

    if !start_stdout_reader(
        &app,
        &tx,
        window_launch_state.clone(),
        child.stdout.take(),
        kernel_port,
    ) {
        cancel_main_window(
            &app,
            &window_launch_state,
            "failed to hide main window after stdout reader unavailability",
        );
        show_fatal_error(
            "514cc Console 启动失败",
            "内核输出监控线程无法创建，已终止启动。详情见 desktop-boot.log。",
        );
        kill_kernel_tree(&mut child);
        app.exit(1);
        return;
    }

    let mut deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut window_up = false;
    let mut clean_shutdown = false;
    let mut ready_delivery_grace_used = false;
    // 本轮内核是否已交付握手 URL：只在握手前 EOF 时才值得换端口重试。
    let mut handshake_seen = false;

    loop {
        let timeout = if window_up {
            Duration::from_secs(3600) // 运行期无 deadline，只等事件
        } else {
            deadline.saturating_duration_since(Instant::now())
        };
        match rx.recv_timeout(timeout) {
            Ok(Event::UrlFound(url)) => {
                if let Err(error) =
                    app.state::<kernel_access::KernelAccess>()
                        .grant(kernel_port, |capability| {
                            app.add_capability(capability)
                                .map_err(|error| error.to_string())
                        })
                {
                    eprintln!("kernel native access grant rejected: {error}");
                    break;
                }
                handshake_seen = true;
                // 猫窗 URL 的 base origin（无 fragment）；猫页凭据由前端桥交，壳不经手 token
                native::set_pet_overlay_origin(url.origin().ascii_serialization());
                // 给窗口构建留出独立预算，消除"URL 已到却被启动超时误杀"的边界
                deadline = Instant::now() + WINDOW_READY_TIMEOUT;
                ready_delivery_grace_used = false;
                let tx_win = tx.clone();
                let app_win = app.clone();
                let state_for_builder = window_launch_state.clone();
                // Tauri 2 / WebView2：builder 在独立线程，结果回传 supervisor。
                // 关键修复（LO 反馈任务栏闪一下就没了）：不要只等 PageLoadEvent::Finished。
                // 外部 URL + 单次 bootstrap 时 Finished 可能迟迟不来，15s 看门狗会杀进程，
                // 用户只看到任务栏闪一下。build 成功后立刻 show + 报告 Live。
                let spawned = std::thread::Builder::new()
                    .name("514cc-window-builder".into())
                    .spawn(move || {
                        let tx_ready = tx_win.clone();
                        let state_for_ready = state_for_builder.clone();
                        let built = WebviewWindowBuilder::new(
                            &app_win,
                            "main",
                            WebviewUrl::External(url),
                        )
                        .title("514 Forge · Control Center")
                        // 控制台形态第七轮：去掉原生标题栏，窗口框与 topbar 合一（Codex 式 slim 横带）。
                        // 前端通过 data-tauri-drag-region + plugin:window 命令自绘拖拽区与最小化/最大化/关闭钮。
                        .decorations(false)
                        .inner_size(1440.0, 920.0)
                        .min_inner_size(960.0, 640.0)
                        .visible(true)
                        .focused(true)
                        .on_page_load(move |window, payload| {
                            // 页面完成后补一次前置/焦点；不作为唯一就绪条件
                            if payload.event() != PageLoadEvent::Finished {
                                return;
                            }
                            if let Err(error) = native::flush_pending_deep_links(&window) {
                                eprintln!("failed to flush native deep links after page load: {error}");
                            }
                            let _ = window.show();
                            let _ = window.set_focus();
                            #[cfg(windows)]
                            if let Ok(hwnd) = window.hwnd() {
                                eprintln!("console page finished: hwnd={hwnd:?}");
                            }
                        })
                        .build();

                        match built {
                            Ok(window) => {
                                let activation = activate_window(
                                    &state_for_ready,
                                    || {
                                        window.show().map_err(|error| error.to_string())?;
                                        let _ = window.unminimize();
                                        let _ = window.set_focus();
                                        Ok(())
                                    },
                                    || {
                                        // 可见性：show 成功即够；is_visible 在部分 WebView2 时机会假阴性
                                        #[cfg(windows)]
                                        {
                                            let hwnd =
                                                window.hwnd().map_err(|error| error.to_string())?;
                                            eprintln!(
                                                "console window activated: hwnd={hwnd:?}"
                                            );
                                        }
                                        Ok(())
                                    },
                                    || window.hide().map_err(|error| error.to_string()),
                                );
                                let activation_event = match activation {
                                    Ok(true) => Ok(()),
                                    Ok(false) => {
                                        // 取消已获胜：仍报告失败以免 supervisor 空等
                                        Err("window activation cancelled".to_string())
                                    }
                                    Err(error) => Err(error),
                                };
                                let was_live = activation_event.is_ok();
                                if was_live {
                                    if let Err(error) = native::flush_pending_deep_links(&window) {
                                        eprintln!(
                                            "native deep links remain queued after activation: {error}"
                                        );
                                    }
                                }
                                if tx_ready
                                    .send(Event::WindowActivated(activation_event))
                                    .is_err()
                                    && was_live
                                {
                                    if let Err(error) = cancel_window_launch(
                                        &state_for_ready,
                                        || window.hide().map_err(|error| error.to_string()),
                                    ) {
                                        eprintln!(
                                            "failed to cancel activated window after supervisor exit: {error}"
                                        );
                                    }
                                }
                            }
                            Err(error) => {
                                if cancel_main_window(
                                    &app_win,
                                    &state_for_builder,
                                    "failed to hide main window after builder failure",
                                ) {
                                    let _ = tx_win
                                        .send(Event::WindowActivated(Err(error.to_string())));
                                }
                            }
                        }
                    });
                if let Err(error) = spawned {
                    cancel_main_window(
                        &app,
                        &window_launch_state,
                        "failed to hide main window after builder thread spawn failure",
                    );
                    eprintln!("failed to spawn window builder thread: {error}");
                    break;
                }
            }
            Ok(Event::WindowActivated(Ok(()))) => {
                if window_phase(&window_launch_state) == WindowLaunchPhase::Live {
                    window_up = true;
                    close_splash_window(&app); // 主窗口已可见：启动反馈窗退场
                } else {
                    // EOF/ExitRequested 可在回执入队前覆盖 Live；对应事件仍会随后到达。
                    eprintln!("console window activation was superseded by cancellation");
                }
            }
            Ok(Event::WindowActivated(Err(error))) => {
                cancel_main_window(
                    &app,
                    &window_launch_state,
                    "failed to hide main window after activation error",
                );
                eprintln!("console window activation failed: {error}");
                break;
            }
            Ok(Event::StdoutEof) => {
                if handshake_seen {
                    cancel_main_window(
                        &app,
                        &window_launch_state,
                        "failed to retry main window hide after stdout EOF",
                    );
                }
                // 关窗与内核死亡可能竞速到达（烛 R2/R3）：先查共享退出意图（ExitRequested
                // 阶段已置位，早于 Shutdown 消息入队），再 drain 通道兜已入队的 Shutdown
                if exit_requested.load(Ordering::SeqCst) {
                    clean_shutdown = true;
                }
                while let Ok(ev) = rx.try_recv() {
                    if matches!(ev, Event::Shutdown) {
                        clean_shutdown = true;
                    }
                }
                // 内核在握手前死亡：多半是瞬时端口/资源竞态。换新端口自动重试，
                // 而不是让用户看到"任务栏闪一下就没了"。握手之后的死亡是运行期崩溃，不重试。
                if !clean_shutdown && !handshake_seen && retries_left > 0 {
                    retries_left -= 1;
                    kill_kernel_tree(&mut child); // 已死则立即返回；负责回收避免僵尸
                    kernel_port = pick_free_kernel_port();
                    boot_log(&format!(
                        "kernel died before handshake; restarting with fresh port {kernel_port} ({retries_left} retries left)"
                    ));
                    match spawn_kernel(kernel_port) {
                        Ok(new_child) => {
                            child = new_child;
                            handshake_seen = false;
                            deadline = Instant::now() + STARTUP_TIMEOUT;
                            window_up = false;
                            if start_stdout_reader(
                                &app,
                                &tx,
                                window_launch_state.clone(),
                                child.stdout.take(),
                                kernel_port,
                            ) {
                                continue;
                            }
                            show_fatal_error(
                                "514cc Console 启动失败",
                                "内核输出监控线程无法创建，已终止启动。详情见 desktop-boot.log。",
                            );
                            break;
                        }
                        Err(e) => {
                            show_fatal_error(
                                "514cc Console 启动失败",
                                &format!("内核重启失败：{e}\n诊断信息见 .scratch/desktop-launch/desktop-boot.log 与 kernel-stderr.log"),
                            );
                            break;
                        }
                    }
                }
                if !clean_shutdown && !handshake_seen {
                    boot_log("kernel died before handshake after exhausting retries");
                    show_fatal_error(
                        "514cc Console 启动失败",
                        &format!(
                            "内核多次在握手前退出，无法自动恢复。\n最近一次内核 stderr 见：{}",
                            kernel_stderr_log_path().display()
                        ),
                    );
                } else if !clean_shutdown {
                    eprintln!("514cc kernel exited unexpectedly (stdout EOF)");
                }
                break;
            }
            Ok(Event::Shutdown) => {
                cancel_main_window(
                    &app,
                    &window_launch_state,
                    "failed to hide main window during shutdown",
                );
                clean_shutdown = true;
                break;
            }
            Err(RecvTimeoutError::Timeout) => {
                if !window_up {
                    let phase = window_phase(&window_launch_state);
                    if phase == WindowLaunchPhase::Live && !ready_delivery_grace_used {
                        ready_delivery_grace_used = true;
                        deadline = Instant::now() + WINDOW_READY_DELIVERY_GRACE;
                        continue;
                    }

                    cancel_main_window(
                        &app,
                        &window_launch_state,
                        "failed to hide main window after readiness timeout",
                    );
                    if phase == WindowLaunchPhase::Pending {
                        eprintln!(
                            "514cc kernel/window did not become ready within the startup budget; giving up."
                        );
                        break;
                    }
                    eprintln!("console window readiness did not reach the supervisor in time");
                    break;
                }
                // window_up 时的 Timeout 只是长轮询到期，继续等事件
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    cancel_main_window(
        &app,
        &window_launch_state,
        "failed to hide main window during supervisor cleanup",
    );
    close_splash_window(&app); // 启动失败/超时/内核早夭路径：别让 splash 悬在桌面上
    kill_kernel_tree(&mut child);
    if !clean_shutdown {
        // 异常路径（启动失败/窗口失败/内核崩溃）：结束应用；正常关窗路径 app 已在退出中
        app.exit(1);
    }
}

fn main() {
    // Read the compiled identity before initializing any user directories or GUI.
    if std::env::args().any(|arg| arg == "--application-info") {
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        println!(
            "{}",
            serde_json::json!({
                "identifier": context.config().identifier,
                "productName": context.config().product_name,
                "version": context.config().version,
            })
        );
        return;
    }
    let runtime_info = std::env::args().any(|arg| arg == "--runtime-info");
    match desktop_layout::initialize() {
        Ok(layout) if runtime_info => {
            println!(
                "{}",
                serde_json::to_string(layout).expect("serializable runtime layout")
            );
            return;
        }
        Ok(_) => {}
        Err(error) => {
            if !runtime_info {
                show_fatal_error(
                    "514 Bot 启动失败",
                    &format!("运行资源或用户数据目录不可用：{error}"),
                );
            }
            eprintln!("desktop layout unavailable: {error}");
            std::process::exit(1);
        }
    }
    let (tx, rx) = mpsc::channel::<Event>();
    let rx_slot: Arc<Mutex<Option<Receiver<Event>>>> = Arc::new(Mutex::new(Some(rx)));
    let sup_handle: Arc<Mutex<Option<JoinHandle<()>>>> = Arc::new(Mutex::new(None));
    let exit_requested = Arc::new(AtomicBool::new(false));
    let window_launch_state = Arc::new(WindowLaunchState::new());

    let tx_setup = tx.clone();
    let rx_for_setup = rx_slot.clone();
    let handle_for_setup = sup_handle.clone();
    let exit_flag_setup = exit_requested.clone();
    let state_for_setup = window_launch_state.clone();

    let builder = tauri::Builder::default()
        .manage(native::NativeState::default())
        .manage(kernel_access::KernelAccess::default())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            native::get_native_capabilities,
            native::get_auto_launch_status,
            native::set_auto_launch,
            native::restart_app,
            native::is_portable_mode,
            native::copy_text_to_clipboard,
            native::set_window_theme,
            native::update_tray_menu,
            native::enter_lightweight_mode,
            native::exit_lightweight_mode,
            native::is_lightweight_mode,
            native::set_pet_overlay,
        ])
        .on_window_event(|window, event| match window.label() {
            "main" => {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Err(error) = native::hide_forge_window(window.app_handle()) {
                        eprintln!("failed to hide Forge on close request: {error}");
                    }
                }
            }
            "pet-overlay" => {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    if let Some(pet_window) = window
                        .app_handle()
                        .get_webview_window(native::PET_OVERLAY_LABEL)
                    {
                        native::save_pet_overlay_geometry_for_window(&pet_window);
                    }
                    native::publish_pet_visibility(window.app_handle(), false);
                }
            }
            _ => {}
        });

    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        let mut found_deep_link = false;
        for arg in &args {
            if native::accept_deep_link(app, arg, "single-instance callback") {
                found_deep_link = true;
            }
        }
        if !found_deep_link {
            if let Err(error) = native::show_forge_window(app) {
                eprintln!("failed to focus existing Forge instance: {error}");
            }
        }
    }));

    builder
        .setup(move |app| {
            native::install_tray(app.handle()).map_err(|error| {
                std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("failed to install native tray: {error}"),
                )
            })?;

            app.deep_link().on_open_url({
                let handle = app.handle().clone();
                move |event| {
                    for url in event.urls() {
                        if native::accept_deep_link(&handle, url.as_str(), "deep-link plugin") {
                            break;
                        }
                    }
                }
            });

            // Initial Windows/Linux protocol activation arrives as an argument. We only
            // receive here; protocol registration is installer-owned and setup never
            // calls register_all(), so running tests/builds cannot touch the registry.
            for arg in std::env::args().skip(1) {
                if native::accept_deep_link(app.handle(), &arg, "initial process args") {
                    break;
                }
            }

            let handle = app.handle().clone();
            // 启动反馈先行：splash 必须早于 supervisor 线程建立，保证「主窗口 Live →
            // 关 splash」时 splash 一定已存在（否则晚建的 splash 会悬在桌面上不退场）。
            show_splash_window(app.handle());
            let rx = rx_for_setup
                .lock()
                .expect("rx slot lock poisoned at setup")
                .take()
                .expect("supervisor receiver already taken");
            let tx_sup = tx_setup.clone();
            let flag = exit_flag_setup.clone();
            let state = state_for_setup.clone();
            let join = std::thread::spawn(move || supervisor(handle, tx_sup, rx, flag, state));
            *handle_for_setup
                .lock()
                .expect("supervisor handle lock poisoned at setup") = Some(join);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(move |app, event| match event {
            RunEvent::ExitRequested { .. } => {
                // 事件源先发布取消，激活回调若仍在 show/验证阶段会同步 hide 回滚。
                exit_requested.store(true, Ordering::SeqCst);
                cancel_main_window(
                    app,
                    &window_launch_state,
                    "failed to hide main window on ExitRequested",
                );
                let _ = tx.send(Event::Shutdown);
            }
            RunEvent::Exit => {
                exit_requested.store(true, Ordering::SeqCst);
                cancel_main_window(
                    app,
                    &window_launch_state,
                    "failed to hide main window on Exit",
                );
                let _ = tx.send(Event::Shutdown);
                // 独立作用域 take，避免持锁 join
                let join = sup_handle.lock().ok().and_then(|mut slot| slot.take());
                if let Some(join) = join {
                    let _ = join.join(); // supervisor 清理全程有界，join 不会无限挂
                }
            }
            _ => {}
        });
}
