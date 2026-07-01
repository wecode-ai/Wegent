// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use wegent_executor::config::device::{load_device_config, DeviceConfig, UpdateConfig};

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
fn update_config_deserializes_missing_fields_to_empty_defaults() {
    let config: UpdateConfig = serde_json::from_str(r#"{}"#).unwrap();

    assert_eq!(config.registry, "");
    assert_eq!(config.registry_token, "");
    assert!(!config.is_registry());
    assert_eq!(config.registry_url(), None);
    assert_eq!(config.token(), None);
}

#[test]
fn update_config_deserializes_partial_fields_with_defaults() {
    let config: UpdateConfig =
        serde_json::from_str(r#"{"registry":"https://example.com/registry"}"#).unwrap();

    assert_eq!(config.registry, "https://example.com/registry");
    assert_eq!(config.registry_token, "");
    assert!(config.is_registry());
    assert_eq!(config.registry_url(), Some("https://example.com/registry"));
    assert_eq!(config.token(), None);
}

#[test]
fn update_config_deserializes_legacy_url_and_token_aliases() {
    let config: UpdateConfig = serde_json::from_str(
        r#"{"url":"https://legacy.example.com/registry","token":"legacy-token"}"#,
    )
    .unwrap();

    assert_eq!(config.registry, "https://legacy.example.com/registry");
    assert_eq!(config.registry_token, "legacy-token");
}

#[test]
fn update_config_new_fields_take_precedence_over_legacy_aliases() {
    let config: UpdateConfig = serde_json::from_str(
        r#"{
            "registry":"https://new.example.com/registry",
            "url":"https://legacy.example.com/registry",
            "registry_token":"new-token",
            "token":"legacy-token"
        }"#,
    )
    .unwrap();

    assert_eq!(config.registry, "https://new.example.com/registry");
    assert_eq!(config.registry_token, "new-token");
}

#[test]
fn device_config_defaults_missing_update_to_empty_update_config() {
    let config: DeviceConfig =
        serde_json::from_str(r#"{"mode":"local","device_id":"test-device"}"#).unwrap();

    assert_eq!(config.update, UpdateConfig::default());
}

#[test]
fn device_config_deserializes_nested_update_config() {
    let config: DeviceConfig = serde_json::from_str(
        r#"{
            "mode":"local",
            "device_id":"test-device",
            "update":{
                "registry":"https://example.com/registry",
                "registry_token":"my-token"
            }
        }"#,
    )
    .unwrap();

    assert_eq!(config.update.registry, "https://example.com/registry");
    assert_eq!(config.update.registry_token, "my-token");
}

#[test]
fn device_config_deserializes_nested_update_legacy_aliases() {
    let config: DeviceConfig = serde_json::from_str(
        r#"{
            "mode":"local",
            "device_id":"test-device",
            "update":{
                "url":"https://legacy.example.com/registry",
                "token":"legacy-token"
            }
        }"#,
    )
    .unwrap();

    assert_eq!(
        config.update.registry,
        "https://legacy.example.com/registry"
    );
    assert_eq!(config.update.registry_token, "legacy-token");
}

#[test]
fn device_config_loader_leaves_update_env_resolution_to_updater_factory() {
    let _lock = lock_env();
    let _registry = EnvGuard::set("REGISTRY", "https://env.example.com/registry");
    let _token = EnvGuard::set("REGISTRY_TOKEN", "env-token");
    let path = temp_path("update-env-boundary-device-config.json");
    fs::write(&path, r#"{"update":{}}"#).unwrap();

    let config = load_device_config(Some(path.to_str().unwrap())).unwrap();

    // Rust has no Python-style should_save flag for update env overrides. Device config
    // loading preserves file-backed update settings; updater_factory_contract covers
    // runtime REGISTRY and REGISTRY_TOKEN resolution.
    assert_eq!(config.update.registry, "");
    assert_eq!(config.update.registry_token, "");
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
