// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn with_catalog_fixture<F, Fut>(run: F)
where
    F: FnOnce(RuntimeWorkRpcHandler, PathBuf, broadcast::Receiver<Value>) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let _lock = crate::test_env::lock();
    let root = tempfile::tempdir().unwrap();
    let _env: Vec<_> = ["WEGENT_EXECUTOR_HOME", "CODEX_HOME", "WEGENT_CODEX_HOME"]
        .into_iter()
        .map(|key| ScalarEnv::set(key, root.path().to_str().unwrap()))
        .collect();
    let mut handler = RuntimeWorkRpcHandler::new("catalog-device", "/bin/false");
    install_native_history(&mut handler, root.path(), vec![], None);
    let (events, receiver) = broadcast::channel(16);
    handler.event_tx = Some(events);
    let client = handler.codex_app_server.clone();
    let path = root.path().to_path_buf();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            run(handler, path, receiver).await;
            client.restart().await;
        });
}

#[test]
fn cached_reconciliation_only_notifies_when_the_visible_catalog_changes() {
    with_catalog_fixture(|handler, root, mut receiver| async move {
        let project_index = CodexGlobalProjectIndex::from_test_payload(&Map::new());
        handler
            .reconcile_codex_threads_after_cached_list(project_index.clone(), Vec::new())
            .await
            .unwrap();
        assert!(
            receiver.try_recv().is_err(),
            "An unchanged empty catalog triggered a refresh"
        );

        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let mut link = RuntimeTaskLink::new_pending(
            "visible-task".to_owned(),
            workspace.display().to_string(),
            "Original title".to_owned(),
        );
        handler.store.upsert_task(link.clone());
        let before = workspace_response(handler.collect_cached_links(false), Vec::new());
        handler
            .reconcile_codex_threads_after_cached_list(project_index.clone(), before.clone())
            .await
            .unwrap();
        assert!(
            receiver.try_recv().is_err(),
            "An unchanged task triggered a refresh"
        );

        link.title = "Updated title".to_owned();
        handler.store.upsert_task(link);
        handler
            .reconcile_codex_threads_after_cached_list(project_index, before)
            .await
            .unwrap();
        assert_eq!(
            receiver.try_recv().unwrap()["payload"]["taskId"],
            "runtime-work-bootstrap"
        );
        assert!(
            receiver.try_recv().is_err(),
            "One catalog change emitted duplicate refreshes"
        );
    });
}

#[test]
fn cached_reconciliation_preserves_notifications_when_catalog_coverage_is_incomplete() {
    with_catalog_fixture(|handler, root, mut receiver| async move {
        let project_index = CodexGlobalProjectIndex::from_test_payload(&Map::new());
        fs::write(root.join("thread_list.json"), "{}").unwrap();
        handler
            .reconcile_codex_threads_after_cached_list(project_index.clone(), Vec::new())
            .await
            .unwrap();
        assert_eq!(
            receiver.try_recv().unwrap()["payload"]["taskId"],
            "runtime-work-bootstrap"
        );

        let threads: Vec<_> = (0..CODEX_THREAD_LIST_MAX_ITEMS)
            .map(|id| json!({"id":format!("thread-{id}")}))
            .collect();
        fs::write(
            root.join("thread_list.json"),
            json!({"data":threads,"nextCursor":"page-2"}).to_string(),
        )
        .unwrap();
        let (links, complete) = handler
            .collect_query_links(false, Some(CODEX_THREAD_LIST_MAX_ITEMS))
            .await;
        assert!(
            !complete,
            "The fixture must leave an unread native catalog page"
        );
        let before = workspace_response(
            handler.visible_links_for_projects(links, &project_index),
            codex_project_workspaces(&project_index),
        );
        handler
            .reconcile_codex_threads_after_cached_list(project_index, before)
            .await
            .unwrap();
        assert_eq!(
            receiver.try_recv().unwrap()["payload"]["taskId"],
            "runtime-work-bootstrap"
        );
    });
}
