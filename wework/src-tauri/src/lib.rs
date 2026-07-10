mod embedded_browser;
mod local_executor;
mod local_terminal;
mod process_environment;

#[cfg(all(desktop, target_os = "macos"))]
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
#[cfg(desktop)]
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::Manager;

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, WebviewWindowBuilder,
};

#[cfg(desktop)]
use tauri::webview::PageLoadEvent;

#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(desktop)]
const TRAY_OPEN_SETTINGS_EVENT: &str = "wework-tray-open-settings";
#[cfg(desktop)]
const TRAY_OPEN_TASK_EVENT: &str = "wework-tray-open-task";
#[cfg(desktop)]
const LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT: &str = "wework-open-local-workspace-requested";
#[cfg(desktop)]
const CLOSE_TO_TRAY_HINT_REQUESTED_EVENT: &str = "wework-close-to-tray-hint-requested";
#[cfg(desktop)]
const TRAY_MENU_OPEN_ID: &str = "open";
#[cfg(desktop)]
const TRAY_MENU_SETTINGS_ID: &str = "settings";
#[cfg(desktop)]
const TRAY_MENU_QUIT_ID: &str = "quit";
#[cfg(desktop)]
const TRAY_MENU_TASK_PREFIX: &str = "task:";

#[cfg(all(desktop, target_os = "macos"))]
thread_local! {
    static MACOS_CACHED_DOCK_ICON: RefCell<Option<objc2::rc::Retained<objc2_app_kit::NSImage>>> =
        const { RefCell::new(None) };
}
#[cfg(desktop)]
const TRAY_ID: &str = "wework-main";
#[cfg(desktop)]
const TRAY_USAGE_ICON_HEIGHT: u32 = 22;
#[cfg(desktop)]
const TRAY_USAGE_ICON_LEFT_PADDING: u32 = 0;
#[cfg(desktop)]
const TRAY_USAGE_ICON_TEXT_GAP: u32 = 2;
#[cfg(desktop)]
const TRAY_STATUS_METER_WIDTH: u32 = 7;
#[cfg(desktop)]
const TRAY_STATUS_METER_GAP: u32 = 6;
#[cfg(desktop)]
const TRAY_STATUS_METER_TEXT_GAP_OFFSET: u32 = 2;
#[cfg(desktop)]
const TRAY_USAGE_TEXT_LEFT_EXTRA_GAP: u32 = 2;
#[cfg(desktop)]
const TRAY_USAGE_ICON_SCALE: u32 = 2;
#[cfg(desktop)]
const TRAY_USAGE_GLYPH_WIDTH: u32 = 3;
#[cfg(desktop)]
const TRAY_USAGE_GLYPH_HEIGHT: u32 = 5;
#[cfg(desktop)]
const TRAY_USAGE_GLYPH_GAP: u32 = 1;
#[cfg(desktop)]
const TRAY_USAGE_SPACE_WIDTH: u32 = 1;
#[cfg(desktop)]
const TRAY_USAGE_LINE_GAP: u32 = 2;
#[cfg(desktop)]
const TRAY_USAGE_MAX_LINE: &str = "7d 100%";
#[cfg(desktop)]
const LOG_DIRECTORY_APP_NAME: &str = "Wework";
#[cfg(desktop)]
const LOG_DIRECTORY_VENDOR_NAME: &str = "Wegent";
#[cfg(desktop)]
const RUST_LOG_FILE_NAME: &str = "wework-tauri";
#[cfg(desktop)]
const WEBVIEW_LOG_FILE_NAME: &str = "wework-frontend";
#[cfg(desktop)]
const WEBVIEW_DEVTOOLS_ENV: &str = "WEWORK_WEBVIEW_DEVTOOLS";
#[cfg(desktop)]
const APP_PREFERENCES_FILE_NAME: &str = "app-preferences.json";
#[cfg(all(desktop, target_os = "macos"))]
const WEWORK_CLI_INSTALL_DIR: &str = ".local/bin";
#[cfg(all(desktop, target_os = "macos"))]
const WEWORK_CLI_INSTALL_NAME: &str = "wework";
#[cfg(all(desktop, target_os = "macos"))]
const WEWORK_CLI_MANAGED_MARKER: &str = "# Wework CLI launcher";

#[cfg(desktop)]
fn app_log_directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if cfg!(debug_assertions) {
        return local_executor::local_executor_log_dir_path();
    }

    #[cfg(target_os = "macos")]
    {
        return Ok(app
            .path()
            .home_dir()
            .map_err(|error| format!("Failed to locate home directory: {error}"))?
            .join("Library")
            .join("Logs")
            .join(LOG_DIRECTORY_VENDOR_NAME)
            .join(LOG_DIRECTORY_APP_NAME));
    }

    #[cfg(target_os = "windows")]
    {
        return Ok(app
            .path()
            .local_data_dir()
            .map_err(|error| format!("Failed to locate local data directory: {error}"))?
            .join(LOG_DIRECTORY_VENDOR_NAME)
            .join(LOG_DIRECTORY_APP_NAME)
            .join("logs"));
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(app
            .path()
            .data_dir()
            .map_err(|error| format!("Failed to locate data directory: {error}"))?
            .join(LOG_DIRECTORY_VENDOR_NAME)
            .join(LOG_DIRECTORY_APP_NAME)
            .join("logs"));
    }

    #[allow(unreachable_code)]
    app.path()
        .app_log_dir()
        .map_err(|error| format!("Failed to locate app log directory: {error}"))
}

#[cfg(desktop)]
fn create_log_plugin(
    app: &tauri::AppHandle,
) -> Result<tauri::plugin::TauriPlugin<tauri::Wry>, String> {
    let log_directory = app_log_directory(app)?;
    let process_id = std::process::id();
    let rust_log_file_name = format!("{RUST_LOG_FILE_NAME}-{process_id}");
    let webview_log_file_name = format!("{WEBVIEW_LOG_FILE_NAME}-{process_id}");
    Ok(tauri_plugin_log::Builder::default()
        .clear_targets()
        .level(log::LevelFilter::Debug)
        .target(
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                path: log_directory.clone(),
                file_name: Some(rust_log_file_name.into()),
            })
            .filter(|metadata| {
                !metadata
                    .target()
                    .starts_with(tauri_plugin_log::WEBVIEW_TARGET)
            }),
        )
        .target(
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                path: log_directory,
                file_name: Some(webview_log_file_name.into()),
            })
            .filter(|metadata| {
                metadata
                    .target()
                    .starts_with(tauri_plugin_log::WEBVIEW_TARGET)
            }),
        )
        .build())
}

#[cfg(desktop)]
#[tauri::command]
fn get_app_log_directory(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app_log_directory(&app)?.to_string_lossy().to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn open_app_log_directory(app: tauri::AppHandle) -> Result<(), String> {
    let log_directory = app_log_directory(&app)?;
    std::fs::create_dir_all(&log_directory)
        .map_err(|error| format!("Failed to create app log directory: {error}"))?;

    #[cfg(target_os = "macos")]
    let output = std::process::Command::new("open")
        .arg(&log_directory)
        .output()
        .map_err(|error| format!("Failed to run macOS open command: {error}"))?;

    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("explorer")
        .arg(&log_directory)
        .output()
        .map_err(|error| format!("Failed to run Windows explorer command: {error}"))?;

    #[cfg(target_os = "linux")]
    let output = std::process::Command::new("xdg-open")
        .arg(&log_directory)
        .output()
        .map_err(|error| format!("Failed to run xdg-open command: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err("Failed to open app log directory".to_string())
    } else {
        Err(stderr)
    }
}

#[cfg(not(desktop))]
#[tauri::command]
fn get_app_log_directory(_app: tauri::AppHandle) -> Result<String, String> {
    Err("App log directory is only available on desktop".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
fn open_app_log_directory(_app: tauri::AppHandle) -> Result<(), String> {
    Err("App log directory is only available on desktop".to_string())
}

#[cfg(desktop)]
fn env_flag_enabled(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .and_then(normalized_non_empty)
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
}

#[cfg(desktop)]
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPreferences {
    #[serde(default = "default_true")]
    close_to_tray_enabled: bool,
    #[serde(default = "default_true")]
    show_main_window_on_launch: bool,
    #[serde(default)]
    close_to_tray_hint_seen: bool,
    #[serde(default = "default_language_preference")]
    language: String,
    #[serde(default = "default_true")]
    terminal_context_injection_enabled: bool,
    #[serde(default)]
    task_completion_notifications_enabled: bool,
    #[serde(default = "default_true")]
    tray_unread_enabled: bool,
    #[serde(default = "default_true")]
    tray_running_enabled: bool,
    #[serde(default = "default_true")]
    tray_usage_enabled: bool,
}

#[cfg(desktop)]
fn default_true() -> bool {
    true
}

#[cfg(desktop)]
fn default_language_preference() -> String {
    "zh-CN".to_string()
}

#[cfg(desktop)]
impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            close_to_tray_enabled: true,
            show_main_window_on_launch: true,
            close_to_tray_hint_seen: false,
            language: default_language_preference(),
            terminal_context_injection_enabled: true,
            task_completion_notifications_enabled: false,
            tray_unread_enabled: true,
            tray_running_enabled: true,
            tray_usage_enabled: true,
        }
    }
}

#[cfg(desktop)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppPreferencesPatch {
    close_to_tray_enabled: Option<bool>,
    show_main_window_on_launch: Option<bool>,
    close_to_tray_hint_seen: Option<bool>,
    language: Option<String>,
    terminal_context_injection_enabled: Option<bool>,
    task_completion_notifications_enabled: Option<bool>,
    tray_unread_enabled: Option<bool>,
    tray_running_enabled: Option<bool>,
    tray_usage_enabled: Option<bool>,
}

#[cfg(desktop)]
#[derive(Clone)]
enum MainWindowOpenAction {
    Settings,
    Task(String),
    LocalWorkspace,
}

#[cfg(desktop)]
#[derive(Default)]
struct MainWindowLifecycleState {
    destroy_to_tray_in_progress: AtomicBool,
    pending_open_action: Mutex<Option<MainWindowOpenAction>>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalWorkspaceOpenRequest {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[derive(Default)]
struct LocalWorkspaceOpenState {
    #[cfg(desktop)]
    pending_requests: Mutex<Vec<LocalWorkspaceOpenRequest>>,
}

#[cfg(desktop)]
fn parse_local_workspace_open_request(argv: &[String]) -> Option<LocalWorkspaceOpenRequest> {
    let mut path: Option<String> = None;
    let mut label: Option<String> = None;
    let mut index = 1;

    while index < argv.len() {
        match argv[index].as_str() {
            "--open-workspace" => {
                index += 1;
                path = argv
                    .get(index)
                    .and_then(|value| normalized_non_empty(value.clone()));
            }
            "--workspace-label" => {
                index += 1;
                label = argv
                    .get(index)
                    .and_then(|value| normalized_non_empty(value.clone()));
            }
            _ => {}
        }
        index += 1;
    }

    path.map(|path| LocalWorkspaceOpenRequest { path, label })
}

#[cfg(desktop)]
fn queue_local_workspace_open_request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    request: LocalWorkspaceOpenRequest,
) {
    let state = app.state::<LocalWorkspaceOpenState>();
    match state.pending_requests.lock() {
        Ok(mut requests) => requests.push(request),
        Err(_) => {
            log::warn!("Failed to lock pending local workspace open requests");
            return;
        }
    }

    if let Err(error) = app.emit(LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT, ()) {
        log::debug!("Local workspace open request queued before frontend listener: {error}");
    }
}

#[cfg(desktop)]
#[tauri::command]
fn take_pending_local_workspace_open_requests(
    app: tauri::AppHandle,
) -> Result<Vec<LocalWorkspaceOpenRequest>, String> {
    let state = app.state::<LocalWorkspaceOpenState>();
    let mut requests = state
        .pending_requests
        .lock()
        .map_err(|_| "Failed to lock pending local workspace open requests".to_string())?;
    Ok(std::mem::take(&mut *requests))
}

#[cfg(not(desktop))]
#[tauri::command]
fn take_pending_local_workspace_open_requests(
    _app: tauri::AppHandle,
) -> Result<Vec<LocalWorkspaceOpenRequest>, String> {
    Err("Local workspace open requests are only available on desktop".to_string())
}

#[cfg(desktop)]
fn app_preferences_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("Failed to locate app config directory: {error}"))?
        .join(APP_PREFERENCES_FILE_NAME))
}

#[cfg(desktop)]
fn read_app_preferences_impl<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> AppPreferences {
    let Ok(path) = app_preferences_path(app) else {
        return AppPreferences::default();
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return AppPreferences::default();
    };
    serde_json::from_str::<AppPreferences>(&content).unwrap_or_default()
}

#[cfg(desktop)]
fn write_app_preferences_impl(
    app: &tauri::AppHandle,
    preferences: &AppPreferences,
) -> Result<(), String> {
    let path = app_preferences_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create app config directory: {error}"))?;
    }
    let content = serde_json::to_string_pretty(preferences)
        .map_err(|error| format!("Failed to serialize app preferences: {error}"))?;
    std::fs::write(path, content)
        .map_err(|error| format!("Failed to write app preferences: {error}"))
}

#[cfg(all(desktop, target_os = "macos"))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(all(desktop, target_os = "macos"))]
fn macos_app_bundle_for_executable(
    executable_path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    executable_path
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .map(std::path::Path::to_path_buf)
}

#[cfg(all(desktop, target_os = "macos"))]
fn wework_cli_launcher_content(
    executable_path: &std::path::Path,
    app_bundle_path: Option<&std::path::Path>,
) -> String {
    let executable = shell_single_quote(&executable_path.to_string_lossy());
    let app_bundle = app_bundle_path
        .map(|path| shell_single_quote(&path.to_string_lossy()))
        .unwrap_or_else(|| "''".to_string());

    format!(
        r#"#!/usr/bin/env bash
{WEWORK_CLI_MANAGED_MARKER}

set -euo pipefail

usage() {{
  cat <<'EOF'
Usage: wework [path]

Open a local workspace in the Wework desktop app.

Examples:
  wework
  wework .
  wework ~/projects/my-app
EOF
}}

if [ "${{1:-}}" = "-h" ] || [ "${{1:-}}" = "--help" ]; then
  usage
  exit 0
fi

if [ "$#" -gt 1 ]; then
  echo "wework: expected at most one path argument" >&2
  usage >&2
  exit 2
fi

TARGET_PATH="${{1:-.}}"

if [ ! -e "$TARGET_PATH" ]; then
  echo "wework: path does not exist: $TARGET_PATH" >&2
  exit 1
fi

if [ ! -d "$TARGET_PATH" ]; then
  echo "wework: path is not a directory: $TARGET_PATH" >&2
  exit 1
fi

ABSOLUTE_PATH="$(cd "$TARGET_PATH" && pwd -P)"
APP_BUNDLE={app_bundle}
WEWORK_EXECUTABLE={executable}

if [ -x "$WEWORK_EXECUTABLE" ]; then
  "$WEWORK_EXECUTABLE" --open-workspace "$ABSOLUTE_PATH" >/dev/null 2>&1 &
  exit 0
fi

if [ -n "$APP_BUNDLE" ] && [ -d "$APP_BUNDLE" ]; then
  exec open "$APP_BUNDLE" --args --open-workspace "$ABSOLUTE_PATH"
fi

echo "wework: unable to locate Wework app executable" >&2
exit 1
"#
    )
}

#[cfg(all(desktop, target_os = "macos"))]
fn can_replace_wework_cli_path(path: &std::path::Path) -> Result<bool, String> {
    if let Ok(target) = std::fs::read_link(path) {
        let target_text = target.to_string_lossy();
        return Ok(target_text.contains("wework") || target_text.contains("WeWork"));
    }

    if !path.exists() {
        return Ok(true);
    }

    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("Failed to inspect existing Wework CLI file: {error}"))?;
    Ok(content.contains(WEWORK_CLI_MANAGED_MARKER))
}

#[cfg(all(desktop, target_os = "macos"))]
fn install_wework_cli_impl(
    home_dir: &std::path::Path,
    executable_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let install_dir = home_dir.join(WEWORK_CLI_INSTALL_DIR);
    std::fs::create_dir_all(&install_dir)
        .map_err(|error| format!("Failed to create Wework CLI install directory: {error}"))?;
    let installed_path = install_dir.join(WEWORK_CLI_INSTALL_NAME);

    if !can_replace_wework_cli_path(&installed_path)? {
        return Err(format!(
            "Wework CLI install path already exists and is not managed by Wework: {}",
            installed_path.display()
        ));
    }

    if installed_path.exists() || std::fs::symlink_metadata(&installed_path).is_ok() {
        std::fs::remove_file(&installed_path)
            .map_err(|error| format!("Failed to replace existing Wework CLI file: {error}"))?;
    }

    let app_bundle = macos_app_bundle_for_executable(executable_path);
    let content = wework_cli_launcher_content(executable_path, app_bundle.as_deref());
    std::fs::write(&installed_path, content)
        .map_err(|error| format!("Failed to write Wework CLI launcher: {error}"))?;
    let mut permissions = std::fs::metadata(&installed_path)
        .map_err(|error| format!("Failed to inspect Wework CLI launcher: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&installed_path, permissions)
        .map_err(|error| format!("Failed to make Wework CLI executable: {error}"))?;

    Ok(installed_path)
}

#[cfg(all(desktop, target_os = "macos"))]
fn install_wework_cli_link(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let home_dir = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to locate home directory: {error}"))?;
    let executable_path = std::env::current_exe()
        .map_err(|error| format!("Failed to locate Wework executable: {error}"))?;
    install_wework_cli_impl(&home_dir, &executable_path)
}

#[cfg(all(desktop, not(target_os = "macos")))]
fn install_wework_cli_link(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Err("Wework CLI installation is only available on macOS".to_string())
}

#[cfg(not(desktop))]
fn install_wework_cli_link(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Err("Wework CLI installation is only available on desktop".to_string())
}

#[tauri::command]
fn install_wework_cli(app: tauri::AppHandle) -> Result<String, String> {
    install_wework_cli_link(&app).map(|path| path.to_string_lossy().to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn get_app_preferences(app: tauri::AppHandle) -> Result<AppPreferences, String> {
    Ok(read_app_preferences_impl(&app))
}

#[cfg(desktop)]
#[tauri::command]
fn update_app_preferences(
    app: tauri::AppHandle,
    patch: AppPreferencesPatch,
) -> Result<AppPreferences, String> {
    let mut preferences = read_app_preferences_impl(&app);
    if let Some(value) = patch.close_to_tray_enabled {
        preferences.close_to_tray_enabled = value;
    }
    if let Some(value) = patch.show_main_window_on_launch {
        preferences.show_main_window_on_launch = value;
    }
    if let Some(value) = patch.close_to_tray_hint_seen {
        preferences.close_to_tray_hint_seen = value;
    }
    if let Some(value) = patch.language {
        preferences.language = value;
    }
    if let Some(value) = patch.terminal_context_injection_enabled {
        preferences.terminal_context_injection_enabled = value;
    }
    if let Some(value) = patch.task_completion_notifications_enabled {
        preferences.task_completion_notifications_enabled = value;
    }
    if let Some(value) = patch.tray_unread_enabled {
        preferences.tray_unread_enabled = value;
    }
    if let Some(value) = patch.tray_running_enabled {
        preferences.tray_running_enabled = value;
    }
    if let Some(value) = patch.tray_usage_enabled {
        preferences.tray_usage_enabled = value;
    }
    write_app_preferences_impl(&app, &preferences)?;
    Ok(preferences)
}

#[cfg(not(desktop))]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPreferences {
    close_to_tray_enabled: bool,
    show_main_window_on_launch: bool,
    close_to_tray_hint_seen: bool,
    language: String,
    terminal_context_injection_enabled: bool,
    task_completion_notifications_enabled: bool,
    tray_unread_enabled: bool,
    tray_running_enabled: bool,
    tray_usage_enabled: bool,
}

#[cfg(not(desktop))]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppPreferencesPatch {
    close_to_tray_enabled: Option<bool>,
    show_main_window_on_launch: Option<bool>,
    close_to_tray_hint_seen: Option<bool>,
    language: Option<String>,
    terminal_context_injection_enabled: Option<bool>,
    task_completion_notifications_enabled: Option<bool>,
    tray_unread_enabled: Option<bool>,
    tray_running_enabled: Option<bool>,
    tray_usage_enabled: Option<bool>,
}

#[cfg(not(desktop))]
#[tauri::command]
fn get_app_preferences(_app: tauri::AppHandle) -> Result<AppPreferences, String> {
    Ok(AppPreferences {
        close_to_tray_enabled: true,
        show_main_window_on_launch: true,
        close_to_tray_hint_seen: false,
        language: "zh-CN".to_string(),
        terminal_context_injection_enabled: true,
        task_completion_notifications_enabled: false,
        tray_unread_enabled: true,
        tray_running_enabled: true,
        tray_usage_enabled: true,
    })
}

#[cfg(not(desktop))]
#[tauri::command]
fn update_app_preferences(
    _app: tauri::AppHandle,
    patch: AppPreferencesPatch,
) -> Result<AppPreferences, String> {
    Ok(AppPreferences {
        close_to_tray_enabled: patch.close_to_tray_enabled.unwrap_or(true),
        show_main_window_on_launch: patch.show_main_window_on_launch.unwrap_or(true),
        close_to_tray_hint_seen: patch.close_to_tray_hint_seen.unwrap_or(false),
        language: patch.language.unwrap_or_else(|| "zh-CN".to_string()),
        terminal_context_injection_enabled: patch
            .terminal_context_injection_enabled
            .unwrap_or(true),
        task_completion_notifications_enabled: patch
            .task_completion_notifications_enabled
            .unwrap_or(false),
        tray_unread_enabled: patch.tray_unread_enabled.unwrap_or(true),
        tray_running_enabled: patch.tray_running_enabled.unwrap_or(true),
        tray_usage_enabled: patch.tray_usage_enabled.unwrap_or(true),
    })
}

#[cfg(all(desktop, any(debug_assertions, feature = "release-devtools")))]
fn open_main_webview_devtools_impl(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("WebView window '{MAIN_WINDOW_LABEL}' was not found"))?;
    window.open_devtools();
    Ok(())
}

#[cfg(all(desktop, not(any(debug_assertions, feature = "release-devtools"))))]
fn open_main_webview_devtools_impl(_app: &tauri::AppHandle) -> Result<(), String> {
    Err("Web Inspector is only available in debug builds or release-devtools builds".to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn open_main_webview_devtools(app: tauri::AppHandle) -> Result<(), String> {
    open_main_webview_devtools_impl(&app)
}

#[cfg(not(desktop))]
#[tauri::command]
fn open_main_webview_devtools(_app: tauri::AppHandle) -> Result<(), String> {
    Err("Web Inspector is only available on desktop".to_string())
}

#[derive(serde::Serialize, Clone)]
struct ProcessDiagnosticsProcess {
    pid: u32,
    ppid: u32,
    group: String,
    rss_kib: u64,
    cpu_percent: f64,
    command: String,
}

#[derive(serde::Serialize, Clone)]
struct ProcessDiagnosticsGroup {
    group: String,
    process_count: usize,
    rss_kib: u64,
    cpu_percent: f64,
    pids: Vec<u32>,
}

#[derive(serde::Serialize, Clone)]
struct ProcessDiagnosticsSnapshot {
    timestamp_ms: u64,
    main_pid: u32,
    groups: Vec<ProcessDiagnosticsGroup>,
    processes: Vec<ProcessDiagnosticsProcess>,
}

#[derive(Clone)]
struct RawProcessInfo {
    pid: u32,
    ppid: u32,
    rss_kib: u64,
    cpu_percent: f64,
    command: String,
}

fn parse_process_snapshot_line(line: &str) -> Option<RawProcessInfo> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?.parse::<u32>().ok()?;
    let ppid = parts.next()?.parse::<u32>().ok()?;
    let rss_kib = parts.next()?.parse::<u64>().ok()?;
    let cpu_percent = parts.next()?.parse::<f64>().ok()?;
    let command = parts.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        return None;
    }

    Some(RawProcessInfo {
        pid,
        ppid,
        rss_kib,
        cpu_percent,
        command,
    })
}

fn collect_descendant_pids(processes: &[RawProcessInfo], roots: &[u32]) -> HashSet<u32> {
    let mut children_by_parent = HashMap::<u32, Vec<u32>>::new();
    for process in processes {
        children_by_parent
            .entry(process.ppid)
            .or_default()
            .push(process.pid);
    }

    let mut descendants = HashSet::new();
    let mut stack = roots.to_vec();
    while let Some(pid) = stack.pop() {
        if !descendants.insert(pid) {
            continue;
        }
        if let Some(children) = children_by_parent.get(&pid) {
            stack.extend(children);
        }
    }

    descendants
}

fn classify_process(
    process: &RawProcessInfo,
    main_pid: u32,
    terminal_process_ids: &HashSet<u32>,
    terminal_descendant_ids: &HashSet<u32>,
) -> Option<String> {
    if process.pid == main_pid {
        return Some("main".to_string());
    }
    if terminal_process_ids.contains(&process.pid) || terminal_descendant_ids.contains(&process.pid)
    {
        return Some("terminal".to_string());
    }
    if process.command.contains("com.apple.WebKit.WebContent") {
        return Some("webkit-webcontent".to_string());
    }
    if process.command.contains("com.apple.WebKit.GPU") {
        return Some("webkit-gpu".to_string());
    }
    if process.command.contains("com.apple.WebKit.Networking") {
        return Some("webkit-networking".to_string());
    }
    if process.command.contains("com.apple.WebKit") {
        return Some("webkit-other".to_string());
    }

    Some("child".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn get_wework_process_snapshot(
    local_terminal_state: tauri::State<'_, local_terminal::LocalTerminalState>,
) -> Result<ProcessDiagnosticsSnapshot, String> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss=,pcpu=,command="])
        .output()
        .map_err(|error| format!("Failed to run ps: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }

    let processes = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_process_snapshot_line)
        .collect::<Vec<_>>();
    let main_pid = std::process::id();
    let terminal_roots = local_terminal_state.active_process_ids()?;
    let app_process_ids = collect_descendant_pids(&processes, &[main_pid]);
    let terminal_process_ids = terminal_roots.iter().copied().collect::<HashSet<_>>();
    let terminal_descendant_ids = collect_descendant_pids(&processes, &terminal_roots);

    let mut related_processes = processes
        .iter()
        .filter(|process| app_process_ids.contains(&process.pid))
        .filter_map(|process| {
            let group = classify_process(
                process,
                main_pid,
                &terminal_process_ids,
                &terminal_descendant_ids,
            )?;
            Some(ProcessDiagnosticsProcess {
                pid: process.pid,
                ppid: process.ppid,
                group,
                rss_kib: process.rss_kib,
                cpu_percent: process.cpu_percent,
                command: process.command.clone(),
            })
        })
        .collect::<Vec<_>>();
    related_processes.sort_by(|left, right| right.rss_kib.cmp(&left.rss_kib));

    let mut groups_by_name = HashMap::<String, ProcessDiagnosticsGroup>::new();
    for process in &related_processes {
        let group = groups_by_name
            .entry(process.group.clone())
            .or_insert_with(|| ProcessDiagnosticsGroup {
                group: process.group.clone(),
                process_count: 0,
                rss_kib: 0,
                cpu_percent: 0.0,
                pids: Vec::new(),
            });
        group.process_count += 1;
        group.rss_kib += process.rss_kib;
        group.cpu_percent += process.cpu_percent;
        group.pids.push(process.pid);
    }

    let mut groups = groups_by_name.into_values().collect::<Vec<_>>();
    groups.sort_by(|left, right| right.rss_kib.cmp(&left.rss_kib));

    Ok(ProcessDiagnosticsSnapshot {
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| format!("System clock is before UNIX epoch: {error}"))?
            .as_millis() as u64,
        main_pid,
        groups,
        processes: related_processes,
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn get_wework_process_snapshot(
    _local_terminal_state: tauri::State<'_, local_terminal::LocalTerminalState>,
) -> Result<ProcessDiagnosticsSnapshot, String> {
    Err("Process diagnostics are currently available only on macOS".to_string())
}

fn normalized_non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn read_device_id_file(path: std::path::PathBuf) -> Option<String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(normalized_non_empty)
}

fn read_device_config(path: std::path::PathBuf) -> Option<String> {
    let value = std::fs::read_to_string(path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&value).ok()?;
    json.get("device_id")
        .and_then(|value| value.as_str())
        .map(String::from)
        .and_then(normalized_non_empty)
}

fn normalize_backend_url(value: &str) -> Option<String> {
    let mut value = value.trim().trim_end_matches('/').to_string();
    if value.is_empty() {
        return None;
    }
    if let Some(stripped) = value.strip_suffix("/api") {
        value = stripped.trim_end_matches('/').to_string();
    }
    if let Some(stripped) = value.strip_prefix("ws://") {
        value = format!("http://{stripped}");
    } else if let Some(stripped) = value.strip_prefix("wss://") {
        value = format!("https://{stripped}");
    }

    Some(value)
}

fn read_device_config_for_backend(
    path: std::path::PathBuf,
    expected_backend_url: Option<&str>,
) -> Option<String> {
    let value = std::fs::read_to_string(path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&value).ok()?;

    if let Some(expected_backend_url) = expected_backend_url {
        let actual_backend_url = json
            .get("connection")
            .and_then(|connection| connection.get("backend_url"))
            .and_then(|value| value.as_str())
            .and_then(normalize_backend_url)?;
        if actual_backend_url != expected_backend_url {
            return None;
        }
    }

    json.get("device_id")
        .and_then(|value| value.as_str())
        .map(String::from)
        .and_then(normalized_non_empty)
}

fn process_env_value(tokens: &[&str], key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    tokens
        .iter()
        .find_map(|token| token.strip_prefix(&prefix))
        .map(String::from)
        .and_then(normalized_non_empty)
}

fn process_config_arg(tokens: &[&str]) -> Option<std::path::PathBuf> {
    tokens
        .windows(2)
        .find_map(|pair| (pair[0] == "--config").then(|| std::path::PathBuf::from(pair[1])))
}

fn read_executor_process_device_id(expected_backend_url: Option<&str>) -> Option<String> {
    let output = std::process::Command::new("ps")
        .args(["eww", "-axo", "pid=,command="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut candidate_device_id = None;
    let mut candidate_count = 0;

    for line in stdout.lines() {
        if !line.contains("wegent-executor") {
            continue;
        }

        let tokens = line.split_whitespace().collect::<Vec<_>>();
        if tokens.len() < 2 || !tokens[1].contains("wegent-executor") {
            continue;
        }

        let process_backend_url = process_env_value(&tokens, "WEGENT_BACKEND_URL")
            .as_deref()
            .and_then(normalize_backend_url);
        if let Some(expected_backend_url) = expected_backend_url {
            if process_backend_url.as_deref() != Some(expected_backend_url) {
                continue;
            }
        }

        let device_id = process_env_value(&tokens, "DEVICE_ID")
            .or_else(|| {
                process_config_arg(&tokens)
                    .and_then(|path| read_device_config_for_backend(path, expected_backend_url))
            })
            .or_else(|| {
                process_env_value(&tokens, "WEGENT_EXECUTOR_HOME").and_then(|home| {
                    read_device_config_for_backend(
                        std::path::PathBuf::from(home).join("device-config.json"),
                        expected_backend_url,
                    )
                })
            })
            .or_else(|| {
                process_env_value(&tokens, "WECODE_HOME").and_then(|home| {
                    read_device_config_for_backend(
                        std::path::PathBuf::from(home)
                            .join("wegent-executor")
                            .join("device-config.json"),
                        expected_backend_url,
                    )
                })
            })
            .or_else(|| {
                process_env_value(&tokens, "HOME").and_then(|home| {
                    read_device_config_for_backend(
                        std::path::PathBuf::from(home)
                            .join(".wegent-executor")
                            .join("device-config.json"),
                        expected_backend_url,
                    )
                })
            });

        if let Some(device_id) = device_id {
            if expected_backend_url.is_some() {
                return Some(device_id);
            }
            candidate_count += 1;
            candidate_device_id = Some(device_id);
        }
    }

    (candidate_count == 1)
        .then_some(candidate_device_id)
        .flatten()
}

#[tauri::command]
fn local_path_exists(path: String) -> bool {
    let Some(path) = normalized_non_empty(path) else {
        return false;
    };

    std::path::Path::new(&path).exists()
}

fn local_workspace_opener_app_name(opener: &str) -> Option<&'static str> {
    match opener {
        "vscode" => Some("Visual Studio Code"),
        "vscode-insiders" => Some("Visual Studio Code - Insiders"),
        "cursor" => Some("Cursor"),
        "sublime-text" => Some("Sublime Text"),
        "windsurf" => Some("Windsurf"),
        "finder" => Some("Finder"),
        "terminal" => Some("Terminal"),
        "iterm2" => Some("iTerm"),
        "ghostty" => Some("Ghostty"),
        "warp" => Some("Warp"),
        "xcode" => Some("Xcode"),
        "android-studio" => Some("Android Studio"),
        "intellij-idea" => Some("IntelliJ IDEA"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn open_local_workspace_with_app(app_name: &str, path: &str) -> Result<(), String> {
    let output = std::process::Command::new("open")
        .args(["-a", app_name, path])
        .output()
        .map_err(|error| format!("Failed to run macOS open command: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!("Failed to open workspace with {app_name}"))
    } else {
        Err(stderr)
    }
}

#[cfg(not(target_os = "macos"))]
fn open_local_workspace_with_app(_app_name: &str, _path: &str) -> Result<(), String> {
    Err("Opening a local workspace is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn open_local_file_with_default_app(path: &str) -> Result<(), String> {
    let output = std::process::Command::new("open")
        .arg(path)
        .output()
        .map_err(|error| format!("Failed to run macOS open command: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err("Failed to open local file".to_string())
    } else {
        Err(stderr)
    }
}

#[cfg(not(target_os = "macos"))]
fn open_local_file_with_default_app(_path: &str) -> Result<(), String> {
    Err("Opening a local file is only supported on macOS".to_string())
}

#[tauri::command]
fn open_local_workspace(opener: String, path: String) -> Result<(), String> {
    let opener =
        normalized_non_empty(opener).ok_or_else(|| "Workspace opener is empty".to_string())?;
    let path = normalized_non_empty(path).ok_or_else(|| "Workspace path is empty".to_string())?;
    let app_name = local_workspace_opener_app_name(&opener)
        .ok_or_else(|| format!("Unsupported workspace opener: {opener}"))?;

    if !std::path::Path::new(&path).exists() {
        return Err("Workspace path does not exist".to_string());
    }

    open_local_workspace_with_app(app_name, &path)
}

#[tauri::command]
fn open_local_file(path: String) -> Result<(), String> {
    let path = normalized_non_empty(path).ok_or_else(|| "Local file path is empty".to_string())?;

    if !std::path::Path::new(&path).is_file() {
        return Err("Local file does not exist".to_string());
    }

    open_local_file_with_default_app(&path)
}

#[derive(serde::Serialize)]
struct DroppedFilePayload {
    name: String,
    bytes: Vec<u8>,
}

#[tauri::command]
fn read_dropped_files(paths: Vec<String>) -> Result<Vec<DroppedFilePayload>, String> {
    let mut files = Vec::new();

    for raw_path in paths {
        let Some(path) = normalized_non_empty(raw_path) else {
            continue;
        };
        let path = std::path::PathBuf::from(path);
        if !path.is_file() {
            continue;
        }

        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .map(String::from)
            .ok_or_else(|| "Dropped file name is invalid".to_string())?;
        let bytes = std::fs::read(&path)
            .map_err(|error| format!("Failed to read dropped file {name}: {error}"))?;
        files.push(DroppedFilePayload { name, bytes });
    }

    Ok(files)
}

fn sanitized_download_filename(filename: &str, fallback: &std::path::Path) -> String {
    let raw = normalized_non_empty(filename.to_string()).or_else(|| {
        fallback
            .file_name()
            .and_then(|value| value.to_str())
            .map(String::from)
    });

    let sanitized = raw
        .unwrap_or_else(|| "image".to_string())
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    if sanitized.is_empty() {
        "image".to_string()
    } else {
        sanitized
    }
}

fn unique_download_path(directory: &std::path::Path, filename: &str) -> std::path::PathBuf {
    let candidate = directory.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    let path = std::path::Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");
    let extension = path.extension().and_then(|value| value.to_str());

    for index in 1..1000 {
        let filename = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = directory.join(filename);
        if !candidate.exists() {
            return candidate;
        }
    }

    directory.join(filename)
}

#[cfg(target_os = "macos")]
fn notify_download_finished(path: &std::path::Path) {
    use objc2_foundation::{NSDistributedNotificationCenter, NSString};

    let notification_name = NSString::from_str("com.apple.DownloadFileFinished");
    let file_path = NSString::from_str(&path.to_string_lossy());
    unsafe {
        NSDistributedNotificationCenter::defaultCenter()
            .postNotificationName_object(&notification_name, Some(&file_path));
    }
}

#[cfg(not(target_os = "macos"))]
fn notify_download_finished(_path: &std::path::Path) {}

#[tauri::command]
fn download_local_file_to_downloads(
    app: tauri::AppHandle,
    source_path: String,
    filename: String,
) -> Result<String, String> {
    let Some(source_path) = normalized_non_empty(source_path) else {
        return Err("Source path is empty".to_string());
    };

    let source_path = std::path::PathBuf::from(source_path);
    if !source_path.is_file() {
        return Err("Source file does not exist".to_string());
    }

    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("Failed to locate Downloads directory: {error}"))?;
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|error| format!("Failed to create Downloads directory: {error}"))?;

    let filename = sanitized_download_filename(&filename, &source_path);
    let target_path = unique_download_path(&downloads_dir, &filename);
    std::fs::copy(&source_path, &target_path)
        .map_err(|error| format!("Failed to copy file to Downloads: {error}"))?;
    notify_download_finished(&target_path);

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_text_file_to_downloads(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    if content.is_empty() {
        return Err("File content is empty".to_string());
    }

    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("Failed to locate Downloads directory: {error}"))?;
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|error| format!("Failed to create Downloads directory: {error}"))?;

    let filename = sanitized_download_filename(&filename, std::path::Path::new("plan.md"));
    let target_path = unique_download_path(&downloads_dir, &filename);
    std::fs::write(&target_path, content)
        .map_err(|error| format!("Failed to save file to Downloads: {error}"))?;
    notify_download_finished(&target_path);

    Ok(target_path.to_string_lossy().to_string())
}

fn default_executor_home(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(home) = std::env::var("WEGENT_EXECUTOR_HOME") {
        if let Some(home) = normalized_non_empty(home) {
            return Ok(std::path::PathBuf::from(home));
        }
    }

    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to locate home directory: {error}"))?;
    Ok(home.join(".wegent-executor"))
}

fn executor_home_attachment_root(executor_home: &std::path::Path) -> std::path::PathBuf {
    executor_home
        .join("workspace")
        .join("attachments")
        .join("draft")
}

fn local_attachment_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(executor_home_attachment_root(&default_executor_home(app)?))
}

fn unique_attachment_directory(root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("System clock is before UNIX epoch: {error}"))?
        .as_millis();

    for index in 0..1000 {
        let directory_name = if index == 0 {
            millis.to_string()
        } else {
            format!("{millis}-{index}")
        };
        let directory = root.join(directory_name);
        if !directory.exists() {
            return Ok(directory);
        }
    }

    Err("Failed to allocate attachment directory".to_string())
}

#[tauri::command]
fn save_local_attachment_file(
    app: tauri::AppHandle,
    _workspace_path: Option<String>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Attachment file is empty".to_string());
    }

    let root = local_attachment_root(&app)?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create attachment directory: {error}"))?;
    let directory = unique_attachment_directory(&root)?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create attachment directory: {error}"))?;

    let filename = sanitized_download_filename(&filename, std::path::Path::new("attachment"));
    let target_path = unique_download_path(&directory, &filename);
    std::fs::write(&target_path, bytes)
        .map_err(|error| format!("Failed to save attachment file: {error}"))?;

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
fn get_local_executor_device_id(expected_backend_url: Option<String>) -> Option<String> {
    let expected_backend_url = expected_backend_url
        .as_deref()
        .and_then(normalize_backend_url);

    for key in ["WEGENT_EXECUTOR_DEVICE_ID", "DEVICE_ID"] {
        if let Ok(value) = std::env::var(key) {
            if let Some(device_id) = normalized_non_empty(value) {
                return Some(device_id);
            }
        }
    }

    if let Some(device_id) = read_executor_process_device_id(expected_backend_url.as_deref()) {
        return Some(device_id);
    }

    let mut candidates = Vec::new();
    if let Ok(home) = std::env::var("WEGENT_EXECUTOR_HOME") {
        let executor_home = std::path::PathBuf::from(home);
        if let Some(device_id) = read_device_config(executor_home.join("device-config.json")) {
            return Some(device_id);
        }
        candidates.push(executor_home.join("device_id"));
    }
    if let Ok(home) = std::env::var("HOME") {
        let home = std::path::PathBuf::from(home);
        if let Some(device_id) = read_device_config(
            home.join(".wecode")
                .join("wegent-executor")
                .join("device-config.json"),
        ) {
            return Some(device_id);
        }
        if let Some(device_id) =
            read_device_config(home.join(".wegent-executor").join("device-config.json"))
        {
            return Some(device_id);
        }
        candidates.push(home.join(".wegent-executor").join("device_id"));
    }

    for path in candidates {
        if let Some(device_id) = read_device_id_file(path) {
            return Some(device_id);
        }
    }

    None
}

#[cfg(desktop)]
fn set_dock_icon_visible<R: tauri::Runtime>(app: &tauri::AppHandle<R>, visible: bool) {
    #[cfg(target_os = "macos")]
    {
        if !visible {
            cache_current_macos_dock_icon();
        }
        let policy = if visible {
            tauri::ActivationPolicy::Regular
        } else {
            tauri::ActivationPolicy::Accessory
        };
        if let Err(error) = app.set_activation_policy(policy) {
            log::warn!("Failed to update macOS activation policy: {error}");
        }
        if visible {
            refresh_macos_dock_icon();
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, visible);
}

#[cfg(all(desktop, target_os = "macos"))]
fn macos_application() -> Option<objc2::rc::Retained<objc2_app_kit::NSApplication>> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSApplication;

    let Some(main_thread) = MainThreadMarker::new() else {
        log::warn!("Skipped macOS Dock icon operation outside the main thread");
        return None;
    };
    Some(NSApplication::sharedApplication(main_thread))
}

#[cfg(all(desktop, target_os = "macos"))]
fn cache_current_macos_dock_icon() {
    let Some(app) = macos_application() else {
        return;
    };
    let Some(app_icon) = app.applicationIconImage() else {
        return;
    };
    MACOS_CACHED_DOCK_ICON.with(|cached| {
        *cached.borrow_mut() = Some(app_icon);
    });
}

#[cfg(all(desktop, target_os = "macos"))]
fn refresh_macos_dock_icon() {
    let Some(app) = macos_application() else {
        return;
    };
    MACOS_CACHED_DOCK_ICON.with(|cached| {
        if let Some(app_icon) = cached.borrow().as_ref() {
            unsafe {
                app.setApplicationIconImage(Some(app_icon));
            }
        }
    });
}

#[cfg(all(desktop, target_os = "macos"))]
fn initialize_macos_dock_icon_cache() {
    if let Some(app) = macos_application() {
        if let Some(app_icon) = app.applicationIconImage() {
            MACOS_CACHED_DOCK_ICON.with(|cached| {
                *cached.borrow_mut() = Some(app_icon);
            });
        }
    }
}

#[cfg(desktop)]
fn emit_main_window_open_action<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: MainWindowOpenAction,
) {
    match action {
        MainWindowOpenAction::Settings => {
            if let Err(error) = app.emit(TRAY_OPEN_SETTINGS_EVENT, ()) {
                log::warn!("Failed to emit tray settings navigation event: {error}");
            }
        }
        MainWindowOpenAction::Task(id) => {
            if let Err(error) = app.emit(TRAY_OPEN_TASK_EVENT, TrayTaskOpenPayload { id }) {
                log::warn!("Failed to emit tray task navigation event: {error}");
            }
        }
        MainWindowOpenAction::LocalWorkspace => {
            if let Err(error) = app.emit(LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT, ()) {
                log::warn!("Failed to emit local workspace open event: {error}");
            }
        }
    }
}

#[cfg(desktop)]
fn emit_pending_main_window_open_action<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<MainWindowLifecycleState>();
    let Ok(mut pending_action) = state.pending_open_action.lock() else {
        return;
    };
    if let Some(action) = pending_action.take() {
        emit_main_window_open_action(app, action);
    }
}

#[cfg(desktop)]
fn main_window_config<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<tauri::utils::config::WindowConfig, String> {
    app.config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .cloned()
        .ok_or_else(|| format!("Window config '{MAIN_WINDOW_LABEL}' was not found"))
}

#[cfg(desktop)]
fn ensure_main_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: Option<MainWindowOpenAction>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        set_dock_icon_visible(app, true);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(action) = action {
            emit_main_window_open_action(app, action);
        }
        return Ok(());
    }

    {
        let state = app.state::<MainWindowLifecycleState>();
        let mut pending_action = state
            .pending_open_action
            .lock()
            .map_err(|_| "Failed to lock pending main window action".to_string())?;
        *pending_action = action;
    }

    let config = main_window_config(app)?;
    let app_handle = app.clone();
    let window = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|error| format!("Failed to prepare main window: {error}"))?
        .on_page_load(move |_window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                emit_pending_main_window_open_action(&app_handle);
            }
        })
        .build()
        .map_err(|error| format!("Failed to create main window: {error}"))?;
    let _ = window.show();
    set_dock_icon_visible(app, true);
    let _ = window.set_focus();
    Ok(())
}

#[cfg(desktop)]
fn maybe_show_main_window_on_launch(app: &tauri::AppHandle) {
    if read_app_preferences_impl(app).show_main_window_on_launch {
        if let Err(error) = ensure_main_window(app, None) {
            log::warn!("Failed to show main window on launch: {error}");
        }
    } else {
        set_dock_icon_visible(app, false);
    }
}

#[cfg(desktop)]
fn destroy_main_window_to_tray<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let app = window.app_handle();
    let state = app.state::<MainWindowLifecycleState>();
    state
        .destroy_to_tray_in_progress
        .store(true, Ordering::SeqCst);
    if let Err(error) = window.destroy() {
        state
            .destroy_to_tray_in_progress
            .store(false, Ordering::SeqCst);
        set_dock_icon_visible(app, true);
        log::warn!("Failed to destroy main window for tray background mode: {error}");
        return;
    }
    set_dock_icon_visible(app, false);
}

#[cfg(desktop)]
fn hide_main_window_on_close<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &tauri::WindowEvent,
) -> bool {
    if window.label() != MAIN_WINDOW_LABEL {
        return false;
    }

    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let preferences = read_app_preferences_impl(window.app_handle());
        if !preferences.close_to_tray_enabled {
            api.prevent_close();
            shutdown_local_executor_for_app(window.app_handle());
            window.app_handle().exit(0);
            return true;
        }

        api.prevent_close();
        if !preferences.close_to_tray_hint_seen {
            if let Err(error) = window
                .app_handle()
                .emit(CLOSE_TO_TRAY_HINT_REQUESTED_EVENT, ())
            {
                log::warn!("Failed to emit close-to-tray hint event: {error}");
            }
            return true;
        }
        destroy_main_window_to_tray(window);
        return true;
    }

    false
}

#[cfg(desktop)]
#[tauri::command]
fn close_main_window_to_tray(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("WebView window '{MAIN_WINDOW_LABEL}' was not found"))?;
    let state = app.state::<MainWindowLifecycleState>();
    state
        .destroy_to_tray_in_progress
        .store(true, Ordering::SeqCst);
    if let Err(error) = window.destroy() {
        state
            .destroy_to_tray_in_progress
            .store(false, Ordering::SeqCst);
        set_dock_icon_visible(&app, true);
        return Err(format!(
            "Failed to destroy main window for tray background mode: {error}"
        ));
    }
    set_dock_icon_visible(&app, false);
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn close_main_window_to_tray(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(desktop)]
fn open_settings_from_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Err(error) = ensure_main_window(app, Some(MainWindowOpenAction::Settings)) {
        log::warn!("Failed to open settings from tray: {error}");
    }
}

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
struct TrayTaskOpenPayload {
    id: String,
}

#[cfg(desktop)]
fn open_task_from_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>, task_id: &str) {
    if let Err(error) =
        ensure_main_window(app, Some(MainWindowOpenAction::Task(task_id.to_string())))
    {
        log::warn!("Failed to open task from tray: {error}");
    }
}

#[cfg(desktop)]
fn quit_from_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    shutdown_local_executor_for_app(app);
    app.exit(0);
}

#[cfg(desktop)]
fn shutdown_local_executor_for_app<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<local_executor::LocalExecutorState>();
    local_executor::shutdown_local_executor(&state);
}

#[cfg(desktop)]
fn install_shutdown_signal_handler(app: tauri::AppHandle) -> Result<(), String> {
    ctrlc::set_handler(move || {
        shutdown_local_executor_for_app(&app);
        app.exit(130);
    })
    .map_err(|error| format!("Failed to install shutdown signal handler: {error}"))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayMenuTaskItem {
    id: String,
    title: String,
    project_name: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayMenuStatePayload {
    language: String,
    usage_title: Option<String>,
    usage_tooltip: Option<String>,
    running: Vec<TrayMenuTaskItem>,
    running_more: Vec<TrayMenuTaskItem>,
    unread: Vec<TrayMenuTaskItem>,
    unread_more: Vec<TrayMenuTaskItem>,
    running_count: usize,
    #[serde(default)]
    show_running_status: bool,
    #[serde(default)]
    unread_count: usize,
    pinned: Vec<TrayMenuTaskItem>,
    pinned_more: Vec<TrayMenuTaskItem>,
    recent: Vec<TrayMenuTaskItem>,
    recent_more: Vec<TrayMenuTaskItem>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TrayVisualSignature {
    usage_title: Option<String>,
    running_count: usize,
    show_running_status: bool,
    unread_count: usize,
}

impl TrayVisualSignature {
    fn from_payload(state: &TrayMenuStatePayload) -> Self {
        Self {
            usage_title: state.usage_title.clone(),
            running_count: state.running_count,
            show_running_status: state.show_running_status,
            unread_count: state.unread_count,
        }
    }
}

#[derive(Default)]
struct TrayVisualState {
    signature: std::sync::Mutex<Option<TrayVisualSignature>>,
}

#[cfg(desktop)]
impl TrayMenuStatePayload {
    fn empty(language: &str) -> Self {
        Self {
            language: language.to_string(),
            usage_title: None,
            usage_tooltip: None,
            running: Vec::new(),
            running_more: Vec::new(),
            unread: Vec::new(),
            unread_more: Vec::new(),
            running_count: 0,
            show_running_status: false,
            unread_count: 0,
            pinned: Vec::new(),
            pinned_more: Vec::new(),
            recent: Vec::new(),
            recent_more: Vec::new(),
        }
    }
}

#[cfg(desktop)]
#[derive(Clone, Copy)]
enum TrayLanguage {
    ZhCn,
    En,
}

#[cfg(desktop)]
impl TrayLanguage {
    fn from_language(language: &str) -> Self {
        if language.trim().to_lowercase().starts_with("en") {
            Self::En
        } else {
            Self::ZhCn
        }
    }

    fn labels(self) -> TrayMenuLabels {
        match self {
            Self::ZhCn => TrayMenuLabels {
                running: "运行中",
                unread_completed: "未读完成",
                pinned: "置顶",
                tasks: "任务",
                untitled_task: "未命名任务",
                no_pinned_tasks: "暂无置顶任务",
                no_tasks: "暂无任务",
                more: "更多",
                open: "打开应用",
                settings: "设置",
                quit: "退出应用",
            },
            Self::En => TrayMenuLabels {
                running: "Running",
                unread_completed: "Unread Completed",
                pinned: "Pinned",
                tasks: "Tasks",
                untitled_task: "Untitled Task",
                no_pinned_tasks: "No Pinned Tasks",
                no_tasks: "No Tasks",
                more: "More",
                open: "Open App",
                settings: "Settings",
                quit: "Quit App",
            },
        }
    }
}

#[cfg(desktop)]
struct TrayMenuLabels {
    running: &'static str,
    unread_completed: &'static str,
    pinned: &'static str,
    tasks: &'static str,
    untitled_task: &'static str,
    no_pinned_tasks: &'static str,
    no_tasks: &'static str,
    more: &'static str,
    open: &'static str,
    settings: &'static str,
    quit: &'static str,
}

#[cfg(desktop)]
fn build_system_tray_menu<M: Manager<tauri::Wry>>(
    manager: &M,
    state: &TrayMenuStatePayload,
) -> tauri::Result<Menu<tauri::Wry>> {
    let labels = TrayLanguage::from_language(&state.language).labels();
    let mut builder = MenuBuilder::new(manager);

    builder = append_tray_task_section(
        builder,
        manager,
        labels.unread_completed,
        labels.untitled_task,
        "",
        labels.more,
        &state.unread,
        &state.unread_more,
        false,
    )?;
    builder = append_tray_task_section(
        builder,
        manager,
        labels.running,
        labels.untitled_task,
        "",
        labels.more,
        &state.running,
        &state.running_more,
        false,
    )?;
    builder = append_tray_task_section(
        builder,
        manager,
        labels.pinned,
        labels.untitled_task,
        labels.no_pinned_tasks,
        labels.more,
        &state.pinned,
        &state.pinned_more,
        true,
    )?;
    builder = append_tray_task_section(
        builder,
        manager,
        labels.tasks,
        labels.untitled_task,
        labels.no_tasks,
        labels.more,
        &state.recent,
        &state.recent_more,
        true,
    )?;

    builder
        .text(TRAY_MENU_OPEN_ID, labels.open)
        .separator()
        .text(TRAY_MENU_SETTINGS_ID, labels.settings)
        .separator()
        .text(TRAY_MENU_QUIT_ID, labels.quit)
        .build()
}

#[cfg(desktop)]
fn append_tray_task_section<'m, M: Manager<tauri::Wry>>(
    mut builder: MenuBuilder<'m, tauri::Wry, M>,
    manager: &M,
    title: &str,
    untitled_task: &str,
    empty_text: &str,
    more: &str,
    items: &[TrayMenuTaskItem],
    more_items: &[TrayMenuTaskItem],
    always_visible: bool,
) -> tauri::Result<MenuBuilder<'m, tauri::Wry, M>> {
    if items.is_empty() && more_items.is_empty() && !always_visible {
        return Ok(builder);
    }

    let heading = MenuItem::new(manager, title, false, None::<&str>)?;
    builder = builder.item(&heading);

    if items.is_empty() && more_items.is_empty() {
        let empty_item = MenuItem::new(manager, empty_text, false, None::<&str>)?;
        builder = builder.item(&empty_item);
    } else {
        for item in items {
            let title = normalized_menu_task_title(item, untitled_task);
            builder = builder.text(format!("{TRAY_MENU_TASK_PREFIX}{}", item.id), title);
        }
        if !more_items.is_empty() {
            let mut submenu = SubmenuBuilder::new(manager, more);
            for item in more_items {
                let title = normalized_menu_task_title(item, untitled_task);
                submenu = submenu.text(format!("{TRAY_MENU_TASK_PREFIX}{}", item.id), title);
            }
            let submenu = submenu.build()?;
            builder = builder.item(&submenu);
        }
    }

    Ok(builder.separator())
}

#[cfg(desktop)]
fn normalized_menu_task_title(item: &TrayMenuTaskItem, fallback: &str) -> String {
    let title = item.title.trim();
    let project_name = item.project_name.trim();
    if title.is_empty() {
        return fallback.to_string();
    }
    if project_name.is_empty() {
        title.to_string()
    } else {
        format!("{title} - {project_name}")
    }
}

#[cfg(desktop)]
fn tray_usage_glyph(character: char) -> Option<[u8; 5]> {
    match character {
        '0' => Some([0b111, 0b101, 0b101, 0b101, 0b111]),
        '1' => Some([0b010, 0b110, 0b010, 0b010, 0b111]),
        '2' => Some([0b111, 0b001, 0b111, 0b100, 0b111]),
        '3' => Some([0b111, 0b001, 0b111, 0b001, 0b111]),
        '4' => Some([0b101, 0b101, 0b111, 0b001, 0b001]),
        '5' => Some([0b111, 0b100, 0b111, 0b001, 0b111]),
        '6' => Some([0b111, 0b100, 0b111, 0b101, 0b111]),
        '7' => Some([0b111, 0b001, 0b010, 0b010, 0b010]),
        '8' => Some([0b111, 0b101, 0b111, 0b101, 0b111]),
        '9' => Some([0b111, 0b101, 0b111, 0b001, 0b111]),
        '%' => Some([0b101, 0b001, 0b010, 0b100, 0b101]),
        '+' => Some([0b000, 0b010, 0b111, 0b010, 0b000]),
        '-' => Some([0b000, 0b000, 0b111, 0b000, 0b000]),
        'd' | 'D' => Some([0b001, 0b001, 0b111, 0b101, 0b111]),
        'h' | 'H' => Some([0b100, 0b100, 0b111, 0b101, 0b101]),
        _ => None,
    }
}

#[cfg(desktop)]
fn tray_usage_line_width(line: &str) -> u32 {
    let glyph_count = line.chars().count() as u32;
    if glyph_count == 0 {
        return 1;
    }
    line.chars()
        .map(|character| {
            if character == ' ' {
                TRAY_USAGE_SPACE_WIDTH * TRAY_USAGE_ICON_SCALE
            } else {
                TRAY_USAGE_GLYPH_WIDTH * TRAY_USAGE_ICON_SCALE
            }
        })
        .sum::<u32>()
        + glyph_count.saturating_sub(1) * TRAY_USAGE_GLYPH_GAP * TRAY_USAGE_ICON_SCALE
}

#[cfg(desktop)]
fn tray_status_meter_slot_width(icon_size: u32) -> u32 {
    if icon_size == 0 {
        0
    } else {
        TRAY_STATUS_METER_WIDTH + TRAY_STATUS_METER_GAP - TRAY_STATUS_METER_TEXT_GAP_OFFSET
    }
}

#[cfg(desktop)]
fn tray_usage_text_x(icon_size: u32) -> u32 {
    icon_size
        + tray_status_meter_slot_width(icon_size)
        + TRAY_USAGE_ICON_TEXT_GAP
        + TRAY_USAGE_TEXT_LEFT_EXTRA_GAP
}

#[cfg(desktop)]
fn tray_usage_canvas_width(icon_size: u32) -> u32 {
    tray_usage_text_x(icon_size)
        + tray_usage_line_width(TRAY_USAGE_MAX_LINE)
        + TRAY_USAGE_ICON_LEFT_PADDING
}

#[cfg(desktop)]
fn draw_tray_usage_text(buffer: &mut [u8], width: u32, x: u32, y: u32, line: &str) {
    let mut cursor_x = x;
    for character in line.chars() {
        if character == ' ' {
            cursor_x += (TRAY_USAGE_SPACE_WIDTH + TRAY_USAGE_GLYPH_GAP) * TRAY_USAGE_ICON_SCALE;
            continue;
        }
        if let Some(glyph) = tray_usage_glyph(character) {
            for (row_index, row) in glyph.iter().enumerate() {
                for column in 0..TRAY_USAGE_GLYPH_WIDTH {
                    if row & (1 << (TRAY_USAGE_GLYPH_WIDTH - column - 1)) == 0 {
                        continue;
                    }
                    for dy in 0..TRAY_USAGE_ICON_SCALE {
                        for dx in 0..TRAY_USAGE_ICON_SCALE {
                            let pixel_x = cursor_x + column * TRAY_USAGE_ICON_SCALE + dx;
                            let pixel_y = y + row_index as u32 * TRAY_USAGE_ICON_SCALE + dy;
                            let offset = ((pixel_y * width + pixel_x) * 4) as usize;
                            if offset + 3 < buffer.len() {
                                buffer[offset..offset + 4]
                                    .copy_from_slice(&tray_foreground_rgba(255));
                            }
                        }
                    }
                }
            }
        }
        cursor_x += (TRAY_USAGE_GLYPH_WIDTH + TRAY_USAGE_GLYPH_GAP) * TRAY_USAGE_ICON_SCALE;
    }
}

#[cfg(desktop)]
fn tray_foreground_rgba(alpha: u8) -> [u8; 4] {
    if cfg!(target_os = "macos") {
        [0, 0, 0, alpha]
    } else {
        [255, 255, 255, alpha]
    }
}

#[cfg(desktop)]
fn tray_template_pixel(source: [u8; 4]) -> [u8; 4] {
    if !cfg!(target_os = "macos") {
        return source;
    }
    let mask = 255_u16.saturating_sub(source[0].min(source[1]).min(source[2]) as u16);
    let alpha = (source[3] as u16 * mask / 255) as u8;
    [0, 0, 0, alpha]
}

#[cfg(desktop)]
fn copy_tray_icon_pixel(
    buffer: &mut [u8],
    target_offset: usize,
    source: &[u8],
    source_offset: usize,
) {
    if source_offset + 3 >= source.len() || target_offset + 3 >= buffer.len() {
        return;
    }
    let pixel = tray_template_pixel([
        source[source_offset],
        source[source_offset + 1],
        source[source_offset + 2],
        source[source_offset + 3],
    ]);
    buffer[target_offset..target_offset + 4].copy_from_slice(&pixel);
}

#[cfg(desktop)]
fn set_tray_pixel(buffer: &mut [u8], width: u32, height: u32, x: i32, y: i32, rgba: [u8; 4]) {
    if x < 0 || y < 0 || x as u32 >= width || y as u32 >= height {
        return;
    }
    let offset = ((y as u32 * width + x as u32) * 4) as usize;
    if offset + 3 < buffer.len() {
        buffer[offset] = rgba[0];
        buffer[offset + 1] = rgba[1];
        buffer[offset + 2] = rgba[2];
        buffer[offset + 3] = rgba[3];
    }
}

fn scaled_tray_text_width(text: &str, numerator: u32, denominator: u32) -> u32 {
    let glyph_count = text.chars().count() as u32;
    if glyph_count == 0 {
        return 0;
    }
    let source_width =
        glyph_count * TRAY_USAGE_GLYPH_WIDTH + glyph_count.saturating_sub(1) * TRAY_USAGE_GLYPH_GAP;
    (source_width * numerator).div_ceil(denominator)
}

#[cfg(desktop)]
fn draw_tray_text_scaled(
    buffer: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    text: &str,
    scale: (u32, u32),
    rgba: [u8; 4],
) {
    let (numerator, denominator) = scale;
    let mut source_cursor_x = 0;
    for character in text.chars() {
        if let Some(glyph) = tray_usage_glyph(character) {
            for (row_index, row) in glyph.iter().enumerate() {
                for column in 0..TRAY_USAGE_GLYPH_WIDTH {
                    if row & (1 << (TRAY_USAGE_GLYPH_WIDTH - column - 1)) == 0 {
                        continue;
                    }
                    let source_x = source_cursor_x + column;
                    let source_y = row_index as u32;
                    let target_x_start = x + source_x * numerator / denominator;
                    let target_x_end = x + ((source_x + 1) * numerator).div_ceil(denominator);
                    let target_y_start = y + source_y * numerator / denominator;
                    let target_y_end = y + ((source_y + 1) * numerator).div_ceil(denominator);
                    for target_y in target_y_start..target_y_end {
                        for target_x in target_x_start..target_x_end {
                            set_tray_pixel(
                                buffer,
                                width,
                                height,
                                target_x as i32,
                                target_y as i32,
                                rgba,
                            );
                        }
                    }
                }
            }
        }
        source_cursor_x += TRAY_USAGE_GLYPH_WIDTH + TRAY_USAGE_GLYPH_GAP;
    }
}

#[cfg(desktop)]
fn draw_tray_running_meter(
    buffer: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    running_count: usize,
) {
    let meter_height = 22_u32.min(height);
    if meter_height < 10 {
        return;
    }
    let y = (height - meter_height) / 2;
    let border = tray_foreground_rgba(120);
    for dy in 0..meter_height {
        for dx in 0..TRAY_STATUS_METER_WIDTH {
            let edge =
                dx == 0 || dx == TRAY_STATUS_METER_WIDTH - 1 || dy == 0 || dy == meter_height - 1;
            if edge {
                set_tray_pixel(
                    buffer,
                    width,
                    height,
                    (x + dx) as i32,
                    (y + dy) as i32,
                    border,
                );
            }
        }
    }

    let segment_count = running_count.min(4);
    let fill = tray_foreground_rgba(235);
    for index in 0..segment_count {
        let segment_y = y + meter_height - 4 - index as u32 * 4;
        for dy in 0..3 {
            for dx in 0..3 {
                set_tray_pixel(
                    buffer,
                    width,
                    height,
                    (x + 2 + dx) as i32,
                    (segment_y + dy) as i32,
                    fill,
                );
            }
        }
    }
}

#[cfg(desktop)]
fn draw_tray_unread_badge(
    buffer: &mut [u8],
    width: u32,
    height: u32,
    icon_size: u32,
    icon_y: u32,
    unread_count: usize,
) {
    if unread_count == 0 || icon_size < 10 {
        return;
    }

    let badge = if cfg!(target_os = "macos") {
        tray_foreground_rgba(255)
    } else {
        [13, 148, 136, 255]
    };
    let outline_x = 0_i32;
    let outline_y = icon_y as i32;
    let outline_size = icon_size as i32;
    for offset in 0..2 {
        for x in outline_x - offset..outline_x + outline_size + offset {
            set_tray_pixel(buffer, width, height, x, outline_y - offset, badge);
            set_tray_pixel(
                buffer,
                width,
                height,
                x,
                outline_y + outline_size - 1 + offset,
                badge,
            );
        }
        for y in outline_y - offset..outline_y + outline_size + offset {
            set_tray_pixel(buffer, width, height, outline_x - offset, y, badge);
            set_tray_pixel(
                buffer,
                width,
                height,
                outline_x + outline_size - 1 + offset,
                y,
                badge,
            );
        }
    }

    let text = if unread_count > 9 {
        "+".to_string()
    } else {
        unread_count.to_string()
    };
    let badge_width = if text.len() > 1 { 14_u32 } else { 12_u32 };
    let badge_height = 10_u32;
    let badge_x = icon_size.saturating_sub(badge_width);
    let badge_y = icon_y + icon_size.saturating_sub(badge_height);
    for dy in 0..badge_height {
        for dx in 0..badge_width {
            let radius = badge_height as i32 / 2;
            let left_cap_center_x = radius - 1;
            let right_cap_center_x = badge_width as i32 - radius;
            let center_y = radius - 1;
            let pixel_x = dx as i32;
            let pixel_y = dy as i32;
            let inside_rect = pixel_x >= left_cap_center_x && pixel_x <= right_cap_center_x;
            let inside_left = {
                let x = pixel_x - left_cap_center_x;
                let y = pixel_y - center_y;
                x * x + y * y <= radius * radius
            };
            let inside_right = {
                let x = pixel_x - right_cap_center_x;
                let y = pixel_y - center_y;
                x * x + y * y <= radius * radius
            };
            if !inside_rect && !inside_left && !inside_right {
                continue;
            }
            set_tray_pixel(
                buffer,
                width,
                height,
                (badge_x + dx) as i32,
                (badge_y + dy) as i32,
                badge,
            );
        }
    }
    let text_width = scaled_tray_text_width(&text, 3, 2);
    let text_x = badge_x + (badge_width.saturating_sub(text_width)) / 2;
    let text_y = badge_y + 1;
    draw_tray_text_scaled(
        buffer,
        width,
        height,
        text_x,
        text_y,
        &text,
        (3, 2),
        if cfg!(target_os = "macos") {
            [0, 0, 0, 0]
        } else {
            [255, 255, 255, 255]
        },
    );
}

#[cfg(desktop)]
fn tray_usage_icon(
    title: &str,
    base_icon: Option<&tauri::image::Image<'_>>,
    running_count: usize,
    show_running_status: bool,
    unread_count: usize,
) -> Option<tauri::image::Image<'static>> {
    let lines = title
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(2)
        .collect::<Vec<_>>();
    if lines.len() != 2 {
        return None;
    }

    let text_height = TRAY_USAGE_GLYPH_HEIGHT * TRAY_USAGE_ICON_SCALE * 2 + TRAY_USAGE_LINE_GAP;
    let base_icon_size = base_icon
        .map(|icon| icon.width().min(icon.height()).min(TRAY_USAGE_ICON_HEIGHT))
        .unwrap_or(0);
    let text_x = tray_usage_text_x(base_icon_size);
    let width = tray_usage_canvas_width(base_icon_size);
    let height = TRAY_USAGE_ICON_HEIGHT.max(text_height);
    let mut buffer = vec![0; (width * height * 4) as usize];
    let first_y = (height - text_height) / 2;
    let second_y = first_y + TRAY_USAGE_GLYPH_HEIGHT * TRAY_USAGE_ICON_SCALE + TRAY_USAGE_LINE_GAP;
    let mut icon_y = 0;

    if let Some(icon) = base_icon {
        let source_width = icon.width();
        let source_height = icon.height();
        let source_size = source_width.min(source_height);
        if source_size > 0 && base_icon_size > 0 {
            let source_x = (source_width - source_size) / 2;
            let source_y = (source_height - source_size) / 2;
            let target_y = (height - base_icon_size) / 2;
            icon_y = target_y;
            let rgba = icon.rgba();
            for y in 0..base_icon_size {
                for x in 0..base_icon_size {
                    let sample_x = source_x + x * source_size / base_icon_size;
                    let sample_y = source_y + y * source_size / base_icon_size;
                    let source_offset = ((sample_y * source_width + sample_x) * 4) as usize;
                    let target_offset = (((target_y + y) * width + x) * 4) as usize;
                    copy_tray_icon_pixel(&mut buffer, target_offset, rgba, source_offset);
                }
            }
        }
    }
    if base_icon_size > 0 {
        draw_tray_unread_badge(
            &mut buffer,
            width,
            height,
            base_icon_size,
            icon_y,
            unread_count,
        );
        if show_running_status {
            draw_tray_running_meter(
                &mut buffer,
                width,
                height,
                base_icon_size + TRAY_STATUS_METER_GAP / 2 + 1,
                running_count,
            );
        }
    }

    for (line_index, line) in lines.iter().enumerate() {
        let y = if line_index == 0 { first_y } else { second_y };
        draw_tray_usage_text(&mut buffer, width, text_x, y, line);
    }

    Some(tauri::image::Image::new_owned(buffer, width, height))
}

#[cfg(desktop)]
fn tray_status_icon(
    base_icon: Option<&tauri::image::Image<'_>>,
    running_count: usize,
    show_running_status: bool,
    unread_count: usize,
) -> Option<tauri::image::Image<'static>> {
    let base_icon = base_icon?;
    let icon_size = base_icon
        .width()
        .min(base_icon.height())
        .min(TRAY_USAGE_ICON_HEIGHT);
    let meter_width = TRAY_STATUS_METER_WIDTH + TRAY_STATUS_METER_GAP;
    let width = icon_size + meter_width;
    let height = TRAY_USAGE_ICON_HEIGHT.max(icon_size);
    let mut buffer = vec![0; (width * height * 4) as usize];
    let source_width = base_icon.width();
    let source_height = base_icon.height();
    let source_size = source_width.min(source_height);
    let source_x = (source_width - source_size) / 2;
    let source_y = (source_height - source_size) / 2;
    let icon_y = (height - icon_size) / 2;
    let rgba = base_icon.rgba();
    for y in 0..icon_size {
        for x in 0..icon_size {
            let sample_x = source_x + x * source_size / icon_size;
            let sample_y = source_y + y * source_size / icon_size;
            let source_offset = ((sample_y * source_width + sample_x) * 4) as usize;
            let target_offset = (((icon_y + y) * width + x) * 4) as usize;
            copy_tray_icon_pixel(&mut buffer, target_offset, rgba, source_offset);
        }
    }
    draw_tray_unread_badge(&mut buffer, width, height, icon_size, icon_y, unread_count);
    if show_running_status {
        draw_tray_running_meter(
            &mut buffer,
            width,
            height,
            icon_size + TRAY_STATUS_METER_GAP / 2 + 1,
            running_count,
        );
    }
    Some(tauri::image::Image::new_owned(buffer, width, height))
}

#[cfg(desktop)]
fn setup_system_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = build_system_tray_menu(app, &TrayMenuStatePayload::empty("zh-CN"))?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("WeWork")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                if let Err(error) = ensure_main_window(tray.app_handle(), None) {
                    log::warn!("Failed to open main window from tray click: {error}");
                }
            }
            _ => {}
        })
        .on_menu_event(|app, event| {
            let event_id = event.id().as_ref();
            match event_id {
                TRAY_MENU_OPEN_ID => {
                    if let Err(error) = ensure_main_window(app, None) {
                        log::warn!("Failed to open main window from tray menu: {error}");
                    }
                }
                TRAY_MENU_SETTINGS_ID => open_settings_from_tray(app),
                TRAY_MENU_QUIT_ID => quit_from_tray(app),
                _ => {
                    if let Some(task_id) = event_id.strip_prefix(TRAY_MENU_TASK_PREFIX) {
                        open_task_from_tray(app, task_id);
                    }
                }
            }
        });

    if cfg!(target_os = "macos") {
        tray = tray.icon_as_template(true);
    }
    if let Some(icon) = tray_status_icon(app.default_window_icon(), 0, false, 0) {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

#[cfg(desktop)]
fn update_tray_visual<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    tray: &tauri::tray::TrayIcon<R>,
    state: &TrayMenuStatePayload,
) -> Result<(), String> {
    let signature = TrayVisualSignature::from_payload(state);
    let visual_state = app.state::<TrayVisualState>();
    let mut cached_signature = visual_state
        .signature
        .lock()
        .map_err(|error| format!("Failed to read tray visual state: {error}"))?;
    if cached_signature.as_ref() == Some(&signature) {
        return Ok(());
    }

    let icon = state
        .usage_title
        .as_deref()
        .and_then(|title| {
            tray_usage_icon(
                title,
                app.default_window_icon(),
                state.running_count,
                state.show_running_status,
                state.unread_count,
            )
        })
        .or_else(|| {
            tray_status_icon(
                app.default_window_icon(),
                state.running_count,
                state.show_running_status,
                state.unread_count,
            )
        });
    if let Some(icon) = icon {
        tray.set_icon_with_as_template(Some(icon), cfg!(target_os = "macos"))
            .map_err(|error| format!("Failed to update tray icon: {error}"))?;
    }
    tray.set_title(None::<&str>)
        .map_err(|error| format!("Failed to clear tray title: {error}"))?;
    *cached_signature = Some(signature);
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
fn set_tray_menu_state(app: tauri::AppHandle, state: TrayMenuStatePayload) -> Result<(), String> {
    let menu = build_system_tray_menu(&app, &state)
        .map_err(|error| format!("Failed to build tray menu: {error}"))?;
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    tray.set_menu(Some(menu))
        .map_err(|error| format!("Failed to update tray menu: {error}"))?;
    update_tray_visual(&app, &tray, &state)?;
    if let Err(error) = tray.set_tooltip(state.usage_tooltip.as_deref().or(Some("WeWork"))) {
        log::warn!("Failed to update tray tooltip: {error}");
    }
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
fn set_tray_menu_state(_state: TrayMenuStatePayload) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        can_replace_wework_cli_path, classify_process, collect_descendant_pids,
        executor_home_attachment_root, install_wework_cli_impl, local_workspace_opener_app_name,
        parse_local_workspace_open_request, parse_process_snapshot_line, tray_template_pixel,
        tray_usage_icon, wework_cli_launcher_content, RawProcessInfo,
    };
    use std::collections::HashSet;

    fn test_temp_dir(name: &str) -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("wework-cli-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("test temp dir should be created");
        path
    }

    #[test]
    fn converts_macos_tray_pixels_to_a_template_mask() {
        assert_eq!(tray_template_pixel([255, 255, 255, 255]), [0, 0, 0, 0]);
        assert_eq!(tray_template_pixel([0, 0, 0, 255]), [0, 0, 0, 255]);
        assert_eq!(tray_template_pixel([20, 120, 220, 128]), [0, 0, 0, 117]);
    }

    #[test]
    fn keeps_tray_usage_canvas_stable_across_usage_and_running_states() {
        let base_icon = tauri::image::Image::new_owned(vec![255; 32 * 32 * 4], 32, 32);
        let compact = tray_usage_icon("5h 9%\n7d --", Some(&base_icon), 0, false, 0)
            .expect("compact usage icon");
        let full = tray_usage_icon("5h 100%\n7d 100%", Some(&base_icon), 3, true, 7)
            .expect("full usage icon");

        assert_eq!(compact.width(), full.width());
        assert_eq!(compact.height(), full.height());
    }

    #[test]
    fn maps_local_workspace_openers_to_macos_app_names() {
        assert_eq!(
            local_workspace_opener_app_name("vscode"),
            Some("Visual Studio Code")
        );
        assert_eq!(
            local_workspace_opener_app_name("vscode-insiders"),
            Some("Visual Studio Code - Insiders")
        );
        assert_eq!(local_workspace_opener_app_name("iterm2"), Some("iTerm"));
        assert_eq!(
            local_workspace_opener_app_name("android-studio"),
            Some("Android Studio")
        );
        assert_eq!(
            local_workspace_opener_app_name("intellij-idea"),
            Some("IntelliJ IDEA")
        );
        assert_eq!(local_workspace_opener_app_name("unknown"), None);
    }

    #[test]
    fn places_local_attachment_drafts_under_executor_home() {
        assert_eq!(
            executor_home_attachment_root(std::path::Path::new("/Users/me/.wegent-executor")),
            std::path::PathBuf::from("/Users/me/.wegent-executor/workspace/attachments/draft")
        );
    }

    #[test]
    fn parses_local_workspace_open_request_from_argv() {
        let request = parse_local_workspace_open_request(&[
            "WeWork".to_string(),
            "--open-workspace".to_string(),
            "/Users/me/project".to_string(),
            "--workspace-label".to_string(),
            "Project".to_string(),
        ])
        .expect("workspace request should parse");

        assert_eq!(request.path, "/Users/me/project");
        assert_eq!(request.label.as_deref(), Some("Project"));
    }

    #[test]
    fn ignores_blank_local_workspace_open_path() {
        assert!(parse_local_workspace_open_request(&[
            "WeWork".to_string(),
            "--open-workspace".to_string(),
            "   ".to_string(),
        ])
        .is_none());
    }

    #[test]
    fn renders_wework_cli_launcher_for_app_bundle() {
        let content = wework_cli_launcher_content(
            std::path::Path::new("/Applications/WeWork.app/Contents/MacOS/WeWork"),
            Some(std::path::Path::new("/Applications/WeWork.app")),
        );

        assert!(content.contains("# Wework CLI launcher"));
        assert!(content.contains("APP_BUNDLE='/Applications/WeWork.app'"));
        assert!(content.contains("\"$WEWORK_EXECUTABLE\" --open-workspace \"$ABSOLUTE_PATH\""));
        assert!(content.contains("exec open \"$APP_BUNDLE\" --args --open-workspace"));
    }

    #[test]
    fn installs_wework_cli_launcher_and_replaces_managed_files() {
        let temp_dir = test_temp_dir("install");
        let executable_path = temp_dir.join("debug").join("app");
        std::fs::create_dir_all(executable_path.parent().expect("executable has parent"))
            .expect("executable dir should be created");
        std::fs::write(&executable_path, b"app").expect("executable should be written");

        let installed_path = install_wework_cli_impl(&temp_dir, &executable_path)
            .expect("launcher should be installed");
        let content = std::fs::read_to_string(&installed_path).expect("launcher should be read");
        assert!(content.contains("# Wework CLI launcher"));
        assert!(content.contains("WEWORK_EXECUTABLE="));

        std::fs::write(&installed_path, "# Wework CLI launcher\nold")
            .expect("managed launcher should be overwritten");
        install_wework_cli_impl(&temp_dir, &executable_path)
            .expect("managed launcher should be replaced");
        let replaced_content =
            std::fs::read_to_string(&installed_path).expect("launcher should be read again");
        assert!(replaced_content.contains("Open a local workspace in the Wework desktop app."));

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn refuses_to_replace_unmanaged_wework_cli_file() {
        let temp_dir = test_temp_dir("unmanaged");
        let install_dir = temp_dir.join(".local/bin");
        std::fs::create_dir_all(&install_dir).expect("install dir should be created");
        let installed_path = install_dir.join("wework");
        std::fs::write(&installed_path, "#!/bin/sh\necho custom")
            .expect("custom command should be written");

        assert!(!can_replace_wework_cli_path(&installed_path)
            .expect("existing file should be inspected"));
        assert!(
            install_wework_cli_impl(&temp_dir, std::path::Path::new("/tmp/app"))
                .expect_err("unmanaged file should not be replaced")
                .contains("not managed by Wework")
        );

        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn parses_process_snapshot_lines_with_spaced_commands() {
        let process =
            parse_process_snapshot_line(" 123  45 6789  12.5 /Applications/WeWork.app/a b c")
                .expect("process line should parse");

        assert_eq!(process.pid, 123);
        assert_eq!(process.ppid, 45);
        assert_eq!(process.rss_kib, 6789);
        assert_eq!(process.cpu_percent, 12.5);
        assert_eq!(process.command, "/Applications/WeWork.app/a b c");
    }

    #[test]
    fn collects_descendant_processes() {
        let processes = vec![
            raw_process(1, 0, "main"),
            raw_process(2, 1, "child"),
            raw_process(3, 2, "grandchild"),
            raw_process(4, 0, "other"),
        ];

        let descendants = collect_descendant_pids(&processes, &[1]);

        assert!(descendants.contains(&1));
        assert!(descendants.contains(&2));
        assert!(descendants.contains(&3));
        assert!(!descendants.contains(&4));
    }

    #[test]
    fn classifies_wework_process_groups() {
        let terminal_roots = HashSet::from([3]);
        let terminal_descendants = HashSet::from([3, 4]);

        assert_eq!(
            classify_process(
                &raw_process(1, 0, "Wework"),
                1,
                &terminal_roots,
                &terminal_descendants
            ),
            Some("main".to_string())
        );
        assert_eq!(
            classify_process(
                &raw_process(2, 1, "com.apple.WebKit.WebContent"),
                1,
                &terminal_roots,
                &terminal_descendants
            ),
            Some("webkit-webcontent".to_string())
        );
        assert_eq!(
            classify_process(
                &raw_process(4, 3, "/bin/zsh"),
                1,
                &terminal_roots,
                &terminal_descendants
            ),
            Some("terminal".to_string())
        );
    }

    fn raw_process(pid: u32, ppid: u32, command: &str) -> RawProcessInfo {
        RawProcessInfo {
            pid,
            ppid,
            rss_kib: 0,
            cpu_percent: 0.0,
            command: command.to_string(),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(all(desktop, not(debug_assertions)))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        let action = if let Some(request) = parse_local_workspace_open_request(&argv) {
            queue_local_workspace_open_request(app, request);
            Some(MainWindowOpenAction::LocalWorkspace)
        } else {
            None
        };
        if let Err(error) = ensure_main_window(app, action) {
            log::warn!("Failed to open main window from single-instance activation: {error}");
        }
    }));

    let app = builder
        .manage(embedded_browser::EmbeddedBrowserState::default())
        .manage(MainWindowLifecycleState::default())
        .manage(LocalWorkspaceOpenState::default())
        .manage(TrayVisualState::default())
        .manage(local_executor::LocalExecutorState::default())
        .manage(local_terminal::LocalTerminalState::default())
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if hide_main_window_on_close(window, event) {
                return;
            }

            if matches!(event, tauri::WindowEvent::Destroyed) {
                #[cfg(desktop)]
                if window.label() == MAIN_WINDOW_LABEL {
                    let lifecycle = window.app_handle().state::<MainWindowLifecycleState>();
                    if lifecycle.destroy_to_tray_in_progress.load(Ordering::SeqCst) {
                        return;
                    }
                }

                let state = window
                    .app_handle()
                    .state::<local_executor::LocalExecutorState>();
                local_executor::shutdown_local_executor(&state);
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            if app
                .config()
                .plugins
                .0
                .get("updater")
                .is_some_and(|config| config.is_object())
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            #[cfg(desktop)]
            app.handle().plugin(
                create_log_plugin(app.handle())
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?,
            )?;

            #[cfg(desktop)]
            println!(
                "Wework app PID={} log dir={}",
                std::process::id(),
                get_app_log_directory(app.handle().clone()).unwrap_or_else(|error| error)
            );

            log::info!(
                "Wework app PID={} logs are written to {}",
                std::process::id(),
                get_app_log_directory(app.handle().clone()).unwrap_or_else(|error| error)
            );

            #[cfg(desktop)]
            setup_system_tray(app)?;
            #[cfg(desktop)]
            match install_wework_cli_link(app.handle()) {
                Ok(path) => log::info!("Installed Wework CLI launcher: {}", path.display()),
                Err(error) => log::warn!("{error}"),
            }
            #[cfg(desktop)]
            if let Some(request) =
                parse_local_workspace_open_request(&std::env::args().collect::<Vec<_>>())
            {
                queue_local_workspace_open_request(app.handle(), request);
                if let Err(error) =
                    ensure_main_window(app.handle(), Some(MainWindowOpenAction::LocalWorkspace))
                {
                    log::warn!("Failed to open main window for local workspace request: {error}");
                }
            } else {
                maybe_show_main_window_on_launch(app.handle());
            }
            #[cfg(desktop)]
            install_shutdown_signal_handler(app.handle().clone())
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            #[cfg(desktop)]
            if let Err(error) =
                embedded_browser::start_embedded_browser_bridge(app.handle().clone())
            {
                log::warn!("Failed to start embedded browser bridge: {error}");
            }
            #[cfg(desktop)]
            if env_flag_enabled(WEBVIEW_DEVTOOLS_ENV) {
                if let Err(error) = open_main_webview_devtools_impl(app.handle()) {
                    log::warn!("Failed to open Web Inspector from {WEBVIEW_DEVTOOLS_ENV}: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            embedded_browser::embedded_browser_close,
            embedded_browser::embedded_browser_eval,
            embedded_browser::embedded_browser_eval_json,
            embedded_browser::embedded_browser_go_back,
            embedded_browser::embedded_browser_go_forward,
            embedded_browser::embedded_browser_navigate,
            embedded_browser::embedded_browser_open,
            embedded_browser::embedded_browser_page_state,
            embedded_browser::embedded_browser_reload,
            embedded_browser::embedded_browser_relabel,
            embedded_browser::embedded_browser_set_bounds,
            local_terminal::close_local_terminal,
            get_local_executor_device_id,
            local_executor::local_executor_connect_backend,
            local_executor::local_executor_copy_debug_info,
            local_executor::local_executor_disconnect_backend,
            local_executor::local_executor_ensure_started,
            local_executor::local_executor_read_log,
            local_executor::local_executor_request,
            local_executor::local_executor_restart,
            local_executor::local_executor_status,
            get_app_log_directory,
            get_app_preferences,
            close_main_window_to_tray,
            open_app_log_directory,
            get_wework_process_snapshot,
            open_main_webview_devtools,
            install_wework_cli,
            take_pending_local_workspace_open_requests,
            set_tray_menu_state,
            update_app_preferences,
            download_local_file_to_downloads,
            save_text_file_to_downloads,
            local_path_exists,
            open_local_file,
            open_local_workspace,
            read_dropped_files,
            save_local_attachment_file,
            local_terminal::resize_local_terminal,
            local_terminal::start_local_terminal,
            local_terminal::write_local_terminal
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        #[cfg(desktop)]
        match event {
            tauri::RunEvent::Ready => {
                #[cfg(target_os = "macos")]
                initialize_macos_dock_icon_cache();
            }
            tauri::RunEvent::ExitRequested { api, .. } => {
                let lifecycle = app_handle.state::<MainWindowLifecycleState>();
                if lifecycle.destroy_to_tray_in_progress.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    lifecycle
                        .destroy_to_tray_in_progress
                        .store(false, Ordering::SeqCst);
                    return;
                }
                shutdown_local_executor_for_app(app_handle);
            }
            tauri::RunEvent::Exit => {
                shutdown_local_executor_for_app(app_handle);
            }
            _ => {}
        }
    });
}
