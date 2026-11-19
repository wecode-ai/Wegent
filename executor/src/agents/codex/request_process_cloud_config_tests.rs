// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::thread_resume::CodexRequestAttempt;
use super::*;

#[tokio::test]
async fn late_launch_failure_joins_only_its_process_cloud_config_recovery() {
    let fixture = Fixture::with_script_home(
        r#"#!/bin/sh
root=$(dirname "$0")
if mkdir "$root/first-process" 2>/dev/null; then original=1; else original=0; fi
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"thread/start"'*|*'"method":"config/read"'*)
      printf '%s\n' "$line" >> "$root/operations.jsonl"
      if [ "$original" = 1 ]; then
        printf '{"id":%s,"error":{"code":-32600,"message":"failed to load cloud config bundle"}}\n' "$id"
        continue
      fi
      case "$line" in
        *'"method":"thread/start"'*)
          printf 'created\n' >> "$root/created"
          printf '{"id":%s,"result":{"thread":{"id":"recovered-thread"}}}\n' "$id" ;;
        *) printf '{"id":%s,"result":{"ready":true}}\n' "$id" ;;
      esac ;;
    *) printf '{"id":%s,"result":{}}\n' "$id" ;;
  esac
done
"#,
        true,
    );
    let client = &fixture.client;
    client.state.lock().await.auth_mode = CodexAuthMode::LocalSubscription;
    let launch = CodexLaunchConfig::default();
    let attempt = client
        .request_with_thread_admission_tracked("thread/start", json!({}), Some(&launch))
        .await;
    let generation = attempt.process_generation.unwrap();
    let error = attempt.result.as_ref().unwrap_err().clone();
    assert_eq!(
        client.request("config/read", json!({})).await.unwrap(),
        json!({"ready":true})
    );
    let replacement = client
        .state
        .lock()
        .await
        .process
        .as_ref()
        .unwrap()
        .notifications
        .process_generation;
    assert_ne!(generation, replacement);
    let recovered = client
        .finish_launch_config_attempt("thread/start", json!({}), &launch, None, attempt)
        .await
        .unwrap();
    assert_eq!(recovered["thread"]["id"], "recovered-thread");

    for failed_generation in [None, Some(replacement), Some(replacement + 1000)] {
        let result = client
            .finish_launch_config_attempt(
                "thread/start",
                json!({}),
                &launch,
                None,
                CodexRequestAttempt {
                    result: Err(error.clone()),
                    process_generation: failed_generation,
                },
            )
            .await;
        assert_eq!(result, Err(error.clone()));
    }
    let official = CodexLaunchConfig {
        auth_mode: Some(CodexAuthMode::LocalSubscription),
        ..CodexLaunchConfig::default()
    };
    let result = client
        .finish_launch_config_attempt(
            "thread/start",
            json!({}),
            &official,
            None,
            CodexRequestAttempt {
                result: Err(error.clone()),
                process_generation: Some(generation),
            },
        )
        .await;
    assert_eq!(result, Err(error.clone()));
    let uncertain = "native transport outcome is unknown".to_owned();
    let result = client
        .finish_launch_config_attempt(
            "thread/start",
            json!({}),
            &launch,
            None,
            CodexRequestAttempt {
                result: Err(uncertain.clone()),
                process_generation: Some(generation),
            },
        )
        .await;
    assert_eq!(result, Err(uncertain));

    let named = client
        .for_home(fixture._directory.path().join("named-home"))
        .unwrap();
    {
        let mut state = named.state.lock().await;
        state.auth_mode = CodexAuthMode::WeworkRouter;
        state.cloud_config_degraded_generation = Some(generation);
    }
    let result = named
        .finish_launch_config_attempt(
            "thread/start",
            json!({}),
            &launch,
            None,
            CodexRequestAttempt {
                result: Err(error.clone()),
                process_generation: Some(generation),
            },
        )
        .await;
    assert_eq!(result, Err(error.clone()));
    assert!(named.state.lock().await.process.is_none());

    // An unrelated replacement's restored subscription must remain untouched.
    client.state.lock().await.auth_mode = CodexAuthMode::LocalSubscription;
    let result = client
        .finish_launch_config_attempt(
            "thread/start",
            json!({}),
            &launch,
            None,
            CodexRequestAttempt {
                result: Err(error.clone()),
                process_generation: Some(generation),
            },
        )
        .await;
    assert_eq!(result, Err(error));
    assert_eq!(
        client.state.lock().await.auth_mode,
        CodexAuthMode::LocalSubscription
    );
    let operations =
        fs::read_to_string(fixture._directory.path().join("operations.jsonl")).unwrap();
    assert_eq!(
        operations
            .lines()
            .filter(|line| line.contains("thread/start"))
            .count(),
        2
    );
    assert_eq!(
        fs::read_to_string(fixture._directory.path().join("created")).unwrap(),
        "created\n"
    );
    client.restart().await;
}
