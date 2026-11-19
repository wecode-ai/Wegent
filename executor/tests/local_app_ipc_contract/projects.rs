// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::{env_lock, EnvGuard};
use serde_json::{json, Value};
use wegent_executor::{
    local::app_ipc::AppIpcServer,
    task_runtime::{LocalTaskStore, ProjectCreate},
};

#[tokio::test]
async fn app_ipc_projects_get_reads_the_default_project_before_any_catalog_request() {
    let _lock = env_lock().await;
    let home = tempfile::tempdir().unwrap();
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", home.path().to_str().unwrap());
    let server = AppIpcServer::new();

    let project = server
        .dispatch("projects.get", json!({"project_id": "default-work-items"}))
        .await
        .unwrap();

    assert_eq!(project["id"], "default-work-items");
    assert_eq!(project["resource_type"], "project");
}

#[tokio::test]
async fn app_ipc_projects_get_returns_current_metadata_with_masked_provider_credentials() {
    let _lock = env_lock().await;
    let home = tempfile::tempdir().unwrap();
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", home.path().to_str().unwrap());
    let server = AppIpcServer::new();
    let created = server
        .dispatch("projects.create", json!({
            "name": "Current project", "project_key": "CURRENT", "task_provider": "github",
            "provider_config": {"repository": "acme/repo", "domain": "github.com", "token": "private-provider-token"}
        }))
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap();
    let connection = rusqlite::Connection::open(home.path().join("data/tasks.sqlite")).unwrap();
    let raw: String = connection
        .query_row(
            "SELECT metadata FROM loop_items WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    let mut metadata: Value = serde_json::from_str(&raw).unwrap();
    let policy = json!({"revision": 3, "content": "Keep the current policy."});
    metadata["collaboration_policy"] = policy.clone();
    connection
        .execute(
            "UPDATE loop_items SET metadata = ?1 WHERE id = ?2",
            rusqlite::params![metadata.to_string(), id],
        )
        .unwrap();
    let board_views = json!({
        "schema_version": 1, "default_view_id": "review",
        "views": [{"id": "review", "name": "Review", "columns": [
            {"id": "review-tag", "type": "tag", "value": "review"}
        ], "filter": {"tags": ["review"], "match": "all"}, "sorts": {"review-tag": ["priority-desc"]}}]
    });
    let updated = server
        .dispatch(
            "projects.update",
            json!({"project_id": id, "project": {
                "version": created["version"], "name": "Updated project", "tags": ["review"],
                "board_views": board_views
            }}),
        )
        .await
        .unwrap();

    let response = server.handle_line(&json!({
        "type": "request", "id": "get-current", "method": "projects.get", "params": {"project_id": id}
    }).to_string()).await.unwrap();

    assert_eq!(response["ok"], true, "{response}");
    let current = &response["result"];
    assert_eq!(current, &updated);
    assert_eq!(current["version"], created["version"].as_i64().unwrap() + 1);
    assert_eq!(current["metadata"]["board_views"], board_views);
    assert_eq!(current["metadata"]["collaboration_policy"], policy);
    let provider = &current["metadata"]["provider_config"];
    assert_eq!(provider["repository"], "acme/repo");
    assert_eq!(provider["credential_configured"], true);
    assert!(provider.get("token").is_none());
    assert!(provider.get("credential").is_none());
    assert!(!current.to_string().contains("private-provider-token"));
}

#[tokio::test]
async fn app_ipc_projects_get_preserves_historical_aliases_hidden_from_the_catalog() {
    let _lock = env_lock().await;
    let home = tempfile::tempdir().unwrap();
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", home.path().to_str().unwrap());
    let workspace = home.path().join("repository").display().to_string();
    let state_path = std::path::PathBuf::from(std::env::var("CODEX_HOME").unwrap())
        .join(".codex-global-state.json");
    std::fs::write(
        &state_path,
        json!({"electron-saved-workspace-roots": [&workspace]}).to_string(),
    )
    .unwrap();
    let server = AppIpcServer::new();
    let before = server.dispatch("projects.list", json!({})).await.unwrap();
    let alias = before
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["metadata"]["code_project_key"] == workspace)
        .unwrap();
    std::fs::write(
        &state_path,
        json!({
            "electron-saved-workspace-roots": [&workspace],
            "project-order": ["canonical", &workspace],
            "local-projects": {"canonical": {"name": "Canonical project"}},
            "project-writable-roots": {"canonical": [{"path": &workspace}]}
        })
        .to_string(),
    )
    .unwrap();
    let catalog = server.dispatch("projects.list", json!({})).await.unwrap();
    assert!(catalog
        .as_array()
        .unwrap()
        .iter()
        .all(|project| project["id"] != alias["id"]));

    let current = server
        .dispatch("projects.get", json!({"project_id": alias["id"]}))
        .await
        .unwrap();

    assert_eq!(current["id"], alias["id"]);
    assert_eq!(current["metadata"]["code_project_key"], workspace);
}

#[tokio::test]
async fn app_ipc_projects_get_never_substitutes_other_store_items_or_archived_projects() {
    let _lock = env_lock().await;
    let home = tempfile::tempdir().unwrap();
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", home.path().to_str().unwrap());
    let server = AppIpcServer::new();
    let current = server
        .dispatch("projects.create", json!({"name": "Visible project"}))
        .await
        .unwrap();
    let todo = server
        .dispatch(
            "todos.create",
            json!({
                "project_id": current["id"], "todo": {"title": "An Issue is not a project"}
            }),
        )
        .await
        .unwrap();
    let other_home = tempfile::tempdir().unwrap();
    let foreign = LocalTaskStore::open(other_home.path().join("tasks.sqlite"))
        .unwrap()
        .create_project(
            serde_json::from_value::<ProjectCreate>(json!({"name": "Other store"})).unwrap(),
        )
        .unwrap();

    for id in [
        "missing-project",
        foreign.id.as_str(),
        todo["id"].as_str().unwrap(),
    ] {
        let error = server
            .dispatch("projects.get", json!({"project_id": id}))
            .await
            .unwrap_err();
        assert_eq!(error.code, "not_found");
    }
    assert_eq!(
        server
            .dispatch("projects.get", json!({"project_id": current["id"]}))
            .await
            .unwrap()["id"],
        current["id"]
    );
    server
        .dispatch(
            "projects.archive",
            json!({"project_id": current["id"], "version": current["version"]}),
        )
        .await
        .unwrap();
    assert_eq!(
        server
            .dispatch("projects.get", json!({"project_id": current["id"]}))
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    for params in [
        json!({}),
        json!({"project_id": ""}),
        json!({"project_id": 12}),
    ] {
        assert_eq!(
            server
                .dispatch("projects.get", params)
                .await
                .unwrap_err()
                .code,
            "bad_request"
        );
    }
}
