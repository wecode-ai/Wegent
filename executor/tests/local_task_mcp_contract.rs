// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    io::Write,
    process::{Command, Stdio},
};

use axum::{http::HeaderMap, routing::post, Json, Router};
use serde_json::json;
use serde_json::Value;
use wegent_executor::task_runtime::{
    LocalTaskStore, ProjectDescriptor, ProjectStoreKind, TaskProviderKind, TaskRuntime,
};

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
async fn task_mcp_routes_cached_cloud_gitlab_projects_to_gitlab() {
    async fn create_issue(headers: HeaderMap, Json(body): Json<Value>) -> Json<Value> {
        assert_eq!(headers.get("private-token").unwrap(), "gitlab-secret");
        assert_eq!(body["title"], "Created through MCP");
        Json(json!({
            "iid": 11,
            "title": "Created through MCP",
            "description": "",
            "state": "opened",
            "web_url": "https://gitlab.example/acme/repo/-/issues/11",
            "author": {"username": "tester"},
            "labels": ["wegent:status:inbox"],
            "user_notes_count": 0,
            "created_at": "2026-07-27T08:00:00Z",
            "updated_at": "2026-07-27T08:00:00Z",
            "closed_at": null
        }))
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/projects/12/issues", post(create_issue)),
        )
        .await
        .unwrap();
    });
    let executor_home = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(executor_home.path().join("data/tasks.sqlite")).unwrap();
    TaskRuntime::new(store.clone())
        .unwrap()
        .configure_external_project(ProjectDescriptor {
            id: "9001".to_owned(),
            public_id: Some("cloud-gitlab".to_owned()),
            project_key: "GLABC".to_owned(),
            name: "Cloud GitLab".to_owned(),
            description: String::new(),
            project_store: ProjectStoreKind::Backend,
            task_provider: TaskProviderKind::Gitlab,
            provider_config: json!({
                "repository": "12",
                "domain": "127.0.0.1",
                "api_base": format!("http://{address}"),
                "token": "gitlab-secret"
            }),
            version: 1,
        })
        .unwrap();

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
        r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"list_projects","arguments":{{}}}}}}"#
    )
    .unwrap();
    writeln!(
        stdin,
        r#"{{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{{"name":"create_todo","arguments":{{"project_id":"9001","todo":{{"title":"Created through MCP"}}}}}}}}"#
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
    assert_eq!(projects[0]["id"], "9001");
    assert_eq!(projects[0]["metadata"]["project_store"], "backend");
    assert_eq!(projects[0]["metadata"]["task_provider"], "gitlab");
    let create_response = responses[1]
        .pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .unwrap();
    assert_eq!(
        responses[1].pointer("/result/isError"),
        Some(&Value::Bool(true))
    );
    assert!(create_response.contains("provider api_base must use HTTPS"));

    let task_count: i64 =
        rusqlite::Connection::open(executor_home.path().join("data/tasks.sqlite"))
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM loop_items WHERE resource_type = 'task'",
                [],
                |row| row.get(0),
            )
            .unwrap();
    assert_eq!(task_count, 0);
    server.abort();
}
