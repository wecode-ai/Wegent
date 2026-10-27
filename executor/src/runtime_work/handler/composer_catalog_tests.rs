use super::*;
use std::future::ready;

fn task() -> ComposerCatalogScope {
    ComposerCatalogScope {
        task_id: Some("side-task".to_owned()),
        workspace_path: Some("/side-workspace".to_owned()),
        project_plugin_ids: vec!["project-tool@local".to_owned()],
    }
}

fn empty_store() -> Value {
    json!({"storePath": "/executor/store", "plugins": []})
}

const TEST_REMOTE_TIMEOUT: Duration = Duration::from_secs(1);

#[tokio::test]
async fn composer_catalog_reads_all_pages_and_uses_the_bound_workspace() {
    let mut calls = Vec::new();
    let mut replies = VecDeque::from([
        json!({"data": [{"cwd": "/side-workspace", "skills": []}]}),
        json!({"data": [{"id": "first"}], "nextCursor": "next"}),
        json!({"data": [{"id": "second", "isAccessible": false}], "nextCursor": null}),
        json!({"marketplaces": [{"name": "local", "plugins": [{"name": "tool", "enabled": false}]}]}),
    ]);
    let snapshot = read_catalog_snapshot(
        &task(),
        true,
        |method, params| {
            calls.push((method, params));
            ready(Ok(replies.pop_front().expect("unexpected catalog request")))
        },
        ready(Ok(empty_store())),
        TEST_REMOTE_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(snapshot["taskId"], "side-task");
    assert_eq!(snapshot["workspacePath"], "/side-workspace");
    assert_eq!(snapshot["projectPluginIds"], json!(["project-tool@local"]));
    assert_eq!(snapshot["apps"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["apps"][1]["isAccessible"], false);
    assert_eq!(calls[0].0, "skills/list");
    assert_eq!(calls[0].1["forceReload"], true);
    assert_eq!(calls[2].1["cursor"], "next");
    assert_eq!(calls[1].1["forceRefetch"], true);
    assert_eq!(calls[3].0, "plugin/installed");
    assert_eq!(calls[3].1["cwds"], json!(["/side-workspace"]));
    assert_eq!(snapshot["partial"], false);
    assert!(replies.is_empty());
}

#[tokio::test]
async fn composer_catalog_degrades_repeated_remote_cursors_without_retries() {
    let mut calls = 0;
    let snapshot = read_catalog_snapshot(
        &task(),
        false,
        |_, _| {
            calls += 1;
            ready(Ok(if calls == 1 {
                json!({"data": []})
            } else {
                json!({"data": [], "nextCursor": "same"})
            }))
        },
        ready(Ok(empty_store())),
        TEST_REMOTE_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(calls, 4);
    assert_eq!(snapshot["apps"], json!([]));
    assert_eq!(snapshot["partial"], true);
    assert_eq!(
        snapshot["unavailableSources"],
        json!(["codex-apps", "codex-marketplaces"])
    );
}

#[tokio::test]
async fn composer_catalog_keeps_local_results_when_remote_sources_fail() {
    let mut calls = 0;
    let snapshot = read_catalog_snapshot(
        &task(),
        false,
        |_, _| {
            calls += 1;
            ready(if calls == 1 {
                Ok(json!({"data": [{"cwd": "/side-workspace", "skills": [{"name": "pdf"}]}]}))
            } else if calls == 2 {
                Err(AppIpcError::new("offline", "App catalog unavailable"))
            } else {
                Err(AppIpcError::new("offline", "Installed catalog unavailable"))
            })
        },
        ready(Ok(empty_store())),
        TEST_REMOTE_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(calls, 3);
    assert_eq!(snapshot["apps"], json!([]));
    assert_eq!(snapshot["marketplaces"], json!([]));
    assert_eq!(snapshot["skills"][0]["skills"][0]["name"], "pdf");
    assert_eq!(snapshot["partial"], true);
    assert_eq!(
        snapshot["unavailableSources"],
        json!(["codex-apps", "codex-marketplaces"])
    );
}

#[tokio::test]
async fn composer_catalog_stops_waiting_for_a_hung_remote_catalog() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    tokio::time::pause();
    let calls = AtomicUsize::new(0);
    let snapshot = read_catalog_snapshot(
        &task(),
        false,
        |_, _| async {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(json!({"data": []}))
            } else {
                std::future::pending().await
            }
        },
        ready(Ok(empty_store())),
        Duration::from_secs(8),
    )
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(snapshot["partial"], true);
    assert_eq!(
        snapshot["unavailableSources"],
        json!(["codex-apps", "codex-marketplaces"])
    );
}

#[tokio::test]
async fn composer_catalog_surfaces_skill_read_errors() {
    let mut replies = VecDeque::from([
        json!({"data": [{"skills": [], "errors": [{"path": "/bad", "message": "unreadable"}]}]}),
    ]);
    let error = read_catalog_snapshot(
        &task(),
        false,
        |_, _| ready(Ok(replies.pop_front().unwrap())),
        ready(Ok(empty_store())),
        TEST_REMOTE_TIMEOUT,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "composer_skills_read_failed");
}

#[tokio::test]
async fn composer_catalog_rejects_missing_task_before_starting_the_app_server() {
    let (events, _) = broadcast::channel(1);
    let handler = RuntimeWorkRpcHandler::with_event_sender_deferred_startup_recovery(
        "device",
        "/bin/false",
        events,
    );
    let missing_id = handler
        .dispatch(
            "runtime.composer.catalog.read",
            json!({"workspacePath": "/untrusted"}),
        )
        .await
        .unwrap_err();
    assert_eq!(missing_id.code, "bad_request");
    let missing_task = handler
        .dispatch(
            "runtime.composer.catalog.read",
            json!({"taskId": "missing-task", "workspacePath": "/untrusted"}),
        )
        .await
        .unwrap_err();
    assert_eq!(missing_task.code, "task_not_found");
    assert!(!should_resume_persisted_turns_before_rpc(
        "runtime.composer.catalog.read"
    ));
}

#[tokio::test]
async fn composer_catalog_preserves_authoritative_empty_catalogs() {
    let mut replies = VecDeque::from([
        json!({"data": []}),
        json!({"data": [], "nextCursor": null}),
        json!({"marketplaces": []}),
    ]);
    let result = read_catalog_snapshot(
        &task(),
        false,
        |_, _| ready(Ok(replies.pop_front().unwrap())),
        ready(Ok(empty_store())),
        TEST_REMOTE_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(result["apps"], json!([]));
    assert_eq!(result["marketplaces"], json!([]));
    assert_eq!(result["store"]["plugins"], json!([]));
}

#[tokio::test]
async fn composer_catalog_degrades_malformed_remote_lists() {
    let snapshot = read_catalog_snapshot(
        &task(),
        false,
        |method, _| {
            ready(Ok(if method == "skills/list" {
                json!({"data": []})
            } else {
                json!({"data": {}})
            }))
        },
        ready(Ok(empty_store())),
        TEST_REMOTE_TIMEOUT,
    )
    .await
    .unwrap();
    assert_eq!(snapshot["apps"], json!([]));
    assert_eq!(snapshot["partial"], true);
}

#[tokio::test]
async fn composer_catalog_rejects_store_failure() {
    let mut replies = VecDeque::from([
        json!({"data": []}),
        json!({"data": [], "nextCursor": null}),
        json!({"marketplaces": []}),
    ]);
    let error = read_catalog_snapshot(
        &task(),
        false,
        |_, _| ready(Ok(replies.pop_front().unwrap())),
        ready(Err(AppIpcError::new(
            "store_unreadable",
            "Unreadable store",
        ))),
        TEST_REMOTE_TIMEOUT,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "store_unreadable");
}

#[tokio::test]
async fn workspace_composer_catalog_uses_context_without_creating_a_task() {
    for path in [
        None,
        Some(std::env::temp_dir().to_string_lossy().into_owned()),
    ] {
        let scope =
            workspace_catalog_scope(&json!({"scope": "workspace", "workspacePath": path})).unwrap();
        assert!(scope.task_id.is_none());
        let mut calls = Vec::new();
        let mut replies = VecDeque::from([
            json!({"data": []}),
            json!({"data": [], "nextCursor": null}),
            json!({"marketplaces": []}),
        ]);
        let result = read_catalog_snapshot(
            &scope,
            true,
            |method, params| {
                calls.push((method, params));
                ready(Ok(replies.pop_front().unwrap()))
            },
            ready(Ok(empty_store())),
            TEST_REMOTE_TIMEOUT,
        )
        .await
        .unwrap();
        assert!(result["taskId"].is_null());
        assert_eq!(result["scope"], "workspace");
        assert_eq!(result["workspacePath"], path.as_deref().unwrap_or_default());
        let cwds: Vec<&str> = path.as_deref().into_iter().collect();
        assert_eq!(calls[0].1["cwds"], json!(cwds));
        assert_eq!(calls[2].1["cwds"], json!(cwds));
    }
}

#[test]
fn workspace_composer_catalog_rejects_mixed_scope_and_unavailable_paths() {
    let error = workspace_catalog_scope(&json!({"scope": "workspace", "taskId": "task"}))
        .err()
        .unwrap();
    assert_eq!(error.code, "bad_request");
    for path in [
        json!(""),
        json!("/nonexistent-wework-composer-workspace"),
        json!(1),
    ] {
        let error = workspace_catalog_scope(&json!({"scope": "workspace", "workspacePath": path}))
            .err()
            .unwrap();
        assert_eq!(error.code, "missing_workspace");
    }
}
