// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn connection_mcp_thread_creation_protects_the_response_to_activity_handoff() {
    let fixture = Fixture::with_script(
        r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"thread/start"'*)
      printf '{"id":%s,"result":{"thread":{"id":"background"}}}\n' "$id" ;;
    *) printf '{"id":%s,"result":{}}\n' "$id" ;;
  esac
done
"#,
    );
    let client = &fixture.client;
    let gate = client.thread_lifecycle_gate("background").await;
    let admission = gate.lock().await;
    let worker = client.clone();
    let started = tokio::spawn(async move {
        worker
            .request_connection_mcp("thread/start", json!({"ephemeral":true}))
            .await
    });
    timeout(Duration::from_secs(5), async {
        while Arc::strong_count(&gate) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("Thread creation must reach the activity handoff after its native response");
    let restart = client.restart_if_idle().await;
    drop(admission);
    started.await.unwrap().unwrap();
    client
        .request_connection_mcp("thread/unsubscribe", json!({"threadId":"background"}))
        .await
        .unwrap();
    let idle_restart = client.restart_if_idle().await;
    assert_eq!(
        restart,
        Err((1, 0)),
        "The handoff must retain process ownership"
    );
    assert_eq!(
        idle_restart,
        Ok(()),
        "Cleanup must release process ownership"
    );
}
