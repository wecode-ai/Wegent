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
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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
fn claude_command_sends_empty_prompt_through_stream_json_stdin() {
    let request = ExecutionRequest {
        prompt: json!(""),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert_eq!(spec.args()[0], "-p");
    assert_eq!(spec.args()[1], "--input-format");
    assert_eq!(spec.args()[2], "stream-json");
    assert_eq!(
        spec.stdin_input().unwrap(),
        "{\"message\":{\"content\":\"\",\"role\":\"user\"},\"parent_tool_use_id\":null,\"session_id\":\"\",\"type\":\"user\"}\n"
    );
}

#[test]
fn claude_command_maps_nested_model_env_to_process_environment() {
    let _lock = env_lock();
    let home = unique_dir("claude-nested-model-home");
    let project_dir = unique_dir("claude-nested-model-project");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
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
        project_workspace_path: Some(project_dir.display().to_string()),
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
        project_dir.display().to_string()
    );
    assert_eq!(
        spec.envs().get("CLAUDE_CONFIG_DIR").unwrap(),
        &home.join(".claude").display().to_string()
    );
    assert_eq!(
        spec.envs().get("SKILLS_DIR").unwrap(),
        &home.join(".claude/skills").display().to_string()
    );
}

#[test]
fn claude_command_uses_model_config_default_haiku_model_when_set() {
    let _lock = env_lock();
    let _default_haiku = EnvGuard::set("ANTHROPIC_DEFAULT_HAIKU_MODEL", "process-haiku");
    let request = ExecutionRequest {
        prompt: json!("run locally"),
        model_config: json!({
            "model": "anthropic",
            "model_id": "claude-sonnet-4",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-custom"
        }),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert_eq!(
        spec.envs().get("ANTHROPIC_DEFAULT_HAIKU_MODEL").unwrap(),
        "claude-haiku-custom"
    );
}

#[test]
fn claude_command_defaults_haiku_model_to_model_id() {
    let _lock = env_lock();
    let _default_haiku = EnvGuard::remove("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    let request = ExecutionRequest {
        prompt: json!("run locally"),
        model_config: json!({"model": "anthropic", "model_id": "claude-sonnet-4"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert_eq!(
        spec.envs().get("ANTHROPIC_DEFAULT_HAIKU_MODEL").unwrap(),
        "claude-sonnet-4"
    );
}

#[test]
fn claude_command_maps_git_fields_to_process_environment() {
    let request = ExecutionRequest {
        prompt: json!("open a pull request"),
        extra: serde_json::Map::from_iter([
            ("git_domain".to_owned(), json!("github.com")),
            ("git_repo".to_owned(), json!("wecode-ai/Wegent")),
            ("git_repo_id".to_owned(), json!("12345")),
            ("branch_name".to_owned(), json!("feature/test")),
            (
                "git_url".to_owned(),
                json!("https://github.com/wecode-ai/Wegent.git"),
            ),
        ]),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert_eq!(spec.envs().get("GIT_DOMAIN").unwrap(), "github.com");
    assert_eq!(spec.envs().get("GIT_REPO").unwrap(), "wecode-ai/Wegent");
    assert_eq!(spec.envs().get("GIT_REPO_ID").unwrap(), "12345");
    assert_eq!(spec.envs().get("BRANCH_NAME").unwrap(), "feature/test");
    assert_eq!(
        spec.envs().get("GIT_URL").unwrap(),
        "https://github.com/wecode-ai/Wegent.git"
    );
}

#[test]
fn claude_command_sends_content_block_prompts_through_stdin() {
    let large_image = "a".repeat(256 * 1024);
    let request = ExecutionRequest {
        prompt: json!([
            {"type": "input_text", "text": "describe image"},
            {"type": "input_image", "image_url": format!("data:image/png;base64,{large_image}")}
        ]),
        model_config: json!({"model_id": "claude-sonnet-4-6"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert_eq!(spec.args()[0], "-p");
    assert!(spec.args().contains(&"--input-format".to_owned()));
    assert!(spec.args().contains(&"stream-json".to_owned()));
    assert!(!spec.args().iter().any(|arg| arg.contains(&large_image)));
    let stdin = spec
        .stdin_input()
        .expect("content block prompt should be sent through stdin");
    assert!(stdin.contains("\"type\":\"user\""));
    assert!(stdin.contains("\"type\":\"image\""));
    assert!(stdin.contains(&large_image));
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
fn claude_command_uses_bot_system_prompt_when_request_prompt_absent() {
    let request = ExecutionRequest {
        prompt: json!("run"),
        bot: json!([{"shell_type": "ClaudeCode", "system_prompt": "You are helpful."}]),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");
    let append_flag_index = spec
        .args()
        .iter()
        .position(|arg| arg == "--append-system-prompt")
        .expect("Claude system prompt append flag should be present");

    assert_eq!(spec.args()[append_flag_index + 1], "You are helpful.");
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
        task_id: "77".to_owned(),
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
fn claude_command_sends_interactive_form_answer_as_tool_result_query() {
    let _lock = env_lock();
    let executor_home = unique_dir("claude-interactive-answer-home");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let session_dir = executor_home.join("sessions/77");
    fs::create_dir_all(&session_dir).unwrap();
    fs::write(
        session_dir.join(".claude_session_id_987"),
        "interactive-session\n",
    )
    .unwrap();
    let request = ExecutionRequest {
        task_id: "77".to_owned(),
        prompt: json!("ignored when answering interactive form"),
        bot: json!([{"id": 987, "shell_type": "ClaudeCode"}]),
        extra: serde_json::Map::from_iter([(
            "interactive_form_answer".to_owned(),
            json!({
                "type": "interactive_form_question",
                "tool_use_id": "toolu_123",
                "task_id": 77,
                "subtask_id": 88,
                "answers": [{"id": "name", "value": "Wegent"}],
                "success": true,
                "status": "answered",
                "ask_id": "ignored"
            }),
        )]),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");
    let query: serde_json::Value = serde_json::from_str(spec.stdin_input().unwrap().trim())
        .expect("interactive form answer should be sent as a JSON tool_result query");

    assert!(spec.args().contains(&"--resume".to_owned()));
    assert!(spec.args().contains(&"interactive-session".to_owned()));
    assert!(spec.args().contains(&"--input-format".to_owned()));
    assert!(spec.args().contains(&"stream-json".to_owned()));
    assert!(!spec
        .args()
        .contains(&"ignored when answering interactive form".to_owned()));
    assert_eq!(query["type"], "user");
    assert_eq!(query["message"]["content"][0]["type"], "tool_result");
    assert_eq!(query["message"]["content"][0]["tool_use_id"], "toolu_123");
    assert_eq!(query["message"]["content"][0]["is_error"], false);
    let payload_text = query["message"]["content"][0]["content"][0]["text"]
        .as_str()
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(payload_text).unwrap();
    assert_eq!(payload["task_id"], 77);
    assert_eq!(payload["subtask_id"], 88);
    assert!(payload.get("ask_id").is_none());
}

#[test]
fn claude_command_prefers_executor_home_session_over_legacy_workspace() {
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
        task_id: "77".to_owned(),
        prompt: json!("follow up"),
        bot: json!([{"id": 987, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "claude", "model_id": "claude-3-5-sonnet"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert!(spec.args().contains(&"--resume".to_owned()));
    assert!(spec.args().contains(&"home-session".to_owned()));
}

#[test]
fn claude_command_ignores_legacy_workspace_task_session_file() {
    let _lock = env_lock();
    let workspace_root = unique_dir("claude-session-legacy-workspace-root");
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let session_dir = workspace_root.join("77");
    fs::create_dir_all(&session_dir).unwrap();
    fs::write(session_dir.join(".claude_session_id"), "legacy-session\n").unwrap();
    let request = ExecutionRequest {
        task_id: "77".to_owned(),
        prompt: json!("follow up"),
        bot: json!([{"id": 987, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "claude", "model_id": "claude-3-5-sonnet"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert!(!spec.args().contains(&"--resume".to_owned()));
    assert!(!spec.args().contains(&"legacy-session".to_owned()));
}

#[test]
fn claude_command_seeds_inherited_session_when_no_saved_session_exists() {
    let _lock = env_lock();
    let executor_home = unique_dir("claude-session-inherited-home");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let request = ExecutionRequest {
        task_id: "77".to_owned(),
        prompt: json!("fork follow up"),
        bot: json!([{"id": 987, "shell_type": "ClaudeCode"}]),
        inherited_sessions: vec![json!({
            "agent": "ClaudeCode",
            "botId": 987,
            "sessionId": "inherited-session"
        })],
        model_config: json!({"model": "claude", "model_id": "claude-3-5-sonnet"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert!(spec.args().contains(&"--resume".to_owned()));
    assert!(spec.args().contains(&"inherited-session".to_owned()));
    assert_eq!(
        fs::read_to_string(executor_home.join("sessions/77/.claude_session_id_987")).unwrap(),
        "inherited-session"
    );
    assert!(!executor_home
        .join("workspace/77/.claude_session_id_987")
        .exists());
}

#[test]
fn claude_command_new_session_deletes_saved_and_legacy_sessions_and_skips_resume() {
    let _lock = env_lock();
    let executor_home = unique_dir("claude-session-new-session-home");
    let workspace_root = unique_dir("claude-session-new-session-workspace-root");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _mode = EnvGuard::set("EXECUTOR_MODE", "docker");
    let session_dir = executor_home.join("sessions/77");
    let legacy_session_dir = workspace_root.join("77");
    fs::create_dir_all(&session_dir).unwrap();
    fs::create_dir_all(&legacy_session_dir).unwrap();
    fs::write(session_dir.join(".claude_session_id_987"), "old-session\n").unwrap();
    fs::write(
        session_dir.join(".claude_session_id"),
        "legacy-old-session\n",
    )
    .unwrap();
    fs::write(
        legacy_session_dir.join(".claude_session_id_987"),
        "workspace-old-session\n",
    )
    .unwrap();
    fs::write(
        legacy_session_dir.join(".claude_session_id"),
        "workspace-legacy-old-session\n",
    )
    .unwrap();
    let request = ExecutionRequest {
        task_id: "77".to_owned(),
        new_session: true,
        prompt: json!("fresh stage"),
        bot: json!([{"id": 987, "shell_type": "ClaudeCode"}]),
        model_config: json!({"model": "claude", "model_id": "claude-3-5-sonnet"}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert!(!spec.args().contains(&"--resume".to_owned()));
    assert!(!session_dir.join(".claude_session_id_987").exists());
    assert!(!session_dir.join(".claude_session_id").exists());
    assert!(!legacy_session_dir.join(".claude_session_id_987").exists());
    assert!(!legacy_session_dir.join(".claude_session_id").exists());
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
        task_id: "0".to_owned(),
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
        task_id: "77".to_owned(),
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
    let home = unique_dir("claude-chat-home");
    let workspace_root = unique_dir("claude-chat-workspace-root");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let request = ExecutionRequest {
        task_id: "42".to_owned(),
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
        &home.join(".claude").display().to_string()
    );
    assert_eq!(
        spec.envs().get("SKILLS_DIR").unwrap(),
        &home.join(".claude/skills").display().to_string()
    );
}

#[test]
fn claude_project_task_uses_global_capability_dirs() {
    let _lock = env_lock();
    let home = unique_dir("claude-project-home");
    let project_dir = unique_dir("claude-project-workspace");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("work inside the project"),
        project_workspace_path: Some(project_dir.display().to_string()),
        extra: serde_json::Map::from_iter([(
            "workspace".to_owned(),
            json!({"project": {"project_id": 42}}),
        )]),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert_eq!(spec.current_dir().unwrap(), &project_dir);
    assert_eq!(
        spec.envs().get("CLAUDE_CONFIG_DIR").unwrap(),
        &home.join(".claude").display().to_string()
    );
    assert_eq!(
        spec.envs().get("SKILLS_DIR").unwrap(),
        &home.join(".claude/skills").display().to_string()
    );
}

#[test]
fn claude_project_headers_merge_custom_headers_and_default_headers() {
    let _lock = env_lock();
    let home = unique_dir("claude-project-headers-home");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _process_headers = EnvGuard::remove("ANTHROPIC_CUSTOM_HEADERS");
    let request = ExecutionRequest {
        prompt: json!("work inside the project"),
        model_config: json!({
            "env": {
                "ANTHROPIC_CUSTOM_HEADERS": "x-custom-user: test",
                "DEFAULT_HEADERS": {
                    "wecode-action": "wecode-cli",
                    "wecode-source": "wecode-cli",
                    "x-weibo-downstream": "shanghai-intranet"
                }
            }
        }),
        extra: serde_json::Map::from_iter([("project_id".to_owned(), json!(42))]),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");
    let default_headers: serde_json::Value =
        serde_json::from_str(spec.envs().get("DEFAULT_HEADERS").unwrap()).unwrap();

    assert_eq!(
        spec.envs().get("ANTHROPIC_CUSTOM_HEADERS").unwrap(),
        "x-custom-user: test\nwecode-action: wecode-cli\nwecode-source: wecode-cli\nx-weibo-downstream: shanghai-intranet\nwecode-executor: claudecode\nwecode-project: 42"
    );
    assert_eq!(default_headers["wecode-action"], "wecode-cli");
    assert_eq!(default_headers["wecode-source"], "wecode-cli");
    assert_eq!(default_headers["x-weibo-downstream"], "shanghai-intranet");
    assert_eq!(default_headers["wecode-executor"], "claudecode");
    assert_eq!(default_headers["wecode-project"], "42");
    assert_eq!(
        spec.envs().get("default_headers"),
        spec.envs().get("DEFAULT_HEADERS")
    );
}

#[test]
fn claude_standalone_project_zero_keeps_global_capabilities_and_project_header() {
    let _lock = env_lock();
    let home = unique_dir("claude-standalone-zero-home");
    let workspace_root = unique_dir("claude-standalone-zero-workspace");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let _process_headers = EnvGuard::remove("ANTHROPIC_CUSTOM_HEADERS");
    let request = ExecutionRequest {
        task_id: "1904".to_owned(),
        prompt: json!("standalone chat"),
        extra: serde_json::Map::from_iter([
            ("project_id".to_owned(), json!(0)),
            ("standalone_chat_workspace".to_owned(), json!(true)),
        ]),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert_eq!(
        spec.envs().get("CLAUDE_CONFIG_DIR").unwrap(),
        &home.join(".claude").display().to_string()
    );
    assert_eq!(
        spec.envs().get("SKILLS_DIR").unwrap(),
        &home.join(".claude/skills").display().to_string()
    );
    assert!(spec
        .envs()
        .get("ANTHROPIC_CUSTOM_HEADERS")
        .unwrap()
        .contains("wecode-project: 0"));
}

#[test]
fn claude_standalone_project_zero_with_task_skills_keeps_global_config_and_uses_task_skills_dir() {
    let _lock = env_lock();
    let home = unique_dir("claude-standalone-skill-home");
    let workspace_root = unique_dir("claude-standalone-skill-workspace");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _workspace = EnvGuard::set("WORKSPACE_ROOT", &workspace_root.display().to_string());
    let request = ExecutionRequest {
        task_id: "1905".to_owned(),
        prompt: json!("standalone chat with skills"),
        bot: json!([{"id": 1905, "shell_type": "ClaudeCode"}]),
        extra: serde_json::Map::from_iter([
            ("project_id".to_owned(), json!(0)),
            ("standalone_chat_workspace".to_owned(), json!(true)),
            ("skill_names".to_owned(), json!(["task-skill"])),
        ]),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");
    let task_dir = workspace_root.join("1905");

    assert_eq!(
        spec.envs().get("CLAUDE_CONFIG_DIR").unwrap(),
        &home.join(".claude").display().to_string()
    );
    assert_eq!(
        spec.envs().get("SKILLS_DIR").unwrap(),
        &task_dir.join(".claude/skills").display().to_string()
    );
}

#[test]
fn claude_command_injects_task_identity_env() {
    let _lock = env_lock();
    let _auth = EnvGuard::remove("AUTH_TOKEN");
    let _task_id = EnvGuard::remove("WEGENT_TASK_ID");
    let _identity = EnvGuard::remove("WEGENT_SKILL_IDENTITY_TOKEN");
    let _user = EnvGuard::remove("WEGENT_SKILL_USER_NAME");
    let request = ExecutionRequest {
        task_id: "525".to_owned(),
        subtask_id: "626".to_owned(),
        prompt: json!("use task scoped skills"),
        auth_token: Some("task-jwt".to_owned()),
        skill_identity_token: Some("skill-jwt".to_owned()),
        user_name: Some("alice".to_owned()),
        model_config: json!({"env": {"EXISTING_VAR": "value"}}),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");

    assert_eq!(spec.envs().get("EXISTING_VAR").unwrap(), "value");
    assert_eq!(spec.envs().get("WEGENT_TASK_ID").unwrap(), "525");
    assert!(spec.envs().get("WEGENT_SUBTASK_ID").is_none());
    assert_eq!(spec.envs().get("AUTH_TOKEN").unwrap(), "task-jwt");
    assert_eq!(
        spec.envs().get("WEGENT_SKILL_IDENTITY_TOKEN").unwrap(),
        "skill-jwt"
    );
    assert_eq!(spec.envs().get("WEGENT_SKILL_USER_NAME").unwrap(), "alice");
    assert!(std::env::var("WEGENT_TASK_ID").is_err());
    assert!(std::env::var("WEGENT_SKILL_IDENTITY_TOKEN").is_err());
}

#[test]
fn claude_command_injects_kb_meta_prompt_for_chat_tasks() {
    let request = ExecutionRequest {
        prompt: json!("Save this file to the selected knowledge base."),
        task_type: Some("chat".to_owned()),
        extra: serde_json::Map::from_iter([
            (
                "kb_meta_prompt".to_owned(),
                json!("Knowledge Bases In Scope:\n- KB Name: 222, KB ID: 1408"),
            ),
            ("is_user_selected_kb".to_owned(), json!(true)),
        ]),
        ..ExecutionRequest::default()
    };

    let spec = build_claude_command(&request, "claude");
    let prompt = &spec.args()[1];

    assert!(prompt.starts_with("<knowledge_base_guidance>\n"));
    assert!(prompt.contains("<knowledge_base_context>\n"));
    assert!(prompt.contains("KB Name: 222, KB ID: 1408"));
    assert!(prompt.contains("wegent_kb_list_documents"));
    assert!(prompt.contains("wegent_kb_read_document_content"));
    assert!(prompt.ends_with("Save this file to the selected knowledge base."));
}

#[test]
fn codex_command_starts_app_server_for_json_rpc_control() {
    let spec = build_codex_app_server_command("codex");

    assert_eq!(spec.program(), "codex");
    assert_eq!(spec.args(), &["app-server"]);
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
fn command_planner_keeps_claudecode_requests_on_claude_binary_for_openai_responses_model() {
    let planner = AgentCommandPlanner::new("claude", "codex");
    let request = ExecutionRequest {
        prompt: json!("hello"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };

    let spec = planner.command_for(&request).unwrap();

    assert_eq!(spec.program(), "claude");
    assert_eq!(spec.args()[0], "-p");
}

#[test]
fn command_planner_routes_codex_requests_to_codex_app_server() {
    let planner = AgentCommandPlanner::new("claude", "codex");
    let request = ExecutionRequest {
        bot: json!([{"shell_type": "Codex"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };

    let spec = planner.command_for(&request).unwrap();

    assert_eq!(spec.program(), "codex");
    assert_eq!(spec.args(), &["app-server"]);
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
