// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    fs,
    sync::{Mutex, MutexGuard, OnceLock},
};

use serde_json::Value;
use wegent_executor::local::command::{build_env, CommandHandler, CommandRequest};

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn build_env_removes_pyinstaller_runtime_variables() {
    let _lock = env_lock();
    let _archive = EnvGuard::set("_PYI_ARCHIVE_FILE", "/tmp/wegent-executor");
    let _parent = EnvGuard::set("_PYI_PARENT_PROCESS_LEVEL", "0");
    let _application = EnvGuard::set("_PYI_APPLICATION_HOME_DIR", "/tmp/_MEI123");
    let _meipass = EnvGuard::set("_MEIPASS", "/tmp/_MEI456");
    let _mei_custom = EnvGuard::set("_MEI_CUSTOM", "/tmp/_MEI789");
    let _home = EnvGuard::set("WECODE_HOME", "/tmp/wecode");

    let env = build_env(&HashMap::from([
        ("EXTRA_ENV".to_owned(), "ok".to_owned()),
        ("NULL_ENV".to_owned(), String::new()),
        ("_PYI_EXTRA".to_owned(), "bad".to_owned()),
        ("_MEI_EXTRA".to_owned(), "bad".to_owned()),
    ]));

    assert_eq!(env.get("WECODE_HOME"), Some(&"/tmp/wecode".to_owned()));
    assert_eq!(env.get("EXTRA_ENV"), Some(&"ok".to_owned()));
    assert_eq!(env.get("NULL_ENV"), Some(&String::new()));
    assert!(env.keys().all(|key| !key.starts_with("_PYI_")));
    assert!(env.keys().all(|key| !key.starts_with("_MEI_")));
    assert!(!env.contains_key("_MEIPASS"));
}

#[tokio::test]
async fn execute_command_uses_argv_and_cwd() {
    let workdir = unique_dir("argv-cwd");
    fs::create_dir_all(&workdir).unwrap();
    fs::write(workdir.join("target.txt"), "ok").unwrap();

    let result = CommandHandler
        .execute(CommandRequest {
            command: "cat".to_owned(),
            argv: vec!["cat".to_owned(), "target.txt".to_owned()],
            cwd: Some(workdir.display().to_string()),
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(result.success);
    assert_eq!(result.stdout, Value::String("ok".to_owned()));
}

#[tokio::test]
async fn execute_command_argv_does_not_invoke_shell() {
    let result = CommandHandler
        .execute(CommandRequest {
            command: "printf %s".to_owned(),
            argv: vec![
                "printf".to_owned(),
                "%s".to_owned(),
                "hello; echo hacked".to_owned(),
            ],
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(result.success);
    assert_eq!(
        result.stdout,
        Value::String("hello; echo hacked".to_owned())
    );
}

#[tokio::test]
async fn execute_command_returns_completed_process_result() {
    let result = CommandHandler
        .execute(CommandRequest {
            command: "printf 'hello'".to_owned(),
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(result.success);
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(result.stdout, Value::String("hello".to_owned()));
    assert_eq!(result.stderr, "");
    assert!(result.duration >= 0.0);
    assert!(!result.timed_out);
}

#[tokio::test]
async fn execute_command_times_out_and_returns_error() {
    let result = CommandHandler
        .execute(CommandRequest {
            command: "sleep 2".to_owned(),
            timeout_seconds: 0.1,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(!result.success);
    assert_eq!(result.exit_code, None);
    assert!(result.timed_out);
    assert!(result
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("timed out"));
}

#[tokio::test]
async fn execute_command_missing_cwd_returns_error() {
    let missing_cwd = unique_dir("missing-cwd");

    let result = CommandHandler
        .execute(CommandRequest {
            command: "pwd".to_owned(),
            cwd: Some(missing_cwd.display().to_string()),
            timeout_seconds: 5.0,
            max_output_bytes: 1024,
            ..CommandRequest::default()
        })
        .await;

    assert!(!result.success);
    assert_eq!(result.exit_code, None);
    assert!(result
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("Working directory does not exist"));
}

fn unique_dir(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-executor-local-command-{label}-{}",
        std::process::id()
    ))
}
