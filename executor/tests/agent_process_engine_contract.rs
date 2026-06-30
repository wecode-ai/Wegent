// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::{Cursor, Write},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
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

    fn remove(key: &'static str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::remove_var(key);
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
async fn agent_process_engine_applies_claude_specific_process_timeout() {
    let _lock = env_lock().lock().await;
    let _legacy_timeout = EnvGuard::remove("WEGENT_EXECUTOR_PROCESS_TIMEOUT_SECONDS");
    let _timeout = EnvGuard::set("WEGENT_CLAUDE_CODE_PROCESS_TIMEOUT_SECONDS", "1");
    let fake_claude = write_fake_executable(
        "fake-claude-timeout",
        r#"#!/bin/sh
sleep 5
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
        ExecutionOutcome::Failed {
            message: "command timed out after 1s".to_owned()
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
        fs::read_to_string(executor_home.join("sessions/81/.claude_session_id_321")).unwrap(),
        "saved-from-output"
    );
    assert!(!workspace_root.join("81/.claude_session_id_321").exists());
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
async fn agent_process_engine_uses_executor_home_workspace_for_local_task_dir() {
    let _lock = env_lock().lock().await;
    let executor_home = unique_dir("claude-local-executor-home");
    let _executor_home =
        EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _workspace_root = EnvGuard::remove("WORKSPACE_ROOT");
    let _wegent_workspace_root = EnvGuard::remove("WEGENT_WORKSPACE_ROOT");
    let _local_workspace_root = EnvGuard::remove("LOCAL_WORKSPACE_ROOT");
    let _mode = EnvGuard::set("EXECUTOR_MODE", "local");
    let fake_claude = write_fake_executable(
        "fake-claude-local-cwd",
        r#"#!/bin/sh
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$(pwd)"
"#,
    );
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 2149,
        prompt: json!("run in local task dir"),
        bot: json!([{"id": 2149, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;
    let expected_cwd = fs::canonicalize(executor_home.join("workspace/2149")).unwrap();

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: expected_cwd.display().to_string()
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_clones_git_workspace_before_running_claude() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("claude-git-workspace-root");
    let bin_dir = unique_dir("claude-git-bin");
    let marker = unique_dir("claude-git-marker").join("git-args.txt");
    fs::create_dir_all(&bin_dir).unwrap();
    write_fake_git(&bin_dir, &marker);
    let fake_claude = write_fake_executable(
        "fake-claude-git-cwd",
        r#"#!/bin/sh
if [ ! -d ".git" ]; then exit 30; fi
if [ ! -f "source.txt" ]; then exit 31; fi
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$(pwd)"
"#,
    );
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let path_value = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let _path = EnvGuard::set("PATH", &path_value);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 85,
        prompt: json!("run in cloned repo"),
        bot: json!([{"id": 325, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([
            (
                "git_url".to_owned(),
                json!("https://github.com/wecode-ai/Wegent.git"),
            ),
            ("branch_name".to_owned(), json!("feature/test")),
        ]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;
    let expected_cwd = fs::canonicalize(workspace_root.join("85/Wegent")).unwrap();

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: expected_cwd.display().to_string()
        }
    );
    let git_args = fs::read_to_string(marker).unwrap();
    assert!(git_args.contains("clone --branch feature/test --single-branch"));
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_downloads_claude_attachments_to_local_task_workspace() {
    let _lock = env_lock().lock().await;
    let executor_home = unique_dir("claude-local-attachment-home");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let backend_url = serve_one_http_response(b"fake-image".to_vec(), Arc::clone(&requests)).await;
    let fake_claude = write_fake_executable(
        "fake-claude-attachment-prompt",
        r#"#!/bin/sh
payload="$(cat)"
for arg in "$@"; do
  payload="$payload $arg"
done
printf '%s\n' "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$payload")}]}}"
"#,
    );
    let _executor_home =
        EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _workspace_root = EnvGuard::remove("WORKSPACE_ROOT");
    let _wegent_workspace_root = EnvGuard::remove("WEGENT_WORKSPACE_ROOT");
    let _local_workspace_root = EnvGuard::remove("LOCAL_WORKSPACE_ROOT");
    let _mode = EnvGuard::set("EXECUTOR_MODE", "local");
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 2201,
        subtask_id: 3212,
        backend_url: Some(backend_url),
        auth_token: Some("task-token".to_owned()),
        prompt: json!([
            {
                "type": "input_text",
                "text": "<attachment>[Image Attachment: image.png | ID: 3212 | Type: image/png | Size: 10 bytes | URL: /api/attachments/3212/download | File Path in Sandbox: /home/user/2201:executor:attachments/3212/image.png]</attachment>"
            },
            {"type": "input_text", "text": "这个图片存在什么位置"}
        ]),
        bot: json!([{"id": 2201, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([(
            "attachments".to_owned(),
            json!([{
                "id": 3212,
                "original_filename": "image.png",
                "mime_type": "image/png",
                "file_size": 10,
                "subtask_id": 3212
            }]),
        )]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;
    let content = match outcome {
        ExecutionOutcome::Completed { content } => content,
        other => panic!("unexpected outcome: {other:?}"),
    };
    let local_path = executor_home
        .join("workspace/2201/2201:executor:attachments/3212/image.png")
        .display()
        .to_string();

    assert!(content.contains(&local_path), "{content}");
    assert!(!content.contains("/home/user/2201:executor:attachments/3212/image.png"));
    assert_eq!(
        fs::read(executor_home.join("workspace/2201/2201:executor:attachments/3212/image.png"))
            .unwrap(),
        b"fake-image"
    );
    let request = requests.lock().unwrap().first().cloned().unwrap();
    assert!(
        request.starts_with("GET /api/attachments/3212/executor-download HTTP/1.1"),
        "{request}"
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer task-token"),
        "{request}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_deploys_standalone_task_skills_before_claude() {
    let _lock = env_lock().lock().await;
    let home = unique_dir("claude-standalone-task-skill-home");
    let workspace_root = unique_dir("claude-standalone-task-skill-workspace");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let backend_url =
        serve_one_http_response(skill_zip_bytes("task-skill"), Arc::clone(&requests)).await;
    let fake_claude = write_fake_executable(
        "fake-claude-task-skill",
        r#"#!/bin/sh
global_config=false
task_skill=false
if [ "$CLAUDE_CONFIG_DIR" = "$HOME/.claude" ]; then global_config=true; fi
if [ -f "$SKILLS_DIR/task-skill/SKILL.md" ]; then task_skill=true; fi
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"global=%s skill=%s"}]}}\n' "$global_config" "$task_skill"
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 86,
        backend_url: Some(backend_url),
        auth_token: Some("task-token".to_owned()),
        prompt: json!("run with task skill"),
        bot: json!([{"id": 326, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([
            ("project_id".to_owned(), json!(0)),
            ("standalone_chat_workspace".to_owned(), json!(true)),
            ("skill_names".to_owned(), json!(["task-skill"])),
            (
                "skill_refs".to_owned(),
                json!({
                    "task-skill": {
                        "skill_id": 42,
                        "namespace": "default",
                        "is_public": false,
                    }
                }),
            ),
        ]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "global=true skill=true".to_owned()
        }
    );
    let request = requests.lock().unwrap().first().cloned().unwrap();
    assert!(
        request.starts_with(
            "GET /api/v1/kinds/skills/42/download?namespace=default&task_id=86 HTTP/1.1"
        ),
        "{request}"
    );
    assert!(
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer task-token"),
        "{request}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_deploys_bot_skills_for_regular_claude_tasks() {
    let _lock = env_lock().lock().await;
    let home = unique_dir("claude-regular-bot-skill-home");
    let workspace_root = unique_dir("claude-regular-bot-skill-workspace");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let backend_url =
        serve_one_http_response(skill_zip_bytes("agent-skill"), Arc::clone(&requests)).await;
    let fake_claude = write_fake_executable(
        "fake-claude-regular-bot-skill",
        r#"#!/bin/sh
global_config=false
agent_skill=false
if [ "$CLAUDE_CONFIG_DIR" = "$HOME/.claude" ]; then global_config=true; fi
if [ -f "$SKILLS_DIR/agent-skill/SKILL.md" ]; then agent_skill=true; fi
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"global=%s skill=%s"}]}}\n' "$global_config" "$agent_skill"
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 87,
        backend_url: Some(backend_url),
        auth_token: Some("task-token".to_owned()),
        prompt: json!("run with bot skill"),
        bot: json!([{
            "id": 327,
            "shell_type": "ClaudeCode",
            "skills": ["agent-skill"],
            "skill_refs": {
                "agent-skill": {
                    "skill_id": 43,
                    "namespace": "default",
                    "is_public": false,
                }
            }
        }]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "global=true skill=true".to_owned()
        }
    );
    let request = requests.lock().unwrap().first().cloned().unwrap();
    assert!(
        request.starts_with(
            "GET /api/v1/kinds/skills/43/download?namespace=default&task_id=87 HTTP/1.1"
        ),
        "{request}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_restores_enabled_claude_plugin_zip_before_claude() {
    let _lock = env_lock().lock().await;
    let home = unique_dir("claude-plugin-zip-home");
    let workspace_root = unique_dir("claude-plugin-zip-workspace");
    let claude_dir = home.join(".claude");
    let plugins_dir = claude_dir.join("plugins");
    let install_path = plugins_dir.join("cache/wegent/superpowers/5.0.7");
    fs::create_dir_all(plugins_dir.join("cache/claude-plugins-official")).unwrap();
    fs::write(
        claude_dir.join("settings.json"),
        json!({"enabledPlugins": {"superpowers@wegent": true}}).to_string(),
    )
    .unwrap();
    fs::write(
        plugins_dir.join("installed_plugins.json"),
        json!({
            "version": 2,
            "plugins": {
                "superpowers@wegent": [{
                    "installPath": install_path.display().to_string(),
                    "version": "5.0.7"
                }]
            }
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        plugins_dir.join("cache/claude-plugins-official/superpowers.zip"),
        plugin_zip_bytes("superpowers", "5.0.7", "systematic-debugging"),
    )
    .unwrap();
    let fake_claude = write_fake_executable(
        "fake-claude-plugin-zip",
        r#"#!/bin/sh
plugin_skill=false
if [ -f "$HOME/.claude/plugins/cache/wegent/superpowers/5.0.7/skills/systematic-debugging/SKILL.md" ]; then plugin_skill=true; fi
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"plugin=%s"}]}}\n' "$plugin_skill"
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 88,
        prompt: json!("run with global plugin skill"),
        bot: json!([{"id": 328, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "plugin=true".to_owned()
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
        skip_git_clone: true,
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
async fn agent_process_engine_writes_file_edit_hooks_before_claude() {
    let _lock = env_lock().lock().await;
    let home = unique_dir("claude-file-edit-hook-home");
    let workspace_root = unique_dir("claude-file-edit-hook-workspace-root");
    let hook_command = "curl -s -X POST http://127.0.0.1:3456/api/file-edit-log --data-binary @-";
    let fake_claude = write_fake_executable(
        "fake-claude-file-edit-hook",
        r#"#!/bin/sh
settings="$CLAUDE_CONFIG_DIR/settings.json"
python3 - "$settings" <<'PY'
import json
import sys

settings_path = sys.argv[1]
with open(settings_path, "r", encoding="utf-8") as handle:
    settings = json.load(handle)
hooks = settings.get("hooks", {})
pre = hooks.get("PreToolUse", [])
post = hooks.get("PostToolUse", [])
file_edit_groups = [
    group
    for group in pre + post
    if group.get("matcher") == "Write|Edit|MultiEdit|NotebookEdit"
]
commands = [
    hook.get("command")
    for group in file_edit_groups
    for hook in group.get("hooks", [])
]
payload = {
    "has_pre": any(group.get("matcher") == "Write|Edit|MultiEdit|NotebookEdit" for group in pre),
    "has_post": any(group.get("matcher") == "Write|Edit|MultiEdit|NotebookEdit" for group in post),
    "commands": commands,
    "matchers": [group.get("matcher") for group in file_edit_groups],
}
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": json.dumps(payload, sort_keys=True)}]}}))
PY
"#,
    );
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _file_edit_hook = EnvGuard::set("WEGENT_FILE_EDIT_HOOK_COMMAND", hook_command);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 85,
        prompt: json!("inspect file edit hooks"),
        bot: json!([{"id": 325, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;
    let content = match outcome {
        ExecutionOutcome::Completed { content } => content,
        other => panic!("unexpected outcome: {other:?}"),
    };
    let payload: serde_json::Value = serde_json::from_str(&content).unwrap();

    assert_eq!(payload["has_pre"], true);
    assert_eq!(payload["has_post"], true);
    assert!(payload["commands"]
        .as_array()
        .unwrap()
        .iter()
        .all(|command| command == hook_command));
    assert!(payload["matchers"]
        .as_array()
        .unwrap()
        .iter()
        .all(|matcher| matcher == "Write|Edit|MultiEdit|NotebookEdit"));
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_replaces_stale_file_edit_hooks_before_claude() {
    let _lock = env_lock().lock().await;
    let workspace_root = unique_dir("claude-stale-file-edit-hook-workspace-root");
    let task_dir = workspace_root.join("86");
    let settings_path = task_dir.join(".claude/settings.json");
    fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    fs::write(
        &settings_path,
        r#"{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "tee -a /tmp/hook-debug.log | curl -sS -X POST http://127.0.0.1:3456/api/file-edit-log --data-binary @-"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "tee -a /tmp/hook-debug.log | curl -sS -X POST http://127.0.0.1:3456/api/file-edit-log --data-binary @-"
          }
        ]
      }
    ]
  }
}
"#,
    )
    .unwrap();
    let hook_command = "curl -s -X POST http://127.0.0.1:3456/api/file-edit-log --data-binary @-";
    let fake_claude = write_fake_executable(
        "fake-claude-stale-file-edit-hook",
        r#"#!/bin/sh
settings="$CLAUDE_CONFIG_DIR/settings.json"
python3 - "$settings" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    settings = json.load(handle)
hooks = settings.get("hooks", {})
pre = [
    group
    for group in hooks.get("PreToolUse", [])
    if group.get("matcher") == "Write|Edit|MultiEdit|NotebookEdit"
]
post = [
    group
    for group in hooks.get("PostToolUse", [])
    if group.get("matcher") == "Write|Edit|MultiEdit|NotebookEdit"
]
payload = {
    "pre_count": len(pre),
    "post_count": len(post),
    "commands": [
        hook.get("command")
        for group in pre + post
        for hook in group.get("hooks", [])
    ],
}
print(json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": json.dumps(payload, sort_keys=True)}]}}))
PY
"#,
    );
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _file_edit_hook = EnvGuard::set("WEGENT_FILE_EDIT_HOOK_COMMAND", hook_command);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: 86,
        prompt: json!("replace stale file edit hooks"),
        bot: json!([{"id": 326, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;
    let content = match outcome {
        ExecutionOutcome::Completed { content } => content,
        other => panic!("unexpected outcome: {other:?}"),
    };
    let payload: serde_json::Value = serde_json::from_str(&content).unwrap();

    assert_eq!(payload["pre_count"], 1);
    assert_eq!(payload["post_count"], 1);
    assert!(payload["commands"]
        .as_array()
        .unwrap()
        .iter()
        .all(|command| command == hook_command));
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

#[cfg(unix)]
fn write_fake_git(bin_dir: &std::path::Path, marker: &std::path::Path) {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let path = bin_dir.join("git");
    let content = format!(
        r#"#!/bin/sh
printf '%s\n' "$*" >> '{}'
if [ "$1" = "clone" ]; then
  shift
  BRANCH=""
  if [ "$1" = "--branch" ]; then
    BRANCH="$2"
    shift 3
  fi
  URL="$1"
  DEST="$2"
  mkdir -p "$DEST/.git"
  printf '%s\n%s\n' "$URL" "$BRANCH" > "$DEST/source.txt"
  exit 0
fi
if [ "$1" = "-C" ] && [ "$3" = "config" ]; then
  exit 0
fi
exit 21
"#,
        marker.display()
    );
    fs::write(&path, content).unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).unwrap();
}

fn unique_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    path
}

async fn serve_one_http_response(body: Vec<u8>, requests: Arc<Mutex<Vec<String>>>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0; 8192];
        let read = stream.read(&mut buffer).await.unwrap();
        requests
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(&buffer[..read]).to_string());
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        stream.write_all(&body).await.unwrap();
    });
    format!("http://{address}")
}

fn skill_zip_bytes(skill_name: &str) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::FileOptions::default();
    writer
        .start_file(format!("{skill_name}/SKILL.md"), options)
        .unwrap();
    writer.write_all(b"# Task Skill").unwrap();
    writer.finish().unwrap().into_inner()
}

fn plugin_zip_bytes(plugin_name: &str, version: &str, skill_name: &str) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::FileOptions::default();
    let root = format!("{plugin_name}/{version}");
    writer
        .start_file(format!("{root}/.claude-plugin/plugin.json"), options)
        .unwrap();
    writer
        .write_all(format!(r#"{{"name":"{plugin_name}","version":"{version}"}}"#).as_bytes())
        .unwrap();
    writer
        .start_file(format!("{root}/skills/{skill_name}/SKILL.md"), options)
        .unwrap();
    writer.write_all(b"# Plugin Skill").unwrap();
    writer.finish().unwrap().into_inner()
}
