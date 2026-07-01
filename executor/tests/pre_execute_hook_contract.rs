// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#![cfg(unix)]

use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use wegent_executor::hooks::pre_execute::{
    get_pre_execute_hook, PreExecuteContext, PreExecuteHook,
};

fn env_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[test]
fn enabled_reflects_hook_command_presence() {
    let hook = PreExecuteHook::new(None, Duration::from_secs(30));
    assert!(!hook.enabled());

    let hook = PreExecuteHook::new(
        Some("/path/to/script.sh".to_owned()),
        Duration::from_secs(30),
    );
    assert!(hook.enabled());
}

#[test]
fn env_config_uses_default_and_custom_timeout() {
    let empty = BTreeMap::new();
    let hook = PreExecuteHook::from_env_map(&empty);
    assert_eq!(hook.timeout_seconds(), 30);

    let env = BTreeMap::from([
        (
            "WEGENT_HOOK_PRE_EXECUTE".to_owned(),
            "/path/to/script.sh".to_owned(),
        ),
        (
            "WEGENT_HOOK_PRE_EXECUTE_TIMEOUT".to_owned(),
            "60".to_owned(),
        ),
    ]);
    let hook = PreExecuteHook::from_env_map(&env);
    assert!(hook.enabled());
    assert_eq!(hook.timeout_seconds(), 60);
}

#[tokio::test]
async fn execute_returns_zero_when_disabled() {
    let hook = PreExecuteHook::new(None, Duration::from_secs(30));

    let result = hook.execute(context("/tmp/task_dir", None, None)).await;

    assert_eq!(result.code, 0);
}

#[tokio::test]
async fn execute_runs_script_with_bash_and_passes_task_dir_argument() {
    let script = write_script(
        "hook-bash",
        r#"
if [ "$1" != "/tmp/my_task_dir" ]; then exit 1; fi
exit 0
"#,
    );
    let hook = PreExecuteHook::new(Some(script.display().to_string()), Duration::from_secs(30));

    let result = hook.execute(context("/tmp/my_task_dir", None, None)).await;

    assert_eq!(result.code, 0);
}

#[tokio::test]
async fn execute_returns_script_exit_code() {
    let script = write_script("hook-exit", "exit 42\n");
    let hook = PreExecuteHook::new(Some(script.display().to_string()), Duration::from_secs(30));

    let result = hook.execute(context("/tmp/task_dir", None, None)).await;

    assert_eq!(result.code, 42);
}

#[tokio::test]
async fn execute_returns_minus_one_on_timeout() {
    let script = write_script("hook-timeout", "sleep 10\n");
    let hook = PreExecuteHook::new(
        Some(script.display().to_string()),
        Duration::from_millis(50),
    );

    let result = hook.execute(context("/tmp/task_dir", None, None)).await;

    assert_eq!(result.code, -1);
}

#[tokio::test]
async fn execute_lets_bash_report_missing_script_as_127() {
    let hook = PreExecuteHook::new(
        Some("/nonexistent/wegent-pre-execute-hook.sh".to_owned()),
        Duration::from_secs(30),
    );

    let result = hook.execute(context("/tmp/task_dir", None, None)).await;

    assert_eq!(result.code, 127);
}

#[tokio::test]
async fn execute_injects_task_environment_variables() {
    let script = write_script(
        "hook-env",
        r#"
if [ "$WEGENT_TASK_DIR" != "/tmp/test_task" ]; then exit 1; fi
if [ "$WEGENT_TASK_ID" != "456" ]; then exit 2; fi
if [ "$WEGENT_GIT_URL" != "https://github.com/test/repo" ]; then exit 3; fi
exit 0
"#,
    );
    let hook = PreExecuteHook::new(Some(script.display().to_string()), Duration::from_secs(30));

    let result = hook
        .execute(context(
            "/tmp/test_task",
            Some(456),
            Some("https://github.com/test/repo"),
        ))
        .await;

    assert_eq!(result.code, 0);
}

#[tokio::test]
async fn execute_captures_stdout_and_stderr() {
    let script = write_script(
        "hook-output",
        r#"
echo stdout-message
echo stderr-message >&2
exit 0
"#,
    );
    let hook = PreExecuteHook::new(Some(script.display().to_string()), Duration::from_secs(30));

    let result = hook.execute(context("/tmp/task_dir", None, None)).await;

    assert_eq!(result.code, 0);
    assert!(result.stdout.contains("stdout-message"));
    assert!(result.stderr.contains("stderr-message"));
}

#[tokio::test]
async fn from_env_reads_process_environment() {
    let _lock = env_lock().lock().await;
    let _command = EnvGuard::set("WEGENT_HOOK_PRE_EXECUTE", "/path/to/script.sh");
    let _timeout = EnvGuard::set("WEGENT_HOOK_PRE_EXECUTE_TIMEOUT", "45");

    let hook = PreExecuteHook::from_env();

    assert!(hook.enabled());
    assert_eq!(hook.timeout_seconds(), 45);
}

#[test]
fn get_pre_execute_hook_returns_singleton_instance() {
    let hook1 = get_pre_execute_hook();
    let hook2 = get_pre_execute_hook();

    assert!(std::ptr::eq(hook1, hook2));
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

fn context(task_dir: &str, task_id: Option<i64>, git_url: Option<&str>) -> PreExecuteContext {
    PreExecuteContext {
        task_dir: PathBuf::from(task_dir),
        task_id,
        git_url: git_url.map(ToOwned::to_owned),
    }
}

fn write_script(name: &str, content: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "{name}-{}-{}.sh",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(&path, content).unwrap();
    path
}
