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
    let _runtime_instance_id = EnvGuard::remove("WEGENT_RUNTIME_INSTANCE_ID");
    let _device_id = EnvGuard::remove("DEVICE_ID");
    let _device_name = EnvGuard::remove("DEVICE_NAME");
    let _device_type = EnvGuard::remove("DEVICE_TYPE");
    let _bind_shell = EnvGuard::remove("BIND_SHELL");
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
    assert!(config.runtime_instance_id.starts_with("runtime-"));
    assert!(path.is_file());

    let reloaded = load_device_config(Some(path.to_str().unwrap())).unwrap();
    assert_eq!(reloaded.device_id, config.device_id);
    assert_eq!(reloaded.runtime_instance_id, config.runtime_instance_id);
    assert_eq!(reloaded.device_name, config.device_name);
}

#[test]
fn device_id_override_does_not_change_runtime_instance_identity() {
    let _lock = lock_env();
    let _runtime_instance_id = EnvGuard::remove("WEGENT_RUNTIME_INSTANCE_ID");
    let _device_id = EnvGuard::set("DEVICE_ID", "route-device");
    let path = temp_path("runtime-instance-device-config.json");
    fs::write(
        &path,
        r#"{"device_id":"stored-device","runtime_instance_id":"runtime-stable"}"#,
    )
    .unwrap();

    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();

    assert_eq!(config.device_id, "route-device");
    assert_eq!(config.runtime_instance_id, "runtime-stable");
}

#[test]
fn runtime_instance_id_has_a_dedicated_environment_override() {
    let _lock = lock_env();
    let _runtime_instance_id = EnvGuard::set("WEGENT_RUNTIME_INSTANCE_ID", "runtime-env");
    let path = temp_path("runtime-instance-env-config.json");
    fs::write(&path, r#"{"device_id":"stored-device"}"#).unwrap();

    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();

    assert_eq!(config.runtime_instance_id, "runtime-env");
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
fn non_docker_mode_is_treated_as_local_runtime_mode() {
    let _lock = lock_env();
    let _mode = EnvGuard::set("EXECUTOR_MODE", "desktop");
    let path = temp_path("desktop-device-config.json");
    fs::write(&path, r#"{"mode":"local"}"#).unwrap();

    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();

    assert_eq!(config.runtime_mode(), RuntimeMode::Local);
}

#[test]
fn environment_overrides_connection_and_device_fields() {
    let _lock = lock_env();
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", "http://localhost:8000");
    let _socket = EnvGuard::set("WEGENT_SOCKET_URL", "wss://socket.example.com");
    let _token = EnvGuard::set("WEGENT_AUTH_TOKEN", "wg-test");
    let _device_id = EnvGuard::set("DEVICE_ID", "device-1");
    let _device_name = EnvGuard::set("DEVICE_NAME", "Device One");
    let _device_type = EnvGuard::set("DEVICE_TYPE", "remote");
    let _bind_shell = EnvGuard::set("BIND_SHELL", "openclaw");
    let path = temp_path("env-overrides-config.json");
    fs::write(
        &path,
        r#"{"connection":{"backend_url":"http://old","socket_url":"ws://old","auth_token":"old"}}"#,
    )
    .unwrap();

    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();

    assert_eq!(config.connection.backend_url, "http://localhost:8000");
    assert_eq!(config.connection.socket_url, "wss://socket.example.com");
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

#[test]
fn wework_first_start_uses_a_persisted_uuid_before_app_profile_connects() {
    let _lock = lock_env();
    let _device_id = EnvGuard::remove("DEVICE_ID");
    let _device_type = EnvGuard::set("DEVICE_TYPE", "local");
    let _app = EnvGuard::set("WEGENT_APP_IPC_DEVICE_ID", "electron-test");
    let path = temp_path("wework-uuid.json");
    let first = load_device_config(Some(path.to_str().unwrap())).unwrap();
    assert_eq!(
        uuid::Uuid::parse_str(&first.device_id)
            .unwrap()
            .get_version_num(),
        4
    );
    let second = load_device_config(Some(path.to_str().unwrap())).unwrap();
    assert_eq!(first.device_id, second.device_id);
    assert_eq!(first.runtime_instance_id, second.runtime_instance_id);
    let independent =
        load_device_config(Some(temp_path("wework-other.json").to_str().unwrap())).unwrap();
    assert_ne!(first.device_id, independent.device_id);
}

#[test]
fn wework_keeps_legacy_identity_and_rejects_corrupt_config() {
    let _lock = lock_env();
    let _device_id = EnvGuard::remove("DEVICE_ID");
    let _runtime = EnvGuard::remove("WEGENT_RUNTIME_INSTANCE_ID");
    let _app = EnvGuard::set("WEGENT_APP_IPC_DEVICE_ID", "electron-test");
    let path = temp_path("wework-legacy.json");
    fs::write(
        &path,
        r#"{"device_id":"local-device","runtime_instance_id":"runtime-old"}"#,
    )
    .unwrap();
    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();
    assert_eq!(config.device_id, "local-device");
    assert_eq!(config.runtime_instance_id, "runtime-old");
    fs::write(&path, "broken config").unwrap();
    assert!(load_device_config(Some(path.to_str().unwrap())).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "broken config");
}

#[test]
fn simultaneous_wework_initialization_has_one_identity() {
    let _lock = lock_env();
    let _device_id = EnvGuard::remove("DEVICE_ID");
    let _app = EnvGuard::set("WEGENT_APP_IPC_DEVICE_ID", "electron-test");
    let path = temp_path("wework-concurrent.json");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let path = path.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                load_device_config(Some(path.to_str().unwrap())).unwrap()
            })
        })
        .collect();
    let configs: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    for config in &configs {
        assert_eq!(config.device_id, configs[0].device_id);
        assert_eq!(config.runtime_instance_id, configs[0].runtime_instance_id);
    }
}
