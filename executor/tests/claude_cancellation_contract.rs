// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::PathBuf,
    sync::OnceLock,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::json;
use wegent_executor::{
    process::{CommandSpec, StreamProcessEngine},
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

fn env_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
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

#[tokio::test]
async fn claude_timeout_kills_process_before_late_side_effect() {
    let _lock = env_lock().lock().await;
    let root = unique_dir("claude-timeout-kill");
    let marker = root.join("late-marker");
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh")
            .arg("-c")
            .arg(format!("sleep 5; printf leaked > {}", marker.display())),
        1,
    );

    let started = Instant::now();
    let outcome = engine.run(ExecutionRequest::default()).await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "command timed out after 1s".to_owned()
        }
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(!marker.exists());
}

#[tokio::test]
async fn claude_timeout_does_not_persist_interrupted_session_id() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("claude-timeout-session-root");
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = StreamProcessEngine::new(
        CommandSpec::new("sh").arg("-c").arg(
            r#"printf '%s\n' '{"type":"system","subtype":"init","session_id":"interrupted-session"}'; sleep 5"#,
        ),
        1,
    );
    let request = ExecutionRequest {
        task_id: 9101,
        bot: json!([{"id": 4101, "shell_type": "ClaudeCode"}]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "command timed out after 1s".to_owned()
        }
    );
    assert!(!workspace_root.join("9101/.claude_session_id_4101").exists());
}

fn unique_dir(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}-{suffix}"));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}
