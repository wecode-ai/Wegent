use super::*;

#[tokio::test(flavor = "current_thread")]
async fn telemetry_write_wait_does_not_block_independent_runtime_reads() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    store.configure_stand_in_telemetry(7, false, None).unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("telemetry-test", "unused");
    handler.task_store_path = Arc::new(path.clone());
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));

    let writer = rusqlite::Connection::open(&path).unwrap();
    writer.execute_batch("BEGIN IMMEDIATE").unwrap();
    let configure = handler.dispatch_method(
        "runtime.stand_in.telemetry.configure",
        json!({"userId":7,"enabled":true}),
    );
    tokio::pin!(configure);
    assert!(
        futures_util::poll!(configure.as_mut()).is_pending(),
        "A telemetry write must yield while another connection owns SQLite's writer slot"
    );
    let read = handler
        .dispatch_method("runtime.stand_in.telemetry.list", json!({"userId":7}))
        .await
        .unwrap();
    assert_eq!(read["items"], json!([]));
    let identity = handler
        .dispatch_method("runtime.stand_in.device_identity", json!({}))
        .await
        .unwrap();
    assert_eq!(identity["deviceId"], "telemetry-test");
    assert!(futures_util::poll!(configure.as_mut()).is_pending());
    let enabled = || {
        writer
            .query_row(
                "SELECT enabled FROM stand_in_telemetry_policy WHERE user_id=7",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap()
    };
    assert!(
        !enabled(),
        "A waiting configure must not report consent as persisted"
    );
    writer.execute_batch("ROLLBACK").unwrap();
    assert_eq!(configure.await.unwrap()["success"], true);
    assert!(enabled());
}
