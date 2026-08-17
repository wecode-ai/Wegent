// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    io::{BufRead, BufReader, Read},
    process::{Command, Stdio},
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

#[test]
fn app_sidecar_reserves_stdout_for_jsonl_before_backend_startup() {
    let executor_home =
        std::env::temp_dir().join(format!("wegent-executor-cli-stdio-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&executor_home);
    let mut child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .env_remove("EXECUTOR_MODE")
        .env("WEGENT_EXECUTOR_HOME", &executor_home)
        .env("WEGENT_APP_IPC_DEVICE_ID", "app-device-stdio")
        .env("DEVICE_ID", "app-device-stdio")
        .env("WEGENT_BACKEND_URL", "http://127.0.0.1:9")
        .env("WEGENT_AUTH_TOKEN", "test-token")
        .env("DEVICE_SESSION_GATEWAY_HOST", "127.0.0.1")
        .env("DEVICE_SESSION_GATEWAY_PORT", "0")
        .env("DEVICE_PUBLIC_BASE_URL", "")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start app stdio sidecar");
    let mut stdout = BufReader::new(child.stdout.take().expect("capture app stdio stdout"));
    let mut ready_line = String::new();
    stdout
        .read_line(&mut ready_line)
        .expect("read app stdio ready event");

    let ready: serde_json::Value = serde_json::from_str(&ready_line)
        .expect("stdout must contain only JSONL protocol messages");
    assert_eq!(ready["event"], "executor.ready");
    assert_eq!(ready["payload"]["device_id"], "app-device-stdio");

    drop(child.stdin.take());
    let status = child.wait().expect("wait for app stdio sidecar");
    assert!(status.success());
    let mut remaining_stdout = String::new();
    stdout
        .read_to_string(&mut remaining_stdout)
        .expect("read remaining app stdio output");
    for line in remaining_stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
    {
        serde_json::from_str::<serde_json::Value>(line)
            .expect("all app sidecar stdout lines must be JSONL protocol messages");
    }

    let _ = std::fs::remove_dir_all(executor_home);
}
