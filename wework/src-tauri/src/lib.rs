mod in_app_browser;
mod local_executor;
mod local_terminal;

use tauri::Manager;

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    Emitter,
};

#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(desktop)]
const TRAY_OPEN_SETTINGS_EVENT: &str = "wework-tray-open-settings";
#[cfg(desktop)]
const TRAY_OPEN_TASK_EVENT: &str = "wework-tray-open-task";
#[cfg(desktop)]
const TRAY_MENU_OPEN_ID: &str = "open";
#[cfg(desktop)]
const TRAY_MENU_SETTINGS_ID: &str = "settings";
#[cfg(desktop)]
const TRAY_MENU_QUIT_ID: &str = "quit";
#[cfg(desktop)]
const TRAY_MENU_TASK_PREFIX: &str = "task:";
#[cfg(desktop)]
const TRAY_ID: &str = "wework-main";

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

fn local_attachment_root(
    app: &tauri::AppHandle,
    workspace_path: Option<String>,
) -> Result<std::path::PathBuf, String> {
    if let Some(workspace_path) = workspace_path.and_then(normalized_non_empty) {
        return Ok(std::path::PathBuf::from(workspace_path)
            .join(".wegent")
            .join("attachments")
            .join("draft"));
    }

    Ok(default_executor_home(app)?
        .join("workspace")
        .join("attachments")
        .join("draft"))
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
    workspace_path: Option<String>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Attachment file is empty".to_string());
    }

    let root = local_attachment_root(&app, workspace_path)?;
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
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
fn open_settings_from_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    show_main_window(app);
    if let Err(error) = app.emit(TRAY_OPEN_SETTINGS_EVENT, ()) {
        log::warn!("Failed to emit tray settings navigation event: {error}");
    }
}

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
struct TrayTaskOpenPayload {
    id: String,
}

#[cfg(desktop)]
fn open_task_from_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>, task_id: &str) {
    show_main_window(app);
    if let Err(error) = app.emit(
        TRAY_OPEN_TASK_EVENT,
        TrayTaskOpenPayload {
            id: task_id.to_string(),
        },
    ) {
        log::warn!("Failed to emit tray task navigation event: {error}");
    }
}

#[cfg(desktop)]
fn quit_from_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<local_executor::LocalExecutorState>();
    local_executor::shutdown_local_executor(&state);
    app.exit(0);
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
    running: Vec<TrayMenuTaskItem>,
    running_more: Vec<TrayMenuTaskItem>,
    pinned: Vec<TrayMenuTaskItem>,
    pinned_more: Vec<TrayMenuTaskItem>,
    recent: Vec<TrayMenuTaskItem>,
    recent_more: Vec<TrayMenuTaskItem>,
}

#[cfg(desktop)]
impl TrayMenuStatePayload {
    fn empty(language: &str) -> Self {
        Self {
            language: language.to_string(),
            running: Vec::new(),
            running_more: Vec::new(),
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
fn setup_system_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = build_system_tray_menu(app, &TrayMenuStatePayload::empty("zh-CN"))?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("WeWork")
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let event_id = event.id().as_ref();
            match event_id {
                TRAY_MENU_OPEN_ID => show_main_window(app),
                TRAY_MENU_SETTINGS_ID => open_settings_from_tray(app),
                TRAY_MENU_QUIT_ID => quit_from_tray(app),
                _ => {
                    if let Some(task_id) = event_id.strip_prefix(TRAY_MENU_TASK_PREFIX) {
                        open_task_from_tray(app, task_id);
                    }
                }
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
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
        .map_err(|error| format!("Failed to update tray menu: {error}"))
}

#[cfg(not(desktop))]
#[tauri::command]
fn set_tray_menu_state(_state: TrayMenuStatePayload) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::local_workspace_opener_app_name;

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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .manage(local_executor::LocalExecutorState::default())
        .manage(local_terminal::LocalTerminalState::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
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

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            #[cfg(desktop)]
            setup_system_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            in_app_browser::in_app_browser_go_back,
            in_app_browser::in_app_browser_create,
            in_app_browser::in_app_browser_go_forward,
            in_app_browser::in_app_browser_page_favicon,
            in_app_browser::in_app_browser_page_title,
            in_app_browser::in_app_browser_reload,
            in_app_browser::in_app_browser_set_frame,
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
            set_tray_menu_state,
            download_local_file_to_downloads,
            local_path_exists,
            open_local_workspace,
            read_dropped_files,
            save_local_attachment_file,
            local_terminal::resize_local_terminal,
            local_terminal::start_local_terminal,
            local_terminal::write_local_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
