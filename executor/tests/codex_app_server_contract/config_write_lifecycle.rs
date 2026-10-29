// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

shared_runtime_tests! {
async fn manual_restart_waits_for_plugin_discovery() {
    assert_restart_waits_for_native_response("plugin/list", false).await;
}

async fn proxy_restart_waits_for_plugin_discovery() {
    assert_restart_waits_for_native_response("plugin/list", true).await;
}

async fn manual_restart_preserves_in_flight_marketplace_config_write() {
    assert_restart_waits_for_native_response("marketplace/add", false).await;
}

async fn proxy_restart_preserves_in_flight_marketplace_config_write() {
    assert_restart_waits_for_native_response("marketplace/add", true).await;
}
}

async fn assert_restart_waits_for_native_response(method: &'static str, proxy_restart: bool) {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("codex home'quoted");
    fs::create_dir(&home).unwrap();
    let _home = EnvGuard::set("WEGENT_CODEX_HOME", home.to_str().unwrap());
    let config = home.join("config.toml");
    fs::write(
        &config,
        "model = \"fixture-model\"\nopenai_base_url = \"http://fixture.invalid/v1\"\n",
    )
    .unwrap();
    let received = root.path().join("received");
    let release = root.path().join("release");
    let backup = root.path().join("config-before-operation.toml");
    let fake_codex = write_held_native_operation(root.path(), &received, &release, &backup);
    let client = CodexAppServerClient::new(fake_codex.display().to_string());
    let request_client = client.clone();
    let request = tokio::spawn(async move { request_client.request(method, json!({})).await });
    wait_for_path(
        &received,
        "protected operation should reach the native process",
    )
    .await;
    let expected = fs::read_to_string(&backup).unwrap();
    assert!(expected.contains("model = \"fixture-model\""));
    assert!(expected.contains("openai_base_url = \"http://fixture.invalid/v1\""));
    if method == "marketplace/add" {
        assert_eq!(fs::metadata(&config).unwrap().len(), 0);
    }

    let mut restart = Box::pin(async {
        if proxy_restart {
            assert!(client
                .configure_runtime_proxy_for_restart(Some("http://127.0.0.1:7890"))
                .await
                .expect("runtime proxy should update"));
        } else {
            client.restart().await;
        }
    });
    assert!(
        futures_util::poll!(restart.as_mut()).is_pending(),
        "restart must await the protected native operation"
    );
    assert!(!request.is_finished());
    fs::write(&release, "release").unwrap();
    restart.await;
    assert_eq!(
        request.await.expect("native request task should join"),
        Ok(json!({"completed": true}))
    );
    assert_eq!(fs::read_to_string(&config).unwrap(), expected);
}

fn write_held_native_operation(
    root: &Path,
    received: &Path,
    release: &Path,
    backup: &Path,
) -> PathBuf {
    let path = root.join("fake-codex");
    let script = r#"#!/bin/sh
while IFS= read -r line; do
  request_id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"id":%s,"result":{"protocolVersion":1}}\n' "$request_id"
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"plugin/list"'*|*'"method":"marketplace/add"'*)
      cp "$CODEX_HOME/config.toml" __BACKUP__ || exit 1
      case "$line" in
        *'"method":"marketplace/add"'*) : > "$CODEX_HOME/config.toml" ;;
      esac
      touch __RECEIVED__
      while [ ! -f __RELEASE__ ]; do sleep 0.01; done
      case "$line" in
        *'"method":"marketplace/add"'*) cp __BACKUP__ "$CODEX_HOME/config.toml" || exit 1 ;;
      esac
      printf '{"id":%s,"result":{"completed":true}}\n' "$request_id"
      ;;
  esac
done
"#
    .replace("__BACKUP__", &shell_quote(backup))
    .replace("__RECEIVED__", &shell_quote(received))
    .replace("__RELEASE__", &shell_quote(release));
    fs::write(&path, script).unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).unwrap();
    path
}
