use std::collections::HashMap;
use std::path::PathBuf;

use tauri::Manager;

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("local-workspace-openers.json"))
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))
}

fn load(app: &tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("Failed to read workspace opener store: {error}"))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| format!("Failed to decode workspace opener store: {error}"))
}

pub fn saved_exe_path(app: &tauri::AppHandle, opener: &str) -> Option<String> {
    load(app).ok()?.get(opener).cloned()
}

pub fn save_exe_path(app: &tauri::AppHandle, opener: &str, exe_path: &str) -> Result<(), String> {
    // A corrupt or unreadable store must not block saving a new opener path;
    // fall back to an empty map and rewrite, matching saved_exe_path's tolerance.
    let mut entries = load(app).unwrap_or_default();
    entries.insert(opener.to_string(), exe_path.to_string());
    let path = store_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create app data directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(&entries)
        .map_err(|error| format!("Failed to encode workspace opener store: {error}"))?;
    // Write to a sibling temp file and rename so an interrupted write never
    // leaves the store truncated.
    let temp_path = path.with_extension("json.tmp");
    std::fs::write(&temp_path, bytes)
        .map_err(|error| format!("Failed to write workspace opener store: {error}"))?;
    std::fs::rename(&temp_path, &path)
        .map_err(|error| format!("Failed to replace workspace opener store: {error}"))
}
