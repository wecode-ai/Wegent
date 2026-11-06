// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::time::Duration;

#[test]
fn automatic_proxy_updates_preserve_pending_history_and_apply_after_it_finishes() {
    shared_test_runtime().block_on(async {
        let _lock = env_lock().await;
        let _proxy_environment: Vec<_> = [
            "ALL_PROXY",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "all_proxy",
            "http_proxy",
            "https_proxy",
        ]
        .into_iter()
        .map(EnvGuard::remove)
        .collect();
        for proxy_url in [Some("http://127.0.0.1:7891"), None] {
            let root = tempfile::tempdir().unwrap();
            let marker = root.path().join("history-received");
            let client = client(&root, &marker);
            client
                .configure_runtime_proxy(Some("http://127.0.0.1:7890"))
                .await
                .unwrap();
            let original = client.request("test/process", json!({})).await.unwrap();
            let reader = client.clone();
            let history = tokio::spawn(async move {
                reader
                    .request("thread/read", json!({"threadId": "thread-1"}))
                    .await
            });
            wait_for_path(&marker, "history must be pending before updating the proxy").await;

            assert!(client.configure_runtime_proxy(proxy_url).await.unwrap());
            assert_eq!(client.restart_if_idle().await, Err((0, 1)));
            assert!(!client.configure_runtime_proxy(proxy_url).await.unwrap());
            assert_eq!(
                client.request("test/release", json!({})).await.unwrap(),
                json!({"released": true})
            );
            let transcript = tokio::time::timeout(Duration::from_secs(2), history)
                .await
                .expect("the original history request must finish")
                .unwrap()
                .expect("automatic proxy updates must not cancel history");
            assert_eq!(transcript["thread"]["id"], "thread-1");
            assert_eq!(transcript["pid"], original["pid"]);
            assert_eq!(transcript["proxy"], "http://127.0.0.1:7890");
            assert_eq!(transcript["readCount"], 1, "history must not be retried");

            let next = client.request("test/process", json!({})).await.unwrap();
            assert_ne!(next["pid"], original["pid"]);
            assert_eq!(next["proxy"], proxy_url.unwrap_or(""));
            assert_eq!(next["readCount"], 0);
            client.restart().await;
        }
    });
}

fn client(root: &tempfile::TempDir, marker: &Path) -> CodexAppServerClient {
    let script = root.path().join("codex");
    fs::write(
        &script,
        SERVER.replace("__REQUEST_MARKER__", &shell_quote(marker)),
    )
    .unwrap();
    let mut permissions = fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&script, permissions).unwrap();
    CodexAppServerClient::new(script.display().to_string())
}

const SERVER: &str = r#"#!/bin/sh
pending_id=
read_count=0
while IFS= read -r line; do
  request_id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"id":%s,"result":{}}\n' "$request_id"
      ;;
    *'"method":"thread/read"'*)
      pending_id=$request_id
      read_count=$((read_count + 1))
      touch __REQUEST_MARKER__
      ;;
    *'"method":"test/process"'*)
      printf '{"id":%s,"result":{"pid":%s,"proxy":"%s","readCount":%s}}\n' "$request_id" "$$" "$ALL_PROXY" "$read_count"
      ;;
    *'"method":"test/release"'*)
      if [ -n "$pending_id" ]; then
        printf '{"id":%s,"result":{"thread":{"id":"thread-1"},"pid":%s,"proxy":"%s","readCount":%s}}\n' "$pending_id" "$$" "$ALL_PROXY" "$read_count"
        pending_id=
        printf '{"id":%s,"result":{"released":true}}\n' "$request_id"
      else
        printf '{"id":%s,"result":{"released":false}}\n' "$request_id"
      fi
      ;;
  esac
done
"#;
