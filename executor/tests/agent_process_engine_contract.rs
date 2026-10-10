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

#[path = "agent_process_engine_contract/claude_capabilities.rs"]
mod claude_capabilities;

fn env_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

// Every native path is isolated before any process planning or preparation.
fn isolated_environment() -> Vec<EnvGuard> {
    let root = unique_dir("claude-process-contract-environment");
    fs::create_dir_all(&root).unwrap();
    let mut guards = Vec::new();
    for key in [
        "WEGENT_CLAUDE_HOME",
        "CLAUDE_CONFIG_DIR",
        "SKILLS_DIR",
        "WEGENT_EXECUTOR_PROJECTS_DIR",
        "WORKSPACE_ROOT",
        "WEGENT_WORKSPACE_ROOT",
        "LOCAL_WORKSPACE_ROOT",
        "WEGENT_BACKEND_URL",
        "TASK_API_DOMAIN",
    ] {
        guards.push(EnvGuard::remove(key));
    }
    for (key, suffix) in [
        ("HOME", "home"),
        ("WEGENT_EXECUTOR_HOME", "executor"),
        ("WEGENT_WORKBENCH_HOME", "workbench"),
    ] {
        let path = root.join(suffix);
        fs::create_dir_all(&path).unwrap();
        guards.push(EnvGuard::set(key, path.to_str().unwrap()));
    }
    guards
}

fn fixture_agent_home() -> PathBuf {
    PathBuf::from(std::env::var_os("WEGENT_WORKBENCH_HOME").unwrap())
        .join("agents/test-user/default/test-agent")
}

fn with_backend_identity(mut request: ExecutionRequest) -> ExecutionRequest {
    if request.bot[0]["id"].is_null() || request.extra.get("team_id") == Some(&json!(0)) {
        return request;
    }
    request
        .backend_url
        .get_or_insert_with(|| "https://backend.example".to_owned());
    request
        .user_name
        .get_or_insert_with(|| "test-user".to_owned());
    request
        .team_namespace
        .get_or_insert_with(|| "default".to_owned());
    for (key, value) in [
        ("user_id", json!(7)),
        ("team_id", json!(12)),
        ("team_name", json!("test-agent")),
    ] {
        request.extra.entry(key.to_owned()).or_insert(value);
    }
    request
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
    let _environment = isolated_environment();
    let workspace_dir = unique_dir("claude-planned-command-workspace");
    let fake_claude = write_fake_executable(
        "fake-claude",
        r#"#!/bin/sh
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"planned"}]}}'
"#,
    );
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        project_workspace_path: Some(workspace_dir.display().to_string()),
        prompt: json!("run"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "planned".to_owned()
        }
    );
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_does_not_inject_project_space_mcp_into_claude_runs() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let workspace_dir = unique_dir("claude-no-space-mcp-workspace");
    let args_dir = unique_dir("claude-no-space-mcp");
    fs::create_dir_all(&args_dir).unwrap();
    let args_file = args_dir.join("args.txt");
    let fake_claude = write_fake_executable(
        "fake-claude-no-space-mcp",
        &format!(
            r#"#!/bin/sh
printf '%s\n' "$@" > "{}"
cat >/dev/null
printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"done"}}]}}}}'
"#,
            args_file.display()
        ),
    );
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        project_workspace_path: Some(workspace_dir.display().to_string()),
        prompt: json!("run"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
    let args = fs::read_to_string(&args_file).unwrap();
    assert!(!args.contains("wework_space"));
    let mcp_config_path = args
        .split_whitespace()
        .collect::<Vec<_>>()
        .windows(2)
        .find_map(|pair| (pair[0] == "--mcp-config").then_some(pair[1]))
        .map(PathBuf::from);
    if let Some(path) = mcp_config_path {
        let config = fs::read_to_string(path).unwrap();
        assert!(!config.contains("wework_space"));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_applies_claude_specific_process_timeout() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let workspace_dir = unique_dir("claude-timeout-workspace");
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
        project_workspace_path: Some(workspace_dir.display().to_string()),
        prompt: json!("run"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

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
    let _environment = isolated_environment();
    let executor_home = unique_dir("claude-session-save-home");
    let workspace_root = unique_dir("claude-session-save-workspace-root");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let fake_claude = write_fake_executable(
        "fake-claude-session",
        r#"#!/bin/sh
cat >/dev/null
printf '%s\n' '{"type":"system","subtype":"init","session_id":"saved-from-output"}'
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"session saved"}]}}'
"#,
    );
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "81".to_owned(),
        prompt: json!("remember"),
        bot: json!([{"id": 321, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

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
    let _environment = isolated_environment();
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
        task_id: "82".to_owned(),
        prompt: json!("run in task dir"),
        bot: json!([{"id": 322, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;
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
    let _environment = isolated_environment();
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
        task_id: "2149".to_owned(),
        prompt: json!("run in local task dir"),
        bot: json!([{"id": 2149, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;
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
    let _environment = isolated_environment();
    let workspace_root = unique_dir("claude-git-workspace-root");
    let executor_home = unique_dir("claude-git-executor-home");
    let source = unique_dir("claude-git-source").join("Wegent");
    let fake_claude = write_fake_executable(
        "fake-claude-git-cwd",
        r#"#!/bin/sh
if [ ! -d ".git" ]; then exit 30; fi
if [ ! -f "source.txt" ]; then exit 31; fi
if [ ! -x "$GIT_ASKPASS" ]; then exit 32; fi
if [ "$("$GIT_ASKPASS" Username)" != "octocat" ]; then exit 33; fi
if [ "$("$GIT_ASKPASS" Password)" != "ghp_test_token" ]; then exit 34; fi
if [ "$GH_TOKEN" != "ghp_test_token" ]; then exit 35; fi
printf '{"type":"assistant","message":{"content":[{"type":"text","text":"%s"}]}}\n' "$(pwd)"
"#,
    );
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _home = EnvGuard::set("HOME", &executor_home.display().to_string());
    let _aes_key = EnvGuard::set("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012");
    let _aes_iv = EnvGuard::set("GIT_TOKEN_AES_IV", "1234567890123456");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("source.txt"), "synthetic repository").unwrap();
    for args in [
        vec!["init", "-b", "feature/test"],
        vec!["add", "source.txt"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "fixture",
        ],
    ] {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&source)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "synthetic Git fixture setup failed"
        );
    }
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "85".to_owned(),
        subtask_id: "8501".to_owned(),
        prompt: json!("run in cloned repo"),
        bot: json!([{"id": 325, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        backend_url: Some("https://backend.example".into()),
        user_name: Some("test-user".into()),
        team_namespace: Some("default".into()),
        extra: serde_json::Map::from_iter([
            ("user_id".into(), json!(7)),
            ("team_id".into(), json!(12)),
            ("team_name".into(), json!("test-agent")),
            (
                "team_owner".into(),
                json!({"kind":"user", "id":7, "name":"test-user"}),
            ),
            ("git_url".to_owned(), json!(source.display().to_string())),
            ("branch_name".to_owned(), json!("feature/test")),
            ("git_domain".to_owned(), json!("github.com")),
            (
                "git_auth_transport".to_owned(),
                json!("encrypted_request_token"),
            ),
            (
                "user".to_owned(),
                json!({
                    "git_domain": "github.com",
                    "git_login": "octocat",
                    "git_token": "iOuoSwc/HrF6ZhttvtSNeQ=="
                }),
            ),
        ]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;
    let ExecutionOutcome::Completed { content } = outcome else {
        panic!("Git/Claude execution did not complete: {outcome:?}");
    };
    let expected_cwd = PathBuf::from(content);
    assert_eq!(
        expected_cwd.parent().unwrap(),
        fs::canonicalize(&workspace_root).unwrap()
    );
    assert_eq!(
        fs::read_to_string(expected_cwd.join("source.txt")).unwrap(),
        "synthetic repository"
    );
    let branch = std::process::Command::new("git")
        .arg("-C")
        .arg(&expected_cwd)
        .args(["branch", "--show-current"])
        .output()
        .unwrap();
    assert!(branch.status.success());
    assert_eq!(
        String::from_utf8(branch.stdout).unwrap().trim(),
        "feature/test"
    );
    let git_config = fs::read_to_string(expected_cwd.join(".git/config")).unwrap();
    assert!(git_config.contains(&format!("url = {}", source.display())));
    assert!(!git_config.contains("ghp_test_token"));
    assert!(!executor_home.join(".wegent/git-auth").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_times_out_git_clone_and_cleans_partial_workspace() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let workspace_root = unique_dir("claude-git-timeout-workspace-root");
    let bin_dir = unique_dir("claude-git-timeout-bin");
    let git_environment = unique_dir("claude-git-timeout-marker").join("git-env.txt");
    let claude_marker = unique_dir("claude-git-timeout-claude").join("ran.txt");
    fs::create_dir_all(&bin_dir).unwrap();
    fs::create_dir_all(git_environment.parent().unwrap()).unwrap();
    let fake_git = bin_dir.join("git");
    fs::write(
        &fake_git,
        format!(
            r#"#!/bin/sh
if [ "$1" = "clone" ]; then
  DEST="$3"
  mkdir -p "$DEST/.git"
  printf '%s\n%s\n%s\n' "$GIT_TERMINAL_PROMPT" "$GIT_HTTP_LOW_SPEED_LIMIT" "$GIT_HTTP_LOW_SPEED_TIME" > '{}'
  sleep 30 &
  wait $!
fi
exit 20
"#,
            git_environment.display()
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&fake_git).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&fake_git, permissions).unwrap();
    let fake_claude = write_fake_executable(
        "fake-claude-after-git-timeout",
        &format!(
            r#"#!/bin/sh
mkdir -p '{}'
touch '{}'
printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"unexpected"}}]}}}}'
"#,
            claude_marker.parent().unwrap().display(),
            claude_marker.display(),
        ),
    );
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _timeout = EnvGuard::set("WEGENT_GIT_CLONE_TIMEOUT_SECONDS", "1");
    let _low_speed_limit = EnvGuard::set("WEGENT_GIT_HTTP_LOW_SPEED_LIMIT", "2048");
    let _low_speed_time = EnvGuard::set("WEGENT_GIT_HTTP_LOW_SPEED_TIME_SECONDS", "5");
    let path_value = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let _path = EnvGuard::set("PATH", &path_value);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "87".to_owned(),
        prompt: json!("do not run after clone timeout"),
        bot: json!([{"id": 327, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([(
            "git_url".to_owned(),
            json!("https://github.com/wecode-ai/Wegent.git"),
        )]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

    assert!(
        matches!(
            outcome,
            ExecutionOutcome::Failed { ref message }
                if message.contains("git clone timed out after 1s")
        ),
        "{outcome:?}"
    );
    assert_eq!(fs::read_to_string(git_environment).unwrap(), "0\n2048\n5\n");
    assert!(!workspace_root.join("87/Wegent").exists());
    assert!(!claude_marker.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_preserves_incomplete_existing_git_workspace() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let workspace_root = unique_dir("claude-incomplete-git-workspace-root");
    let claude_marker = unique_dir("claude-incomplete-git-claude").join("ran.txt");
    let project_path = workspace_root.join("88/Wegent");
    // An interrupted clone leaves a `.git` that cannot resolve HEAD^{commit}.
    fs::create_dir_all(&project_path).unwrap();
    for args in [
        vec!["init"],
        vec![
            "remote",
            "add",
            "origin",
            "https://github.com/wecode-ai/Wegent.git",
        ],
    ] {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&project_path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "synthetic Git fixture setup failed"
        );
    }
    fs::write(project_path.join("partial.txt"), "interrupted clone").unwrap();
    let fake_claude = write_fake_executable(
        "fake-claude-after-incomplete-git",
        &format!(
            r#"#!/bin/sh
mkdir -p '{}'
touch '{}'
"#,
            claude_marker.parent().unwrap().display(),
            claude_marker.display(),
        ),
    );
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "88".to_owned(),
        prompt: json!("do not reuse partial clone"),
        bot: json!([{"id": 328, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([(
            "git_url".to_owned(),
            json!("https://github.com/wecode-ai/Wegent.git"),
        )]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

    assert!(
        matches!(outcome, ExecutionOutcome::Failed { ref message } if message.contains("incomplete or invalid repository")),
        "{outcome:?}"
    );
    assert!(!claude_marker.exists());
    assert_eq!(
        fs::read_to_string(project_path.join("partial.txt")).unwrap(),
        "interrupted clone"
    );
    assert!(!project_path.join("source.txt").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn agent_process_engine_downloads_claude_attachments_to_device_private_workspace() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
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
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let planner = AgentCommandPlanner::new(fake_claude.display().to_string(), "codex");
    let engine = AgentProcessEngine::new(planner);
    let request = ExecutionRequest {
        task_id: "2201".to_owned(),
        subtask_id: "3212".to_owned(),
        backend_url: Some("http://payload-backend.invalid".to_owned()),
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

    let outcome = engine.run(with_backend_identity(request)).await;
    let content = match outcome {
        ExecutionOutcome::Completed { content } => content,
        other => panic!("unexpected outcome: {other:?}"),
    };
    let local_path = executor_home
        .join("workspace/attachments/runtime/2201/3212/image.png")
        .display()
        .to_string();

    assert!(content.contains(&local_path), "{content}");
    assert!(!content.contains("/home/user/2201:executor:attachments/3212/image.png"));
    assert_eq!(
        fs::read(executor_home.join("workspace/attachments/runtime/2201/3212/image.png")).unwrap(),
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
async fn agent_process_engine_keeps_running_when_pre_execute_hook_is_nonzero() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
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
        task_id: "84".to_owned(),
        prompt: json!("continue after hook"),
        bot: json!([{"id": 324, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_backend_identity(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "continued".to_owned()
        }
    );
}

fn write_fake_executable(name: &str, content: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    let content = if name.starts_with("fake-claude") && !content.contains(r#""type":"result""#) {
        format!(
            "{content}\nprintf '%s\\n' '{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"stop_reason\":\"end_turn\"}}'\n"
        )
    } else {
        content.to_owned()
    };
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
