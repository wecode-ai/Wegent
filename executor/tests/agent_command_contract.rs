// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    sync::{Mutex, MutexGuard, OnceLock},
};

use serde_json::json;
use wegent_executor::{
    agents::{build_claude_command, build_codex_app_server_command, AgentCommandPlanner},
    protocol::ExecutionRequest,
};

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
fn claude_command_uses_headless_stream_json_mode() {
    let request = ExecutionRequest {
        prompt: json!("implement feature"),
        model_config: json!({"model_id": "claude-sonnet-4-6"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert_eq!(spec.program(), "claude");
    assert_eq!(
        spec.args(),
        &[
            "-p",
            "implement feature",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-mode",
            "bypassPermissions",
            "--model",
            "claude-sonnet-4-6"
        ]
    );
}

#[test]
fn claude_command_maps_nested_model_env_to_process_environment() {
    let request = ExecutionRequest {
        prompt: json!("run locally"),
        model_config: json!({
            "env": {
                "model": "anthropic",
                "model_id": "claude-3-5-sonnet-20241022",
                "api_key": "mock-api-key",
                "base_url": "http://localhost:9999/v1",
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
            }
        }),
        project_workspace_path: Some("/tmp/project".to_owned()),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert!(spec.args().contains(&"--model".to_owned()));
    assert!(spec
        .args()
        .contains(&"claude-3-5-sonnet-20241022".to_owned()));
    assert_eq!(
        spec.envs().get("ANTHROPIC_API_KEY").unwrap(),
        "mock-api-key"
    );
    assert_eq!(
        spec.envs().get("ANTHROPIC_BASE_URL").unwrap(),
        "http://localhost:9999/v1"
    );
    assert_eq!(
        spec.envs()
            .get("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")
            .unwrap(),
        "1"
    );
    assert_eq!(
        spec.current_dir().unwrap().display().to_string(),
        "/tmp/project"
    );
    assert_eq!(
        spec.envs().get("CLAUDE_CONFIG_DIR").unwrap(),
        "/tmp/project/.claude"
    );
    assert_eq!(
        spec.envs().get("SKILLS_DIR").unwrap(),
        "/tmp/project/.claude/skills"
    );
}

#[test]
fn claude_command_appends_execution_system_prompt() {
    let request = ExecutionRequest {
        prompt: json!("Previous stage output:\nMANUAL_PIPELINE_STAGE_ONE_OUTPUT_CTX_MANUAL_STAGE"),
        system_prompt: concat!(
            "<base_prompt>\n",
            "MANUAL_PIPELINE_STAGE_TWO_SYSTEM_PROMPT\n\n",
            "MANUAL_PIPELINE_STAGE_TWO_MEMBER_PROMPT\n",
            "</base_prompt>"
        )
        .to_owned(),
        model_config: json!({"model_id": "claude-3-5-sonnet-20241022"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");
    let append_flag_index = spec
        .args()
        .iter()
        .position(|arg| arg == "--append-system-prompt")
        .expect("Claude system prompt append flag should be present");
    let appended_prompt = &spec.args()[append_flag_index + 1];

    assert!(appended_prompt.contains("MANUAL_PIPELINE_STAGE_TWO_SYSTEM_PROMPT"));
    assert!(appended_prompt.contains("MANUAL_PIPELINE_STAGE_TWO_MEMBER_PROMPT"));
    assert!(spec.args()[1].contains("MANUAL_PIPELINE_STAGE_ONE_OUTPUT_CTX_MANUAL_STAGE"));
}

#[test]
fn claude_command_maps_flat_resolved_model_config_to_process_environment() {
    let request = ExecutionRequest {
        prompt: json!("run with resolved backend model config"),
        model_config: json!({
            "model": "claude",
            "model_id": "claude-3-5-sonnet-20241022",
            "api_key": "resolved-api-key",
            "base_url": "http://localhost:9999/v1"
        }),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert_eq!(
        spec.envs().get("ANTHROPIC_API_KEY").unwrap(),
        "resolved-api-key"
    );
    assert_eq!(
        spec.envs().get("ANTHROPIC_BASE_URL").unwrap(),
        "http://localhost:9999/v1"
    );
}

#[test]
fn claude_command_falls_back_to_bot_agent_config_env_for_credentials() {
    let request = ExecutionRequest {
        prompt: json!("run with bot agent config"),
        bot: json!([{
            "shell_type": "ClaudeCode",
            "agent_config": {
                "env": {
                    "model_id": "claude-3-5-sonnet-20241022",
                    "api_key": "bot-api-key",
                    "base_url": "http://localhost:9998/v1"
                }
            }
        }]),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert!(spec
        .args()
        .contains(&"claude-3-5-sonnet-20241022".to_owned()));
    assert_eq!(spec.envs().get("ANTHROPIC_API_KEY").unwrap(), "bot-api-key");
    assert_eq!(
        spec.envs().get("ANTHROPIC_BASE_URL").unwrap(),
        "http://localhost:9998/v1"
    );
}

#[test]
fn claude_command_resumes_saved_task_session() {
    let _lock = env_lock();
    let executor_home = unique_dir("claude-session-home");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let session_dir = executor_home.join("sessions/77");
    fs::create_dir_all(&session_dir).unwrap();
    fs::write(
        session_dir.join(".claude_session_id_987"),
        "saved-session\n",
    )
    .unwrap();
    let request = ExecutionRequest {
        task_id: 77,
        prompt: json!("follow up"),
        bot: json!([{"id": 987, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "claude", "model_id": "claude-3-5-sonnet"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert!(spec.args().contains(&"--resume".to_owned()));
    assert!(spec.args().contains(&"saved-session".to_owned()));
}

#[test]
fn claude_command_prefers_workspace_task_session_over_executor_home() {
    let _lock = env_lock();
    let executor_home = unique_dir("claude-session-home-fallback");
    let workspace_root = unique_dir("claude-session-workspace-root");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let session_dir = workspace_root.join("77");
    fs::create_dir_all(&session_dir).unwrap();
    fs::create_dir_all(executor_home.join("sessions/77")).unwrap();
    fs::write(
        session_dir.join(".claude_session_id_987"),
        "workspace-session\n",
    )
    .unwrap();
    fs::write(
        executor_home.join("sessions/77/.claude_session_id_987"),
        "home-session\n",
    )
    .unwrap();
    let request = ExecutionRequest {
        task_id: 77,
        prompt: json!("follow up"),
        bot: json!([{"id": 987, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "claude", "model_id": "claude-3-5-sonnet"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert!(spec.args().contains(&"--resume".to_owned()));
    assert!(spec.args().contains(&"workspace-session".to_owned()));
}

#[test]
fn claude_command_does_not_resume_nonpositive_task_sessions() {
    let _lock = env_lock();
    let executor_home = unique_dir("claude-session-zero-home");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let session_dir = executor_home.join("sessions/0");
    fs::create_dir_all(&session_dir).unwrap();
    fs::write(session_dir.join(".claude_session_id_987"), "stale-zero\n").unwrap();
    let request = ExecutionRequest {
        task_id: 0,
        prompt: json!("fresh"),
        bot: json!([{"id": 987, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "claude", "model_id": "claude-3-5-sonnet"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert!(!spec.args().contains(&"--resume".to_owned()));
    assert!(!spec.args().contains(&"stale-zero".to_owned()));
}

#[test]
fn claude_command_rejects_unsafe_string_bot_id_for_session_filename() {
    let _lock = env_lock();
    let workspace_root = unique_dir("claude-session-unsafe-bot");
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let task_dir = workspace_root.join("77");
    fs::create_dir_all(task_dir.join(".claude_session_id_x")).unwrap();
    fs::write(workspace_root.join("escape"), "escaped-session\n").unwrap();
    let request = ExecutionRequest {
        task_id: 77,
        prompt: json!("follow up"),
        bot: json!([{"id": "x/../../escape", "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "claude", "model_id": "claude-3-5-sonnet"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert!(!spec.args().contains(&"--resume".to_owned()));
    assert!(!spec.args().contains(&"escaped-session".to_owned()));
}

#[test]
fn claude_command_uses_workspace_task_dir_for_chat_turn_state() {
    let _lock = env_lock();
    let workspace_root = unique_dir("claude-chat-workspace-root");
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let request = ExecutionRequest {
        task_id: 42,
        prompt: json!("remember this"),
        bot: json!([{"id": 7, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "claude", "model_id": "claude-3-5-sonnet"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");
    let task_dir = workspace_root.join("42");

    assert_eq!(spec.current_dir().unwrap(), &task_dir);
    assert_eq!(
        spec.envs().get("CLAUDE_CONFIG_DIR").unwrap(),
        &task_dir.join(".claude").display().to_string()
    );
    assert_eq!(
        spec.envs().get("SKILLS_DIR").unwrap(),
        &task_dir.join(".claude/skills").display().to_string()
    );
}

#[test]
fn codex_command_starts_app_server_for_json_rpc_control() {
    let spec = build_codex_app_server_command("codex");

    assert_eq!(spec.program(), "codex");
    assert_eq!(spec.args(), &["app-server", "--stdio"]);
}

#[test]
fn command_planner_routes_claudecode_requests_to_claude_binary() {
    let planner = AgentCommandPlanner::new("claude", "codex");
    let request = ExecutionRequest {
        prompt: json!("hello"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let spec = planner.command_for(&request).unwrap();

    assert_eq!(spec.program(), "claude");
    assert_eq!(spec.args()[0], "-p");
}

#[test]
fn command_planner_routes_openai_responses_requests_to_codex_app_server() {
    let planner = AgentCommandPlanner::new("claude", "codex");
    let request = ExecutionRequest {
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };

    let spec = planner.command_for(&request).unwrap();

    assert_eq!(spec.program(), "codex");
    assert_eq!(spec.args(), &["app-server", "--stdio"]);
}

#[test]
fn command_planner_rejects_unsupported_agent_kinds() {
    let planner = AgentCommandPlanner::new("claude", "codex");
    let request = ExecutionRequest {
        bot: json!([{"shell_type": "Agno"}]),
        ..ExecutionRequest::default()
    };

    let error = planner.command_for(&request).unwrap_err();

    assert!(error.contains("unsupported agent kind"));
}

fn unique_dir(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&path);
    path
}
