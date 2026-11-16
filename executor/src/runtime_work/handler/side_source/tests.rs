use super::*;
use crate::runtime_work::handler::tests::{install_native_history, ScalarEnv};

#[test]
fn persisted_side_source_is_resolved_by_id_outside_the_default_provider_catalog() {
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
            let mut handler = RuntimeWorkRpcHandler::new("device", "/bin/false");
            install_native_history(&mut handler, root.path(), vec![], None);
            handler
                .codex_app_server
                .ensure_started()
                .await
                .expect("The native fixture must finish its protocol handshake before the metadata-read deadline");
            let path = root.path().join("source.jsonl");
            fs::write(&path, metadata("source")).unwrap();
            fs::write(
                root.path().join("thread_read.json"),
                json!({"thread":{"id":"source","modelProvider":"openai","path":path}}).to_string(),
            )
            .unwrap();
            // thread/list intentionally excludes this source, as a router-default catalog does.
            let mut source = SideSourceThread {
                thread_id: "source".into(),
                thread_path: None,
                workspace_path: root.path().to_string_lossy().into_owned(),
            };
            let ready = tokio::time::timeout(
                // Match the production side-source wait; Windows app-server startup can
                // exceed five seconds on a loaded runner.
                Duration::from_secs(30),
                handler.wait_for_side_source_rollout(&mut source),
            )
            .await;
            handler.codex_app_server.restart().await;
            let calls = fs::read_to_string(root.path().join("requests.jsonl"))
                .unwrap_or_else(|error| format!("Cannot read native fixture requests: {error}"));
            ready.unwrap_or_else(|error| {
                panic!("A persisted source must not depend on catalog visibility: {error}; native fixture requests: {calls}")
            }).unwrap();
            assert_eq!(source.thread_path.as_deref(), path.to_str());
            let calls = fs::read_to_string(root.path().join("requests.jsonl")).unwrap();
            let calls: Vec<Value> = calls
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert!(!calls.iter().any(|call| call["method"] == "thread/list"));
            assert!(calls.iter().any(|call| call["method"] == "thread/read"
                && call["params"] == json!({"threadId":"source","includeTurns":false})));
        });
}

fn metadata(thread_id: &str) -> String {
    format!(
        "{}\n",
        json!({"type":"session_meta","payload":{"id":thread_id}})
    )
}

#[test]
fn side_source_rejects_missing_or_mismatched_native_metadata() {
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
            let mut handler = RuntimeWorkRpcHandler::new("device", "/bin/false");
            install_native_history(&mut handler, root.path(), vec![], None);
            for response in [json!({}), json!({"thread":{"id":"another-source"}})] {
                fs::write(root.path().join("thread_read.json"), response.to_string()).unwrap();
                let mut source = SideSourceThread {
                    thread_id: "source".into(),
                    thread_path: None,
                    workspace_path: root.path().to_string_lossy().into_owned(),
                };
                let error = handler
                    .wait_for_side_source_rollout(&mut source)
                    .await
                    .unwrap_err();
                assert_eq!(error.code, "side_source_not_ready");
                assert!(error.message.contains("different or missing source thread"));
                assert!(source.thread_path.is_none());
            }
            handler.codex_app_server.restart().await;
        });
}

#[tokio::test]
async fn fork_requires_complete_persisted_source_metadata() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.jsonl");
    assert!(!rollout_metadata_ready(&path, "source").await.unwrap());
    tokio::fs::write(&path, b"").await.unwrap();
    assert!(!rollout_metadata_ready(&path, "source").await.unwrap());
    tokio::fs::write(&path, metadata("source").trim_end())
        .await
        .unwrap();
    assert!(!rollout_metadata_ready(&path, "source").await.unwrap());
    tokio::fs::write(&path, b"{\"label\":\"\xe4").await.unwrap();
    assert!(!rollout_metadata_ready(&path, "source").await.unwrap());
    tokio::fs::write(&path, metadata("source")).await.unwrap();
    assert!(rollout_metadata_ready(&path, "source").await.unwrap());
}

#[tokio::test]
async fn fork_rejects_mismatched_corrupt_and_unreadable_rollouts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.jsonl");
    for content in [metadata("another-thread"), "invalid metadata\n".to_owned()] {
        tokio::fs::write(&path, content).await.unwrap();
        assert!(rollout_metadata_ready(&path, "source").await.is_err());
    }
    assert!(rollout_metadata_ready(directory.path(), "source")
        .await
        .is_err());
}

#[tokio::test]
async fn side_source_waits_for_rollout_without_waiting_for_the_model_to_finish() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.jsonl");
    tokio::fs::write(&path, b"").await.unwrap();
    let handler = RuntimeWorkRpcHandler::new("device", "/bin/false");
    let mut source = SideSourceThread {
        thread_id: "source".into(),
        thread_path: Some(path.to_string_lossy().into_owned()),
        workspace_path: directory.path().to_string_lossy().into_owned(),
    };
    let wait = handler.wait_for_side_source_rollout(&mut source);
    tokio::pin!(wait);
    assert!(futures_util::poll!(wait.as_mut()).is_pending());
    tokio::fs::write(&path, metadata("source")).await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), wait)
        .await
        .expect("persisted source metadata must unblock the fork")
        .unwrap();
}
