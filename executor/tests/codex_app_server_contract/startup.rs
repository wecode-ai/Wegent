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
            let script = root.path().join("codex");
            fs::write(&script, SERVER).unwrap();
            let mut permissions = fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(&script, permissions).unwrap();
            let client = CodexAppServerClient::new(script.display().to_string());
            let request = ExecutionRequest {
                prompt: json!(if delayed_response {
                    "delay-response"
                } else {
                    "delay-progress"
                }),
                bot: json!([{"shell_type": "ClaudeCode"}]),
                ..ExecutionRequest::default()
            };
            let turns = async {
                tokio::join!(
                    client.run_turn_with_cancel(
                        request.clone(),
                        CodexAppServerTurnOptions::default()
                    ),
                    client.run_turn_with_cancel(request, CodexAppServerTurnOptions::default())
                )
            };
            tokio::pin!(turns);
            // Both turns remain pending beyond the one-second startup watchdog.
            assert!(
                tokio::time::timeout(Duration::from_millis(1500), &mut turns)
                    .await
                    .is_err()
            );
            assert_eq!(
                client.request("test/release", json!({})).await.unwrap()["turnCount"],
                2
            );
            let (first, second) = tokio::time::timeout(Duration::from_secs(5), turns)
                .await
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

const SERVER: &str = r#"#!/bin/sh
thread_count=0
turn_count=0
delayed_id=
while IFS= read -r line; do
  request_id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"id":%s,"result":{}}\n' "$request_id"
      ;;
    *'"method":"thread/start"'*)
      thread_count=$((thread_count + 1))
      printf '{"id":%s,"result":{"thread":{"id":"thread-%s"}}}\n' "$request_id" "$thread_count"
      ;;
    *'"method":"turn/start"'*)
      turn_count=$((turn_count + 1))
      thread_id=$(printf '%s' "$line" | sed -n 's/.*"threadId":"\([^"]*\)".*/\1/p')
      if [ "$turn_count" -eq 2 ] && printf '%s' "$line" | grep -q delay-response; then
        delayed_id=$request_id
        delayed_thread=$thread_id
      else
        printf '{"id":%s,"result":{"turn":{"id":"turn-%s","status":"inProgress"}}}\n' "$request_id" "$thread_id"
      fi
      ;;
    *'"method":"test/release"'*)
      if [ -n "$delayed_id" ]; then
        printf '{"id":%s,"result":{"turn":{"id":"turn-%s","status":"inProgress"}}}\n' "$delayed_id" "$delayed_thread"
      fi
      for active in 1 2; do
        printf '{"method":"item/completed","params":{"threadId":"thread-%s","turnId":"turn-thread-%s","item":{"id":"answer","type":"agentMessage","text":"late answer"}}}\n' "$active" "$active"
        printf '{"method":"turn/completed","params":{"threadId":"thread-%s","turn":{"id":"turn-thread-%s","status":"completed"}}}\n' "$active" "$active"
      done
      printf '{"id":%s,"result":{"turnCount":%s}}\n' "$request_id" "$turn_count"
      ;;
    *'"method":"test/count"'*)
      printf '{"id":%s,"result":{"turnCount":%s}}\n' "$request_id" "$turn_count"
      ;;
  esac
done
"#;
