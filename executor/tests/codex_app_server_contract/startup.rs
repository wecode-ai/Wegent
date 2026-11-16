// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::time::Duration;

#[test]
fn shared_startup_timeout_preserves_live_turns_and_late_responses() {
    shared_test_runtime().block_on(async {
        let _lock = env_lock().await;
        let _timeout = EnvGuard::set("WEGENT_CODEX_TURN_STARTUP_TIMEOUT_SECONDS", "1");
        for delayed_response in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let client = client(&root);
            let request = ExecutionRequest {
                prompt: json!(if delayed_response {
                    "delay-response"
                } else {
                    "delay-progress"
                }),
                bot: json!([{"shell_type": "ClaudeCode"}]),
                ..ExecutionRequest::default()
            };
            let running_client = client.clone();
            let mut turns = tokio::task::JoinSet::new();
            turns.spawn(async move {
                tokio::join!(
                    running_client.run_turn_with_cancel(
                        request.clone(),
                        CodexAppServerTurnOptions::default()
                    ),
                    running_client
                        .run_turn_with_cancel(request, CodexAppServerTurnOptions::default())
                )
            });
            wait_for_fixture_events(&root.path().join("codex"), "ready", 2).await;
            // Both turns remain pending beyond the one-second startup watchdog.
            assert!(
                tokio::time::timeout(Duration::from_millis(1500), turns.join_next())
                    .await
                    .is_err()
            );
            assert_eq!(
                client.request("test/release", json!({})).await.unwrap()["turnCount"],
                2
            );
            let (first, second) = tokio::time::timeout(Duration::from_secs(5), turns.join_next())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            for result in [first, second] {
                assert_eq!(
                    result
                        .expect("a live shared turn must keep its listener")
                        .outcome,
                    ExecutionOutcome::Completed {
                        content: "late answer".into()
                    }
                );
            }
            assert_eq!(
                client.request("test/count", json!({})).await.unwrap()["turnCount"],
                2,
                "startup recovery must not submit a duplicate turn"
            );
        }
    });
}

fn client(root: &tempfile::TempDir) -> CodexAppServerClient {
    let script = root.path().join("codex");
    fs::write(
        &script,
        wegent_executor_test_support::with_codex_bundled_catalog(SERVER),
    )
    .unwrap();
    let mut permissions = fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&script, permissions).unwrap();
    CodexAppServerClient::new(script.display().to_string())
}

#[test]
fn shared_startup_timeout_can_cancel_without_a_turn_id() {
    shared_test_runtime().block_on(async {
        let _lock = env_lock().await;
        let _timeout = EnvGuard::set("WEGENT_CODEX_TURN_STARTUP_TIMEOUT_SECONDS", "1");
        for goal_startup in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let client = client(&root);
            let request = ExecutionRequest {
                prompt: json!("delay-target"),
                bot: json!([{"shell_type": "ClaudeCode"}]),
                ..ExecutionRequest::default()
            };
            let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
            let other_request = ExecutionRequest {
                prompt: json!("live-other-turn"),
                ..request.clone()
            };
            let options = CodexAppServerTurnOptions {
                cancellation: Some(cancel_rx),
                initial_thread_goal: goal_startup
                    .then(|| json!({"objective": "Goal startup", "status": "active"})),
                ..CodexAppServerTurnOptions::default()
            };
            let running_client = client.clone();
            let mut turns = tokio::task::JoinSet::new();
            turns.spawn(async move {
                tokio::join!(
                    running_client
                        .run_turn_with_cancel(other_request, CodexAppServerTurnOptions::default()),
                    running_client.run_turn_with_cancel(request, options)
                )
            });
            wait_for_fixture_events(&root.path().join("codex"), "ready", 2).await;
            assert!(
                tokio::time::timeout(Duration::from_millis(1500), turns.join_next())
                    .await
                    .is_err()
            );
            cancel_tx.send(()).unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(100), turns.join_next())
                    .await
                    .is_err()
            );
            wait_for_fixture_events(&root.path().join("codex"), "interrupted", 1).await;
            assert_eq!(
                client
                    .request("test/interrupt-count", json!({}))
                    .await
                    .unwrap(),
                json!({"count": 1, "emptyCount": 1})
            );
            client.request("test/release", json!({})).await.unwrap();
            let (other, cancelled) =
                tokio::time::timeout(Duration::from_secs(5), turns.join_next())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap();
            assert!(other.is_ok());
            assert_eq!(
                cancelled.unwrap_err(),
                wegent_executor::agents::CODEX_APP_SERVER_TURN_CANCELLED
            );
        }
    });
}

#[test]
fn shared_startup_timeout_retries_recovery_after_other_turn_finishes() {
    shared_test_runtime().block_on(async {
        let _lock = env_lock().await;
        let _timeout = EnvGuard::set("WEGENT_CODEX_TURN_STARTUP_TIMEOUT_SECONDS", "1");
        for delayed_response in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let client = client(&root);
            let request = ExecutionRequest {
                prompt: json!(if delayed_response { "delay-target" } else { "delay-progress" }),
                bot: json!([{"shell_type": "ClaudeCode"}]),
                ..ExecutionRequest::default()
            };
            let other_request = ExecutionRequest { prompt: json!("other-turn"), ..request.clone() };
            let running_client = client.clone();
            let mut turns = tokio::task::JoinSet::new();
            turns.spawn(async move {
                tokio::join!(
                    running_client.run_turn_with_cancel(other_request, CodexAppServerTurnOptions::default()),
                    running_client.run_turn_with_cancel(request, CodexAppServerTurnOptions::default())
                )
            });
            let fixture_binary = root.path().join("codex");
            tokio::select! {
                _ = wait_for_fixture_events(&fixture_binary, "ready", 2) => {}
                settled = turns.join_next() => panic!("startup turns ended before fixture readiness: {settled:?}"),
            }
            assert!(tokio::time::timeout(Duration::from_millis(1500), turns.join_next()).await.is_err());
            client.request("test/finish-first", json!({})).await.unwrap();
            let (first, stalled) = tokio::time::timeout(Duration::from_secs(5), turns.join_next()).await.unwrap().unwrap().unwrap();
            assert!(first.is_ok());
            assert_eq!(stalled.unwrap_err(), "codex app-server turn made no model or tool progress for 1s; the shared app-server was restarted");
        }
    });
}

const SERVER: &str = r#"#!/bin/sh
printf '%s\n' boot >> "$0.events"
thread_count=0
turn_count=0
delayed_id=
interrupt_count=0
empty_interrupt_count=0
other_index=1
complete_thread() {
  printf '{"method":"item/completed","params":{"threadId":"thread-%s","turnId":"turn-thread-%s","item":{"id":"answer","type":"agentMessage","text":"late answer"}}}\n' "$1" "$1"
  printf '{"method":"turn/completed","params":{"threadId":"thread-%s","turn":{"id":"turn-thread-%s","status":"completed"}}}\n' "$1" "$1"
}
while IFS= read -r line; do
  request_id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' initialized >> "$0.events"
      printf '{"id":%s,"result":{}}\n' "$request_id"
      ;;
    *'"method":"thread/start"'*)
      thread_count=$((thread_count + 1))
      printf '{"id":%s,"result":{"thread":{"id":"thread-%s"}}}\n' "$request_id" "$thread_count"
      ;;
    *'"method":"turn/start"'*)
      turn_count=$((turn_count + 1))
      printf '%s\n' ready >> "$0.events"
      thread_id=$(printf '%s' "$line" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
      if printf '%s' "$line" | grep -q other-turn; then
        other_index=${thread_id#thread-}
      fi
      if printf '%s' "$line" | grep -q delay-target || { [ "$turn_count" -eq 2 ] && printf '%s' "$line" | grep -q delay-response; }; then
        delayed_id=$request_id
        delayed_thread=$thread_id
      else
        printf '{"id":%s,"result":{"turn":{"id":"turn-%s","status":"inProgress"}}}\n' "$request_id" "$thread_id"
      fi
      if printf '%s' "$line" | grep -q live-other-turn; then
        # Keep the other turn live after cancellation removes the stalled target.
        printf '{"method":"item/started","params":{"threadId":"%s","turnId":"turn-%s","item":{"id":"answer","type":"agentMessage"}}}\n' "$thread_id" "$thread_id"
      fi
      ;;
    *'"method":"thread/settings/update"'*)
      printf '{"id":%s,"result":{}}\n' "$request_id"
      ;;
    *'"method":"thread/goal/set"'*)
      printf '%s\n' ready >> "$0.events"
      printf '{"id":%s,"result":{"goal":{"status":"active"}}}\n' "$request_id"
      ;;
    *'"method":"turn/interrupt"'*)
      interrupt_count=$((interrupt_count + 1))
      printf '%s\n' interrupted >> "$0.events"
      if printf '%s' "$line" | grep -q '"turnId":""'; then
        empty_interrupt_count=$((empty_interrupt_count + 1))
      fi
      thread_id=$(printf '%s' "$line" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
      printf '{"id":%s,"result":{}}\n' "$request_id"
      printf '{"method":"turn/completed","params":{"threadId":"%s","turn":{"id":"turn-%s","status":"interrupted"}}}\n' "$thread_id" "$thread_id"
      ;;
    *'"method":"test/interrupt-count"'*)
      printf '{"id":%s,"result":{"count":%s,"emptyCount":%s}}\n' "$request_id" "$interrupt_count" "$empty_interrupt_count"
      ;;
    *'"method":"test/finish-first"'*)
      complete_thread "$other_index"
      printf '{"id":%s,"result":{}}\n' "$request_id"
      ;;
    *'"method":"test/release"'*)
      if [ -n "$delayed_id" ]; then
        printf '{"id":%s,"result":{"turn":{"id":"turn-%s","status":"inProgress"}}}\n' "$delayed_id" "$delayed_thread"
      fi
      for active in 1 2; do
        complete_thread "$active"
      done
      printf '{"id":%s,"result":{"turnCount":%s}}\n' "$request_id" "$turn_count"
      ;;
    *'"method":"test/count"'*)
      printf '{"id":%s,"result":{"turnCount":%s}}\n' "$request_id" "$turn_count"
      ;;
  esac
done
"#;

#[test]
fn shared_startup_watchdog_preserves_another_thread_preparation() {
    shared_test_runtime().block_on(async {
        let _lock = env_lock().await;
        let _timeout = EnvGuard::set("WEGENT_CODEX_TURN_STARTUP_TIMEOUT_SECONDS", "1");
        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("second-thread-blocked");
        let admitted = root.path().join("first-thread-admitted");
        let release = root.path().join("release-second-thread");
        let script = root.path().join("codex");
        let gate = format!(
            "thread_count=$((thread_count + 1))\n      if [ \"$thread_count\" -eq 2 ]; then\n        touch '{}'\n        while [ ! -f '{}' ]; do sleep 0.01; done\n      fi",
            blocked.display(), release.display()
        );
        let progress = "for active in 1 2; do\n        printf '{\"method\":\"item/agentMessage/delta\",\"params\":{\"threadId\":\"thread-%s\",\"turnId\":\"turn-thread-%s\",\"itemId\":\"answer\",\"delta\":\"late answer\"}}\\n' \"$active\" \"$active\"\n      done\n      for active in 1 2; do";
        fs::write(&script, wegent_executor_test_support::with_codex_bundled_catalog(&SERVER.replace("thread_count=$((thread_count + 1))", &gate)
            .replace("for active in 1 2; do", progress))).unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).unwrap();
        let client = CodexAppServerClient::new(script.display().to_string());
        let start = || {
            let client = client.clone();
            let admitted = admitted.clone();
            tokio::spawn(async move {
                client.run_turn_with_cancel(ExecutionRequest {
                    prompt: json!("delay-progress"),
                    bot: json!([{"shell_type":"ClaudeCode"}]),
                    ..ExecutionRequest::default()
                }, CodexAppServerTurnOptions {
                    thread_started: Some(Box::new(move |id| {
                        if id == "thread-1" { fs::write(admitted, "ready").unwrap(); }
                    })),
                    ..CodexAppServerTurnOptions::default()
                }).await
            })
        };
        let first = start();
        let second = start();
        let turns = async { tokio::join!(first, second) };
        tokio::pin!(turns);
        tokio::time::timeout(Duration::from_secs(5), async {
            while !blocked.is_file() || !admitted.is_file() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("Both preparation stages must be established");
        assert!(tokio::time::timeout(Duration::from_millis(1200), &mut turns).await.is_err(),
            "A stalled turn must not kill another thread's pending preparation");
        fs::write(release, "continue").unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while client.request("test/count", json!({})).await.unwrap()["turnCount"] != 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        client.request("test/release", json!({})).await.unwrap();
        let (first, second) = tokio::time::timeout(Duration::from_secs(5), turns).await.unwrap();
        for result in [first, second] {
            assert_eq!(result.unwrap().unwrap().outcome,
                ExecutionOutcome::Completed {content:"late answer".into()});
        }
    });
}
