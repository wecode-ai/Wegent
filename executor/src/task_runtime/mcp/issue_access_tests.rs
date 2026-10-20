// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::{LocalTaskStore, TaskCreate, TaskProviderKind};

fn personal_issue_grant(project_id: &str, item_id: &str) -> SpaceContextGrant {
    SpaceContextGrant {
        version: 1,
        task_id: "personal-task".to_owned(),
        space_id: Some(project_id.to_owned()),
        item_id: Some(item_id.to_owned()),
        device_id: Some("device-1".to_owned()),
        expires_at_unix: Local::now().timestamp() + 60,
        ..SpaceContextGrant::default()
    }
}

fn result_value(result: Value) -> Value {
    assert_eq!(result["isError"], false, "{result}");
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn personal_issue_task_operates_on_another_local_issue_without_rebinding() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(ProjectCreate {
            name: "Issue access".to_owned(),
            project_key: Some("ACCESS".to_owned()),
            description: String::new(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    let mut items = Vec::new();
    for title in ["Source Issue", "Target Issue"] {
        items.push(
            runtime
                .create_task(
                    &project.id,
                    TaskCreate {
                        title: title.to_owned(),
                        description: String::new(),
                        status: "inbox".to_owned(),
                        priority: "none".to_owned(),
                        parent_id: None,
                        tags: Vec::new(),
                        assignee_user_id: None,
                        assignee_agent_id: None,
                        assignee_group_id: None,
                        workflow: None,
                    },
                )
                .await
                .unwrap(),
        );
    }
    let source = &items[0];
    let target = &items[1];
    let context = SpaceMcpRequestContext::new(
        Some(personal_issue_grant(&project.id, &source.id)),
        None,
        None,
    );

    let read = result_value(
        call_tool_with_runtime_context(
            &runtime,
            "get_board_item",
            json!({"space_id": project.id, "item_id": target.id}),
            &context,
        )
        .await,
    );
    assert_eq!(read["id"], target.id);
    let updated = result_value(
        call_tool_with_runtime_context(
            &runtime,
            "update_board_item",
            json!({
                "item_id": target.id,
                "item": {"version": read["version"], "title": "Updated target"}
            }),
            &context,
        )
        .await,
    );
    assert_eq!(updated["id"], target.id);
    assert_eq!(updated["title"], "Updated target");
    let current = result_value(
        call_tool_with_runtime_context(&runtime, "get_current_context", json!({}), &context).await,
    );
    assert_eq!(current["item_id"], source.id);
    assert_eq!(current["item"]["title"], "Source Issue");
    assert_eq!(current["item"]["version"], source.version);

    let denied = call_tool_with_runtime_context(
        &runtime,
        "get_board_item",
        json!({"space_id": "other-project", "item_id": target.id}),
        &context,
    )
    .await;
    assert_eq!(denied["isError"], true);
    assert!(denied["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("project space is outside"));
}

#[tokio::test]
async fn personal_issue_task_routes_cloud_issue_targets_and_preserves_permission_errors() {
    use axum::{
        extract::{Json, Path as AxumPath},
        http::{HeaderMap, StatusCode},
        routing::{get, post},
        Router,
    };

    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route(
            "/api/v1/loop-items/{item_id}",
            get(
                |headers: HeaderMap, AxumPath(item_id): AxumPath<String>| async move {
                    assert_eq!(headers.get("authorization").unwrap(), "Bearer unit-token");
                    if item_id == "PRIVATE-3" {
                        return (
                            StatusCode::FORBIDDEN,
                            Json(json!({"detail": "Issue access denied"})),
                        );
                    }
                    (StatusCode::OK, Json(json!({"id": item_id, "version": 1})))
                },
            )
            .patch(
                |headers: HeaderMap,
                 AxumPath(item_id): AxumPath<String>,
                 Json(body): Json<Value>| async move {
                    assert_eq!(headers.get("authorization").unwrap(), "Bearer unit-token");
                    assert_eq!(body, json!({"version": 1, "title": "Updated target"}));
                    Json(json!({"id": item_id, "title": body["title"], "version": 2}))
                },
            ),
        )
        .route(
            "/api/v1/cloud-projects/12/loop-items/{item_id}/activity-comments",
            post(
                |headers: HeaderMap,
                 AxumPath(item_id): AxumPath<String>,
                 Json(body): Json<Value>| async move {
                    assert_eq!(headers.get("authorization").unwrap(), "Bearer unit-token");
                    assert_eq!(item_id, "ISSUE-2");
                    assert_eq!(body, json!({"body": "Related work completed"}));
                    Json(json!({"id": "comment-1", "body": body["body"]}))
                },
            ),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let context = SpaceMcpRequestContext::new(
        Some(personal_issue_grant("12", "ISSUE-1")),
        Some(url),
        Some("unit-token".to_owned()),
    );

    let read = result_value(
        call_tool_with_runtime_context(
            &runtime,
            "get_board_item",
            json!({"space_id": "12", "item_id": "ISSUE-2"}),
            &context,
        )
        .await,
    );
    assert_eq!(read["id"], "ISSUE-2");
    let updated = result_value(
        call_tool_with_runtime_context(
            &runtime,
            "update_board_item",
            json!({"item_id": "ISSUE-2", "item": {"version": read["version"], "title": "Updated target"}}),
            &context,
        )
        .await,
    );
    assert_eq!(updated["id"], "ISSUE-2");
    assert_eq!(updated["title"], "Updated target");
    let comment = result_value(
        call_tool_with_runtime_context(
            &runtime,
            "add_board_item_comment",
            json!({"item_id": "ISSUE-2", "body": "Related work completed"}),
            &context,
        )
        .await,
    );
    assert_eq!(comment["id"], "comment-1");

    let denied = call_tool_with_runtime_context(
        &runtime,
        "get_board_item",
        json!({"item_id": "PRIVATE-3"}),
        &context,
    )
    .await;
    assert_eq!(denied["isError"], true);
    assert!(denied["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("Issue access denied"));
    let current = result_value(
        call_tool_with_runtime_context(&runtime, "get_current_context", json!({}), &context).await,
    );
    assert_eq!(current["item_id"], "ISSUE-1");
    assert_eq!(current["item"]["id"], "ISSUE-1");
    server.abort();
}
