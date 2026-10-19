// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::super::{call_backend_tool, BackendToolContext};
use super::*;

#[tokio::test]
async fn backend_comment_tools_use_the_visible_issue_activity() {
    use axum::{extract::Query, http::HeaderMap, routing::get, Json, Router};
    use std::collections::HashMap;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/api/v1/cloud-projects/12/loop-items/ISSUE-1/activity-comments",
        get(
            |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| async move {
                assert_eq!(headers.get("authorization").unwrap(), "Bearer unit-token");
                assert_eq!(query["after_sequence"], "31");
                assert_eq!(query["limit"], "2");
                Json(json!([{"id": "visible-comment", "body": "PR link", "sequence_number": 32}]))
            },
        )
        .post(|headers: HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer unit-token");
            assert_eq!(body["body"], "Review report");
            Json(json!({"id": "visible-report", "body": body["body"]}))
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let backend_url = format!("http://{address}");
    let context = BackendToolContext {
        backend_url: &backend_url,
        auth_token: "unit-token",
        project_id: "12",
        grant: None,
        collaboration_dispatcher: None,
    };
    let written = call_backend_tool(
        &context,
        "add_board_item_comment",
        &json!({"item_id": "ISSUE-1", "body": "Review report"}),
    )
    .await
    .unwrap();
    assert_eq!(written["id"], "visible-report");
    let comments = call_backend_tool(
        &context,
        "list_board_item_comments",
        &json!({"item_id": "ISSUE-1", "after_sequence": 31, "limit": 2}),
    )
    .await
    .unwrap();
    assert_eq!(comments[0]["id"], "visible-comment");
    server.abort();
}

#[tokio::test]
async fn local_comment_history_pages_the_same_activity_without_crossing_issues() {
    use crate::task_runtime::{LocalCommentCreate, LocalTaskStore};
    let directory = tempfile::tempdir().unwrap();
    let runtime =
        TaskRuntime::new(LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap())
            .unwrap();
    let project = runtime
        .create_project(
            serde_json::from_value(json!({"name": "Review", "project_key": "REVIEW"})).unwrap(),
        )
        .unwrap();
    let issue = runtime
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title": "PR review"})).unwrap(),
        )
        .await
        .unwrap();
    for body in ["PR link", "Review report"] {
        runtime
            .create_comment(LocalCommentCreate {
                project_id: project.id.clone(),
                task_id: issue.id.clone(),
                client_message_id: None,
                sender_type: "user".to_owned(),
                sender_id: "0".to_owned(),
                sender_name: "Reviewer".to_owned(),
                content: body.to_owned(),
                metadata: json!({}),
                reply_to_message_id: None,
            })
            .unwrap();
    }
    let args = json!({"space_id": project.id, "item_id": issue.id, "limit": 1});
    let latest = list(&runtime, &args).await.unwrap();
    assert_eq!(latest[0]["body"], "Review report");
    let mut after = args.clone();
    after["after_sequence"] = json!(1);
    assert_eq!(list(&runtime, &after).await.unwrap(), latest);
    after["limit"] = json!(-1);
    assert!(list(&runtime, &after).await.is_err());
    let other = runtime
        .create_project(
            serde_json::from_value(json!({"name": "Other", "project_key": "OTHER"})).unwrap(),
        )
        .unwrap();
    after["space_id"] = json!(other.id);
    after["limit"] = json!(1);
    assert!(list(&runtime, &after).await.is_err());
}
