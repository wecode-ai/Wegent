// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::{LocalTaskStore, TaskCreate, TaskProviderKind};

fn executor_context(project: &str, child: &str) -> SpaceMcpRequestContext {
    SpaceMcpRequestContext::new(
        Some(SpaceContextGrant {
            version: 1,
            task_id: "child-runtime".to_owned(),
            space_id: Some(project.to_owned()),
            item_id: Some(child.to_owned()),
            role: Some(SpaceContextRole::Executor),
            categories: HashSet::from([BoardToolCategory::Execution]),
            expires_at_unix: Local::now().timestamp() + 60,
            ..SpaceContextGrant::default()
        }),
        None,
        None,
    )
}

fn value(result: Value) -> Value {
    assert_eq!(result["isError"], false, "{result}");
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

async fn call(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    name: &str,
    arguments: Value,
) -> Value {
    call_tool_with_runtime_context(runtime, name, arguments, context).await
}

#[tokio::test]
async fn direct_parent_reads_preserve_child_binding_and_reject_other_targets_and_writes() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let project = store
        .create_project(ProjectCreate {
            name: "Parent access".to_owned(),
            project_key: Some("PARENT".to_owned()),
            description: String::new(),
            task_provider: TaskProviderKind::Local,
            provider_config: json!({}),
        })
        .unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    let mut issues = Vec::new();
    for title in ["Grandparent", "Parent", "Child", "Sibling"] {
        let parent_id = match title {
            "Parent" => Some(&issues[0]),
            "Child" | "Sibling" => Some(&issues[1]),
            _ => None,
        };
        let input: TaskCreate = serde_json::from_value(json!({
            "title": title, "description": format!("{title} requirements"),
            "parent_id": parent_id,
        }))
        .unwrap();
        issues.push(runtime.create_task(&project.id, input).await.unwrap().id);
    }
    let parent = &issues[1];
    let child = &issues[2];
    runtime
        .add_comment(&project.id, parent, "Parent acceptance criteria")
        .await
        .unwrap();
    let delivery = runtime
        .create_delivery(
            &project.id,
            parent,
            DeliveryCreate {
                title: "Parent result".to_owned(),
                markdown: "Parent handoff".to_owned(),
                chat: None,
                source_task: None,
            },
        )
        .await
        .unwrap();
    let asset = runtime
        .add_delivery_asset(
            &delivery.id,
            "result.txt",
            serde_json::from_value(json!({
                "display_name": "result.txt", "base64": STANDARD.encode(b"parent result"),
            }))
            .unwrap(),
        )
        .unwrap();
    let context = executor_context(&project.id, child);
    let args = json!({"space_id": project.id, "item_id": parent});
    let read = value(call(&runtime, &context, "get_board_item", args.clone()).await);
    assert_eq!(read["description"], "Parent requirements");
    let comments = value(call(&runtime, &context, "list_board_item_comments", args.clone()).await);
    assert!(comments
        .as_array()
        .unwrap()
        .iter()
        .any(|comment| comment["body"] == "Parent acceptance criteria"));
    let deliveries = value(call(&runtime, &context, "list_deliveries", args.clone()).await);
    assert!(deliveries
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == delivery.id));
    let detail = value(
        call(
            &runtime,
            &context,
            "read_delivery",
            json!({
                "item_id": parent, "delivery_id": delivery.id,
            }),
        )
        .await,
    );
    assert_eq!(detail["markdown"], "Parent handoff");
    let downloaded = value(
        call(
            &runtime,
            &context,
            "download_delivery_asset",
            json!({
                "item_id": parent, "delivery_id": delivery.id, "asset_id": asset.id,
            }),
        )
        .await,
    );
    assert_eq!(
        fs::read(downloaded["path"].as_str().unwrap()).unwrap(),
        b"parent result"
    );
    for target in [&issues[0], &issues[3]] {
        let denied = call(
            &runtime,
            &context,
            "get_board_item",
            json!({"item_id": target}),
        )
        .await;
        assert_eq!(denied["isError"], true, "{denied}");
    }
    for name in [
        "add_board_item_comment",
        "update_board_item",
        "create_delivery",
        "finalize_delivery",
        "discard_delivery_draft",
        "upload_delivery_asset",
        "get_workflow_stage_context",
        "get_current_context",
    ] {
        let denied = call(&runtime, &context, name, args.clone()).await;
        assert_eq!(denied["isError"], true, "{name}: {denied}");
    }
    let foreign = call(
        &runtime,
        &context,
        "get_board_item",
        json!({"space_id": "other-project", "item_id": parent}),
    )
    .await;
    assert_eq!(foreign["isError"], true);
    let current = value(call(&runtime, &context, "get_current_context", json!({})).await);
    assert_eq!(current["item_id"], child.as_str());
    let wrong_delivery = call(
        &runtime,
        &context,
        "read_delivery",
        json!({
            "item_id": child, "delivery_id": delivery.id,
        }),
    )
    .await;
    assert_eq!(wrong_delivery["isError"], true);
    let wrong_asset = call(
        &runtime,
        &context,
        "download_delivery_asset",
        json!({
            "item_id": parent, "delivery_id": delivery.id, "asset_id": "unrelated-asset",
        }),
    )
    .await;
    assert_eq!(wrong_asset["isError"], true);
    let item = runtime.get_task(&project.id, child).await.unwrap();
    runtime
        .update_task(
            &project.id,
            child,
            TaskUpdate {
                version: item.version,
                parent_id: Some(None),
                ..TaskUpdate::default()
            },
        )
        .await
        .unwrap();
    let stale = call(&runtime, &context, "get_board_item", args).await;
    assert_eq!(stale["isError"], true, "{stale}");
}

#[tokio::test]
async fn cloud_parent_reads_recheck_visibility_relationship_and_project() {
    use axum::{
        extract::{Path as AxumPath, State},
        http::{HeaderMap, StatusCode},
        routing::get,
        Json, Router,
    };
    use std::sync::atomic::AtomicUsize;

    // Protocol doubles model Backend responses; authorization failures must survive the bridge.
    let state = Arc::new((AtomicUsize::new(0), AtomicUsize::new(0)));
    let app = Router::new().route("/api/v1/loop-items/{id}", get(
        |State(state): State<Arc<(AtomicUsize, AtomicUsize)>>, headers: HeaderMap, AxumPath(id): AxumPath<String>| async move {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer protocol-test-token");
            let mode = state.0.load(Ordering::SeqCst);
            if id == "child" {
                if mode == 4 {
                    return (StatusCode::FORBIDDEN, Json(json!({"detail": "Child access revoked"})));
                }
                let parent = if mode == 2 { "new-parent" } else { "parent" };
                return (StatusCode::OK, Json(json!({"id": id, "cloud_project_id": 12, "parent_id": parent})));
            }
            state.1.fetch_add(1, Ordering::SeqCst);
            if mode == 1 {
                return (StatusCode::FORBIDDEN, Json(json!({"detail": "Parent access revoked"})));
            }
            let project = if mode == 3 { 99 } else { 12 };
            (StatusCode::OK, Json(json!({"id": id, "cloud_project_id": project, "description": "Cloud parent requirements"})))
        }
    ))
    .route("/api/v1/cloud-projects/12/loop-items/parent/activity-comments", get(|| async {
        Json(json!([{"body": "Cloud review feedback"}]))
    }))
    .route("/api/v1/loop-items/parent/deliveries", get(|| async {
        Json(json!({"items": [{"id": "delivery"}]}))
    }))
    .route("/api/v1/deliveries/{id}", get(|AxumPath(id): AxumPath<String>| async move {
        Json(json!({"id": id, "loop_item_id": if id == "delivery" { "parent" } else { "sibling" }, "markdown": "Cloud handoff", "assets": [{"id": "asset"}]}))
    }))
    .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let runtime =
        TaskRuntime::new(LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap())
            .unwrap();
    let mut context = executor_context("12", "child");
    context.backend_url = Some(url);
    context.auth_token = Some("protocol-test-token".to_owned());
    let args = json!({"item_id": "parent"});
    let parent = value(call(&runtime, &context, "get_board_item", args.clone()).await);
    assert_eq!(parent["description"], "Cloud parent requirements");
    let comments = value(call(&runtime, &context, "list_board_item_comments", args.clone()).await);
    assert_eq!(comments[0]["body"], "Cloud review feedback");
    let deliveries = value(call(&runtime, &context, "list_deliveries", args.clone()).await);
    assert_eq!(deliveries[0]["id"], "delivery");
    let detail = value(
        call(
            &runtime,
            &context,
            "read_delivery",
            json!({"item_id": "parent", "delivery_id": "delivery"}),
        )
        .await,
    );
    assert_eq!(detail["markdown"], "Cloud handoff");
    let wrong_delivery = call(
        &runtime,
        &context,
        "read_delivery",
        json!({"item_id": "parent", "delivery_id": "other-delivery"}),
    )
    .await;
    assert_eq!(wrong_delivery["isError"], true);
    let wrong_asset = call(
        &runtime,
        &context,
        "download_delivery_asset",
        json!({"item_id": "parent", "delivery_id": "delivery", "asset_id": "foreign-asset"}),
    )
    .await;
    assert_eq!(wrong_asset["isError"], true);
    state.0.store(1, Ordering::SeqCst);
    for name in [
        "get_board_item",
        "list_board_item_comments",
        "list_deliveries",
        "read_delivery",
        "download_delivery_asset",
    ] {
        let denied = call(&runtime, &context, name, args.clone()).await;
        assert_eq!(denied["isError"], true, "{name}: {denied}");
        assert!(denied["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Parent access revoked"));
    }
    state.0.store(2, Ordering::SeqCst);
    let reads = state.1.load(Ordering::SeqCst);
    let stale = call(&runtime, &context, "get_board_item", args.clone()).await;
    assert_eq!(stale["isError"], true);
    assert_eq!(state.1.load(Ordering::SeqCst), reads);
    state.0.store(3, Ordering::SeqCst);
    let cross_project = call(&runtime, &context, "get_board_item", args.clone()).await;
    assert_eq!(cross_project["isError"], true);
    state.0.store(4, Ordering::SeqCst);
    let reads = state.1.load(Ordering::SeqCst);
    let revoked_child = call(&runtime, &context, "get_board_item", args).await;
    assert_eq!(revoked_child["isError"], true);
    assert_eq!(state.1.load(Ordering::SeqCst), reads);
    server.abort();
}
