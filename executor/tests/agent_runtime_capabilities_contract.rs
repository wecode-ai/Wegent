// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    ffi::{OsStr, OsString},
    fs,
    future::ready,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Mutex, MutexGuard},
};
use wegent_executor::{
    agents::{AgentCommandPlanner, AgentProcessEngine},
    emitter::{EventEnvelope, ResponsesEventBuilder},
    protocol::ExecutionRequest,
    runner::{AgentEngine, EventSink, ExecutionOutcome},
};

#[derive(Clone, Default)]
struct RecordingSink {
    events: Arc<StdMutex<Vec<EventEnvelope>>>,
}

fn authenticated_bot_request(mut request: ExecutionRequest) -> ExecutionRequest {
    request.backend_url.get_or_insert_with(|| {
        std::env::var("TASK_API_DOMAIN")
            .or_else(|_| std::env::var("WEGENT_BACKEND_URL"))
            .unwrap_or_else(|_| "https://backend.example".to_owned())
    });
    request.extra.insert("user_id".to_owned(), json!(7));
    request.user_name = Some("user7".to_owned());
    request.team_namespace = Some("default".to_owned());
    request.extra.insert("team_id".to_owned(), json!(12));
    request.extra.insert(
        "team_owner".to_owned(),
        json!({"kind":"user","id":7,"name":"user7"}),
    );
    request
        .extra
        .insert("team_name".to_owned(), json!("design"));
    request
}

impl RecordingSink {
    fn events(&self) -> Vec<EventEnvelope> {
        self.events.lock().unwrap().clone()
    }
}

impl EventSink for RecordingSink {
    type SendFuture = std::future::Ready<Result<(), String>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        self.events.lock().unwrap().push(event);
        ready(Ok(()))
    }
}

#[tokio::test]
async fn claude_agent_home_preserves_spaces_in_environment_and_config_paths() {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let workbench = root.path().join("workbench with spaces");
    let _workbench = EnvGuard::set("WEGENT_WORKBENCH_HOME", &workbench);
    let log = root.path().join("args.json");
    let native = write_fake_claude_with_prelude(
        &log,
        r#"
test -f "$CLAUDE_CONFIG_DIR/settings.json" || exit 80
printf '%s' "$CLAUDE_CONFIG_DIR" > "$CLAUDE_CONFIG_DIR/observed-home"
"#,
    );
    let engine =
        AgentProcessEngine::new(AgentCommandPlanner::new(native.to_str().unwrap(), "codex"));
    let mut request = authenticated_bot_request(ExecutionRequest {
        task_id: "spaces".to_owned(),
        new_session: true,
        bot: json!([{"id":7,"shell_type":"ClaudeCode"}]),
        project_workspace_path: Some(root.path().display().to_string()),
        ..Default::default()
    });
    request.extra["team_owner"] = json!({"kind":"group","id":8,"name":"design team"});
    request.team_namespace = Some("design  space".to_owned());
    request.extra["team_name"] = json!("agent name");
    assert!(matches!(
        engine.run(request).await,
        ExecutionOutcome::Completed { .. }
    ));
    let home = workbench.join("agents/user7/design  space/agent name");
    assert_eq!(
        fs::read_to_string(home.join("observed-home")).unwrap(),
        home.to_str().unwrap()
    );
    assert!(home.join("runtime/tasks/spaces.json").is_file());
}

#[tokio::test]
async fn isolated_bot_missing_claude_session_preserves_marker_without_retry_in_both_modes() {
    use wegent_executor::process::{CommandSpec, StreamProcessEngine};
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let _executor = EnvGuard::set("WEGENT_EXECUTOR_HOME", root.path().to_str().unwrap());
    for streaming in [false, true] {
        let task = if streaming {
            "missing-streamed"
        } else {
            "missing-silent"
        };
        let marker = root
            .path()
            .join("sessions")
            .join(task)
            .join(".claude_session_id_7");
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        fs::write(&marker, "keep-existing-session").unwrap();
        let calls = root.path().join(format!("{task}.calls"));
        let spec = CommandSpec::new("sh")
            .arg("-c")
            .arg(
                r#"
printf 'called\n' >> "$CALL_LOG"
printf 'No conversation found with session ID: keep-existing-session\n' >&2
exit 1
"#,
            )
            .env("CALL_LOG", calls.display().to_string())
            .arg("--resume")
            .arg("keep-existing-session");
        let engine = StreamProcessEngine::new(spec, 30);
        let request = ExecutionRequest {
            task_id: task.to_owned(),
            subtask_id: "next".to_owned(),
            bot: json!([{"id":7,"shell_type":"ClaudeCode"}]),
            ..Default::default()
        };
        let outcome = if streaming {
            engine
                .run_with_events(
                    authenticated_bot_request(request),
                    RecordingSink::default(),
                    ResponsesEventBuilder::new(task, "next", "claude"),
                )
                .await
        } else {
            engine.run(authenticated_bot_request(request)).await
        };
        let ExecutionOutcome::Failed { message } = outcome else {
            panic!("missing session must fail");
        };
        assert!(message.contains("no new conversation"));
        assert_eq!(
            fs::read_to_string(&marker).unwrap(),
            "keep-existing-session"
        );
        assert_eq!(fs::read_to_string(calls).unwrap(), "called\n");
    }
}

#[tokio::test]
async fn existing_bot_claude_session_is_imported_and_resumed_in_selected_home() {
    verify_existing_claude_session_import(0).await;
}

#[tokio::test]
async fn restored_default_claude_home_resumes_without_managed_home_override() {
    verify_existing_claude_session_import(1).await;
}

#[tokio::test]
async fn hashed_home_claude_session_is_imported_into_readable_agent_home() {
    verify_existing_claude_session_import(2).await;
}

#[tokio::test]
async fn existing_named_claude_home_imports_only_the_bound_session() {
    verify_existing_claude_session_import(3).await;
}

#[tokio::test]
async fn resource_owner_home_resumes_under_executing_user_without_owner_metadata() {
    verify_existing_claude_session_import(5).await;
}

async fn verify_existing_claude_session_import(schema: u64) {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let executor = root.path().join("executor");
    let workbench = root.path().join("workbench");
    let _workbench = EnvGuard::set("WEGENT_WORKBENCH_HOME", &workbench);
    let legacy = if schema == 1 {
        root.path().join(".claude")
    } else if schema == 2 {
        let owner = format!(
            "{:x}",
            Sha256::digest(json!(["https://backend.example", "7"]).to_string())
        );
        let instance = format!(
            "{:x}",
            Sha256::digest(json!(["12", "7", "99123", "claudecode"]).to_string())
        );
        workbench.join("agents").join(owner).join(instance)
    } else if schema == 3 {
        workbench.join("agents/user7/design")
    } else if schema == 5 {
        workbench.join("agents/agent-author/default/design")
    } else {
        root.path().join("legacy-claude")
    };
    let _executor = EnvGuard::set("WEGENT_EXECUTOR_HOME", executor.to_str().unwrap());
    let _legacy = if schema == 1 {
        EnvGuard::remove("WEGENT_CLAUDE_HOME")
    } else {
        EnvGuard::set(
            "WEGENT_CLAUDE_HOME",
            if schema != 0 {
                root.path().join("unused-claude")
            } else {
                legacy.clone()
            },
        )
    };
    let _home = EnvGuard::set("HOME", root.path().to_str().unwrap());
    let marker = executor.join("sessions/99123/.claude_session_id_7");
    fs::create_dir_all(marker.parent().unwrap()).unwrap();
    fs::write(&marker, "existing-session").unwrap();
    let relative = "projects/-workspace-task/existing-session.jsonl";
    fs::create_dir_all(legacy.join("projects/-workspace-task")).unwrap();
    fs::write(
        legacy.join(relative),
        "{\"sessionId\":\"existing-session\",\"type\":\"user\"}\n",
    )
    .unwrap();
    fs::write(legacy.join("auth.json"), "not-a-task-secret").unwrap();
    if schema > 1 {
        fs::write(legacy.join(".execution.lock"), "").unwrap();
        let mut identity = json!({"schema_version":schema,
            "backend_url":"https://backend.example", "user_id":"7", "team_id":"12",
            "bot_id":"7", "shell_type":"claudecode"});
        if schema == 3 {
            identity["team_namespace"] = json!("default");
            identity["team_name"] = json!("design");
            fs::create_dir_all(legacy.join("runtime/tasks")).unwrap();
            let mut task = identity.clone();
            task["task_id"] = json!("99123");
            fs::write(legacy.join("runtime/tasks/99123.json"), task.to_string()).unwrap();
        } else if schema == 5 {
            fs::create_dir_all(legacy.join("runtime/tasks")).unwrap();
            fs::write(
                legacy.join("runtime/tasks/99123.json"),
                json!({"task_id":"99123", "migrated_session":null}).to_string(),
            )
            .unwrap();
        } else {
            identity["task_id"] = json!("99123");
        }
        fs::write(legacy.join("agent.json"), identity.to_string()).unwrap();
    }
    if schema == 3 {
        let fresh_log = root.path().join("fresh.json");
        let fresh_native = write_fake_claude(&fresh_log);
        let fresh_engine = AgentProcessEngine::new(AgentCommandPlanner::new(
            fresh_native.to_str().unwrap(),
            "codex",
        ));
        let fresh = authenticated_bot_request(ExecutionRequest {
            task_id: "new-task".to_owned(),
            bot: json!([{"id":7,"shell_type":"ClaudeCode"}]),
            project_workspace_path: Some(root.path().display().to_string()),
            ..Default::default()
        });
        assert!(matches!(
            fresh_engine.run(fresh).await,
            ExecutionOutcome::Completed { .. }
        ));
        let home = task_home("new-task");
        assert!(
            !home.join(relative).exists(),
            "New tasks must not import old conversations"
        );
    }
    let log = root.path().join("args.json");
    let native = write_fake_claude_with_prelude(
        &log,
        r#"
test -f "$CLAUDE_CONFIG_DIR/projects/-workspace-task/existing-session.jsonl" || exit 80
test ! -f "$CLAUDE_CONFIG_DIR/auth.json" || exit 81
"#,
    );
    let engine =
        AgentProcessEngine::new(AgentCommandPlanner::new(native.to_str().unwrap(), "codex"));
    let request = ExecutionRequest {
        task_id: "99123".to_owned(),
        subtask_id: "followup".to_owned(),
        bot: json!([{"id":7,"shell_type":"ClaudeCode"}]),
        prompt: json!("continue"),
        project_workspace_path: Some(root.path().display().to_string()),
        ..Default::default()
    };
    let mut request = authenticated_bot_request(request);
    request
        .extra
        .insert("legacy_session_bindings".to_owned(), json!([]));
    let refused = engine.run(request.clone()).await;
    assert!(
        matches!(refused, ExecutionOutcome::Failed { ref message } if message.contains("ownership proof"))
    );
    assert!(!log.exists(), "Unproven history must not start the engine");
    let proof = json!({"task_id":99123, "user_id":7, "agent":"ClaudeCode", "botId":7, "sessionId":"existing-session"});
    for (key, value) in [
        ("botId", json!(null)),
        ("botId", json!(8)),
        ("agent", json!("Codex")),
        ("sessionId", json!("another-session")),
        ("task_id", json!(99124)),
        ("user_id", json!(8)),
    ] {
        let mut wrong = proof.clone();
        wrong[key] = value;
        request
            .extra
            .insert("legacy_session_bindings".to_owned(), json!([wrong]));
        assert!(matches!(engine.run(request.clone()).await,
            ExecutionOutcome::Failed { ref message } if message.contains("ownership")));
        assert!(!log.exists());
        assert_eq!(fs::read_to_string(&marker).unwrap(), "existing-session");
    }
    request
        .extra
        .insert("legacy_session_bindings".to_owned(), json!([proof]));
    if matches!(schema, 0 | 1 | 5) {
        request.extra.remove("team_owner");
        request.extra.remove("legacy_session_bindings");
    }
    assert_eq!(legacy.join("agent.json").exists(), schema > 1);
    assert!(matches!(
        engine.run(request.clone()).await,
        ExecutionOutcome::Completed { .. }
    ));
    let arguments = read_json(&log);
    assert!(arguments
        .as_array()
        .unwrap()
        .windows(2)
        .any(|pair| pair[0] == "--resume" && pair[1] == "existing-session"));
    let selected = task_home("99123");
    assert_eq!(
        read_json(&selected.join("runtime/tasks/99123.json"))["migrated_session"]["id"],
        "existing-session"
    );
    assert!(legacy.join(relative).is_file());
    if schema != 0 {
        fs::write(legacy.join("agent.json"), "invalid-old-marker").unwrap();
        assert!(
            matches!(
                engine.run(request).await,
                ExecutionOutcome::Completed { .. }
            ),
            "Bound tasks must not migrate again"
        );
    }
}

#[tokio::test]
async fn claude_runtime_writes_mcp_config_and_passes_it_to_process() {
    let _lock = env_lock().await;
    let home = unique_dir("claude-runtime-home");
    let workspace_root = unique_dir("claude-runtime-workspace");
    let log_path = unique_dir("claude-runtime-log").join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let _home = EnvGuard::set("HOME", home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7788".to_owned(),
        subtask_id: "99".to_owned(),
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
            "headers": {"x-task": "7788"},
            "timeout": 60
        })],
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request.clone())).await;

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
    let mcp_config = read_json(&log_path.with_extension("mcp"));
    let agent_home = task_home("7788");
    assert_eq!(Path::new(mcp_config_path), agent_home.join("mcp.json"));
    assert!(
        Path::new(mcp_config_path).exists(),
        "agent MCP definitions must survive execution"
    );

    assert_eq!(
        mcp_config["mcpServers"]["request-docs"]["url"],
        "https://mcp.example.com/docs"
    );
    assert_eq!(mcp_config["mcpServers"]["request-docs"]["type"], "http");
    assert_eq!(
        mcp_config["mcpServers"]["request-docs"]["headers"]["x-task"],
        "7788"
    );
    assert_eq!(mcp_config["mcpServers"]["request-docs"]["timeout"], 60000);
    assert_eq!(mcp_config["mcpServers"]["bot-shell"]["command"], "uvx");
    assert_eq!(
        mcp_config["mcpServers"]["bot-shell"]["args"],
        json!(["bot-tool"])
    );
    assert_eq!(mcp_config["mcpServers"]["bot-shell"]["env"]["BOT_ENV"], "1");
    let settings_path = agent_home.join("settings.json");
    let settings = read_json(&settings_path);
    let pre_tool_use = settings["hooks"]["PreToolUse"].as_array().unwrap();
    assert!(pre_tool_use.iter().any(|entry| {
        entry["matcher"] == "mcp__.*interactive_form_question.*"
            && entry["hooks"][0]["type"] == "command"
            && entry["hooks"][0]["command"]
                .as_str()
                .is_some_and(|command| command.ends_with("defer-interactive-mcp-hook.sh"))
    }));
    assert!(!pre_tool_use.iter().any(|entry| {
        entry["matcher"] == "mcp__*interactive_form_question*"
            && entry["hooks"][0]["type"] == "command"
            && entry["hooks"][0]["command"]
                .as_str()
                .is_some_and(|command| command.ends_with("defer-interactive-mcp-hook.sh"))
    }));

    let mut followup = request;
    followup.subtask_id = "100".to_owned();
    followup.bot = json!([{"id": 7, "shell_type": "ClaudeCode"}]);
    followup.mcp_servers = vec![json!({
        "name": "bot-shell", "type": "stdio", "command": "updated-tool"
    })];
    assert_eq!(
        engine
            .run(authenticated_bot_request(followup.clone()))
            .await,
        outcome
    );
    let merged = read_json(&log_path.with_extension("mcp"));
    assert_eq!(
        merged["mcpServers"]["request-docs"],
        mcp_config["mcpServers"]["request-docs"]
    );
    assert_eq!(
        merged["mcpServers"]["bot-shell"],
        json!({"type": "stdio", "command": "updated-tool"})
    );

    followup.subtask_id = "101".to_owned();
    followup.mcp_servers.clear();
    assert_eq!(
        engine
            .run(authenticated_bot_request(followup.clone()))
            .await,
        outcome
    );
    let latest_args = read_json(&log_path);
    let latest_args = latest_args.as_array().unwrap();
    assert!(latest_args.iter().any(|arg| arg == "--mcp-config"));
    assert_eq!(read_json(&log_path.with_extension("mcp")), merged);
    assert!(Path::new(mcp_config_path).exists());
    assert!(!agent_home.join("runtime/claude-mcp-7788-101.json").exists());

    // The stable definitions belong to the agent, not a single task.
    followup.task_id = "7789".to_owned();
    followup.project_workspace_path = Some(workspace_root.join("7788").display().to_string());
    assert_eq!(
        engine
            .run(authenticated_bot_request(followup.clone()))
            .await,
        outcome
    );
    let other_args = read_json(&log_path);
    assert!(other_args
        .as_array()
        .unwrap()
        .iter()
        .any(|arg| arg == "--mcp-config"));
    assert_eq!(read_json(&log_path.with_extension("mcp")), merged);

    // A different agent sharing the checkout must not inherit the definitions.
    let mut other_agent = authenticated_bot_request(followup);
    other_agent.task_id = "7791".to_owned();
    other_agent.extra.insert("team_id".to_owned(), json!(13));
    other_agent
        .extra
        .insert("team_name".to_owned(), json!("other-agent"));
    assert_eq!(engine.run(other_agent).await, outcome);
    assert_eq!(
        read_json(&log_path.with_extension("mcp")),
        json!({"mcpServers": {}})
    );
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
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
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
        task_id: "7790".to_owned(),
        subtask_id: "99".to_owned(),
        prompt: json!("use project instructions"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

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
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7791".to_owned(),
        subtask_id: "99".to_owned(),
        prompt: json!("preserve claude md"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

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
    let home = unique_dir("claude-runtime-skill-home");
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
    let _home = EnvGuard::set("HOME", home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7789".to_owned(),
        subtask_id: "100".to_owned(),
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

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    server.await.unwrap();
    let skill_path = task_home("7789").join("skills/example-skill/SKILL.md");
    assert_eq!(fs::read_to_string(skill_path).unwrap(), "# Example Skill\n");
}

#[tokio::test]
async fn claude_runtime_uses_metadata_version_when_download_etag_differs() {
    let _lock = env_lock().await;
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let workspace_root = temp.path().join("workspace");
    let log_path = temp.path().join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let skills_dir = workspace_root.join("7796/.claude/skills");
    let old_skill = skills_dir.join("optional-skill/SKILL.md");
    fs::create_dir_all(old_skill.parent().unwrap()).unwrap();
    fs::write(&old_skill, "# Old Skill\n").unwrap();
    let manifest = json!({"optional-skill": {
        "skill_id": 41,
        "namespace": "previous",
        "content_hash": format!("sha256:{:x}", Sha256::digest(b"old archive"))
    }})
    .to_string();
    fs::write(skills_dir.join(".wegent-skills.json"), &manifest).unwrap();
    let archive = skill_zip("optional-skill/SKILL.md", "# Updated Skill\n");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_http_request_headers(&mut stream).await;
        assert!(!request.to_ascii_lowercase().contains("if-none-match:"));
        let response = format!(
            "HTTP/1.1 200 OK\r\nETag: \"sha256:{:x}\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            Sha256::digest(&archive), archive.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(&archive).await.unwrap();
    });
    let _home = EnvGuard::set("HOME", home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7796".to_owned(),
        subtask_id: "107".to_owned(),
        prompt: json!("use optional skill"),
        auth_token: Some("synthetic-token".to_owned()),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode", "skills": ["optional-skill"]}]),
        extra: serde_json::Map::from_iter([(
            "skill_refs".to_owned(),
            json!({"optional-skill": {
                "skill_id": 42,
                "namespace": "default",
                "content_hash": format!("sha256:{:x}", Sha256::digest(b"expected archive"))
            }}),
        )]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    assert!(log_path.exists());
    let managed = task_home("7796").join("skills");
    assert!(!managed.is_symlink());
    let link = managed.join("optional-skill");
    assert!(link.is_symlink());
    assert!(fs::read_link(&link).unwrap().is_relative());
    assert_eq!(
        fs::read_to_string(link.join("SKILL.md")).unwrap(),
        "# Updated Skill\n"
    );
    let records: Value =
        serde_json::from_slice(&fs::read(managed.join(".wegent-skills.json")).unwrap()).unwrap();
    assert_eq!(
        records["optional-skill"]["content_hash"],
        format!("sha256:{:x}", Sha256::digest(b"expected archive"))
    );
    assert!(
        old_skill.exists(),
        "legacy repository content is not the managed Home"
    );
    assert!(skills_dir.join(".wegent-skills.json").exists());
    server.await.unwrap();
}

#[tokio::test]
async fn claude_runtime_does_not_start_when_required_skill_download_fails() {
    let _lock = env_lock().await;
    let home = unique_dir("claude-required-skill-failure-home");
    let workspace_root = unique_dir("claude-required-skill-failure-workspace");
    let log_path = unique_dir("claude-required-skill-failure-log").join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let _ = read_http_request_headers(&mut stream).await;
        stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let _home = EnvGuard::set("HOME", home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7790".to_owned(),
        subtask_id: "101".to_owned(),
        prompt: json!("use required skill"),
        auth_token: Some("task-token".to_owned()),
        bot: json!([{
            "id": 7,
            "shell_type": "ClaudeCode",
            "skills": ["abtest-file-analyzer"]
        }]),
        extra: serde_json::Map::from_iter([
            (
                "skill_refs".to_owned(),
                json!({
                    "abtest-file-analyzer": {
                        "skill_id": 237510,
                        "namespace": "default"
                    }
                }),
            ),
            ("preload_skills".to_owned(), json!(["abtest-file-analyzer"])),
        ]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "required Skill deployment failed: abtest-file-analyzer (backend download failed with HTTP 404)".to_owned()
        }
    );
    assert!(!log_path.exists());
    server.await.unwrap();
}

#[tokio::test]
async fn claude_runtime_remaps_historical_skill_zip_root_to_skill_name() {
    let _lock = env_lock().await;
    let home = unique_dir("claude-historical-skill-root-home");
    let workspace_root = unique_dir("claude-historical-skill-root-workspace");
    let log_path = unique_dir("claude-historical-skill-root-log").join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let _ = read_http_request_headers(&mut stream).await;
        let archive = skill_zip("unexpected-root/SKILL.md", "# Test Skill\n");
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            archive.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(&archive).await.unwrap();
    });
    let _home = EnvGuard::set("HOME", home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7791".to_owned(),
        subtask_id: "102".to_owned(),
        prompt: json!("use required skill"),
        auth_token: Some("task-token".to_owned()),
        bot: json!([{
            "id": 7,
            "shell_type": "ClaudeCode",
            "skills": ["requested-skill"]
        }]),
        extra: serde_json::Map::from_iter([
            (
                "skill_refs".to_owned(),
                json!({
                    "requested-skill": {
                        "skill_id": 196659,
                        "namespace": "default"
                    }
                }),
            ),
            ("preload_skills".to_owned(), json!(["requested-skill"])),
        ]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    let skill_path = task_home("7791").join("skills/requested-skill/SKILL.md");
    assert_eq!(fs::read_to_string(skill_path).unwrap(), "# Test Skill\n");
    assert!(!task_home("7791").join("skills/unexpected-root").exists());
    server.await.unwrap();
}

#[tokio::test]
async fn claude_runtime_reports_missing_skill_md_without_exposing_token() {
    let _lock = env_lock().await;
    let home = unique_dir("claude-missing-skill-md-home");
    let workspace_root = unique_dir("claude-missing-skill-md-workspace");
    let log_path = unique_dir("claude-missing-skill-md-log").join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_http_request_headers(&mut stream).await;
        assert!(request_has_header(
            &request,
            "authorization",
            "Bearer secret-task-token"
        ));
        let archive = skill_zip("requested-skill/OTHER.md", "# Not a skill manifest\n");
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            archive.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(&archive).await.unwrap();
    });
    let _home = EnvGuard::set("HOME", home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let _api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7791".to_owned(),
        subtask_id: "102".to_owned(),
        prompt: json!("use required skill"),
        auth_token: Some("secret-task-token".to_owned()),
        bot: json!([{
            "id": 7,
            "shell_type": "ClaudeCode",
            "skills": ["requested-skill"]
        }]),
        extra: serde_json::Map::from_iter([
            (
                "skill_refs".to_owned(),
                json!({
                    "requested-skill": {
                        "skill_id": 196659,
                        "namespace": "default"
                    }
                }),
            ),
            ("preload_skills".to_owned(), json!(["requested-skill"])),
        ]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;
    let ExecutionOutcome::Failed { message } = outcome else {
        panic!("expected required Skill deployment to fail");
    };

    assert_eq!(
        message,
        "required Skill deployment failed: requested-skill (downloaded Skill ZIP is missing required SKILL.md)"
    );
    assert!(!message.contains("secret-task-token"));
    assert!(!log_path.exists());
    server.await.unwrap();
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
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _backend = EnvGuard::remove("WEGENT_BACKEND_URL");
    let _api = EnvGuard::set("TASK_API_DOMAIN", &backend_url);
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7792".to_owned(),
        subtask_id: "101".to_owned(),
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

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    server.await.unwrap();
    let query = read_json(&log_path.with_extension("stdin"));
    let prompt = query["message"]["content"]
        .as_str()
        .expect("Claude stdin user message should contain text");
    let expected_path = workspace_root.join("7792/7792:executor:attachments/101/note.txt");
    assert_eq!(
        fs::read_to_string(&expected_path).unwrap(),
        "hello attachment"
    );
    assert!(prompt.contains(&expected_path.display().to_string()));
    assert!(prompt.contains("Available attachments:"));
}

#[tokio::test]
async fn local_claude_runtime_downloads_project_attachments_outside_the_project() {
    let _lock = env_lock().await;
    let executor_home = unique_dir("local-claude-runtime-home");
    let project_workspace = unique_dir("local-claude-project-workspace");
    fs::create_dir_all(&project_workspace).unwrap();
    let log_path = unique_dir("local-claude-runtime-log").join("args.json");
    let fake_claude = write_fake_claude(&log_path);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend_url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_http_request_headers(&mut stream).await;
        assert!(request.starts_with("GET /api/attachments/56/executor-download "));
        let body = b"private attachment";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();
    });
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", executor_home.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "local");
    let _backend = EnvGuard::set("WEGENT_BACKEND_URL", &backend_url);
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "runtime-7792".to_owned(),
        subtask_id: "turn-101".to_owned(),
        prompt: json!("summarize [attachment:56]"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        auth_token: Some("task-token".to_owned()),
        project_workspace_path: Some(project_workspace.display().to_string()),
        extra: serde_json::Map::from_iter([(
            "attachments".to_owned(),
            json!([{
                "id": 56,
                "original_filename": "note.txt",
                "mime_type": "text/plain",
                "file_size": 18,
                "subtask_id": "turn-101"
            }]),
        )]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    server.await.unwrap();
    let expected_path =
        executor_home.join("workspace/attachments/runtime/runtime-7792/turn-101/note.txt");
    assert_eq!(
        fs::read_to_string(&expected_path).unwrap(),
        "private attachment"
    );
    assert!(!project_workspace.join(".wegent").exists());
    let query = read_json(&log_path.with_extension("stdin"));
    let prompt = query["message"]["content"].as_str().unwrap();
    assert!(prompt.contains(&expected_path.display().to_string()));
}

#[tokio::test]
async fn claude_runtime_retries_retryable_api_error_with_saved_session() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-api-retry-workspace");
    let marker = unique_dir("claude-runtime-api-retry-marker").join("attempt");
    let fake_claude = write_fake_claude_api_error_then_completed(&marker);
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7793".to_owned(),
        subtask_id: "99".to_owned(),
        // Exceed a normal pipe buffer to expose a fake process that closes stdin early.
        prompt: json!(format!("retry api errors {}", "x".repeat(128 * 1024))),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "retried".to_owned()
        }
    );
}

#[tokio::test]
async fn claude_runtime_decrypts_git_token_and_injects_request_auth_environment() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-git-auth-workspace");
    let home_dir = unique_dir("claude-runtime-git-auth-home");
    let log_path = unique_dir("claude-runtime-git-auth-log").join("args.json");
    let fake_claude =
        write_fake_claude_with_git_auth(&log_path, "github.com", "token", "ghp_test_token");
    let _home = EnvGuard::set("HOME", home_dir.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let _key = EnvGuard::set("GIT_TOKEN_AES_KEY", "12345678901234567890123456789012");
    let _iv = EnvGuard::set("GIT_TOKEN_AES_IV", "1234567890123456");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7794".to_owned(),
        subtask_id: "99".to_owned(),
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

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
}

#[tokio::test]
async fn claude_runtime_injects_github_enterprise_auth_environment() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-ghe-auth-workspace");
    let home_dir = unique_dir("claude-runtime-ghe-auth-home");
    let log_path = unique_dir("claude-runtime-ghe-auth-log").join("args.json");
    let fake_claude = write_fake_claude_with_git_auth(
        &log_path,
        "github.internal.example",
        "token",
        "ghp_enterprise_token",
    );
    let _home = EnvGuard::set("HOME", home_dir.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7795".to_owned(),
        subtask_id: "99".to_owned(),
        skip_git_clone: true,
        prompt: json!("authenticate github enterprise cli"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([
            ("git_domain".to_owned(), json!("github.internal.example")),
            (
                "git_url".to_owned(),
                json!("https://github.internal.example/wecode-ai/Wegent.git"),
            ),
            (
                "user".to_owned(),
                json!({"git_token": "ghp_enterprise_token"}),
            ),
        ]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
}

#[tokio::test]
async fn claude_runtime_keeps_request_auth_out_of_persistent_cli_config() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-gh-hosts-workspace");
    let home_dir = unique_dir("claude-runtime-gh-hosts-home");
    let log_path = unique_dir("claude-runtime-gh-hosts-log").join("args.json");
    let fake_claude = write_fake_claude_with_git_auth(
        &log_path,
        "github.com",
        "test-git-user",
        "ghp_repo_only_token",
    );
    let _home = EnvGuard::set("HOME", home_dir.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7797".to_owned(),
        subtask_id: "99".to_owned(),
        skip_git_clone: true,
        prompt: json!("authenticate git cli"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        extra: serde_json::Map::from_iter([(
            "user".to_owned(),
            json!({
                "git_domain": "github.com",
                "git_token": "ghp_repo_only_token",
                "git_login": "test-git-user"
            }),
        )]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "ok".to_owned()
        }
    );
    assert!(!home_dir.join(".config/gh/hosts.yml").exists());
}

#[tokio::test]
async fn codex_runtime_authenticates_github_cli_before_start() {
    let _lock = env_lock().await;
    let executor_home = unique_dir("codex-runtime-git-auth-executor-home");
    let workspace_root = unique_dir("codex-runtime-git-auth-workspace");
    let log_path = unique_dir("codex-runtime-git-auth-log").join("rpc.jsonl");
    let marker = unique_dir("codex-runtime-git-auth-marker").join("token.txt");
    let bin_dir = unique_dir("codex-runtime-git-auth-bin");
    fs::create_dir_all(&bin_dir).unwrap();
    write_fake_gh(&bin_dir, &marker, "github.com");
    let fake_codex = write_fake_codex_app_server(&log_path);
    let _executor_home = EnvGuard::set("WEGENT_EXECUTOR_HOME", executor_home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let path_value = format!(
        "{}:{}",
        bin_dir.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let _path = EnvGuard::set("PATH", &path_value);
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        "claude".to_owned(),
        fake_codex.display().to_string(),
    ));
    let request = ExecutionRequest {
        task_id: "7796".to_owned(),
        subtask_id: "99".to_owned(),
        skip_git_clone: true,
        prompt: json!("authenticate git cli"),
        bot: json!([{"id": 7, "shell_type": "codex"}]),
        extra: serde_json::Map::from_iter([(
            "user".to_owned(),
            json!({
                "git_domain": "github.com",
                "git_token": "ghp_codex_token"
            }),
        )]),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
    assert_eq!(fs::read_to_string(marker).unwrap(), "ghp_codex_token\n");
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
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7790".to_owned(),
        subtask_id: "101".to_owned(),
        prompt: json!("ask for form"),
        bot: json!([{
            "id": 7,
            "shell_type": "ClaudeCode"
        }]),
        backend_url: Some(mcp_url),
        auth_token: Some("synthetic-form-token".to_owned()),
        mcp_servers: vec![json!({
            "name": "interactive-wegent-interactive-form-question",
            "type": "streamable-http",
            "url": "${{backend_url}}",
            "headers": {"Authorization": "Bearer ${{auth_token}}"}
        })],
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(authenticated_bot_request(request)).await;

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
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7791".to_owned(),
        subtask_id: "102".to_owned(),
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

    let outcome = engine.run(authenticated_bot_request(request)).await;

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
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = ExecutionRequest {
        task_id: "7792".to_owned(),
        subtask_id: "103".to_owned(),
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

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "answered".to_owned()
        }
    );
}

#[tokio::test]
async fn claude_runtime_completes_after_answer_drain_even_if_old_defer_remains() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-answer-drain-stale-workspace");
    let marker = unique_dir("claude-runtime-answer-drain-stale-marker").join("count");
    let fake_claude = write_fake_claude_answer_drain_final_text_with_stale_defer(&marker);
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = interactive_form_answer_request(7793, 104);

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "published".to_owned()
        }
    );
}

#[tokio::test]
async fn claude_runtime_streams_answer_drain_follow_up_output() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-answer-drain-stream-workspace");
    let marker = unique_dir("claude-runtime-answer-drain-stream-marker").join("count");
    let fake_claude = write_fake_claude_answer_drain_final_text_with_stale_defer(&marker);
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let request = interactive_form_answer_request(7794, 105);
    let sink = RecordingSink::default();
    let builder = ResponsesEventBuilder::new(
        request.task_id.clone(),
        request.subtask_id.clone(),
        "claude",
    );

    let outcome = engine
        .run_with_events(authenticated_bot_request(request), sink.clone(), builder)
        .await;
    let events = sink.events();

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "published".to_owned()
        }
    );
    assert!(events.iter().any(|event| {
        event.event_type == "response.output_text.delta" && event.data["delta"] == "published"
    }));
}

#[tokio::test]
async fn claude_runtime_preserves_new_deferred_form_after_answer_drain() {
    let _lock = env_lock().await;
    let workspace_root = unique_dir("claude-runtime-answer-new-defer-workspace");
    let marker = unique_dir("claude-runtime-answer-new-defer-marker").join("count");
    let fake_claude = write_fake_claude_answer_drain_with_new_defer(&marker);
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
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let mut request = interactive_form_answer_request(7795, 106);
    request.mcp_servers = vec![json!({
        "name": "interactive-wegent-interactive-form-question",
        "type": "streamable-http",
        "url": mcp_url
    })];

    let outcome = engine.run(authenticated_bot_request(request)).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::WaitingForUserInput {
            stop_reason: "tool_deferred".to_owned()
        }
    );
}

struct TestEnvironment {
    // Restore the environment and remove this case's temporary tree before unlocking.
    _environment: Vec<EnvGuard>,
    _root: tempfile::TempDir,
    _lock: MutexGuard<'static, ()>,
}

async fn env_lock() -> TestEnvironment {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    let lock = LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let root = tempfile::tempdir().unwrap();
    let mut environment = Vec::new();
    for (key, relative) in [
        ("HOME", "home"),
        ("USERPROFILE", "home"),
        ("WEGENT_EXECUTOR_HOME", "executor"),
        ("WEGENT_WORKBENCH_HOME", "workbench"),
        ("WEGENT_CAPABILITIES_HOME", "capabilities"),
        ("WEGENT_CODEX_HOME", "codex"),
        ("CODEX_HOME", "codex"),
        ("WEGENT_CLAUDE_HOME", "claude"),
        ("CLAUDE_CONFIG_DIR", "claude"),
    ] {
        let path = root.path().join(relative);
        fs::create_dir_all(&path).unwrap();
        environment.push(EnvGuard::set(key, path));
    }
    for key in [
        "WEGENT_BACKEND_URL",
        "TASK_API_DOMAIN",
        "WORKSPACE_ROOT",
        "WEGENT_WORKSPACE_ROOT",
        "LOCAL_WORKSPACE_ROOT",
        "WEGENT_EXECUTOR_PROJECTS_DIR",
    ] {
        environment.push(EnvGuard::remove(key));
    }
    TestEnvironment {
        _environment: environment,
        _root: root,
        _lock: lock,
    }
}

fn task_home(task_id: &str) -> PathBuf {
    let root = PathBuf::from(std::env::var_os("WEGENT_WORKBENCH_HOME").unwrap());
    let home = root.join("agents/user7/default/design");
    assert!(
        home.join("runtime/tasks")
            .join(format!("{task_id}.json"))
            .is_file(),
        "missing agent Home for task {task_id}"
    );
    home
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
    write_fake_claude_with_prelude(log_path, "")
}

fn write_fake_claude_with_git_auth(
    log_path: &Path,
    expected_domain: &str,
    expected_username: &str,
    expected_token: &str,
) -> PathBuf {
    let prelude = format!(
        r#"if [ "$GH_HOST" != "{expected_domain}" ]; then exit 31; fi
if [ "$GH_TOKEN" != "{expected_token}" ]; then exit 32; fi
if [ "$GIT_ASKPASS_REQUIRE" != "force" ]; then exit 33; fi
if [ "$GIT_TERMINAL_PROMPT" != "0" ]; then exit 34; fi
if [ ! -x "$GIT_ASKPASS" ]; then exit 35; fi
if [ "$("$GIT_ASKPASS" Username)" != "{expected_username}" ]; then exit 36; fi
if [ "$("$GIT_ASKPASS" Password)" != "{expected_token}" ]; then exit 37; fi"#
    );
    write_fake_claude_with_prelude(log_path, &prelude)
}

fn write_fake_claude_with_prelude(log_path: &Path, prelude: &str) -> PathBuf {
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let stdin_log_path = log_path.with_extension("stdin");
    let path = unique_dir("fake-claude-runtime").join("claude");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let content = format!(
        r#"#!/bin/sh
{}
LOG_PATH='{}'
STDIN_LOG_PATH='{}'
if [ -n "$WEGENT_MCP_CONFIG_PATH" ]; then
  cp "$WEGENT_MCP_CONFIG_PATH" "${{LOG_PATH%.json}}.mcp"
fi
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
cat > "$STDIN_LOG_PATH"
printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"ok"}}]}}}}'
printf '%s\n' '{{"type":"result","is_error":false}}'
"#,
        prelude,
        log_path.display(),
        stdin_log_path.display()
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
cat >/dev/null
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
  cat >/dev/null
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
  cat >/dev/null
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

fn write_fake_claude_answer_drain_final_text_with_stale_defer(marker: &Path) -> PathBuf {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let path = unique_dir("fake-claude-answer-drain-stale").join("claude");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let content = format!(
        r#"#!/bin/sh
MARKER='{}'
if [ ! -f "$MARKER" ]; then
  printf 1 > "$MARKER"
  cat >/dev/null
  printf '%s\n' '{{"type":"system","subtype":"init","session_id":"session-answer-stale"}}'
  printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"session_id":"session-answer-stale","stop_reason":"tool_deferred","usage":{{}},"deferred_tool_use":{{"id":"tool-answered","name":"mcp__interactive_wegent-interactive-form-question__interactive_form_question","input":{{"questions":[]}}}}}}'
  exit 0
fi
if ! grep -q 'tool-answered' >/dev/null 2>&1; then
  exit 9
fi
printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"published"}}]}}}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"session_id":"session-answer-stale","stop_reason":"tool_deferred","usage":{{}},"deferred_tool_use":{{"id":"tool-answered","name":"mcp__interactive_wegent-interactive-form-question__interactive_form_question","input":{{"questions":[]}}}}}}'
"#,
        marker.display()
    );
    fs::write(&path, content).unwrap();
    make_executable(&path);
    path
}

fn write_fake_claude_answer_drain_with_new_defer(marker: &Path) -> PathBuf {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let path = unique_dir("fake-claude-answer-new-defer").join("claude");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let content = format!(
        r#"#!/bin/sh
MARKER='{}'
if [ ! -f "$MARKER" ]; then
  printf 1 > "$MARKER"
  cat >/dev/null
  printf '%s\n' '{{"type":"system","subtype":"init","session_id":"session-answer-new-defer"}}'
  printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"session_id":"session-answer-new-defer","stop_reason":"tool_deferred","usage":{{}},"deferred_tool_use":{{"id":"tool-answered","name":"mcp__interactive_wegent-interactive-form-question__interactive_form_question","input":{{"questions":[]}}}}}}'
  exit 0
fi
if ! grep -q 'tool-answered' >/dev/null 2>&1; then
  exit 9
fi
printf '%s\n' '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"one verification decision remains"}}]}}}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"session_id":"session-answer-new-defer","stop_reason":"tool_deferred","usage":{{}},"deferred_tool_use":{{"id":"tool-new","name":"mcp__interactive_wegent-interactive-form-question__interactive_form_question","input":{{"questions":[{{"id":"verification_scope","question":"Which verification scope?"}}]}}}}}}'
"#,
        marker.display()
    );
    fs::write(&path, content).unwrap();
    make_executable(&path);
    path
}

fn interactive_form_answer_request(task_id: i64, subtask_id: i64) -> ExecutionRequest {
    ExecutionRequest {
        task_id: task_id.to_string(),
        subtask_id: subtask_id.to_string(),
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
    }
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
  cat >/dev/null
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

fn write_fake_gh(bin_dir: &Path, marker: &Path, expected_hostname: &str) {
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let path = bin_dir.join("gh");
    let content = format!(
        r#"#!/bin/sh
if [ "$1" != "auth" ] || [ "$2" != "login" ] || [ "$3" != "--hostname" ] || [ "$4" != "{}" ] || [ "$5" != "--with-token" ]; then
  exit 11
fi
cat > '{}'
"#,
        expected_hostname,
        marker.display()
    );
    fs::write(&path, content).unwrap();
    make_executable(&path);
}

fn write_fake_codex_app_server(log_path: &Path) -> PathBuf {
    let path = unique_dir("fake-codex-app-server").join("codex");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":3,"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"delta":"done","phase":"finalAnswer"}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-1","status":"completed"}}}}}}'
      exit 0
      ;;
  esac
done
"#,
        log_path.display()
    );
    fs::write(&path, content).unwrap();
    make_executable(&path);
    path
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
    previous: Option<OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }

    fn remove(key: &'static str) -> Self {
        let previous = std::env::var_os(key);
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
