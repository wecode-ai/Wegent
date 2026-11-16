// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use axum::{extract::Json, http::HeaderMap, routing::get, Router};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn bound_runtime(backend_url: String) -> (tempfile::TempDir, TaskRuntime, SpaceMcpRequestContext) {
    let directory = tempfile::tempdir().unwrap();
    let store =
        crate::task_runtime::LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    let mut grant = super::super::SpaceContextGrant {
        space_id: Some("12".to_owned()),
        item_id: Some("ISSUE-1".to_owned()),
        role: Some(super::super::SpaceContextRole::Manager),
        ..Default::default()
    };
    grant.categories.extend([
        super::super::BoardToolCategory::Management,
        super::super::BoardToolCategory::Execution,
    ]);
    let context = SpaceMcpRequestContext::new(
        Some(grant),
        Some(backend_url),
        Some("unit-token".to_owned()),
    );
    (directory, runtime, context)
}

#[tokio::test]
async fn catalog_failure_preserves_existing_issue_tools() {
    for (status, body, reason) in [
        (
            axum::http::StatusCode::OK,
            json!({"id": "12"}),
            "unsupported_capability",
        ),
        (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            json!({"detail": "Project service is unavailable."}),
            "connection_unavailable",
        ),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/api/v1/projects/12",
            get(move || {
                let body = body.clone();
                async move { (status, Json(body)) }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let (_directory, runtime, context) = bound_runtime(format!("http://{address}"));
        let response = super::super::handle_request_with_context(
            &runtime,
            &json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
            &context,
        )
        .await
        .unwrap();

        assert!(response.get("error").is_none(), "{response}");
        let tools = response["result"]["tools"].as_array().unwrap();
        for name in [
            "get_current_context",
            "get_board_item",
            "add_board_item_comment",
        ] {
            assert!(tools.iter().any(|tool| tool["name"] == name));
        }
        assert!(tools
            .iter()
            .all(|tool| tool["name"] != "update_project_tags"));
        let discovery = super::super::call_tool_with_runtime_context(
            &runtime,
            "get_project_admin_capabilities",
            json!({}),
            &context,
        )
        .await;
        assert_eq!(discovery["isError"], true);
        assert_eq!(
            discovery["structuredContent"]["error"]["reason_code"],
            reason
        );
        server.abort();
    }
}

#[tokio::test]
async fn catalog_missing_rejects_generic_update_before_patch() {
    let patches = Arc::new(AtomicUsize::new(0));
    let recorded_patches = Arc::clone(&patches);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/api/v1/projects/12", get(|| async { Json(json!({"id": "12"})) }))
        .route("/api/v1/cloud-projects/12", axum::routing::patch(move || {
            let patches = Arc::clone(&recorded_patches);
            async move {
                patches.fetch_add(1, Ordering::SeqCst);
                Json(json!({"id": "12", "project_key": "WORK", "name": "Updated", "description": "", "task_provider": "local", "tags": [], "version": 2}))
            }
        }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (_directory, runtime, context) = bound_runtime(format!("http://{address}"));

    let result = super::super::call_tool_with_runtime_context(
        &runtime,
        "update_space",
        json!({"project": {"version": 1, "name": "Updated"}}),
        &context,
    )
    .await;

    assert_eq!(patches.load(Ordering::SeqCst), 0);
    assert_eq!(result["isError"], true);
    assert_eq!(
        result["structuredContent"]["error"]["reason_code"],
        "unsupported_capability"
    );
    server.abort();
}

#[tokio::test]
async fn catalog_disabled_preserves_existing_generic_update() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/api/v1/projects/12", get(|| async { Json(json!({"project_admin_capabilities": catalog(false)})) }))
        .route("/api/v1/cloud-projects/12", axum::routing::patch(|| async { Json(json!({"id": "12", "project_key": "WORK", "name": "Updated", "description": "", "task_provider": "local", "tags": [], "version": 2, "project_admin_result": {"auditId": "audit-1"}})) }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (_directory, runtime, context) = bound_runtime(format!("http://{address}"));

    let result = super::super::call_tool_with_runtime_context(
        &runtime,
        "update_space",
        json!({"project": {"version": 1, "name": "Updated"}}),
        &context,
    )
    .await;

    assert_eq!(result["isError"], false);
    assert_eq!(
        result["structuredContent"]["project_admin_result"]["auditId"],
        "audit-1"
    );
    server.abort();
}

fn catalog(enabled: bool) -> Value {
    json!({
        "enabled": enabled,
        "updateSpaceInputSchema": {"type": "object"},
        "operations": if enabled { vec![json!({
            "name": "project.tags.replace",
            "toolName": "update_project_tags",
            "description": "Replace project tags.",
            "availability": {"available": true},
            "inputSchema": {
                "$defs": {"Tags": {"type": "array", "items": {"type": "string"}}},
                "properties": {"request": {"$ref": "#/$defs/Tags"}}
            },
            "outputSchema": {"type": "object", "required": ["auditId"]}
        })] } else { vec![] }
    })
}

fn board_input_schema(wrapper: &str) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {"space_id": {"type": "string"}, wrapper: {"$ref": "#/$defs/Request"}},
        "$defs": {
            "Request": {"type": "object", "additionalProperties": false, "properties": {
                "version": {"type": "integer"}, "dry_run": {"type": "boolean"},
                "board_views": {"anyOf": [{"$ref": "#/$defs/BoardViews"}, {"type": "null"}]}
            }},
            "BoardViews": {"type": "object", "additionalProperties": false, "properties": {
                "schema_version": {"type": "integer"}, "default_view_id": {"type": "string"},
                "views": {"type": "array", "items": {"$ref": "#/$defs/BoardView"}}
            }},
            "BoardView": {"type": "object", "additionalProperties": false, "properties": {
                "id": {"type": "string"}, "name": {"type": "string"},
                "columns": {"type": "array", "items": {"$ref": "#/$defs/Column"}},
                "filter": {"anyOf": [{"$ref": "#/$defs/Filter"}, {"type": "null"}]},
                "sorts": {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "string"}}}
            }},
            "Column": {"type": "object", "additionalProperties": false, "properties": {
                "id": {"type": "string"}, "type": {"type": "string"}, "value": {"type": "string"}
            }},
            "Filter": {"type": "object", "additionalProperties": false, "properties": {
                "tags": {"type": "array", "items": {"type": "string"}},
                "match": {"type": "string"}, "needs_my_input": {"type": "boolean"}
            }}
        }
    })
}

fn board_catalog() -> Value {
    json!({
        "enabled": true,
        "updateSpaceInputSchema": board_input_schema("project"),
        "operations": [{
            "toolName": "update_project_board_views",
            "availability": {"available": true},
            "inputSchema": board_input_schema("request")
        }]
    })
}

fn canonical_views() -> Value {
    json!({
        "schema_version": 1, "default_view_id": "review",
        "views": [{
            "id": "review", "name": "Review",
            "columns": [{"id": "tag-review", "type": "tag", "value": "review"}],
            "filter": {"tags": ["review"], "match": "any"},
            "sorts": {"tag-review": ["priority-desc"], "arbitrary-column-id": []}
        }]
    })
}

async fn assert_unknown_nested_fields_rejected(name: &str, wrapper: &str) {
    let patches = Arc::new(AtomicUsize::new(0));
    let recorded_patches = Arc::clone(&patches);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/api/v1/projects/12", get(|| async { Json(json!({"project_admin_capabilities": board_catalog()})) }))
        .route("/api/v1/cloud-projects/12", axum::routing::patch(move || {
            let patches = Arc::clone(&recorded_patches);
            async move {
                patches.fetch_add(1, Ordering::SeqCst);
                Json(json!({"id": "12", "project_key": "WORK", "name": "Review", "description": "", "task_provider": "local", "tags": [], "version": 7, "project_admin_result": {"auditId": "audit-1"}}))
            }
        }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (_directory, runtime, context) = bound_runtime(format!("http://{address}"));

    for (pointer, field) in [
        ("", "board_views.futureField"),
        ("/views/0", "board_views.views.0.futureField"),
        (
            "/views/0/columns/0",
            "board_views.views.0.columns.0.futureField",
        ),
        ("/views/0/filter", "board_views.views.0.filter.futureField"),
    ] {
        let mut views = canonical_views();
        views
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("futureField".to_owned(), json!("private-sentinel"));
        let result = super::super::call_tool_with_runtime_context(
            &runtime,
            name,
            json!({wrapper: {"version": 7, "board_views": views}}),
            &context,
        )
        .await;
        assert_eq!(
            patches.load(Ordering::SeqCst),
            0,
            "{name} forwarded {field}"
        );
        assert_eq!(result["isError"], true);
        assert_eq!(
            result["structuredContent"]["error"]["reason_code"],
            "unsupported_field"
        );
        assert_eq!(
            result["structuredContent"]["error"]["fields"][0]["path"],
            format!("{wrapper}.{field}")
        );
        assert!(!result.to_string().contains("private-sentinel"));
    }
    let allowed = super::super::call_tool_with_runtime_context(
        &runtime,
        name,
        json!({wrapper: {"version": 7, "board_views": canonical_views()}}),
        &context,
    )
    .await;
    assert_eq!(allowed["isError"], false, "{allowed}");
    assert_eq!(patches.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn typed_updates_reject_unknown_nested_fields_before_patch() {
    assert_unknown_nested_fields_rejected("update_project_board_views", "request").await;
}

#[tokio::test]
async fn generic_updates_reject_unknown_nested_fields_before_patch() {
    assert_unknown_nested_fields_rejected("update_space", "project").await;
}

#[test]
fn publishes_the_server_schemas_without_rewriting_nested_references() {
    let catalog = catalog(true);
    let mut tools = discovery_tools();

    extend_tools(&mut tools, &catalog, &SpaceMcpRequestContext::default());

    let tool = tools
        .iter()
        .find(|tool| tool["name"] == "update_project_tags")
        .unwrap();
    assert_eq!(tool["inputSchema"], catalog["operations"][0]["inputSchema"]);
    assert_eq!(
        tool["outputSchema"],
        catalog["operations"][0]["outputSchema"]
    );
}

#[test]
fn does_not_publish_disabled_or_unknown_admin_writes() {
    let mut catalog = catalog(true);
    catalog["operations"][0]["availability"]["available"] = json!(false);
    catalog["operations"].as_array_mut().unwrap().push(json!({
        "toolName": "run_sql",
        "availability": {"available": true}
    }));
    let mut tools = discovery_tools();

    extend_tools(&mut tools, &catalog, &SpaceMcpRequestContext::default());

    assert!(tools
        .iter()
        .all(|tool| is_read_tool(tool["name"].as_str().unwrap())));
}

#[test]
fn executor_scope_does_not_inherit_the_users_management_capabilities() {
    let mut grant = super::super::SpaceContextGrant::default();
    grant
        .categories
        .insert(super::super::BoardToolCategory::Execution);
    let context = BackendToolContext {
        backend_url: "http://unused",
        auth_token: "unit-token",
        project_id: "12",
        grant: Some(&grant),
        collaboration_dispatcher: None,
    };

    let catalog = scoped_catalog(catalog(true), &context);

    assert!(catalog["operations"].as_array().unwrap().is_empty());
    assert_eq!(
        catalog["unavailableCapabilities"][0]["availability"]["reason_code"],
        "permission_denied"
    );
}

#[tokio::test]
async fn category_and_project_scope_denials_have_structured_permission_errors() {
    let directory = tempfile::tempdir().unwrap();
    let store =
        crate::task_runtime::LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    let mut grant = super::super::SpaceContextGrant {
        space_id: Some("space-1".to_owned()),
        role: Some(super::super::SpaceContextRole::Executor),
        ..Default::default()
    };
    grant
        .categories
        .insert(super::super::BoardToolCategory::Execution);
    let context = SpaceMcpRequestContext::new(Some(grant), None, None);

    for (name, arguments) in [
        (
            "update_project_tags",
            json!({"space_id": "space-1", "request": {"version": 1, "tags": []}}),
        ),
        (
            "update_space",
            json!({"space_id": "space-1", "project": {"version": 1, "tags": []}}),
        ),
        ("get_project_config", json!({"space_id": "another-space"})),
    ] {
        let denied =
            super::super::call_tool_with_runtime_context(&runtime, name, arguments, &context).await;

        assert_eq!(denied["isError"], true);
        assert_eq!(
            denied["structuredContent"]["error"]["reason_code"],
            "permission_denied"
        );
        assert_eq!(denied["structuredContent"]["error"]["status_code"], 403);
        assert_eq!(denied["structuredContent"]["error"]["fields"], json!([]));
    }
}

#[test]
fn rejects_fields_from_another_operation_instead_of_forwarding_them() {
    let arguments = json!({"request": {"version": 1, "tags": [], "name": "hidden update"}});
    let error = validate_request("update_project_tags", &arguments).unwrap_err();
    assert!(error.contains("unsupported_field"));
    assert!(error.contains("request.name"));
    assert!(validate_request(
        "update_project_tags",
        &json!({"project": {"version": 1, "tags": []}})
    )
    .unwrap_err()
    .contains("unsupported_field"));
    assert!(validate_request("update_project_tags", &json!({"request": {"version": 1}})).is_err());
    assert!(validate_request(
        "update_project_tags",
        &json!({"request": {"version": 1, "tags": []}})
    )
    .is_ok());
    let automation_error = validate_request(
        "update_project_automation",
        &json!({"request": {"version": 1, "pull_request_automation": {}}}),
    )
    .unwrap_err();
    assert!(automation_error.contains("request.ai_automation"));
    assert!(validate_request(
        "update_project_automation",
        &json!({"request": {"version": 1, "ai_automation": {"auto_retry_on_failure": false, "max_retry_count": 0}}}),
    )
    .is_ok());
    for (name, field) in [
        ("update_project_members", "member_changes"),
        (
            "update_project_assistant_roster",
            "assistant_roster_changes",
        ),
    ] {
        assert!(validate_request(name, &json!({"request": {"version": 1, field: []}})).is_ok());
        let error = validate_request(
            name,
            &json!({"request": {"version": 1, field: [], "provider_config": {}}}),
        )
        .unwrap_err();
        assert!(error.contains("unsupported_field"));
    }
}

#[tokio::test]
async fn space_updates_reject_provider_payloads_before_contacting_the_backend() {
    let context = BackendToolContext {
        backend_url: "http://unused",
        auth_token: "unit-token",
        project_id: "12",
        grant: None,
        collaboration_dispatcher: None,
    };

    let error = call(
        &context,
        "update_space",
        &json!({"project": {"version": 1, "provider_config": {"token": "private-sentinel"}}}),
    )
    .await
    .unwrap_err();

    let error: Value = serde_json::from_str(&error).unwrap();
    assert_eq!(error["error"]["reason_code"], "unsupported_field");
    assert_eq!(
        error["error"]["fields"][0]["path"],
        "project.provider_config"
    );
    assert!(!error.to_string().contains("private-sentinel"));
}

#[tokio::test]
async fn roster_reads_return_only_the_selected_configuration_and_revisions() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route("/api/v1/projects/12", get(|| async {
        Json(json!({
            "provider_config": {"token": "private-sentinel"},
            "project_admin_config": {
                "projectVersion": 3, "revision": 2,
                "configuration": {"members": [{"user_id": 8, "permission_role": "Developer"}], "assistant_roster": [{"agent_id": "assistant-1", "agent_version": 2, "status": "active"}], "tags": ["review"]}
            }
        }))
    }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let backend_url = format!("http://{address}");
    let context = BackendToolContext {
        backend_url: &backend_url,
        auth_token: "unit-token",
        project_id: "12",
        grant: None,
        collaboration_dispatcher: None,
    };

    for (tool, key) in [
        ("get_project_members", "members"),
        ("get_project_assistant_roster", "assistant_roster"),
    ] {
        let result = call(&context, tool, &json!({})).await.unwrap();
        assert_eq!(result["projectVersion"], 3);
        assert_eq!(result["revision"], 2);
        assert_eq!(result["configuration"].as_object().unwrap().len(), 1);
        assert!(result["configuration"][key].is_array());
        assert!(!result.to_string().contains("private-sentinel"));
    }
    server.abort();
}

#[tokio::test]
async fn generic_space_update_returns_public_summary_and_structured_errors() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/api/v1/projects/12", get(|| async { Json(json!({"project_admin_capabilities": catalog(true)})) }))
        .route("/api/v1/cloud-projects/12", axum::routing::patch(|headers: HeaderMap, Json(body): Json<Value>| async move {
        assert_eq!(headers.get("authorization").unwrap(), "Bearer unit-token");
        if body["version"] == 1 {
            (axum::http::StatusCode::CONFLICT, Json(json!({"detail": {"reason_code": "version_conflict", "message": "Reload the project.", "fields": [{"path": "version", "message": "Stale version."}]}})))
        } else {
            (axum::http::StatusCode::OK, Json(json!({
                "id": "12", "project_key": "WORK", "name": "Updated", "description": "Policy", "task_provider": "local", "tags": ["review"], "version": 3,
                "project_admin_result": {"projectVersion": 3, "auditId": "audit-1"},
                "workflow_definition": {"execution_config": {"system_prompt": "private-sentinel"}}
            })))
        }
    }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let directory = tempfile::tempdir().unwrap();
    let store =
        crate::task_runtime::LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let runtime = TaskRuntime::new(store).unwrap();
    let context = SpaceMcpRequestContext::new(
        None,
        Some(format!("http://{address}")),
        Some("unit-token".to_owned()),
    );

    let success = super::super::call_tool_with_runtime_context(
        &runtime,
        "update_space",
        json!({"space_id": "12", "project": {"version": 2, "name": "Updated"}}),
        &context,
    )
    .await;
    assert_eq!(success["isError"], false);
    assert_eq!(
        success["structuredContent"]["project_admin_result"]["auditId"],
        "audit-1"
    );
    assert!(!success.to_string().contains("private-sentinel"));
    assert_eq!(success["structuredContent"].as_object().unwrap().len(), 8);
    let failure = super::super::call_tool_with_runtime_context(
        &runtime,
        "update_space",
        json!({"space_id": "12", "project": {"version": 1, "name": "Updated"}}),
        &context,
    )
    .await;
    assert_eq!(failure["isError"], true);
    assert_eq!(
        failure["structuredContent"]["error"]["reason_code"],
        "version_conflict"
    );
    assert_eq!(
        failure["structuredContent"]["error"]["fields"][0]["path"],
        "version"
    );
    server.abort();
}

#[tokio::test]
async fn writes_use_the_same_authenticated_project_patch_and_return_only_the_audit_result() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/api/v1/projects/12", get(|headers: HeaderMap| async move {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer unit-token");
            Json(json!({"access_role": "Maintainer", "project_admin_capabilities": catalog(true)}))
        }))
        .route("/api/v1/cloud-projects/12", axum::routing::patch(|headers: HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer unit-token");
            assert_eq!(body, json!({"version": 7, "tags": ["new"], "operation_id": "op-1", "dry_run": true}));
            Json(json!({"provider_config": {"secret": "not-returned"}, "project_admin_result": {"projectVersion": 7, "dryRun": true, "auditId": null}}))
        }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let backend_url = format!("http://{address}");
    let context = BackendToolContext {
        backend_url: &backend_url,
        auth_token: "unit-token",
        project_id: "12",
        grant: None,
        collaboration_dispatcher: None,
    };

    let result = call(&context, "update_project_tags", &json!({"request": {"version": 7, "tags": ["new"], "operation_id": "op-1", "dry_run": true}})).await.unwrap();

    assert_eq!(
        result,
        json!({"projectVersion": 7, "dryRun": true, "auditId": null})
    );
    server.abort();
}

#[tokio::test]
async fn saved_views_and_tag_changes_preserve_the_canonical_backend_shapes() {
    let views = json!({
        "schema_version": 1,
        "default_view_id": "review",
        "views": [{
            "id": "review",
            "name": "Review",
            "columns": [
                {"id": "tag-review", "type": "tag", "value": "review"},
                {"id": "unmatched", "type": "unmatched", "value": "unmatched"}
            ],
            "filter": {"tags": ["review"], "match": "any"},
            "sorts": {"tag-review": ["priority-desc"]}
        }]
    });
    let board_request = json!({"version": 7, "board_views": views, "dry_run": true});
    let tag_request = json!({
        "version": 7,
        "tag_change": {"source": "review", "target": "verified"},
        "operation_id": "rename-review"
    });
    let expected_board = board_request.clone();
    let expected_tag = tag_request.clone();
    let patches = Arc::new(AtomicUsize::new(0));
    let recorded_patches = Arc::clone(&patches);
    let mut admin_catalog = board_catalog();
    admin_catalog["operations"] = json!([
        {"toolName": "update_project_board_views", "availability": {"available": true}, "inputSchema": board_input_schema("request")},
        {"toolName": "change_project_tag", "availability": {"available": true}, "inputSchema": {"type": "object"}}
    ]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route(
            "/api/v1/projects/12",
            get(move || {
                let catalog = admin_catalog.clone();
                async move { Json(json!({"project_admin_capabilities": catalog})) }
            }),
        )
        .route(
            "/api/v1/cloud-projects/12",
            axum::routing::patch(move |Json(body): Json<Value>| {
                let expected_board = expected_board.clone();
                let expected_tag = expected_tag.clone();
                let patches = Arc::clone(&recorded_patches);
                async move {
                    assert!(body == expected_board || body == expected_tag, "{body}");
                    patches.fetch_add(1, Ordering::SeqCst);
                    Json(json!({
                        "id": "12", "project_key": "WORK", "name": "Review", "description": "",
                        "task_provider": "local", "tags": ["review"], "version": 7,
                        "project_admin_result": {"projectVersion": 7, "auditId": "audit-1"}
                    }))
                }
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

    for (name, arguments) in [
        (
            "update_project_board_views",
            json!({"request": board_request.clone()}),
        ),
        ("change_project_tag", json!({"request": tag_request})),
        ("update_space", json!({"project": board_request})),
    ] {
        let result = call(&context, name, &arguments).await.unwrap();
        let receipt = if name == "update_space" {
            &result["project_admin_result"]
        } else {
            &result
        };
        assert_eq!(receipt["auditId"], "audit-1");
    }
    assert_eq!(patches.load(Ordering::SeqCst), 3);
    server.abort();
}

#[tokio::test]
async fn a_disabled_catalog_blocks_the_write_before_a_patch_request() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route(
        "/api/v1/projects/12",
        get(|| async {
            Json(json!({"access_role": "Maintainer", "project_admin_capabilities": catalog(false)}))
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

    let error = call(
        &context,
        "update_project_tags",
        &json!({"request": {"version": 1, "tags": []}}),
    )
    .await
    .unwrap_err();

    assert!(error.contains("feature_disabled"));
    server.abort();
}

#[tokio::test]
async fn preserves_top_level_validation_reason_and_fields() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new().route("/validation", get(|| async {
        (
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({
                "detail": "Unsupported configuration field.",
                "reason_code": "unsupported_field",
                "fields": [{"path": "board_views.views.0.columns.0.value", "message": "Unknown status."}]
            })),
        )
    }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let response = client()
        .unwrap()
        .get(format!("http://{address}/validation"))
        .send()
        .await
        .unwrap();

    let error: Value = serde_json::from_str(&response_json(response).await.unwrap_err()).unwrap();

    assert_eq!(error["error"]["reason_code"], "unsupported_field");
    assert_eq!(error["error"]["status_code"], 422);
    assert_eq!(
        error["error"]["fields"][0]["path"],
        "board_views.views.0.columns.0.value"
    );
    server.abort();
}
