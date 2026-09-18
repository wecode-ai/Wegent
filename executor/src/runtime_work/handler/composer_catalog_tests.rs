use super::*;
use std::future::ready;

fn task() -> RuntimeTaskLink {
    let mut task = RuntimeTaskLink::new_pending(
        "side-task".to_owned(),
        "/side-workspace".to_owned(),
        "Side task".to_owned(),
    );
    task.project_plugin_ids = vec!["project-tool@local".to_owned()];
    task
}

fn empty_store() -> Value {
    json!({"storePath": "/executor/store", "plugins": []})
}

#[tokio::test]
async fn composer_catalog_reads_all_pages_and_uses_the_bound_workspace() {
    let mut calls = Vec::new();
    let mut replies = VecDeque::from([
        json!({"data": [{"id": "first"}], "nextCursor": "next"}),
        json!({"data": [{"id": "second", "isAccessible": false}], "nextCursor": null}),
        json!({"marketplaces": [{"name": "local", "plugins": [{"name": "tool", "enabled": false}]}]}),
        json!({"data": [{"cwd": "/side-workspace", "skills": []}]}),
    ]);
    let snapshot = read_catalog_snapshot(
        &task(),
        true,
        |method, params| {
            calls.push((method, params));
            ready(Ok(replies.pop_front().expect("unexpected catalog request")))
        },
        ready(Ok(empty_store())),
    )
    .await
    .unwrap();
    assert_eq!(snapshot["taskId"], "side-task");
    assert_eq!(snapshot["workspacePath"], "/side-workspace");
    assert_eq!(snapshot["projectPluginIds"], json!(["project-tool@local"]));
    assert_eq!(snapshot["apps"].as_array().unwrap().len(), 2);
    assert_eq!(snapshot["apps"][1]["isAccessible"], false);
    assert_eq!(calls[1].1["cursor"], "next");
    assert_eq!(calls[0].1["forceRefetch"], true);
    assert_eq!(calls[2].0, "plugin/installed");
    assert_eq!(calls[2].1["cwds"], json!(["/side-workspace"]));
    assert_eq!(calls[3].0, "skills/list");
    assert_eq!(calls[3].1["forceReload"], true);
    assert!(replies.is_empty());
}

#[tokio::test]
async fn composer_catalog_rejects_repeated_cursors_without_retries() {
    let mut calls = 0;
    let error = read_catalog_snapshot(
        &task(),
        false,
        |_, _| {
            calls += 1;
            ready(Ok(json!({"data": [], "nextCursor": "same"})))
        },
        ready(Ok(empty_store())),
    )
    .await
    .unwrap_err();
    assert_eq!(calls, 2);
    assert_eq!(error.code, "invalid_composer_catalog");
}

#[tokio::test]
async fn composer_catalog_does_not_publish_partial_results_on_source_failure() {
    let mut calls = 0;
    let error = read_catalog_snapshot(
        &task(),
        false,
        |_, _| {
            calls += 1;
            ready(if calls == 1 {
                Ok(json!({"data": [{"id": "app"}], "nextCursor": null}))
            } else {
                Err(AppIpcError::new("offline", "Installed catalog unavailable"))
            })
        },
        ready(Ok(empty_store())),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "offline");
    assert_eq!(calls, 2);
}

#[tokio::test]
async fn composer_catalog_surfaces_skill_read_errors() {
    let mut replies = VecDeque::from([
        json!({"data": [], "nextCursor": null}),
        json!({"marketplaces": []}),
        json!({"data": [{"skills": [], "errors": [{"path": "/bad", "message": "unreadable"}]}]}),
    ]);
    let error = read_catalog_snapshot(
        &task(),
        false,
        |_, _| ready(Ok(replies.pop_front().unwrap())),
        ready(Ok(empty_store())),
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
        json!({"data": [], "nextCursor": null}),
        json!({"marketplaces": []}),
        json!({"data": []}),
    ]);
    let result = read_catalog_snapshot(
        &task(),
        false,
        |_, _| ready(Ok(replies.pop_front().unwrap())),
        ready(Ok(empty_store())),
    )
    .await
    .unwrap();
    assert_eq!(result["apps"], json!([]));
    assert_eq!(result["marketplaces"], json!([]));
    assert_eq!(result["store"]["plugins"], json!([]));
}

#[tokio::test]
async fn composer_catalog_rejects_malformed_lists_and_store_failure() {
    let error = read_catalog_snapshot(
        &task(),
        false,
        |_, _| ready(Ok(json!({"data": {}}))),
        ready(Ok(empty_store())),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "invalid_composer_catalog");
    let mut replies = VecDeque::from([
        json!({"data": [], "nextCursor": null}),
        json!({"marketplaces": []}),
        json!({"data": []}),
    ]);
    let error = read_catalog_snapshot(
        &task(),
        false,
        |_, _| ready(Ok(replies.pop_front().unwrap())),
        ready(Err(AppIpcError::new(
            "store_unreadable",
            "Unreadable store",
        ))),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "store_unreadable");
}
