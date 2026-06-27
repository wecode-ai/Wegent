// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use rusqlite::Connection;
use serde_json::json;
use wegent_executor::{local::app_ipc::RuntimeWorkHandler, runtime_work::RuntimeWorkRpcHandler};

#[tokio::test]
#[ignore]
async fn manual_runtime_transcript_perf_for_long_local_rollout() {
    let rollout_path = std::env::var("WEGENT_MANUAL_ROLLOUT")
        .expect("set WEGENT_MANUAL_ROLLOUT to a local Codex rollout jsonl path");
    let mut rollout_path = PathBuf::from(rollout_path);
    if std::env::var("WEGENT_MANUAL_APPEND").ok().as_deref() == Some("1") {
        let copied = temp_path("manual-runtime-perf-rollout-copy", "jsonl");
        fs::copy(&rollout_path, &copied).expect("rollout copy should succeed");
        rollout_path = copied;
    }
    let state_db_path = temp_path("manual-runtime-perf-state", "sqlite");
    write_state_db_thread(&state_db_path, &rollout_path);
    let _state_db = EnvGuard::set(
        "WEGENT_CODEX_STATE_DB",
        &state_db_path.display().to_string(),
    );
    let fake_codex = write_fake_codex(&rollout_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let list_started = Instant::now();
    let list = handler
        .handle_runtime_rpc(json!({"method": "runtime.tasks.list", "payload": {}}))
        .await
        .expect("list should succeed");
    let list_elapsed = list_started.elapsed();
    let warm_list_started = Instant::now();
    let warm_list = handler
        .handle_runtime_rpc(json!({"method": "runtime.tasks.list", "payload": {}}))
        .await
        .expect("warm list should succeed");
    let warm_list_elapsed = warm_list_started.elapsed();

    let address = json!({
        "localTaskId": "thread-long",
        "workspacePath": "/tmp/project",
    });
    let cold_started = Instant::now();
    let cold = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "address": address,
                "localTaskId": "thread-long",
                "limit": 50,
                "refresh": true,
            }
        }))
        .await
        .expect("cold transcript should succeed");
    let cold_elapsed = cold_started.elapsed();

    let warm_started = Instant::now();
    let warm = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "address": address,
                "localTaskId": "thread-long",
                "limit": 50,
                "refresh": true,
            }
        }))
        .await
        .expect("warm transcript should succeed");
    let warm_elapsed = warm_started.elapsed();
    let append_elapsed = if std::env::var("WEGENT_MANUAL_APPEND").ok().as_deref() == Some("1") {
        append_rollout_message(&rollout_path);
        let append_started = Instant::now();
        handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.transcript",
                "payload": {
                    "address": address,
                    "localTaskId": "thread-long",
                    "limit": 50,
                    "refresh": true,
                }
            }))
            .await
            .expect("incremental transcript should succeed");
        Some(append_started.elapsed())
    } else {
        None
    };

    let cold_messages = cold["messages"]
        .as_array()
        .map(Vec::len)
        .unwrap_or_default();
    let warm_messages = warm["messages"]
        .as_array()
        .map(Vec::len)
        .unwrap_or_default();
    eprintln!(
        "manual_runtime_perf list_ms={} warm_list_ms={} cold_ms={} warm_ms={} append_ms={} list_workspaces={} cold_messages={} warm_messages={}",
        list_elapsed.as_millis(),
        warm_list_elapsed.as_millis(),
        cold_elapsed.as_millis(),
        warm_elapsed.as_millis(),
        append_elapsed
            .map(|elapsed| elapsed.as_millis().to_string())
            .unwrap_or_else(|| "n/a".to_owned()),
        warm_list["workspaces"]
            .as_array()
            .map(Vec::len)
            .unwrap_or_else(|| list["workspaces"].as_array().map(Vec::len).unwrap_or_default()),
        cold_messages,
        warm_messages,
    );
}

fn write_fake_codex(rollout_path: &Path) -> PathBuf {
    let path = temp_path("manual-runtime-perf-fake-codex", "sh");
    let rollout = rollout_path.display();
    let content = format!(
        r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":2,"result":{{"data":[{{"id":"thread-long","cwd":"/tmp/project","name":"Long transcript","preview":"long","path":"{}","createdAt":1780000000,"updatedAt":1780000060,"status":{{"type":"notLoaded"}},"turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-long","cwd":"/tmp/project","name":"Long transcript","preview":"long","path":"{}","createdAt":1780000000,"updatedAt":1780000060,"status":{{"type":"notLoaded"}},"turns":[]}}}}}}'
      exit 0
      ;;
  esac
done
"#,
        rollout, rollout
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

fn append_rollout_message(path: &Path) {
    use std::io::Write;

    let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(
        file,
        "{}",
        json!({
            "timestamp": "2026-06-27T20:00:00.000Z",
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "incremental marker"}],
            },
        })
    )
    .unwrap();
}

fn write_state_db_thread(db_path: &Path, rollout_path: &Path) {
    let connection = Connection::open(db_path).unwrap();
    connection
        .execute_batch(
            r#"
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                source TEXT NOT NULL,
                model_provider TEXT NOT NULL,
                cwd TEXT NOT NULL,
                title TEXT NOT NULL,
                sandbox_policy TEXT NOT NULL DEFAULT '',
                approval_mode TEXT NOT NULL DEFAULT '',
                tokens_used INTEGER NOT NULL DEFAULT 0,
                has_user_event INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                archived_at INTEGER,
                git_sha TEXT,
                git_branch TEXT,
                git_origin_url TEXT,
                cli_version TEXT NOT NULL DEFAULT '',
                first_user_message TEXT NOT NULL DEFAULT '',
                agent_nickname TEXT,
                agent_role TEXT,
                memory_mode TEXT NOT NULL DEFAULT 'enabled',
                model TEXT,
                reasoning_effort TEXT,
                agent_path TEXT,
                created_at_ms INTEGER,
                updated_at_ms INTEGER,
                thread_source TEXT,
                preview TEXT NOT NULL DEFAULT ''
            );
            "#,
        )
        .unwrap();
    connection
        .execute(
            r#"
            INSERT INTO threads (
                id, rollout_path, created_at, updated_at, source, model_provider,
                cwd, title, archived, cli_version, created_at_ms, updated_at_ms, preview
            )
            VALUES (
                'thread-long', ?1, 1780000000, 1780000060, 'vscode', 'openai',
                '/tmp/project', 'Long transcript', 0, 'test', 1780000000000, 1780000060000, 'long'
            )
            "#,
            (rollout_path.display().to_string(),),
        )
        .unwrap();
}

fn temp_path(prefix: &str, extension: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{nanos}.{extension}",
        std::process::id(),
    ))
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
