// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::os::unix::fs::PermissionsExt;

#[test]
fn background_account_usage_waits_for_initial_runtime_proxy_configuration() {
    let _lock = crate::test_env::lock();
    let home = tempfile::tempdir().unwrap();
    let _homes: Vec<_> = [
        "WEGENT_EXECUTOR_HOME",
        "WEGENT_CODEX_HOME",
        "CODEX_HOME",
        "WEGENT_WORKBENCH_HOME",
    ]
    .into_iter()
    .map(|key| ScalarEnv::set(key, home.path().to_str().unwrap()))
    .collect();
    let binary = home.path().join("codex-fixture");
    fs::write(&binary, r#"#!/bin/sh
touch "$(dirname "$0")/native-started"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"account/rateLimits/read"'*)
      printf '{"id":%s,"result":{"proxy":"%s","rateLimits":{"primary":{"usedPercent":12}}}}\n' "$id" "$HTTPS_PROXY" ;;
    *) printf '{"id":%s,"result":{}}\n' "$id" ;;
  esac
done
"#).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let (events, _) = broadcast::channel(1);
            let handler = RuntimeWorkRpcHandler::with_event_sender_deferred_startup_recovery(
                "proxy-startup",
                binary.to_str().unwrap(),
                events,
                None,
                None,
            );
            let premature = handler.read_codex_rate_limits().await;
            let native_started = home.path().join("native-started").exists();
            handler.codex_app_server.restart().await;
            assert_eq!(premature.unwrap_err().code, "codex_runtime_not_ready");
            assert!(
                !native_started,
                "Background usage started native cloud requests before proxy setup"
            );
            handler
                .dispatch(
                    "runtime.codex.runtime_config.update",
                    json!({"proxyUrl":"http://127.0.0.1:7890"}),
                )
                .await
                .unwrap();
            let result = handler.read_codex_rate_limits().await;
            handler.codex_app_server.restart().await;
            let result = result.unwrap();
            assert_eq!(result["proxy"], "http://127.0.0.1:7890");
            assert_eq!(result["rateLimits"]["primary"]["usedPercent"], 12);
        });
}
