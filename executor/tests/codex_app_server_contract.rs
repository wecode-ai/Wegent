// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde_json::{json, Value};
use tokio::sync::{Mutex, MutexGuard};
use wegent_executor::{
    agents::CodexAppServerEngine,
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

#[tokio::test]
async fn codex_app_server_engine_drives_thread_and_turn_over_json_rpc() {
    let _lock = env_lock().await;
    let log_path = std::env::temp_dir().join(format!(
        "wegent-executor-codex-rpc-{}.jsonl",
        std::process::id()
    ));
    let fake_codex = write_fake_codex(&log_path);
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("implement feature"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses",
            "reasoning": {"effort": "high", "summary": "concise"}
        }),
        project_workspace_path: Some("/tmp/wegent/project".to_owned()),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );

    let messages = fs::read_to_string(log_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(messages[0]["method"], "initialize");
    assert_eq!(messages[1]["method"], "initialized");
    assert_eq!(messages[2]["method"], "thread/start");
    assert_eq!(messages[2]["params"]["model"], "gpt-5");
    assert_eq!(messages[2]["params"]["cwd"], "/tmp/wegent/project");
    assert_eq!(messages[3]["method"], "turn/start");
    assert_eq!(messages[3]["params"]["threadId"], "thread-1");
    assert_eq!(messages[3]["params"]["model"], "gpt-5");
    assert_eq!(messages[3]["params"]["cwd"], "/tmp/wegent/project");
    assert_eq!(messages[3]["params"]["effort"], "high");
    assert_eq!(messages[3]["params"]["summary"], "concise");
    assert_eq!(
        messages[3]["params"]["input"][0],
        json!({"type": "text", "text": "implement feature", "text_elements": []})
    );
    assert_eq!(
        messages[3]["params"]["sandboxPolicy"]["type"],
        "dangerFullAccess"
    );
}

#[tokio::test]
async fn codex_app_server_engine_maps_vision_prompt_blocks_to_user_input() {
    let _lock = env_lock().await;
    let log_path = std::env::temp_dir().join(format!(
        "wegent-executor-codex-vision-rpc-{}.jsonl",
        std::process::id()
    ));
    let fake_codex = write_fake_codex(&log_path);
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!([
            {"type": "input_text", "text": "Analyze this image"},
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
            {"type": "localImage", "path": "/tmp/wegent/image.png"}
        ]),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );

    let messages = fs::read_to_string(log_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        messages[3]["params"]["input"],
        json!([
            {"type": "text", "text": "Analyze this image", "text_elements": []},
            {"type": "image", "url": "data:image/png;base64,abc"},
            {"type": "localImage", "path": "/tmp/wegent/image.png"}
        ])
    );
}

#[tokio::test]
async fn codex_app_server_engine_passes_provider_overrides_as_cli_config() {
    let _lock = env_lock().await;
    let _api_key = EnvGuard::set("WECODE_USER_API_KEY", "sk-from-executor-env");
    let log_path = std::env::temp_dir().join(format!(
        "wegent-executor-codex-config-rpc-{}.jsonl",
        std::process::id()
    ));
    let fake_codex = write_fake_codex_logging_start(&log_path, &[]);
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("implement feature"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1/",
            "api_key": "${WECODE_USER_API_KEY}",
            "api_format": "responses",
            "reasoning": "Ultra",
            "service_tier": "快速",
            "default_headers": {
                "wecode-action": "wecode-cli",
                "x-weibo-downstream": "shanghai-intranet"
            }
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_project_id(request, json!(42))).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );

    let messages = read_json_lines(&log_path);
    let args = messages[0]["args"].as_array().unwrap();
    assert_config_arg(args, "forced_login_method=api");
    assert_config_arg(args, "model=gpt-5.5");
    assert_config_arg(args, "model_provider=wecode-openai");
    assert_config_arg(args, "model_providers.wecode-openai.name=\"wecode openai\"");
    assert_config_arg(
        args,
        "model_providers.wecode-openai.base_url=\"http://127.0.0.1:3456/v1\"",
    );
    assert_config_arg(args, "model_providers.wecode-openai.wire_api=\"responses\"");
    assert_config_arg(
        args,
        "model_providers.wecode-openai.experimental_bearer_token=\"sk-from-executor-env\"",
    );
    assert_config_arg(
        args,
        "model_providers.wecode-openai.http_headers.wecode-action=\"wecode-cli\"",
    );
    assert_config_arg(
        args,
        "model_providers.wecode-openai.http_headers.wecode-source=\"wegent-local\"",
    );
    assert_config_arg(
        args,
        "model_providers.wecode-openai.http_headers.wecode-project=\"42\"",
    );
    assert_config_arg(
        args,
        "model_providers.wecode-openai.http_headers.wecode-executor=\"codex\"",
    );
    assert_config_arg(
        args,
        "model_providers.wecode-openai.http_headers.x-weibo-downstream=\"shanghai-intranet\"",
    );
    assert_eq!(messages[3]["params"]["modelProvider"], "wecode-openai");
    assert_eq!(
        messages[3]["params"]["config"]["model_reasoning_effort"],
        "xhigh"
    );
    assert_eq!(messages[3]["params"]["config"]["service_tier"], "priority");
    assert_eq!(messages[4]["params"]["effort"], "xhigh");
}

#[tokio::test]
async fn codex_app_server_engine_uses_user_runtime_proxy_without_provider_override() {
    let _lock = env_lock().await;
    let _no_proxy = EnvGuard::set("NO_PROXY", "localhost,.internal");
    let log_path = std::env::temp_dir().join(format!(
        "wegent-executor-codex-user-runtime-rpc-{}.jsonl",
        std::process::id()
    ));
    let fake_codex = write_fake_codex_logging_start(
        &log_path,
        &["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "no_proxy"],
    );
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("implement feature"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5.5",
            "api_format": "responses",
            "runtime_config": {
                "codex": {
                    "use_user_config": true,
                    "configured": true,
                    "use_proxy": true
                }
            },
            "proxy": {"url": "socks5://127.0.0.1:7890"},
            "model_provider": "openai"
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(with_project_id(request, json!(42))).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );

    let messages = read_json_lines(&log_path);
    let args = messages[0]["args"].as_array().unwrap();
    assert_config_arg(args, "model=gpt-5.5");
    assert_no_config_arg(args, "forced_login_method=api");
    assert_no_config_arg(args, "model_provider=wecode-openai");
    assert_config_arg(
        args,
        "model_providers.openai.http_headers.wecode-project=\"42\"",
    );
    assert_eq!(messages[0]["env"]["HTTP_PROXY"], "socks5://127.0.0.1:7890");
    assert_eq!(messages[0]["env"]["HTTPS_PROXY"], "socks5://127.0.0.1:7890");
    assert_eq!(messages[0]["env"]["NO_PROXY"], "localhost,.internal");
    assert_eq!(messages[0]["env"]["no_proxy"], "localhost,.internal");
    assert_eq!(messages[3]["params"]["modelProvider"], "openai");
}

#[tokio::test]
async fn codex_app_server_receives_normalized_developer_path() {
    let _lock = env_lock().await;
    let _path = EnvGuard::set("PATH", "/usr/bin:/bin");
    let _extra_paths = EnvGuard::set("WEGENT_EXTRA_PATHS", "/custom/bin:/opt/homebrew/bin");
    let log_path = std::env::temp_dir().join(format!(
        "wegent-executor-codex-path-rpc-{}.jsonl",
        std::process::id()
    ));
    let fake_codex = write_fake_codex_logging_start(&log_path, &["PATH"]);
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("check path"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert!(matches!(outcome, ExecutionOutcome::Completed { .. }));
    let messages = read_json_lines(&log_path);
    let args = messages[0]["args"].as_array().unwrap();
    assert_config_arg(
        args,
        "shell_environment_policy.set.PATH=\"/usr/bin:/bin:/custom/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/Library/Apple/usr/bin\"",
    );
    let path = messages[0]["env"]["PATH"].as_str().unwrap();
    assert!(path.starts_with("/usr/bin:/bin:/custom/bin:/opt/homebrew/bin"));
    assert_eq!(path.matches("/opt/homebrew/bin").count(), 1);
    assert!(path.contains("/opt/homebrew/sbin"));
    assert!(path.contains("/usr/local/bin"));
}

#[tokio::test]
async fn codex_app_server_engine_does_not_override_user_runtime_home() {
    let _lock = env_lock().await;
    let home = unique_dir("codex-user-home");
    let codex_home = unique_dir("codex-home");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    let log_path = std::env::temp_dir().join(format!(
        "wegent-executor-codex-user-home-rpc-{}.jsonl",
        std::process::id()
    ));
    let fake_codex = write_fake_codex_logging_start(&log_path, &["CODEX_HOME", "HOME"]);
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("list skills"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "runtime_config": {
                "codex": {
                    "use_user_config": true,
                    "configured": true
                }
            },
            "model_provider": "openai"
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
    let messages = read_json_lines(&log_path);
    assert_eq!(
        messages[0]["env"]["CODEX_HOME"],
        codex_home.display().to_string()
    );
    assert_eq!(messages[0]["env"]["HOME"], home.display().to_string());
}

#[tokio::test]
async fn codex_app_server_engine_injects_global_mcp_config_overrides() {
    let _lock = env_lock().await;
    let executor_home = unique_dir("codex-mcp-home");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let manifest_path = executor_home.join("capabilities/manifest.json");
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(
        &manifest_path,
        serde_json::to_string(&json!({
            "version": 1,
            "revision": 1,
            "skills": {},
            "plugins": {},
            "mcps": {
                "docs": {
                    "server": {
                        "type": "streamable-http",
                        "url": "https://mcp.example.com/docs",
                        "base_url": "https://ignored.example.com/docs",
                        "bearer_token_env_var": "DOCS_TOKEN"
                    }
                },
                "shell": {
                    "server": {
                        "type": "stdio",
                        "command": "uvx",
                        "args": ["tool", "--flag"],
                        "env": {"FOO": "bar"}
                    }
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let log_path = std::env::temp_dir().join(format!(
        "wegent-executor-codex-mcp-rpc-{}.jsonl",
        std::process::id()
    ));
    let fake_codex = write_fake_codex_logging_start(&log_path, &[]);
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("implement feature"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses"
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );

    let messages = read_json_lines(&log_path);
    let args = messages[0]["args"].as_array().unwrap();
    assert_config_arg(
        args,
        "mcp_servers.docs.url=\"https://mcp.example.com/docs\"",
    );
    assert_config_arg(args, "mcp_servers.docs.bearer_token_env_var=\"DOCS_TOKEN\"");
    assert_config_arg(args, "mcp_servers.shell.command=\"uvx\"");
    assert_config_arg(args, "mcp_servers.shell.args=[\"tool\",\"--flag\"]");
    assert_config_arg(args, "mcp_servers.shell.env.FOO=\"bar\"");
}

#[tokio::test]
async fn codex_app_server_engine_injects_request_mcp_config_overrides() {
    let _lock = env_lock().await;
    let executor_home = unique_dir("codex-request-mcp-home");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let log_path = std::env::temp_dir().join(format!(
        "wegent-executor-codex-request-mcp-rpc-{}.jsonl",
        std::process::id()
    ));
    let fake_codex = write_fake_codex_logging_start(&log_path, &[]);
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("implement feature"),
        bot: json!([{
            "shell_type": "Codex",
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
            "url": "https://mcp.example.com/request-docs",
            "bearer_token_env_var": "REQUEST_DOCS_TOKEN"
        })],
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5.5",
            "base_url": "http://127.0.0.1:3456/v1",
            "api_key": "wecode-proxy-placeholder",
            "api_format": "responses"
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );

    let messages = read_json_lines(&log_path);
    let args = messages[0]["args"].as_array().unwrap();
    assert_config_arg(
        args,
        "mcp_servers.request-docs.url=\"https://mcp.example.com/request-docs\"",
    );
    assert_config_arg(
        args,
        "mcp_servers.request-docs.bearer_token_env_var=\"REQUEST_DOCS_TOKEN\"",
    );
    assert_config_arg(args, "mcp_servers.bot-shell.command=\"uvx\"");
    assert_config_arg(args, "mcp_servers.bot-shell.args=[\"bot-tool\"]");
    assert_config_arg(args, "mcp_servers.bot-shell.env.BOT_ENV=\"1\"");
}

#[tokio::test]
async fn codex_app_server_engine_times_out_unresponsive_rpc() {
    let _lock = env_lock().await;
    let _timeout = EnvGuard::set("WEGENT_CODEX_RPC_TIMEOUT_SECONDS", "1");
    let fake_codex = write_fake_codex_hang();
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("implement feature"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message: "codex app-server initialize timed out after 1s".to_owned()
        }
    );
}

#[tokio::test]
async fn codex_app_server_engine_does_not_timeout_running_turn() {
    let _lock = env_lock().await;
    let _timeout = EnvGuard::set("WEGENT_CODEX_RPC_TIMEOUT_SECONDS", "3");
    let fake_codex = write_fake_codex_slow_turn();
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("implement feature"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );
}

#[tokio::test]
async fn codex_app_server_engine_reports_nested_turn_error_details() {
    let _lock = env_lock().await;
    let fake_codex = write_fake_codex_nested_turn_error();
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let request = ExecutionRequest {
        prompt: json!("implement feature"),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Failed {
            message:
                "Reconnecting... 2/5: stream disconnected before completion: tls handshake eof"
                    .to_owned()
        }
    );
}

async fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().await
}

fn write_fake_codex(log_path: &Path) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "fake-codex-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    let _ = fs::remove_file(log_path);
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
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn write_fake_codex_logging_start(log_path: &Path, env_keys: &[&str]) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "fake-codex-log-start-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    let _ = fs::remove_file(log_path);
    let env_log_commands = env_keys
        .iter()
        .enumerate()
        .map(|(index, key)| {
            let comma = if index == 0 {
                String::new()
            } else {
                "printf ',' >> \"$LOG_PATH\"\n".to_owned()
            };
            format!(
                r#"{comma}value=$(printenv '{key}')
escaped=$(printf '%s' "$value" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf '"{key}":"%s"' "$escaped" >> "$LOG_PATH""#
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
printf '{{"args":[' >> "$LOG_PATH"
first=1
for arg in "$@"; do
  if [ "$first" = 0 ]; then
    printf ',' >> "$LOG_PATH"
  fi
  first=0
  escaped=$(printf '%s' "$arg" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '"%s"' "$escaped" >> "$LOG_PATH"
done
printf '],"env":{{' >> "$LOG_PATH"
{}
printf '}}}}\n' >> "$LOG_PATH"
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
        log_path.display(),
        env_log_commands
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

fn write_fake_codex_hang() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "fake-codex-hang-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    fs::write(
        &path,
        r#"#!/bin/sh
while IFS= read -r _line; do
  sleep 30
done
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn write_fake_codex_slow_turn() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "fake-codex-slow-turn-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    fs::write(
        &path,
        r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"id":1,"result":{"protocolVersion":1}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}'
      sleep 4
      printf '%s\n' '{"method":"item/agentMessage/delta","params":{"delta":"done","phase":"finalAnswer"}}'
      printf '%s\n' '{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}}'
      exit 0
      ;;
  esac
done
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn write_fake_codex_nested_turn_error() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "fake-codex-nested-turn-error-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    fs::write(
        &path,
        r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"id":1,"result":{"protocolVersion":1}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-1","status":"inProgress"}}}'
      printf '%s\n' '{"method":"error","params":{"error":{"additionalDetails":"stream disconnected before completion: tls handshake eof","message":"Reconnecting... 2/5"},"threadId":"thread-1","turnId":"turn-1","willRetry":true}}'
      exit 0
      ;;
  esac
done
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn read_json_lines(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>()
}

fn assert_config_arg(args: &[Value], expected: &str) {
    assert!(
        args.windows(2)
            .any(|window| window[0] == "-c" && window[1] == expected),
        "missing -c {expected}; args={args:?}"
    );
}

fn assert_no_config_arg(args: &[Value], unexpected: &str) {
    assert!(
        !args
            .windows(2)
            .any(|window| window[0] == "-c" && window[1] == unexpected),
        "unexpected -c {unexpected}; args={args:?}"
    );
}

fn with_project_id(mut request: ExecutionRequest, project_id: Value) -> ExecutionRequest {
    request.extra.insert("project_id".to_owned(), project_id);
    request
}

fn unique_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "wegent-executor-{name}-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
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
