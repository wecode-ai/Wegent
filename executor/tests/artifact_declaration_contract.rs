// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use axum::{extract::Path, http::HeaderMap, routing::post, Json, Router};
use serde_json::{json, Value};
use std::process::Output;
use tokio::{net::TcpListener, process::Command, sync::mpsc};

async fn declare_artifact(task_token: Option<&str>) -> (Output, Option<Value>) {
    declare_artifact_with_root(task_token, false).await
}

async fn declare_artifact_with_root(
    task_token: Option<&str>,
    local_root: bool,
) -> (Output, Option<Value>) {
    let workspace = tempfile::tempdir().unwrap();
    std::fs::create_dir(workspace.path().join("local-conversation")).unwrap();
    std::fs::write(
        workspace.path().join("local-conversation/report.txt"),
        "device-only bytes",
    )
    .unwrap();
    let (sender, mut receiver) = mpsc::channel(1);
    let app = Router::new().route(
        "/api/tasks/{task_id}/remote-workspace/artifacts",
        post(
            move |Path(task_id): Path<String>, headers: HeaderMap, Json(body): Json<Value>| {
                let sender = sender.clone();
                async move {
                    sender
                        .send(json!({"task_id": task_id, "authorization": headers["authorization"].to_str().unwrap(), "body": body}))
                        .await
                        .unwrap();
                    Json(json!({"id": 12}))
                }
            },
        ),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async { axum::serve(listener, app).await.unwrap() });
    let mut command = Command::new(env!("CARGO_BIN_EXE_wegent-executor"));
    command
        .args(["artifact", "declare", "--path", "report.txt"])
        .env("WORKSPACE_ROOT", workspace.path())
        .env("WEGENT_TASK_ID", "local-conversation")
        .env_remove("WEGENT_TASK_WORKSPACE")
        .env("WEGENT_BACKEND_TASK_ID", "123")
        .env("WEGENT_RUNTIME_BACKEND_URL", format!("http://{address}"))
        .env("WEGENT_RUNTIME_AUTH_TOKEN", "runtime-credential");
    if local_root {
        command
            .env_remove("WORKSPACE_ROOT")
            .env_remove("WEGENT_WORKSPACE_ROOT")
            .env_remove("WEGENT_EXECUTOR_PROJECTS_DIR")
            .env("EXECUTOR_MODE", "local")
            .env("LOCAL_WORKSPACE_ROOT", workspace.path());
    }
    match task_token {
        Some(token) => command.env("AUTH_TOKEN", token),
        None => command.env_remove("AUTH_TOKEN"),
    };
    let output = command.output().await.unwrap();
    let request = receiver.try_recv().ok();
    server.abort();
    (output, request)
}

#[tokio::test]
async fn declaration_resolves_native_workspace_without_a_container_root() {
    let (output, request) = declare_artifact_with_root(Some("task-credential"), true).await;

    assert!(output.status.success(), "{:?}", output.status);
    let request = request.unwrap();
    assert_eq!(request["body"]["relative_path"], "report.txt");
    assert_eq!(request["body"]["file_size"], 17);
}

#[tokio::test]
async fn declaration_uses_backend_identity_and_task_token_with_local_workspace() {
    let (output, request) = declare_artifact(Some("  task-credential  ")).await;

    assert!(output.status.success(), "{:?}", output.status);
    let request = request.unwrap();
    assert_eq!(request["task_id"], "123");
    assert_eq!(request["authorization"], "Bearer task-credential");
    assert_eq!(request["body"]["relative_path"], "report.txt");
    assert_eq!(request["body"]["file_size"], 17);
    assert!(request["body"]["workspace_root"]
        .as_str()
        .is_some_and(|root| root.ends_with("local-conversation")));
    assert!(request["body"].get("content").is_none());
}

#[tokio::test]
async fn declaration_rejects_absent_or_blank_task_token_even_with_runtime_credential() {
    for token in [None, Some("   ")] {
        let (output, request) = declare_artifact(token).await;

        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("AUTH_TOKEN is required"));
        assert!(request.is_none());
    }
}
