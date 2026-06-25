// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use serde_json::{json, Value};
use wegent_executor::{
    agents::CodexAppServerEngine,
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

#[tokio::test]
async fn codex_app_server_engine_drives_thread_and_turn_over_json_rpc() {
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
        messages[3]["params"]["sandboxPolicy"]["type"],
        "dangerFullAccess"
    );
}

#[tokio::test]
async fn codex_app_server_engine_times_out_unresponsive_rpc() {
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

fn write_fake_codex(log_path: &Path) -> PathBuf {
    let path = std::env::temp_dir().join(format!("fake-codex-{}", std::process::id()));
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

fn write_fake_codex_hang() -> PathBuf {
    let path = std::env::temp_dir().join(format!("fake-codex-hang-{}", std::process::id()));
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
