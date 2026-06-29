// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use wegent_executor::config::device::{load_device_config, RuntimeMode};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

struct EnvGuard {
    key: &'static str,
    original: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let original = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, original }
    }

    fn remove(key: &'static str) -> Self {
        let original = std::env::var(key).ok();
        std::env::remove_var(key);
        Self { key, original }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(value) = &self.original {
            std::env::set_var(self.key, value);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn missing_config_creates_stable_local_device_identity() {
    let _lock = lock_env();
    let _mode = EnvGuard::remove("EXECUTOR_MODE");
    let path = temp_path("missing-device-config.json");
    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();

    assert_eq!(config.runtime_mode(), RuntimeMode::Local);
    assert_eq!(config.device_type, "local");
    assert_eq!(config.bind_shell, "claudecode");
    assert!(!config.device_id.trim().is_empty());
    assert_ne!(config.device_id, "local-device");
    assert!(config
        .device_name
        .contains(&config.device_id[config.device_id.len() - 12..]));
    assert!(path.is_file());

    let reloaded = load_device_config(Some(path.to_str().unwrap())).unwrap();
    assert_eq!(reloaded.device_id, config.device_id);
    assert_eq!(reloaded.device_name, config.device_name);
}

#[test]
fn unicode_device_id_override_builds_default_name_without_byte_slicing() {
    let _lock = lock_env();
    let _mode = EnvGuard::remove("EXECUTOR_MODE");
    let _device_name = EnvGuard::remove("DEVICE_NAME");
    let _device_id = EnvGuard::set("DEVICE_ID", "设备-abcdefghi");
    let path = temp_path("unicode-device-config.json");
    fs::write(&path, "{}").unwrap();

    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();

    assert_eq!(config.device_id, "设备-abcdefghi");
    assert!(config.device_name.ends_with("设备-abcdefghi"));
}

#[test]
fn config_file_can_select_docker_mode() {
    let _lock = lock_env();
    let _mode = EnvGuard::remove("EXECUTOR_MODE");
    let path = temp_path("docker-device-config.json");
    fs::write(&path, r#"{"mode":"docker"}"#).unwrap();

    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();
    assert_eq!(config.runtime_mode(), RuntimeMode::Docker);
}

#[test]
fn env_mode_overrides_config_file_mode() {
    let _lock = lock_env();
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let path = temp_path("local-device-config.json");
    fs::write(&path, r#"{"mode":"local"}"#).unwrap();

    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();
    assert_eq!(config.runtime_mode(), RuntimeMode::Docker);
}

#[test]
fn remote_mode_is_not_treated_as_local_runtime_mode() {
    let _lock = lock_env();
    let _mode = EnvGuard::set("EXECUTOR_MODE", "remote");
    let path = temp_path("remote-device-config.json");
    fs::write(&path, r#"{"mode":"local"}"#).unwrap();

    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();

    assert_eq!(config.runtime_mode(), RuntimeMode::Remote);
}

#[test]
fn environment_overrides_connection_and_device_fields() {
    let _lock = lock_env();
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "http://localhost:8000");
    let _token = EnvGuard::set("WEGENT_AUTH_TOKEN", "wg-test");
    let _device_id = EnvGuard::set("DEVICE_ID", "device-1");
    let _device_name = EnvGuard::set("DEVICE_NAME", "Device One");
    let _device_type = EnvGuard::set("DEVICE_TYPE", "remote");
    let _bind_shell = EnvGuard::set("BIND_SHELL", "openclaw");
    let path = temp_path("env-overrides-config.json");
    fs::write(
        &path,
        r#"{"connection":{"backend_url":"http://old","auth_token":"old"}}"#,
    )
    .unwrap();

    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();

    assert_eq!(config.connection.backend_url, "http://localhost:8000");
    assert_eq!(config.connection.auth_token, "wg-test");
    assert_eq!(config.device_id, "device-1");
    assert_eq!(config.device_name, "Device One");
    assert_eq!(config.device_type, "remote");
    assert_eq!(config.bind_shell, "openclaw");
}

fn temp_path(name: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    path.push(format!("wegent-executor-{nanos}-{name}"));
    path
}

fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("lock test environment")
}
