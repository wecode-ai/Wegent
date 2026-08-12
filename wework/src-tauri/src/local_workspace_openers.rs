//! Per-platform registry of "open a local workspace with X" openers. Each
//! opener carries the detection and launch strategy for every platform it is
//! available on, so the frontend can gray out uninstalled apps and the launch
//! never fails with a macOS-only error.

use serde::Serialize;

#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::path::PathBuf;

#[cfg(target_os = "windows")]
use std::collections::HashMap;

#[cfg(target_os = "windows")]
use crate::opener_store;

#[derive(Clone, Copy, PartialEq, Eq)]
enum OpenerCategory {
    General,
    FileManager,
    Terminal,
    MacOnly,
    WinOnly,
}

// Fields are read only by cfg-gated platform code, so they appear unused on
// other targets.
#[allow(dead_code)]
#[derive(Clone, Copy)]
struct WindowsDef {
    env_vars: &'static [&'static str],
    cli: Option<&'static str>,
    common_dirs: &'static [&'static str],
    exe_candidates: &'static [&'static str],
}

#[allow(dead_code)]
struct OpenerDef {
    id: &'static str,
    category: OpenerCategory,
    macos_app_name: Option<&'static str>,
    windows: Option<WindowsDef>,
    linux_cli: Option<(&'static str, &'static [&'static str])>,
}

fn opener_defs() -> &'static [OpenerDef] {
    const WINDOWS_IDE_COMMON: WindowsDef = WindowsDef {
        env_vars: &["WEGENT_VSCODE_PATH"],
        cli: Some("code"),
        common_dirs: &["%LOCALAPPDATA%/Programs/Microsoft VS Code"],
        exe_candidates: &["Code.exe"],
    };
    const WINDOWS_INSIDERS_COMMON: WindowsDef = WindowsDef {
        env_vars: &["WEGENT_VSCODE_INSIDERS_PATH"],
        cli: Some("code-insiders"),
        common_dirs: &["%LOCALAPPDATA%/Programs/Microsoft VS Code Insiders"],
        exe_candidates: &["Code - Insiders.exe"],
    };
    const WINDOWS_CURSOR_COMMON: WindowsDef = WindowsDef {
        env_vars: &["WEGENT_CURSOR_PATH"],
        cli: Some("cursor"),
        common_dirs: &["%LOCALAPPDATA%/Programs/cursor"],
        exe_candidates: &["Cursor.exe"],
    };
    const WINDOWS_SUBLIME_COMMON: WindowsDef = WindowsDef {
        env_vars: &["WEGENT_SUBLIME_TEXT_PATH"],
        cli: Some("subl"),
        common_dirs: &[
            "%ProgramFiles%/Sublime Text",
            "%ProgramFiles(x86)%/Sublime Text",
        ],
        exe_candidates: &["sublime_text.exe"],
    };
    const WINDOWS_WINDSURF_COMMON: WindowsDef = WindowsDef {
        env_vars: &["WEGENT_WINDSURF_PATH"],
        cli: Some("windsurf"),
        common_dirs: &["%LOCALAPPDATA%/Programs/Windsurf"],
        exe_candidates: &["Windsurf.exe"],
    };
    const WINDOWS_IDEA_COMMON: WindowsDef = WindowsDef {
        env_vars: &["WEGENT_INTELLIJ_IDEA_PATH"],
        cli: Some("idea64"),
        common_dirs: &[],
        exe_candidates: &["idea64.exe", "idea.exe"],
    };
    const WINDOWS_ANDROID_STUDIO_COMMON: WindowsDef = WindowsDef {
        env_vars: &["WEGENT_ANDROID_STUDIO_PATH"],
        cli: None,
        common_dirs: &["%ProgramFiles%/Android/Android Studio/bin"],
        exe_candidates: &["studio64.exe"],
    };
    const WINDOWS_TERMINAL: WindowsDef = WindowsDef {
        env_vars: &["WEGENT_TERMINAL_PATH"],
        cli: Some("wt"),
        common_dirs: &["%LOCALAPPDATA%/Microsoft/WindowsApps"],
        exe_candidates: &["wt.exe"],
    };
    const WINDOWS_CMD: WindowsDef = WindowsDef {
        env_vars: &["WEGENT_CMD_PATH"],
        cli: Some("cmd"),
        common_dirs: &["%WINDIR%/System32"],
        exe_candidates: &["cmd.exe"],
    };
    const WINDOWS_POWERSHELL: WindowsDef = WindowsDef {
        env_vars: &["WEGENT_POWERSHELL_PATH"],
        cli: Some("powershell"),
        common_dirs: &["%WINDIR%/System32/WindowsPowerShell/v1.0"],
        exe_candidates: &["powershell.exe"],
    };

    const WINDOWS_CUSTOM: WindowsDef = WindowsDef {
        env_vars: &[],
        cli: None,
        common_dirs: &[],
        exe_candidates: &[],
    };

    const ALL: &[OpenerDef] = &[
        OpenerDef {
            id: "vscode",
            category: OpenerCategory::General,
            macos_app_name: Some("Visual Studio Code"),
            windows: Some(WINDOWS_IDE_COMMON),
            linux_cli: Some(("code", &[])),
        },
        OpenerDef {
            id: "vscode-insiders",
            category: OpenerCategory::General,
            macos_app_name: Some("Visual Studio Code - Insiders"),
            windows: Some(WINDOWS_INSIDERS_COMMON),
            linux_cli: Some(("code-insiders", &[])),
        },
        OpenerDef {
            id: "cursor",
            category: OpenerCategory::General,
            macos_app_name: Some("Cursor"),
            windows: Some(WINDOWS_CURSOR_COMMON),
            linux_cli: Some(("cursor", &[])),
        },
        OpenerDef {
            id: "sublime-text",
            category: OpenerCategory::General,
            macos_app_name: Some("Sublime Text"),
            windows: Some(WINDOWS_SUBLIME_COMMON),
            linux_cli: Some(("subl", &[])),
        },
        OpenerDef {
            id: "windsurf",
            category: OpenerCategory::General,
            macos_app_name: Some("Windsurf"),
            windows: Some(WINDOWS_WINDSURF_COMMON),
            linux_cli: Some(("windsurf", &[])),
        },
        OpenerDef {
            id: "intellij-idea",
            category: OpenerCategory::General,
            macos_app_name: Some("IntelliJ IDEA"),
            windows: Some(WINDOWS_IDEA_COMMON),
            linux_cli: Some(("idea", &[])),
        },
        OpenerDef {
            id: "android-studio",
            category: OpenerCategory::General,
            macos_app_name: Some("Android Studio"),
            windows: Some(WINDOWS_ANDROID_STUDIO_COMMON),
            linux_cli: Some(("android-studio", &[])),
        },
        OpenerDef {
            id: "file-manager",
            category: OpenerCategory::FileManager,
            macos_app_name: Some("Finder"),
            windows: None,
            linux_cli: None,
        },
        OpenerDef {
            id: "terminal",
            category: OpenerCategory::Terminal,
            macos_app_name: Some("Terminal"),
            windows: Some(WINDOWS_TERMINAL),
            linux_cli: Some(("x-terminal-emulator", &[])),
        },
        OpenerDef {
            id: "xcode",
            category: OpenerCategory::MacOnly,
            macos_app_name: Some("Xcode"),
            windows: None,
            linux_cli: None,
        },
        OpenerDef {
            id: "iterm2",
            category: OpenerCategory::MacOnly,
            macos_app_name: Some("iTerm"),
            windows: None,
            linux_cli: None,
        },
        OpenerDef {
            id: "ghostty",
            category: OpenerCategory::MacOnly,
            macos_app_name: Some("Ghostty"),
            windows: None,
            linux_cli: None,
        },
        OpenerDef {
            id: "warp",
            category: OpenerCategory::MacOnly,
            macos_app_name: Some("Warp"),
            windows: None,
            linux_cli: None,
        },
        OpenerDef {
            id: "cmd",
            category: OpenerCategory::WinOnly,
            macos_app_name: None,
            windows: Some(WINDOWS_CMD),
            linux_cli: None,
        },
        OpenerDef {
            id: "powershell",
            category: OpenerCategory::WinOnly,
            macos_app_name: None,
            windows: Some(WINDOWS_POWERSHELL),
            linux_cli: None,
        },
        OpenerDef {
            id: "custom",
            category: OpenerCategory::General,
            macos_app_name: None,
            windows: Some(WINDOWS_CUSTOM),
            linux_cli: None,
        },
    ];
    ALL
}

fn opener_def(id: &str) -> Option<&'static OpenerDef> {
    opener_defs().iter().find(|def| def.id == id)
}

fn is_visible(def: &OpenerDef) -> bool {
    if def.id == "file-manager" {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        def.macos_app_name.is_some()
    }
    #[cfg(target_os = "windows")]
    {
        def.windows.is_some()
    }
    #[cfg(target_os = "linux")]
    {
        def.linux_cli.is_some()
    }
}

fn category_name(category: OpenerCategory) -> &'static str {
    match category {
        OpenerCategory::General => "general",
        OpenerCategory::FileManager => "fileManager",
        OpenerCategory::Terminal => "terminal",
        OpenerCategory::MacOnly => "macOnly",
        OpenerCategory::WinOnly => "winOnly",
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenerInfo {
    id: String,
    category: String,
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

#[tauri::command]
pub async fn list_local_workspace_openers(app: tauri::AppHandle) -> Vec<OpenerInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let app = &app;
        opener_defs()
            .iter()
            .filter(|def| is_visible(def))
            .map(|def| OpenerInfo {
                id: def.id.to_string(),
                category: category_name(def.category).to_string(),
                available: opener_available(def, app),
                label: custom_opener_label(def, app),
            })
            .collect()
    })
    .await
    .unwrap_or_else(|error| {
        log::warn!("Failed to list local workspace openers: {error}");
        Vec::new()
    })
}

fn opener_available(def: &OpenerDef, _app: &tauri::AppHandle) -> bool {
    if def.id == "file-manager" {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        def.macos_app_name.map_or(false, macos_app_exists)
    }
    #[cfg(target_os = "windows")]
    {
        // cmd and powershell are system shell built-ins shipped in %WINDIR%; their
        // launch does not depend on detection, so never gate them on a locate step.
        if matches!(def.id, "cmd" | "powershell") {
            return true;
        }
        detect_windows(def, _app).is_some()
    }
    #[cfg(target_os = "linux")]
    {
        def.linux_cli
            .map_or(false, |(cli, _)| find_on_path(cli).is_some())
    }
}

#[cfg(target_os = "windows")]
fn custom_opener_label(def: &OpenerDef, app: &tauri::AppHandle) -> Option<String> {
    if def.id != "custom" {
        return None;
    }
    let saved = opener_store::saved_exe_path(app, "custom")?;
    std::path::Path::new(&saved)
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "windows"))]
fn custom_opener_label(_def: &OpenerDef, _app: &tauri::AppHandle) -> Option<String> {
    None
}

#[tauri::command]
pub async fn pick_local_workspace_opener_exe(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let dialog_app = app.clone();
        let picked = tauri::async_runtime::spawn_blocking(move || {
            use tauri_plugin_dialog::DialogExt;
            dialog_app
                .dialog()
                .file()
                .add_filter("Executable", &["exe"])
                .blocking_pick_file()
        })
        .await
        .map_err(|error| format!("Failed to pick workspace opener executable: {error}"))?;
        match picked {
            Some(tauri_plugin_dialog::FilePath::Path(path)) => {
                opener_store::save_exe_path(&app, "custom", &path.to_string_lossy())?;
                Ok(Some(path.to_string_lossy().into_owned()))
            }
            Some(tauri_plugin_dialog::FilePath::Url(_)) => Ok(None),
            None => Ok(None),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Ok(None)
    }
}

pub fn launch_opener(_app: &tauri::AppHandle, opener_id: &str, path: &str) -> Result<(), String> {
    let def = opener_def(opener_id)
        .ok_or_else(|| format!("Unsupported workspace opener: {opener_id}"))?;
    if def.id == "file-manager" {
        return crate::platform_fs::open_directory(path);
    }

    #[cfg(target_os = "macos")]
    {
        let app_name = def
            .macos_app_name
            .ok_or_else(|| format!("{opener_id} is not available on macOS"))?;
        crate::open_local_workspace_with_app(app_name, path)
    }

    #[cfg(target_os = "windows")]
    {
        launch_windows(_app, def, path)
    }

    #[cfg(target_os = "linux")]
    {
        launch_linux(def, path)
    }
}

#[cfg(target_os = "macos")]
fn macos_app_exists(app_name: &str) -> bool {
    let bundle = format!("{app_name}.app");
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/Applications",
        &format!("{home}/Applications"),
        "/System/Applications",
        "/System/Applications/Utilities",
    ];
    candidates
        .iter()
        .any(|dir| std::path::Path::new(dir).join(&bundle).exists())
}

#[cfg(target_os = "windows")]
fn detect_windows(def: &OpenerDef, app: &tauri::AppHandle) -> Option<PathBuf> {
    let windows = def.windows?;

    if let Some(saved) = opener_store::saved_exe_path(app, def.id) {
        let path = PathBuf::from(saved);
        if path.is_file() {
            return Some(path);
        }
    }

    for var in windows.env_vars {
        // Unset override variables are common; skip them and keep probing the
        // remaining detection strategies instead of aborting detection.
        let Ok(value) = std::env::var(var) else {
            continue;
        };
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
        if path.is_dir() {
            if let Some(exe) = find_exe_in_dir(&path, windows.exe_candidates) {
                return Some(exe);
            }
        }
    }

    if let Some(cli) = windows.cli {
        if let Some(found) = find_on_path(cli) {
            return Some(found);
        }
    }

    for dir in windows.common_dirs {
        let dir_path = PathBuf::from(expand_windows_dir(dir));
        if let Some(exe) = find_exe_in_dir(&dir_path, windows.exe_candidates) {
            return Some(exe);
        }
    }

    // Fall back to shortcuts pinned in the Start Menu or on the Desktop; their
    // targets cover installs outside the well-known directories (e.g. JetBrains
    // Toolbox apps).
    for candidate in windows.exe_candidates {
        if let Some(exe) = shortcut_targets().get(&candidate.to_lowercase()) {
            return Some(exe.clone());
        }
    }

    None
}

/// Resolved targets of Start Menu and Desktop shortcuts, keyed by the lowercase
/// executable file name. Resolving every shortcut on every availability probe is
/// wasteful, so the scan runs once per process.
#[cfg(target_os = "windows")]
fn shortcut_targets() -> &'static HashMap<String, PathBuf> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<HashMap<String, PathBuf>> = OnceLock::new();
    CACHE.get_or_init(scan_shortcut_targets)
}

#[cfg(target_os = "windows")]
fn scan_shortcut_targets() -> HashMap<String, PathBuf> {
    // One PowerShell pass resolves the target of every .lnk in the user and
    // all-users Start Menu Programs and Desktop folders. WScript.Shell resolves
    // each shortcut without any unsafe code or extra dependencies here.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$seen = @{}
$folders = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('Programs'),
  [Environment]::GetFolderPath('CommonPrograms')
)
foreach ($dir in $folders) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Filter *.lnk -File -Recurse | ForEach-Object {
    try {
      $shortcut = $shell.CreateShortcut($_.FullName)
      $target = $shortcut.TargetPath
      if ($target -and (Test-Path -LiteralPath $target) -and -not $seen.ContainsKey($target.ToLower())) {
        $seen[$target.ToLower()] = $true
        Write-Output ([System.IO.Path]::GetFileName($target) + "`t" + $target)
      }
    } catch {}
  }
}
"#;
    let mut command = std::process::Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT]);
    crate::process::hide_windows_console(&mut command);
    let Ok(output) = command.output() else {
        return HashMap::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut targets = HashMap::new();
    for line in text.lines() {
        let Some((name, path)) = line.split_once('\t') else {
            continue;
        };
        let key = name.trim().to_lowercase();
        let value = path.trim();
        if !key.is_empty() && !value.is_empty() {
            targets.insert(key, PathBuf::from(value));
        }
    }
    targets
}

#[cfg(target_os = "windows")]
fn expand_windows_dir(template: &str) -> String {
    let mut result = template.to_string();
    for (token, var) in [
        ("%LOCALAPPDATA%", "LOCALAPPDATA"),
        ("%ProgramFiles(x86)%", "ProgramFiles(x86)"),
        ("%ProgramFiles%", "ProgramFiles"),
        ("%WINDIR%", "WINDIR"),
        ("%USERPROFILE%", "USERPROFILE"),
    ] {
        if let Ok(value) = std::env::var(var) {
            result = result.replace(token, &value);
        }
    }
    result
}

#[cfg(target_os = "windows")]
fn find_exe_in_dir(dir: &std::path::Path, candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(|candidate| dir.join(candidate))
        .find(|path| path.is_file())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for candidate in command_candidates(&dir, name) {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn command_candidates(dir: &std::path::Path, name: &str) -> Vec<PathBuf> {
    let mut candidates = vec![dir.join(name)];
    if cfg!(windows) {
        for extension in ["exe", "cmd", "bat", "com"] {
            candidates.push(dir.join(format!("{name}.{extension}")));
        }
    }
    candidates
}

#[cfg(target_os = "windows")]
fn launch_windows(app: &tauri::AppHandle, def: &OpenerDef, path: &str) -> Result<(), String> {
    match def.id {
        "cmd" => launch_detached_console(path, "cmd"),
        "powershell" => launch_detached_console(path, "powershell"),
        "terminal" => {
            let wt = detect_windows(def, app)
                .ok_or_else(|| "Windows Terminal is not installed".to_string())?;
            let mut command = std::process::Command::new(&wt);
            command.args(["-d", path]);
            crate::process::hide_windows_console(&mut command);
            let _ = command
                .spawn()
                .map_err(|error| format!("Failed to launch Windows Terminal: {error}"))?;
            Ok(())
        }
        _ => {
            let program = detect_windows(def, app)
                .ok_or_else(|| format!("{} is not installed", def.id))?;
            launch_executable(&program, path)
        }
    }
}

#[cfg(target_os = "windows")]
fn launch_detached_console(path: &str, shell: &str) -> Result<(), String> {
    let mut command = std::process::Command::new("cmd");
    if shell == "powershell" {
        let escaped = path.replace('\'', "''");
        command.args([
            "/C",
            "start",
            "",
            "powershell",
            "-NoExit",
            "-Command",
            &format!("Set-Location -LiteralPath '{escaped}'"),
        ]);
    } else {
        command.args([
            "/C",
            "start",
            "",
            "cmd",
            "/K",
            &format!("cd /d \"{path}\""),
        ]);
    }
    crate::process::hide_windows_console(&mut command);
    let _ = command
        .spawn()
        .map_err(|error| format!("Failed to open {shell} at {path}: {error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn launch_executable(program: &std::path::Path, path: &str) -> Result<(), String> {
    let extension = program
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let mut command = if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args([
            "/C",
            &format!("\"{}\" \"{}\"", program.to_string_lossy(), path),
        ]);
        cmd
    } else {
        let mut cmd = std::process::Command::new(program);
        cmd.arg(path);
        cmd
    };
    crate::process::hide_windows_console(&mut command);
    let _ = command
        .spawn()
        .map_err(|error| format!("Failed to launch {}: {error}", program.display()))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn launch_linux(def: &OpenerDef, path: &str) -> Result<(), String> {
    if def.id == "terminal" {
        let mut command = std::process::Command::new("x-terminal-emulator");
        command.args([
            "-e",
            "bash",
            "-c",
            &format!("cd \"{path}\" && exec $SHELL"),
        ]);
        let _ = command
            .spawn()
            .map_err(|error| format!("Failed to launch terminal: {error}"))?;
        return Ok(());
    }
    let (cli, args) = def
        .linux_cli
        .ok_or_else(|| format!("{} is not available on Linux", def.id))?;
    let mut command = std::process::Command::new(cli);
    command.args(args).arg(path);
    let _ = command
        .spawn()
        .map_err(|error| format!("Failed to launch {cli}: {error}"))?;
    Ok(())
}
