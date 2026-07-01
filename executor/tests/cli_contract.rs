// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    process::Command,
    sync::{Mutex, MutexGuard, OnceLock},
};
use wegent_executor::app::cli::{CliArgs, CliError};
use wegent_executor::version::get_version;

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

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

#[test]
fn version_prefers_environment_override() {
    let _lock = env_lock();
    let _guard = EnvGuard::set("WEGENT_EXECUTOR_VERSION", "9.9.9");
    assert_eq!(get_version(), "9.9.9");
}

#[test]
fn cli_accepts_version_and_config_flags() {
    let args = [
        "wegent-executor",
        "--config",
        "/tmp/device.json",
        "--version",
    ];
    let parsed = CliArgs::parse_from(args).unwrap();
    assert!(parsed.version);
    assert_eq!(parsed.config_path.as_deref(), Some("/tmp/device.json"));
}

#[test]
fn cli_rejects_missing_config_value() {
    let args = ["wegent-executor", "--config"];
    let error = CliArgs::parse_from(args).unwrap_err();
    assert_eq!(error, CliError::MissingValue("--config"));
}

#[test]
fn cli_rejects_flag_like_config_value() {
    let args = ["wegent-executor", "--config", "--version"];
    let error = CliArgs::parse_from(args).unwrap_err();
    assert_eq!(error, CliError::MissingValue("--config"));
}

#[test]
fn binary_version_exits_without_runtime_startup() {
    let output = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("--version")
        .env("WEGENT_EXECUTOR_VERSION", "7.8.9")
        .output()
        .expect("run wegent-executor --version");

    assert!(output.status.success());
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "7.8.9");
    assert!(output.stderr.is_empty());
}
