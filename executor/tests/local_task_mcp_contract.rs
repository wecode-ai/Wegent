// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    io::Write,
    process::{Command, Stdio},
};

use axum::{
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use serde_json::Value;

#[test]
fn task_mcp_runs_over_stdio_without_listening_on_a_port() {
    let executor_home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("task-mcp-server")
        .env("WEGENT_EXECUTOR_HOME", executor_home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{{}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"create_project","arguments":{{"name":"GitHub board","project_key":"GH","task_provider":"github","provider_config":{{"repository":"acme/repo","token":"mcp-secret"}}}}}}}}"#
    )
    .unwrap();
    drop(stdin);

    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();

    assert_eq!(
        responses[0].pointer("/result/serverInfo/name"),
        Some(&Value::String("wegent_tasks".to_owned()))
    );
    let tools = responses[1]
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .unwrap();
    assert!(tools.iter().any(|tool| tool["name"] == "list_projects"));
    assert!(tools.iter().any(|tool| tool["name"] == "update_project"));
    assert!(tools.iter().any(|tool| tool["name"] == "create_todo"));
    assert!(tools.iter().any(|tool| tool["name"] == "update_todo"));
    assert!(tools.iter().any(|tool| tool["name"] == "add_todo_comment"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "list_todo_attachments"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "upload_todo_attachment"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "download_todo_attachment"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "delete_todo_attachment"));
    assert!(executor_home.path().join("data/tasks.sqlite").is_file());
    let project = responses[2]
        .pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or_else(|| panic!("unexpected create_todo response: {}", responses[1]));
    assert_eq!(
        project["metadata"]["provider_config"]["credential_configured"],
        true
    );
    assert!(!responses[2].to_string().contains("mcp-secret"));

    let connection =
        rusqlite::Connection::open(executor_home.path().join("data/tasks.sqlite")).unwrap();
    let metadata: String = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE resource_type = 'project'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!metadata.contains("mcp-secret"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn task_mcp_routes_cloud_project_crud_through_backend() {
    fn assert_auth(headers: &HeaderMap) {
        assert_eq!(
            headers.get("authorization").unwrap(),
            "Bearer backend-token"
        );
    }

    async fn list_projects(headers: HeaderMap) -> Json<Value> {
        assert_auth(&headers);
        Json(json!({"items": [{"id": 9001, "name": "Cloud GitLab"}]}))
    }

    async fn list_todos(headers: HeaderMap) -> Json<Value> {
        assert_auth(&headers);
        Json(json!({"items": [{"id": "GL-11", "title": "Existing"}]}))
    }

    async fn get_todo(headers: HeaderMap) -> Json<Value> {
        assert_auth(&headers);
        Json(json!({"id": "GL-11", "title": "Existing"}))
    }

    async fn create_todo(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        assert_auth(&headers);
        assert_eq!(body["title"], "Created through MCP");
        Json(json!({"id": "GL-12", "title": body["title"]}))
    }

    async fn update_todo(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        assert_auth(&headers);
        assert_eq!(body["title"], "Updated through MCP");
        Json(json!({"id": "GL-11", "title": body["title"]}))
    }

    async fn add_comment(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        assert_auth(&headers);
        assert_eq!(body["body"], "MCP comment");
        Json(json!({"id": "comment-1", "body": body["body"]}))
    }

    async fn reorder_todos(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        assert_auth(&headers);
        assert_eq!(body["status"], "in_progress");
        Json(json!({"items": [{"id": "GL-11", "status": "in_progress"}]}))
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/api/v1/cloud-projects", get(list_projects))
                .route(
                    "/api/v1/cloud-projects/9001/loop-items",
                    get(list_todos).post(create_todo),
                )
                .route(
                    "/api/v1/cloud-projects/9001/loop-items/reorder",
                    post(reorder_todos),
                )
                .route("/api/v1/loop-items/GL-11", get(get_todo).patch(update_todo))
                .route("/api/v1/loop-items/GL-11/comments", post(add_comment)),
        )
        .await
        .unwrap();
    });
    let executor_home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("task-mcp-server")
        .env("WEGENT_EXECUTOR_HOME", executor_home.path())
        .env("WEGENT_TASK_PROJECT_ID", "9001")
        .env("WEGENT_TASK_BACKEND_URL", format!("http://{address}"))
        .env("WEGENT_TASK_AUTH_TOKEN", "backend-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"list_projects","arguments":{{}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"list_todos","arguments":{{"project_id":"9001"}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"get_todo","arguments":{{"project_id":"9001","task_id":"GL-11"}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"create_todo","arguments":{{"project_id":"9001","todo":{{"title":"Created through MCP"}}}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{{"name":"update_todo","arguments":{{"project_id":"9001","task_id":"GL-11","todo":{{"version":1,"title":"Updated through MCP"}}}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{{"name":"add_todo_comment","arguments":{{"project_id":"9001","task_id":"GL-11","body":"MCP comment"}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":"reorder_todos","arguments":{{"project_id":"9001","reorder":{{"parent_id":null,"status":"in_progress","item_ids":["GL-11"]}}}}}}}}"#
    )
    .unwrap();
    drop(stdin);

    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let projects = responses[0]
        .pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap();
    assert_eq!(projects[0]["id"], 9001);
    let decoded = responses
        .iter()
        .map(|response| {
            serde_json::from_str::<Value>(
                response
                    .pointer("/result/content/0/text")
                    .and_then(Value::as_str)
                    .unwrap(),
            )
            .unwrap()
        })
        .collect::<Vec<_>>();
    assert_eq!(decoded[1][0]["id"], "GL-11");
    assert_eq!(decoded[2]["id"], "GL-11");
    assert_eq!(decoded[3]["id"], "GL-12");
    assert_eq!(decoded[4]["title"], "Updated through MCP");
    assert_eq!(decoded[5]["body"], "MCP comment");
    assert_eq!(decoded[6]["items"][0]["status"], "in_progress");
    server.abort();
}
