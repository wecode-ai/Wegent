use super::*;

fn metadata(thread_id: &str) -> String {
    format!(
        "{}\n",
        json!({"type":"session_meta","payload":{"id":thread_id}})
    )
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
