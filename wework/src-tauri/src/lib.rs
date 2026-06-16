mod local_terminal;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(local_terminal::LocalTerminalState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_terminal::close_local_terminal,
            get_local_executor_device_id,
            local_path_exists,
            local_terminal::resize_local_terminal,
            local_terminal::start_local_terminal,
            local_terminal::write_local_terminal
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
