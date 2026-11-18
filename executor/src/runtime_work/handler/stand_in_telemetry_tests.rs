use super::super::tests::isolated_runtime_work_handler;
use super::*;

#[tokio::test(flavor = "current_thread")]
async fn telemetry_configuration_keeps_startup_reads_responsive_under_a_writer_lock() {
    verify_blocked_write("runtime.stand_in.telemetry.configure").await;
}

#[tokio::test(flavor = "current_thread")]
async fn telemetry_acknowledgement_keeps_startup_reads_responsive_under_a_writer_lock() {
    verify_blocked_write("runtime.stand_in.telemetry.ack").await;
}

async fn verify_blocked_write(method: &'static str) {
    let (handler, root) = isolated_runtime_work_handler(method);
    let facts = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    for user in [7, 8] {
        facts
            .configure_stand_in_telemetry(user, true, None)
            .unwrap();
        facts
            .record_stand_in_fact(user, "stand_in_configuration_succeeded", &json!({}))
            .unwrap();
    }
    let before = facts.list_stand_in_telemetry(7).unwrap();
    let other_user = facts.list_stand_in_telemetry(8).unwrap();
    let payload = json!({
        "userId": 7, "enabled": false,
        "ids": [before["items"][0]["id"], other_user["items"][0]["id"]],
    });
    let mut writer = rusqlite::Connection::open(handler.task_store_path.as_ref()).unwrap();
    let transaction = writer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    let writing = handler.clone();
    let write = tokio::spawn(async move { writing.dispatch_method(method, payload).await });
    let started = Instant::now();
    let reads = tokio::time::timeout(Duration::from_secs(1), async {
        // Let the real write RPC run before dispatching the startup read.
        tokio::task::yield_now().await;
        handler
            .dispatch_method("runtime.stand_in.telemetry.list", json!({"userId": 7}))
            .await
    })
    .await;
    let elapsed = started.elapsed();
    let still_pending = !write.is_finished();
    transaction.rollback().unwrap();
    let result = write.await.unwrap();

    assert!(
        elapsed < Duration::from_secs(1),
        "SQLite contention blocked the async runtime: {elapsed:?}"
    );
    assert!(
        still_pending,
        "The write must remain pending until its writer lock is released"
    );
    assert_eq!(reads.unwrap().unwrap(), before);
    assert_eq!(result.unwrap(), json!({"success": true}));
    assert!(facts.list_stand_in_telemetry(7).unwrap()["items"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(facts.list_stand_in_telemetry(8).unwrap(), other_user);
    drop(facts);
    drop(writer);
    fs::remove_dir_all(root).unwrap();
}
