// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Mutex, MutexGuard},
};
use wegent_executor::{
    agents::{AgentCommandPlanner, AgentProcessEngine},
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

#[tokio::test]
async fn claude_runtime_writes_mcp_config_and_passes_it_to_process() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-workspace");
    let log_path = unique_dir("claude-runtime-log").join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: 7788,
        subtask_id: 99,
        prompt: json!("use request tools"),
        bot: json!([{
            "id": 7,
            "shell_type": "ClaudeCode",
            "mcp_servers": {
                "bot-shell": {
                    "type": "stdio",
                    "command": "uvx",
                    "args": ["bot-tool"],
                    "env": {"BOT_ENV": "1"}
                }
            }
        }]),
        mcp_servers: vec![json!({
            "name": "request-docs",
            "type": "streamable-http",
            "url": "https://mcp.example.com/docs",
            "headers": {"x-task": "7788"}
        })],
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    let args = read_json(&log_path);
    let args = args.as_array().unwrap();
    let mcp_flag_index = args
        .iter()
        .position(|arg| arg == "--mcp-config")
        .expect("Claude command should include --mcp-config");
    let mcp_config_path = args[mcp_flag_index + 1].as_str().unwrap();
    let mcp_config = read_json(Path::new(mcp_config_path));

    assert_eq!(
        mcp_config["mcpServers"]["request-docs"]["url"],
        "https://mcp.example.com/docs"
    );
    assert_eq!(mcp_config["mcpServers"]["request-docs"]["type"], "http");
    assert_eq!(
        mcp_config["mcpServers"]["request-docs"]["headers"]["x-task"],
        "7788"
    );
    assert_eq!(mcp_config["mcpServers"]["bot-shell"]["command"], "uvx");
    assert_eq!(
        mcp_config["mcpServers"]["bot-shell"]["args"],
        json!(["bot-tool"])
    );
    assert_eq!(mcp_config["mcpServers"]["bot-shell"]["env"]["BOT_ENV"], "1");
    let settings_path = Path::new(mcp_config_path)
        .parent()
        .unwrap()
        .join("settings.json");
    let settings = read_json(&settings_path);
    assert_eq!(
        settings["hooks"]["PreToolUse"][0]["hooks"][0]["type"],
        "command"
    );
    assert!(settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .ends_with("defer-interactive-mcp-hook.sh"));
}

#[tokio::test]
async fn claude_runtime_prepares_project_custom_instructions_and_claude_md() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-custom-workspace");
    let task_dir = workspace_root.join("7790");
    fs::create_dir_all(task_dir.join(".git")).unwrap();
    fs::write(task_dir.join("AGENTS.md"), "# Agent instructions\n").unwrap();
    fs::write(task_dir.join(".cursorrules"), "cursor rules\n").unwrap();
    fs::write(task_dir.join(".windsurfrules"), "windsurf rules\n").unwrap();
    let log_path = unique_dir("claude-runtime-custom-log").join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _custom_files = EnvGuard::set(
        "CUSTOM_INSTRUCTION_FILES",
        ".cursorrules,.windsurfrules,../escape,/tmp/ignored",
    );
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: 7790,
        subtask_id: 99,
        prompt: json!("use project instructions"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    assert_eq!(
        fs::read_to_string(task_dir.join(".claudecode/.cursorrules")).unwrap(),
        "cursor rules\n"
    );
    assert_eq!(
        fs::read_to_string(task_dir.join(".claudecode/.windsurfrules")).unwrap(),
        "windsurf rules\n"
    );
    #[cfg(unix)]
    assert_eq!(
        fs::read_link(task_dir.join("CLAUDE.md")).unwrap(),
        PathBuf::from("AGENTS.md")
    );
    #[cfg(not(unix))]
    assert_eq!(
        fs::read_to_string(task_dir.join("CLAUDE.md")).unwrap(),
        "# Agent instructions\n"
    );
    let exclude = fs::read_to_string(task_dir.join(".git/info/exclude")).unwrap();
    assert!(exclude.lines().any(|line| line == ".claudecode/"));
    assert!(exclude.lines().any(|line| line == "CLAUDE.md"));
}

#[tokio::test]
async fn claude_runtime_does_not_overwrite_regular_claude_md() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-existing-claude-md-workspace");
    let task_dir = workspace_root.join("7791");
    fs::create_dir_all(task_dir.join(".git")).unwrap();
    fs::write(task_dir.join("AGENTS.md"), "# Agent instructions\n").unwrap();
    fs::write(task_dir.join("CLAUDE.md"), "# Keep me\n").unwrap();
    let log_path = unique_dir("claude-runtime-existing-claude-md-log").join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: 7791,
        subtask_id: 99,
        prompt: json!("preserve claude md"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    assert_eq!(
        fs::read_to_string(task_dir.join("CLAUDE.md")).unwrap(),
        "# Keep me\n"
    );
    assert!(!task_dir.join(".git/info/exclude").exists());
}

#[tokio::test]
async fn claude_runtime_downloads_request_skills_before_process_start() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-skill-workspace");
    let log_path = unique_dir("claude-runtime-skill-log").join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let _ = read_http_request_headers(&mut stream).await;
        let archive = skill_zip("example-skill/SKILL.md", "# Example Skill\n");
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            archive.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(&archive).await.unwrap();
    });
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: 7789,
        subtask_id: 100,
        prompt: json!("use request skills"),
        auth_token: Some("task-token".to_owned()),
        bot: json!([{
            "id": 7,
            "shell_type": "ClaudeCode",
            "skills": ["example-skill"]
        }]),
        extra: serde_json::Map::from_iter([(
            "skill_refs".to_owned(),
            json!({"example-skill": {"skill_id": 42, "namespace": "default"}}),
        )]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    server.await.unwrap();
    let skill_path = workspace_root.join("7789/.claude/skills/example-skill/SKILL.md");
    assert_eq!(fs::read_to_string(skill_path).unwrap(), "# Example Skill\n");
}

#[tokio::test]
async fn claude_runtime_downloads_attachments_and_rewrites_prompt_before_process_start() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-attachment-workspace");
    let log_path = unique_dir("claude-runtime-attachment-log").join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_http_request_headers(&mut stream).await;
        assert!(request.starts_with("GET /api/attachments/55/executor-download "));
        assert!(request_has_header(
            &request,
            "authorization",
            "Bearer task-token"
        ));
        let body = b"hello attachment";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
    });
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: 7792,
        subtask_id: 101,
        prompt: json!("summarize [attachment:55]"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        auth_token: Some("task-token".to_owned()),
        extra: serde_json::Map::from_iter([(
            "attachments".to_owned(),
            json!([{
                "id": 55,
                "original_filename": "note.txt",
                "mime_type": "text/plain",
                "file_size": 16,
                "subtask_id": 101
            }]),
        )]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    server.await.unwrap();
    let raw_args = fs::read_to_string(&log_path).unwrap();
    let expected_path = workspace_root.join("7792/7792:executor:attachments/101/note.txt");
    assert_eq!(
        fs::read_to_string(&expected_path).unwrap(),
        "hello attachment"
    );
    assert!(raw_args.contains(&expected_path.display().to_string()));
    assert!(raw_args.contains("Available attachments:"));
}

#[tokio::test]
async fn claude_runtime_retries_retryable_api_error_with_saved_session() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-api-retry-workspace");
    let marker = unique_dir("claude-runtime-api-retry-marker").join("attempt");
    let fake_claude = write_fake_claude_api_error_then_completed(&marker);
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: 7793,
        subtask_id: 99,
        prompt: json!("retry api errors"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "retried".to_owned()
        }
    );
}

#[tokio::test]
async fn claude_runtime_decrypts_git_token_and_authenticates_github_cli() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-git-auth-workspace");
    let log_path = unique_dir("claude-runtime-git-auth-log").join("args.json");
    let marker = unique_dir("claude-runtime-git-auth-marker").join("token.txt");
    let bin_dir = unique_dir("claude-runtime-git-auth-bin");
    fs::create_dir_all(&bin_dir).unwrap();
    write_fake_gh(&bin_dir, &marker);
    let fake_claude = write_fake_claude(&log_path);
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let path_value = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let _path = EnvGuard::set("PATH", &path_value);
    let _key = EnvGuard::set("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012");
    let _iv = EnvGuard::set("GIT_TOKEN_AES_IV", "1234567890123456");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: 7794,
        subtask_id: 99,
        skip_git_clone: true,
        prompt: json!("authenticate git cli"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([
            ("git_domain".to_owned(), json!("github.com")),
            (
                "git_url".to_owned(),
                json!("https://github.com/wecode-ai/Wegent.git"),
            ),
            (
                "user".to_owned(),
                json!({"git_token": "iOuoSwc/HrF6ZhttvtSNeQ=="}),
            ),
        ]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    assert_eq!(fs::read_to_string(marker).unwrap(), "ghp_test_token\n");
}

#[tokio::test]
async fn claude_runtime_proxies_deferred_interactive_mcp_to_waiting_outcome() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-deferred-workspace");
    let fake_claude = write_fake_claude_deferred_once();
    let waiting_payload = json!({
        "__deferred_user_input__": true,
        "success": true,
        "status": "waiting_for_user_response"
    });
    let mcp_url = spawn_mcp_server(vec![
        json!({"jsonrpc": "2.0", "id": 1, "result": {}}),
        json!({"jsonrpc": "2.0", "result": {}}),
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "content": [{
                    "type": "text",
                    "text": waiting_payload.to_string()
                }]
            }
        }),
    ])
    .await;
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: 7790,
        subtask_id: 101,
        prompt: json!("ask for form"),
        bot: json!([{
            "id": 7,
            "shell_type": "ClaudeCode"
        }]),
        mcp_servers: vec![json!({
            "name": "interactive-wegent-interactive-form-question",
            "type": "streamable-http",
            "url": mcp_url
        })],
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::WaitingForUserInput {
            stop_reason: "tool_deferred".to_owned()
        }
    );
}

#[tokio::test]
async fn claude_runtime_retries_deferred_interactive_mcp_invalid_form() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-deferred-retry-workspace");
    let marker = unique_dir("claude-runtime-deferred-retry-marker").join("count");
    let fake_claude = write_fake_claude_deferred_then_completed(&marker);
    let mcp_url = spawn_mcp_server(vec![
        json!({"jsonrpc": "2.0", "id": 1, "result": {}}),
        json!({"jsonrpc": "2.0", "result": {}}),
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "result": {
                "content": [{"type": "text", "text": "{\"error\":\"question field required\"}"}]
            }
        }),
    ])
    .await;
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: 7791,
        subtask_id: 102,
        prompt: json!("ask for form"),
        bot: json!([{
            "id": 7,
            "shell_type": "ClaudeCode"
        }]),
        mcp_servers: vec![json!({
            "name": "interactive-wegent-interactive-form-question",
            "type": "streamable-http",
            "url": mcp_url
        })],
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "retried".to_owned()
        }
    );
}

#[tokio::test]
async fn claude_runtime_drains_stale_defer_after_interactive_form_answer() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-answer-drain-workspace");
    let marker = unique_dir("claude-runtime-answer-drain-marker").join("count");
    let fake_claude = write_fake_claude_stale_defer_then_completed(&marker);
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: 7792,
        subtask_id: 103,
        prompt: json!("answer form"),
        bot: json!([{
            "id": 7,
            "shell_type": "ClaudeCode"
        }]),
        extra: serde_json::Map::from_iter([(
            "interactive_form_answer".to_owned(),
            json!({
                "type": "interactive_form_question",
                "tool_use_id": "tool-answered",
                "answers": [{"id": "scope", "value": "all"}],
                "success": true,
                "status": "answered"
            }),
        )]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "answered".to_owned()
        }
    );
}

async fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().await
}

fn skill_zip(path: &str, content: &str) -> Vec<u8> {
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    writer
        .start_file(path, zip::write::FileOptions::default())
        .unwrap();
    writer.write_all(content.as_bytes()).unwrap();
    writer.finish().unwrap().into_inner()
}

fn write_fake_claude(log_path: &Path) -> PathBuf {
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let path = unique_dir("fake-claude-runtime").join("claude");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
printf '[' > "$LOG_PATH"
first=1
for arg in "$@"; do
  if [ "$first" = 0 ]; then
    printf ',' >> "$LOG_PATH"
  fi
  first=0
  escaped=$(printf '%s' "$arg" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '"%s"' "$escaped" >> "$LOG_PATH"
done
printf ']\n' >> "$LOG_PATH"
printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"ok"}}]}}}}'
printf '%s\n' '{{"type":"result","is_error":false}}'
"#,
        log_path.display()
    );
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn write_fake_claude_deferred_once() -> PathBuf {
    let path = unique_dir("fake-claude-deferred-once").join("claude");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        &path,
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","session_id":"session-deferred"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"session-deferred","stop_reason":"tool_deferred","usage":{},"deferred_tool_use":{"id":"tool-1","name":"mcp__interactive_wegent-interactive-form-question__interactive_form_question","input":{"questions":[]}}}'
"#,
    )
    .unwrap();
    make_executable(&path);
    path
}

fn write_fake_claude_deferred_then_completed(marker: &Path) -> PathBuf {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let path = unique_dir("fake-claude-deferred-retry").join("claude");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let content = format!(
        r#"#!/bin/sh
MARKER='{}'
if [ ! -f "$MARKER" ]; then
  printf 1 > "$MARKER"
  printf '%s\n' '{{"type":"system","subtype":"init","session_id":"session-retry"}}'
  printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"session_id":"session-retry","stop_reason":"tool_deferred","usage":{{}},"deferred_tool_use":{{"id":"tool-1","name":"mcp__interactive_wegent-interactive-form-question__interactive_form_question","input":{{"questions":[]}}}}}}'
  exit 0
fi
case "$*" in
  *"--resume session-retry"*"--input-format stream-json"*)
    if ! grep -q 'interactive_form_question arguments were invalid' >/dev/null 2>&1; then
      exit 7
    fi
    printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"retried"}}]}}}}'
    printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"session_id":"session-retry","stop_reason":"end_turn"}}'
    ;;
  *)
    exit 8
    ;;
esac
"#,
        marker.display()
    );
    fs::write(&path, content).unwrap();
    make_executable(&path);
    path
}

fn write_fake_claude_stale_defer_then_completed(marker: &Path) -> PathBuf {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let path = unique_dir("fake-claude-answer-drain").join("claude");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let content = format!(
        r#"#!/bin/sh
MARKER='{}'
if [ ! -f "$MARKER" ]; then
  printf 1 > "$MARKER"
  printf '%s\n' '{{"type":"system","subtype":"init","session_id":"session-answer"}}'
  printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"session_id":"session-answer","stop_reason":"tool_deferred","usage":{{}},"deferred_tool_use":{{"id":"tool-answered","name":"mcp__interactive_wegent-interactive-form-question__interactive_form_question","input":{{"questions":[]}}}}}}'
  exit 0
fi
if ! grep -q 'tool-answered' >/dev/null 2>&1; then
  exit 9
fi
printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"answered"}}]}}}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"session_id":"session-answer","stop_reason":"end_turn"}}'
"#,
        marker.display()
    );
    fs::write(&path, content).unwrap();
    make_executable(&path);
    path
}

fn write_fake_claude_api_error_then_completed(marker: &Path) -> PathBuf {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let path = unique_dir("fake-claude-api-retry").join("claude");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let content = format!(
        r#"#!/bin/sh
MARKER='{}'
if [ ! -f "$MARKER" ]; then
  printf 1 > "$MARKER"
  printf '%s\n' '{{"type":"system","subtype":"init","session_id":"session-api-error"}}'
  printf '%s\n' '{{"type":"result","subtype":"error","is_error":true,"session_id":"session-api-error","result":"API Error: Cannot read properties of undefined (reading message)"}}'
  exit 0
fi
case "$*" in
  *"--resume session-api-error"*"Retry to proceed"*)
    printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"retried"}}]}}}}'
    printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"session_id":"session-api-error","stop_reason":"end_turn"}}'
    ;;
  *)
    exit 10
    ;;
esac
"#,
        marker.display()
    );
    fs::write(&path, content).unwrap();
    make_executable(&path);
    path
}

fn write_fake_gh(bin_dir: &Path, marker: &Path) {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let path = bin_dir.join("gh");
    let content = format!(
        r#"#!/bin/sh
if [ "$1" != "auth" ] || [ "$2" != "login" ] || [ "$3" != "--with-token" ]; then
  exit 11
fi
cat > '{}'
"#,
        marker.display()
    );
    fs::write(&path, content).unwrap();
    make_executable(&path);
}

async fn spawn_mcp_server(responses: Vec<Value>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        for (index, response_value) in responses.into_iter().enumerate() {
            let (mut stream, _) = listener.accept().await.unwrap();
            let _ = read_http_request_headers(&mut stream).await;
            let body = response_value.to_string();
            let session_header = if index == 0 {
                "Mcp-Session-Id: test-session\r\n"
            } else {
                ""
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{session_header}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    url
}

async fn read_http_request_headers(stream: &mut tokio::net::TcpStream) -> String {
    let mut request = Vec::new();
    let mut buffer = [0_u8; 1024];
    loop {
        let read = stream.read(&mut buffer).await.unwrap();
        if read == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8_lossy(&request).into_owned()
}

fn request_has_header(request: &str, expected_name: &str, expected_value: &str) -> bool {
    request.lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        name.eq_ignore_ascii_case(expected_name) && value.trim() == expected_value
    })
}

fn make_executable(path: &Path) {
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).unwrap();
    }
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn unique_dir(name: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let path = std::env::temp_dir().join(format!("{name}-{}-{suffix}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    path
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
