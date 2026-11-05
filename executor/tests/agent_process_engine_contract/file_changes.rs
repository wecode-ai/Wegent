// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use axum::{routing::post, Json, Router};
use serde_json::Value;
use tokio::{sync::mpsc, time::timeout};
use wegent_executor::{callback::CallbackSink, runner::BackgroundTaskRunner, server::TaskRunner};

struct AbortServer(tokio::task::JoinHandle<()>);

impl Drop for AbortServer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[tokio::test]
async fn standard_claude_capture_reaches_final_http_callback_after_bash_commit() {
    let _lock = env_lock().lock().await;
    let _environment = isolated_environment();
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source-repository");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("source.txt"), "before\n").unwrap();
    for args in [
        vec!["init", "--initial-branch=main"],
        vec!["add", "source.txt"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "baseline",
        ],
    ] {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&source)
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    }
    let fake_claude = root.path().join("fake-claude-file-changes");
    fs::write(
        &fake_claude,
        r#"#!/bin/sh
set -eu
cat >/dev/null
test -f source.txt
git checkout -b agent/changes >/dev/null 2>&1
printf 'after\n' > source.txt
git add source.txt
git -c user.name=Test -c user.email=test@example.invalid commit -m change >/dev/null
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"bash-1","name":"Bash","input":{"command":"git commit"}},{"type":"text","text":"changed using Bash"}]}}'
printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"bash-1","content":"committed","is_error":false}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"changed using Bash","is_error":false}'
"#,
    )
    .unwrap();
    #[cfg(unix)]
    fs::set_permissions(&fake_claude, fs::Permissions::from_mode(0o700)).unwrap();
    let (sender, mut receiver) = mpsc::unbounded_channel::<Value>();
    let app = Router::new().route(
        "/callback",
        post(move |Json(value): Json<Value>| {
            let sender = sender.clone();
            async move {
                sender.send(value).unwrap();
                Json(json!({"success": true}))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let callback = format!("http://{}/callback", listener.local_addr().unwrap());
    let (shutdown, stopped) = tokio::sync::oneshot::channel();
    let mut server = AbortServer(tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    }));
    let engine = AgentProcessEngine::new(AgentCommandPlanner::new(
        fake_claude.display().to_string(),
        "codex",
    ));
    let runner = BackgroundTaskRunner::new(engine, CallbackSink::new(callback).unwrap());
    let workspace = root.path().join("prepared-workspace");
    let request = with_backend_identity(ExecutionRequest {
        task_id: "910".into(),
        subtask_id: "9101".into(),
        project_workspace_path: Some(workspace.display().to_string()),
        prompt: json!("modify and commit"),
        bot: json!([{"shell_type":"ClaudeCode"}]),
        model_config: json!({"model":"anthropic", "model_id":"claude-sonnet-4"}),
        extra: serde_json::Map::from_iter([(
            "git_url".into(),
            json!(source.display().to_string()),
        )]),
        ..ExecutionRequest::default()
    });
    runner.submit(request).await;
    let completed = timeout(std::time::Duration::from_secs(20), async {
        loop {
            let event = receiver.recv().await.unwrap();
            assert_ne!(event["event_type"], "error", "{event}");
            if event["event_type"] == "response.completed" {
                break event;
            }
        }
    })
    .await
    .unwrap();

    let changes = &completed["data"]["response"]["file_changes"];
    assert_eq!(changes["file_count"], 1, "{completed}");
    assert_eq!(changes["files"][0]["path"], "source.txt");
    assert_eq!(
        changes["workspace_path"],
        workspace.canonicalize().unwrap().display().to_string()
    );
    assert!(changes["diff"]
        .as_str()
        .unwrap()
        .contains("-before\n+after\n"));
    assert_eq!(changes["diff_truncated"], false);
    assert!(completed["data"]["response"]["workbench"].is_null());
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(&workspace)
        .args(["status", "--porcelain"])
        .output()
        .unwrap()
        .stdout
        .is_empty());
    let _ = shutdown.send(());
    (&mut server.0).await.unwrap();
}
