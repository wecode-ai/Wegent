// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::{future::Future, io::Write, pin::Pin, task::Poll, time::Duration};
use wegent_executor::{agents::CodexAppServerClient, services::capability_activation};

#[tokio::test]
async fn model_query_completes_while_activation_waits_for_running_turn() {
    assert_model_query_activation(None).await;
}

#[tokio::test]
async fn pending_model_query_does_not_block_activation() {
    for method in ["config/read", "model/list"] {
        assert_model_query_activation(Some(method)).await;
    }
}

async fn assert_pending<F: Future>(mut future: Pin<&mut F>) {
    std::future::poll_fn(|cx| {
        assert!(
            future.as_mut().poll(cx).is_pending(),
            "activation must wait"
        );
        Poll::Ready(())
    })
    .await;
}

async fn assert_model_query_activation(cancel_at: Option<&str>) {
    let _lock = env_lock().await;
    let root = tempfile::tempdir().unwrap();
    let _environment = [
        ("HOME", "home"),
        ("WEGENT_EXECUTOR_HOME", "executor"),
        ("WEGENT_WORKBENCH_HOME", "workbench"),
        ("WEGENT_CAPABILITIES_HOME", "capabilities"),
        ("WEGENT_CODEX_HOME", "codex"),
        ("CODEX_HOME", "codex"),
        ("CODEX_SQLITE_HOME", "sqlite"),
    ]
    .map(|(key, child)| {
        let path = root.path().join(child);
        fs::create_dir_all(&path).unwrap();
        EnvGuard::set(key, path.to_str().unwrap())
    });
    let log_path = root.path().join("rpc.jsonl");
    let gate_path = root.path().join("release.fifo");
    assert!(std::process::Command::new("mkfifo")
        .arg(&gate_path)
        .status()
        .unwrap()
        .success());
    // Keep both ends open so each explicit newline releases exactly one RPC.
    let mut gate = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&gate_path)
        .unwrap();
    let binary = write_gated_model_codex(root.path(), &log_path, &gate_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", binary.display().to_string());
    handler
        .handle_runtime_rpc(json!({"method": "runtime.codex.ensure_started"}))
        .await
        .unwrap();
    let execution = capability_activation::begin_execution().await;
    let mut activation = Box::pin(capability_activation::activate());
    assert_pending(activation.as_mut()).await;
    let mut query = handler.handle_runtime_rpc(json!({"method": "runtime.codex.models.list"}));
    tokio::select! {
        result = &mut query => panic!("query completed before config release: {result:?}"),
        () = wait_for_codex_call(&log_path, "config/read") => {}
    }
    assert_pending(activation.as_mut()).await;

    if cancel_at != Some("config/read") {
        gate.write_all(b"release\n").unwrap();
        tokio::select! {
            result = &mut query => panic!("query completed before model release: {result:?}"),
            () = wait_for_codex_call(&log_path, "model/list") => {}
        }
        assert_pending(activation.as_mut()).await;
    }
    if cancel_at.is_none() {
        gate.write_all(b"release\n").unwrap();
        let response = tokio::time::timeout(Duration::from_secs(5), query.as_mut())
            .await
            .expect("released query must finish")
            .expect("model query should succeed");
        assert_eq!(response["providers"][0]["available"], true);
        assert_pending(activation.as_mut()).await;
    }
    drop(execution);
    let writer = tokio::time::timeout(Duration::from_secs(5), activation.as_mut())
        .await
        .expect("only the running turn, not model discovery, should block activation");
    drop(writer);
    // Dropping a pending RPC future models caller cancellation, without completing it.
    drop(query);
    CodexAppServerClient::new(binary.display().to_string())
        .restart()
        .await;
    drop(handler);
}

fn write_gated_model_codex(root: &Path, log_path: &Path, gate_path: &Path) -> PathBuf {
    let binary = root.join("fake-codex.sh");
    fs::write(
        &binary,
        format!(
            r#"#!/bin/sh
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{}'
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialized"'*) continue ;;
    *'"method":"config/read"'*)
      IFS= read -r release < '{}'
      result='{{"config":{{"model_provider":"openai"}}}}'
      ;;
    *'"method":"model/list"'*)
      IFS= read -r release < '{}'
      result='{{"data":[],"nextCursor":null}}'
      ;;
    *) result='{{}}' ;;
  esac
  printf '{{"id":%s,"result":%s}}\n' "$request_id" "$result"
done
"#,
            log_path.display(),
            gate_path.display(),
            gate_path.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    binary
}
