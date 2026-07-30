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
fn space_mcp_runs_over_stdio_without_listening_on_a_port() {
    let executor_home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("space-mcp-server")
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
        r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"create_space","arguments":{{"name":"Feedback space","project_key":"FB"}}}}}}"#
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
        Some(&Value::String("wework_space".to_owned()))
    );
    let tools = responses[1]
        .pointer("/result/tools")
        .and_then(Value::as_array)
        .unwrap();
    assert!(tools.iter().any(|tool| tool["name"] == "list_spaces"));
    assert!(tools.iter().any(|tool| tool["name"] == "update_space"));
    assert!(tools.iter().any(|tool| tool["name"] == "create_board_item"));
    assert!(tools.iter().any(|tool| tool["name"] == "update_board_item"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "add_board_item_comment"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "list_item_attachments"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "upload_item_attachment"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "read_item_attachment"));
    assert!(tools
        .iter()
        .any(|tool| tool["name"] == "delete_item_attachment"));
    assert!(executor_home.path().join("data/tasks.sqlite").is_file());
    let project = responses[2]
        .pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap_or_else(|| panic!("unexpected create_space response: {}", responses[2]));
    assert_eq!(project["metadata"]["task_provider"], "local");

    let connection =
        rusqlite::Connection::open(executor_home.path().join("data/tasks.sqlite")).unwrap();
    let metadata: String = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE resource_type = 'project'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(metadata.contains("\"task_provider\":\"local\""));
}

#[test]
fn list_spaces_remains_available_locally_without_backend_connection() {
    let executor_home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("space-mcp-server")
        .env("WEGENT_EXECUTOR_HOME", executor_home.path())
        .env("WEWORK_SPACE_ID", "841738010351776815")
        .env_remove("WEWORK_SPACE_BACKEND_URL")
        .env_remove("WEWORK_SPACE_AUTH_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"list_spaces","arguments":{{}}}}}}"#
    )
    .unwrap();

    let output = child.wait_with_output().unwrap();
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    let text = response["result"]["content"][0]["text"].as_str().unwrap();

    assert_eq!(response["result"]["isError"], false);
    assert_eq!(serde_json::from_str::<Value>(text).unwrap(), json!([]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_spaces_merges_cloud_and_local_projects_for_the_signed_in_user() {
    async fn list_spaces(headers: HeaderMap) -> Json<Value> {
        assert_eq!(
            headers.get("authorization").unwrap(),
            "Bearer backend-token"
        );
        Json(json!({"items": [{"id": 9001, "name": "Cloud project"}]}))
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/api/v1/cloud-projects", get(list_spaces)),
        )
        .await
        .unwrap();
    });
    let executor_home = tempfile::tempdir().unwrap();

    let mut local_child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("space-mcp-server")
        .env("WEGENT_EXECUTOR_HOME", executor_home.path())
        .env_remove("WEWORK_SPACE_BACKEND_URL")
        .env_remove("WEWORK_SPACE_AUTH_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        local_child.stdin.take().unwrap(),
        r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"create_space","arguments":{{"name":"Local project"}}}}}}"#
    )
    .unwrap();
    assert!(local_child.wait().unwrap().success());

    let mut child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("space-mcp-server")
        .env("WEGENT_EXECUTOR_HOME", executor_home.path())
        .env("WEWORK_SPACE_BACKEND_URL", format!("http://{address}"))
        .env("WEWORK_SPACE_AUTH_TOKEN", "backend-token")
        .env_remove("WEWORK_SPACE_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    writeln!(
        child.stdin.take().unwrap(),
        r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"list_spaces","arguments":{{}}}}}}"#
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    let projects: Value =
        serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap();

    assert_eq!(response["result"]["isError"], false);
    assert_eq!(projects.as_array().unwrap().len(), 2);
    assert!(projects
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == 9001));
    assert!(projects
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["name"] == "Local project"));
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn space_mcp_routes_board_operations_through_backend() {
    fn assert_auth(headers: &HeaderMap) {
        assert_eq!(
            headers.get("authorization").unwrap(),
            "Bearer backend-token"
        );
    }

    async fn list_spaces(headers: HeaderMap) -> Json<Value> {
        assert_auth(&headers);
        Json(json!({"items": [{"id": 9001, "name": "Cloud GitLab"}]}))
    }

    async fn list_board_items(headers: HeaderMap) -> Json<Value> {
        assert_auth(&headers);
        Json(json!({"items": [{"id": "GL-11", "title": "Existing"}]}))
    }

    async fn get_board_item(headers: HeaderMap) -> Json<Value> {
        assert_auth(&headers);
        Json(json!({"id": "GL-11", "title": "Existing"}))
    }

    async fn create_board_item(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        assert_auth(&headers);
        assert_eq!(body["title"], "Created through MCP");
        Json(json!({"id": "GL-12", "title": body["title"]}))
    }

    async fn update_board_item(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        assert_auth(&headers);
        assert_eq!(body["title"], "Updated through MCP");
        Json(json!({"id": "GL-11", "title": body["title"]}))
    }

    async fn add_comment(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        assert_auth(&headers);
        assert_eq!(body["body"], "MCP comment");
        Json(json!({"id": "comment-1", "body": body["body"]}))
    }

    async fn list_attachments(headers: HeaderMap) -> Json<Value> {
        assert_auth(&headers);
        Json(json!([{
            "id": "attachment-1",
            "display_name": "feedback.zip",
            "size_bytes": 10
        }]))
    }

    async fn read_attachment(headers: HeaderMap) -> Vec<u8> {
        assert_auth(&headers);
        b"diagnostic".to_vec()
    }

    async fn reorder_board_items(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
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
                .route("/api/v1/cloud-projects", get(list_spaces))
                .route(
                    "/api/v1/cloud-projects/9001/loop-items",
                    get(list_board_items).post(create_board_item),
                )
                .route(
                    "/api/v1/cloud-projects/9002/loop-items",
                    get(list_board_items),
                )
                .route(
                    "/api/v1/cloud-projects/9001/loop-items/reorder",
                    post(reorder_board_items),
                )
                .route(
                    "/api/v1/loop-items/GL-11",
                    get(get_board_item).patch(update_board_item),
                )
                .route("/api/v1/loop-items/GL-11/comments", post(add_comment))
                .route(
                    "/api/v1/loop-items/GL-11/attachments",
                    get(list_attachments),
                )
                .route(
                    "/api/v1/loop-item-attachments/attachment-1/content",
                    get(read_attachment),
                ),
        )
        .await
        .unwrap();
    });
    let executor_home = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .arg("space-mcp-server")
        .env("WEGENT_EXECUTOR_HOME", executor_home.path())
        .env("WEWORK_SPACE_ID", "9001")
        .env("WEWORK_SPACE_BACKEND_URL", format!("http://{address}"))
        .env("WEWORK_SPACE_AUTH_TOKEN", "backend-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"list_spaces","arguments":{{}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        "{}",
        json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": {
                "name": "list_item_attachments",
                "arguments": {"space_id": "9001", "item_id": "GL-11"}
            }
        })
    )
    .unwrap();
    let attachment_path = executor_home.path().join("feedback.zip");
    writeln!(
        stdin,
        "{}",
        json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {
                "name": "read_item_attachment",
                "arguments": {
                    "space_id": "9001",
                    "item_id": "GL-11",
                    "attachment_id": "attachment-1",
                    "output_path": attachment_path
                }
            }
        })
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"list_board_items","arguments":{{"space_id":"9001"}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{{"name":"get_board_item","arguments":{{"space_id":"9001","item_id":"GL-11"}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{{"name":"create_board_item","arguments":{{"space_id":"9001","item":{{"title":"Created through MCP"}}}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{{"name":"update_board_item","arguments":{{"space_id":"9001","item_id":"GL-11","item":{{"version":1,"title":"Updated through MCP"}}}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{{"name":"add_board_item_comment","arguments":{{"space_id":"9001","item_id":"GL-11","body":"MCP comment"}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{{"name":"reorder_board_items","arguments":{{"space_id":"9001","reorder":{{"parent_id":null,"status":"in_progress","item_ids":["GL-11"]}}}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{{"name":"list_board_items","arguments":{{"space_id":"9002"}}}}}}"#
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
    assert_eq!(responses[1].pointer("/result/isError"), Some(&json!(false)));
    assert_eq!(responses[2].pointer("/result/isError"), Some(&json!(false)));
    assert_eq!(responses[9].pointer("/result/isError"), Some(&json!(false)));
    assert_eq!(std::fs::read(attachment_path).unwrap(), b"diagnostic");
    let projects = responses[0]
        .pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .unwrap();
    assert_eq!(projects[0]["id"], 9001);
    let decoded = responses
        .iter()
        .take(9)
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
    assert_eq!(decoded[1][0]["id"], "attachment-1");
    assert_eq!(decoded[3][0]["id"], "GL-11");
    assert_eq!(decoded[4]["id"], "GL-11");
    assert_eq!(decoded[5]["id"], "GL-12");
    assert_eq!(decoded[6]["title"], "Updated through MCP");
    assert_eq!(decoded[7]["body"], "MCP comment");
    assert_eq!(decoded[8]["items"][0]["status"], "in_progress");
    server.abort();
}
