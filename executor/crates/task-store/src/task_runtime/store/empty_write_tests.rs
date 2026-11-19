use super::*;

fn with_other_writer(operation: impl FnOnce(&LocalTaskStore)) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("tasks.sqlite");
    let store = LocalTaskStore::open(&path).unwrap();
    store
        .connection()
        .unwrap()
        .busy_timeout(Duration::ZERO)
        .unwrap();
    let mut writer = Connection::open(&path).unwrap();
    let transaction = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();
    operation(&store);
    transaction.rollback().unwrap();
}

#[test]
fn standalone_runtime_start_does_not_compete_with_an_unrelated_writer() {
    with_other_writer(|store| {
        assert!(store
            .mark_runtime_running("standalone-runtime")
            .unwrap()
            .is_none());
    });
}

#[test]
fn absent_runtime_comment_completion_does_not_compete_with_an_unrelated_writer() {
    with_other_writer(|store| {
        store
            .finish_runtime_comment("standalone-runtime", "completed", "Result")
            .unwrap();
    });
}

#[test]
fn empty_receipt_expiry_does_not_compete_with_an_unrelated_writer() {
    with_other_writer(|store| {
        assert_eq!(store.expire_assignment_receipts(&now()).unwrap(), 0);
    });
}
