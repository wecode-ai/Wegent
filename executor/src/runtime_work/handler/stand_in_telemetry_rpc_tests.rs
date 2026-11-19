use super::*;
use crate::runtime_work::handler::tests::isolated_runtime_work_handler;
use rusqlite::{Connection, TransactionBehavior};

#[tokio::test(flavor = "current_thread")]
async fn telemetry_writer_does_not_block_independent_startup_reads() {
    let (handler, root) = isolated_runtime_work_handler("telemetry-startup-writer");
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let expected = store
        .read_personal_stand_in(9007, &handler.device_id)
        .unwrap();
    let mut writer = Connection::open(handler.task_store_path.as_ref()).unwrap();
    let transaction = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    let mut configure = handler.dispatch_method(
        "runtime.stand_in.telemetry.configure",
        json!({"userId":9007,"enabled":true}),
    );

    assert!(futures_util::poll!(configure.as_mut()).is_pending());
    let personal = handler
        .dispatch_method("runtime.stand_in.personal.get", json!({"userId":9007}))
        .await
        .unwrap();
    let telemetry = handler
        .dispatch_method("runtime.stand_in.telemetry.list", json!({"userId":9007}))
        .await
        .unwrap();
    assert_eq!(personal, expected);
    assert_eq!(telemetry["items"], json!([]));
    assert!(futures_util::poll!(configure.as_mut()).is_pending());

    transaction.rollback().unwrap();
    assert_eq!(configure.await.unwrap(), json!({"success":true}));
    let enabled: bool = writer
        .query_row(
            "SELECT enabled FROM stand_in_telemetry_policy WHERE user_id=?1",
            [9007],
            |row| row.get(0),
        )
        .unwrap();
    assert!(enabled);
    drop((writer, store));
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn telemetry_dispatch_preserves_validation_errors() {
    let (handler, root) = isolated_runtime_work_handler("telemetry-validation-errors");
    for (method, payload, message) in [
        (
            "runtime.stand_in.telemetry.configure",
            json!({"userId":-1,"enabled":true}),
            "userId is required",
        ),
        (
            "runtime.stand_in.telemetry.configure",
            json!({"userId":9007}),
            "enabled is required",
        ),
        (
            "runtime.stand_in.telemetry.ack",
            json!({"userId":9007,"ids":["invalid"]}),
            "Invalid event ID",
        ),
    ] {
        let error = handler.dispatch_method(method, payload).await.unwrap_err();
        assert_eq!(error.code, "bad_request");
        assert_eq!(error.message, message);
    }
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn telemetry_dispatch_preserves_database_errors() {
    let (handler, root) = isolated_runtime_work_handler("telemetry-database-errors");
    fs::create_dir_all(handler.task_store_path.as_ref()).unwrap();
    for (method, payload) in [
        (
            "runtime.stand_in.telemetry.configure",
            json!({"userId":9007,"enabled":true}),
        ),
        ("runtime.stand_in.telemetry.list", json!({"userId":9007})),
        (
            "runtime.stand_in.telemetry.ack",
            json!({"userId":9007,"ids":[]}),
        ),
    ] {
        let error = handler.dispatch_method(method, payload).await.unwrap_err();
        assert_eq!(error.code, "stand_in_settings");
        assert!(error.message.contains("database"));
    }
    fs::remove_dir_all(root).unwrap();
}
