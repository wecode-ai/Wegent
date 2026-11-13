// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::time::Duration;
use wegent_executor::agents::{
    run_codex_app_server_turn_with_cancel, CodexAppServerTurn, CodexQuotaRecovery,
    CODEX_APP_SERVER_TURN_CANCELLED,
};

fn fixture(root: &tempfile::TempDir, mode: &str) -> PathBuf {
    let path = root.path().join("codex");
    fs::write(
        &path,
        wegent_executor_test_support::with_codex_bundled_catalog(&SERVER.replace("__MODE__", mode)),
    )
    .unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).unwrap();
    path
}

fn options() -> CodexAppServerTurnOptions {
    CodexAppServerTurnOptions {
        direct_thread_id: Some("thread-1".into()),
        quota_resume: Some(CodexQuotaRecovery {
            thread_id: "thread-1".into(),
            turn_id: "failed-turn".into(),
            goal: Some(json!({
                "threadId":"thread-1", "objective":"Finish", "status":"usageLimited",
                "tokenBudget":2000, "tokensUsed":10, "timeUsedSeconds":2,
                "createdAt":1, "updatedAt":2
            })),
        }),
        ..Default::default()
    }
}

async fn run(
    binary: &Path,
    shared: bool,
    options: CodexAppServerTurnOptions,
) -> Result<CodexAppServerTurn, String> {
    let request = ExecutionRequest {
        bot: json!([{"shell_type":"ClaudeCode"}]),
        prompt: json!(""),
        ..Default::default()
    };
    if shared {
        CodexAppServerClient::new(binary.display().to_string())
            .run_turn_with_cancel(request, options)
            .await
    } else {
        run_codex_app_server_turn_with_cancel(&binary.display().to_string(), request, options).await
    }
}

#[test]
fn quota_goal_read_can_be_cancelled_before_restoration_on_both_execution_paths() {
    shared_test_runtime().block_on(async {
        let _lock = env_lock().await;
        for shared in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let binary = fixture(&root, "stall");
            let (cancel, cancelled) = tokio::sync::oneshot::channel();
            let mut options = options();
            options.cancellation = Some(cancelled);
            let running_binary = binary.clone();
            let running = tokio::spawn(async move { run(&running_binary, shared, options).await });
            wait_for_fixture_events(&binary, "goal-read", 1).await;
            cancel.send(()).unwrap();
            let result = tokio::time::timeout(Duration::from_secs(2), running)
                .await
                .expect("cancellation must cover the pending Goal RPC")
                .unwrap();
            assert_eq!(result.unwrap_err(), CODEX_APP_SERVER_TURN_CANCELLED);
            let requests = fs::read_to_string(binary.with_extension("requests")).unwrap();
            assert!(!requests.contains("thread/goal/set"));
            assert!(!requests.contains("turn/start"));
        }
    });
}

#[test]
fn quota_goal_read_obeys_the_isolated_rpc_timeout() {
    shared_test_runtime().block_on(async {
        let _lock = env_lock().await;
        let _timeout = EnvGuard::set("WEGENT_CODEX_RPC_TIMEOUT_SECONDS", "1");
        let root = tempfile::tempdir().unwrap();
        let binary = fixture(&root, "stall");
        let error = tokio::time::timeout(Duration::from_secs(3), run(&binary, false, options()))
            .await
            .expect("the pending Goal read must have a bounded RPC timeout")
            .unwrap_err();
        assert!(error.contains("thread/goal/get"), "{error}");
        assert!(error.contains("timed out"), "{error}");
    });
}

#[test]
fn quota_goal_recovery_keeps_reading_until_the_goal_finishes() {
    shared_test_runtime().block_on(async {
        let _lock = env_lock().await;
        for shared in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let binary = fixture(&root, "complete");
            let (started, mut turns) = tokio::sync::mpsc::unbounded_channel();
            let mut options = options();
            options.active_turn_started = Some(Box::new(move |_, turn| {
                started.send(turn).unwrap();
            }));
            let result =
                tokio::time::timeout(Duration::from_secs(5), run(&binary, shared, options))
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(result.goal_status.as_deref(), Some("complete"));
            assert_eq!(
                result.outcome,
                ExecutionOutcome::Completed {
                    content: "goal finished".into()
                }
            );
            assert_eq!(turns.try_recv().unwrap(), "first-turn");
            assert_eq!(turns.try_recv().unwrap(), "second-turn");
            assert!(turns.try_recv().is_err());
            let requests = fs::read_to_string(binary.with_extension("requests")).unwrap();
            let restore: Value = requests
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).unwrap())
                .find(|request| request["method"] == "thread/goal/set")
                .unwrap();
            assert_eq!(
                restore["params"],
                json!({"threadId":"thread-1","status":"active","origin":"automatic"})
            );
            assert!(!requests.contains("turn/start"));
        }
    });
}

const SERVER: &str = r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$0.requests"
  request_id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialized"'*) ;;
    *'"method":"thread/goal/get"'*)
      printf '%s\n' goal-read >> "$0.events"
      if [ '__MODE__' = stall ]; then continue; fi
      printf '{"id":%s,"result":{"goal":{"threadId":"thread-1","objective":"Finish","status":"usageLimited","tokenBudget":2000,"tokensUsed":20,"timeUsedSeconds":3,"createdAt":1,"updatedAt":4}}}\n' "$request_id"
      ;;
    *'"method":"thread/goal/set"'*)
      printf '{"id":%s,"result":{"goal":{"threadId":"thread-1","status":"active"}}}\n' "$request_id"
      for turn in first-turn second-turn; do
        printf '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"%s"}}}\n' "$turn"
        printf '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"%s","itemId":"answer","delta":"goal finished"}}\n' "$turn"
        if [ "$turn" = second-turn ]; then
          printf '%s\n' '{"method":"thread/goal/updated","params":{"threadId":"thread-1","goal":{"status":"complete"}}}'
        fi
        printf '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"%s","status":"completed"}}}\n' "$turn"
      done
      ;;
    *)
      if [ -n "$request_id" ]; then printf '{"id":%s,"result":{}}\n' "$request_id"; fi
      ;;
  esac
done
"#;
