// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, path::PathBuf, sync::OnceLock};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde_json::json;
use wegent_executor::{
    agents::{AgentCommandPlanner, AgentProcessEngine},
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

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_runs_planned_claude_command_and_parses_stream_output() {
    let _lock = env_lock().lock().await;
    let fake_claude = write_fake_executable(
        "fake-claude",
        r#"#!/bin/sh
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"planned"}]}}'
"#,
    );
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        prompt: json!("run"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "planned".to_owned()
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_saves_claude_session_id_for_follow_up_turns() {
    let _lock = env_lock().lock().await;
    let executor_home = unique_dir("claude-session-save-home");
    let workspace_root = unique_dir("claude-session-save-workspace-root");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let fake_claude = write_fake_executable(
        "fake-claude-session",
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"saved-from-output"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"session saved"}]}}'
"#,
    );
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 81,
        prompt: json!("remember"),
        bot: json!([{"id": 321, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "session saved".to_owned()
        }
    );
    assert_eq!(
        fs::read_to_string(workspace_root.join("81/.claude_session_id_321")).unwrap(),
        "saved-from-output"
    );
    assert!(!executor_home
        .join("sessions/81/.claude_session_id_321")
        .exists());
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_creates_workspace_task_dir_before_running_claude() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("claude-created-workspace-root");
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let fake_claude = write_fake_executable(
        "fake-claude-cwd",
        r#"#!/bin/sh
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$(pwd)"
"#,
    );
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 82,
        prompt: json!("run in task dir"),
        bot: json!([{"id": 322, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;
    let expected_cwd = fs::canonicalize(workspace_root.join("82")).unwrap();

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: expected_cwd.display().to_string()
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_runs_pre_execute_hook_before_claude() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("claude-hook-workspace-root");
    let marker_dir = unique_dir("claude-hook-marker");
    fs::create_dir_all(&marker_dir).unwrap();
    let marker = marker_dir.join("hook-ran");
    let hook_script = write_fake_executable(
        "pre-execute-hook",
        &format!(
            r#"#!/bin/sh
if [ ! -d "$WEGENT_TASK_DIR" ]; then exit 10; fi
if [ "$WEGENT_TASK_ID" != "83" ]; then exit 11; fi
if [ "$WEGENT_GIT_URL" != "https://github.com/wecode-ai/Wegent.git" ]; then exit 12; fi
printf hook > "{}"
exit 0
"#,
            marker.display()
        ),
    );
    let fake_claude = write_fake_executable(
        "fake-claude-hook",
        &format!(
            r#"#!/bin/sh
if [ ! -f "{}" ]; then exit 13; fi
printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"hook first"}}]}}}}'
"#,
            marker.display()
        ),
    );
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _hook = EnvGuard::set(
        "WEGENT_HOOK_PRE_EXECUTE",
        &hook_script.display().to_string(),
    );
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 83,
        prompt: json!("run with hook"),
        bot: json!([{"id": 323, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([(
            "git_url".to_owned(),
            json!("https://github.com/wecode-ai/Wegent.git"),
        )]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "hook first".to_owned()
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_keeps_running_when_pre_execute_hook_is_nonzero() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("claude-hook-nonzero-workspace-root");
    let hook_script = write_fake_executable(
        "pre-execute-hook-nonzero",
        r#"#!/bin/sh
exit 42
"#,
    );
    let fake_claude = write_fake_executable(
        "fake-claude-after-hook-nonzero",
        r#"#!/bin/sh
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"continued"}]}}'
"#,
    );
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _hook = EnvGuard::set(
        "WEGENT_HOOK_PRE_EXECUTE",
        &hook_script.display().to_string(),
    );
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 84,
        prompt: json!("continue after hook"),
        bot: json!([{"id": 324, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "continued".to_owned()
        }
    );
}

fn write_fake_executable(name: &str, content: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn unique_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    path
}
