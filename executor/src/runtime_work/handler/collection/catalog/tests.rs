use super::*;
use crate::runtime_work::handler::tests::{install_native_history, ScalarEnv};

#[test]
fn control_catalog_follows_every_page_beyond_the_sidebar_limit() {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env: Vec<_> = ["WEGENT_EXECUTOR_HOME", "CODEX_HOME", "WEGENT_CODEX_HOME"]
                .into_iter()
                .map(|key| ScalarEnv::set(key, root.path().to_str().unwrap()))
                .collect();
            let mut handler = RuntimeWorkRpcHandler::new("catalog-device", "/bin/false");
            install_native_history(&mut handler, root.path(), vec![], None);
            let first: Vec<_> = (0..CODEX_THREAD_LIST_MAX_ITEMS)
                .map(|id| json!({"id":format!("thread-{id}")}))
                .collect();
            fs::write(
                root.path().join("thread_list.json"),
                json!({"data":first,"nextCursor":"page-2"}).to_string(),
            )
            .unwrap();
            fs::write(
                root.path().join("thread_list_page2.json"),
                json!({"data":[{"id":"old-conversation"}],"nextCursor":null}).to_string(),
            )
            .unwrap();
            let (sidebar, complete) = handler
                .read_codex_catalog(false, Some(CODEX_THREAD_LIST_MAX_ITEMS))
                .await;
            assert_eq!(sidebar.len(), CODEX_THREAD_LIST_MAX_ITEMS);
            assert!(!complete);
            let (all, complete) = handler.read_codex_catalog(false, None).await;
            assert_eq!(all.len(), CODEX_THREAD_LIST_MAX_ITEMS + 1);
            assert_eq!(all.last().unwrap()["id"], "old-conversation");
            assert!(complete);
            let desktop = handler.list_tasks(&json!({})).await.unwrap();
            let visible: Vec<_> = desktop["workspaces"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|workspace| workspace["tasks"].as_array().unwrap())
                .collect();
            assert_eq!(visible.len(), CODEX_THREAD_LIST_MAX_ITEMS + 1);
            assert!(visible
                .iter()
                .any(|item| item["threadId"] == "old-conversation"));
            assert_eq!(desktop["coverage"]["authorized_index_complete"], true);
            handler.codex_app_server.restart().await;
        });
}

#[test]
fn control_catalog_failure_keeps_known_conversations_and_reports_the_gap() {
    let _lock = crate::test_env::lock();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let _env: Vec<_> = ["WEGENT_EXECUTOR_HOME", "CODEX_HOME", "WEGENT_CODEX_HOME"]
                .into_iter()
                .map(|key| ScalarEnv::set(key, root.path().to_str().unwrap()))
                .collect();
            let mut handler = RuntimeWorkRpcHandler::new("catalog-device", "/bin/false");
            install_native_history(&mut handler, root.path(), vec![], None);
            fs::write(root.path().join("thread_list.json"), "{}").unwrap();
            handler.store.upsert_task(RuntimeTaskLink::new_pending(
                "known-conversation".into(),
                "/tmp/known".into(),
                "known title".into(),
            ));
            let result = handler.list_tasks(&json!({})).await.unwrap();
            assert!(result["workspaces"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|workspace| workspace["tasks"].as_array().unwrap())
                .any(|item| item["taskId"] == "known-conversation"));
            assert_eq!(result["coverage"]["authorized_index_complete"], false);
            assert_eq!(
                result["coverage"]["unavailable_reasons"]["native_catalog_unavailable"],
                1
            );
            handler.codex_app_server.restart().await;
        });
}
