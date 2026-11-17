use super::*;

fn insert(store: &LocalTaskStore, kind: &str, value: Value, at: chrono::DateTime<Utc>) {
    let connection = store.connection().unwrap();
    write(&connection, kind, &value).unwrap();
    connection
        .execute(
            "UPDATE loop_items SET created_at=?2,updated_at=?2 WHERE id=?1",
            params![value["id"].as_str().unwrap(), at.to_rfc3339()],
        )
        .unwrap();
}

#[test]
fn retention_keeps_recovery_and_deduplication_but_removes_expired_diagnostics() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let at = Utc::now();
    let old = at - chrono::Duration::days(8);
    let event = store.enqueue_stand_in_event(7, json!("settled"), json!({"kind":"connection","roleScoped":true,"roleIds":["role"],"source":{"id":"group"},"message":{"text":"Payload"}})).unwrap();
    let mut settled = event.clone();
    settled["status"] = json!("handled");
    insert(&store, "stand_in_event", settled, old);
    for (id, status) in [
        ("blocked", "pending"),
        ("waiting", "handled"),
        ("snapshot", "handled"),
    ] {
        insert(
            &store,
            "stand_in_event",
            json!({"id":id,"userId":7,"status":status,"payload":"Keep"}),
            old,
        );
    }
    for (id, status, batch, events, age) in [
        (
            "expired",
            "succeeded",
            "expired-batch",
            json!([event["id"]]),
            old,
        ),
        ("recent", "succeeded", "recent-batch", json!([]), at),
        ("queued", "pending", "queued-batch", json!([]), old),
        (
            "sending",
            "sending",
            "sending-batch",
            json!(["waiting"]),
            old,
        ),
        (
            "duplicate-failure",
            "failed",
            "old-failure",
            json!(["blocked"]),
            old - chrono::Duration::seconds(1),
        ),
        (
            "latest-failure",
            "failed",
            "latest-failure",
            json!(["blocked"]),
            old,
        ),
        ("assessment", "failed", "current-batch", json!([]), old),
        ("unknown-result", "failed", "unknown-batch", json!([]), old),
    ] {
        insert(
            &store,
            "stand_in_action",
            json!({"id":id,"userId":7,"status":status,"kind":"continue_work","batchId":batch,"arguments":{"eventIds":events}}),
            age,
        );
    }
    insert(
        &store,
        "stand_in_action",
        json!({"id":"foreign","userId":8,"status":"succeeded","kind":"ignore_events"}),
        old,
    );
    for (id, batch) in [
        ("expired-route", "expired-batch"),
        ("live-route", "current-batch"),
        ("failed-route", "latest-failure"),
    ] {
        insert(
            &store,
            "stand_in_route",
            json!({"id":id,"userId":7,"result":{"snapshotId":batch}}),
            old,
        );
    }
    store.save_stand_in_processing_state(7, &json!({"batchId":"current-batch","error":{"commandId":"unknown-result"},"snapshot":{"events":[{"id":"snapshot"}]}})).unwrap();
    assert_eq!(store.prune_stand_in_history(7, at).unwrap(), 4);
    let actions = store.stand_in_actions(7).unwrap();
    for id in [
        "recent",
        "queued",
        "sending",
        "latest-failure",
        "assessment",
        "unknown-result",
    ] {
        assert!(actions.iter().any(|action| action["id"] == id), "{id}");
    }
    assert_eq!(actions.len(), 6);
    assert_eq!(store.stand_in_actions(8).unwrap().len(), 1);
    let compact = store
        .stand_in_event(7, event["id"].as_str().unwrap())
        .unwrap();
    assert_eq!(compact["compacted"], true);
    assert!(compact.get("message").is_none());
    assert_eq!(
        store
            .enqueue_stand_in_event(7, json!("settled"), event)
            .unwrap(),
        compact
    );
    for id in ["blocked", "waiting", "snapshot"] {
        assert_eq!(store.stand_in_event(7, id).unwrap()["payload"], "Keep");
    }
    assert!(store.get_item("expired-route", "stand_in_route").is_err());
    assert!(store.get_item("live-route", "stand_in_route").is_ok());
    assert!(store.get_item("failed-route", "stand_in_route").is_ok());
    assert_eq!(store.prune_stand_in_history(7, at).unwrap(), 0);
}

#[test]
fn retention_is_bounded_and_resumes_the_backlog_without_waiting_a_day() {
    let root = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(root.path().join("tasks.sqlite")).unwrap();
    let at = Utc::now();
    {
        let mut guard = store.connection().unwrap();
        let tx = guard.transaction().unwrap();
        for index in 0..=CLEANUP_BATCH {
            write(&tx, "stand_in_action", &json!({"id":format!("old-{index}"),"userId":7,"status":"succeeded","kind":"ignore_events"})).unwrap();
        }
        tx.execute(
            "UPDATE loop_items SET updated_at=?1 WHERE resource_type='stand_in_action'",
            [(at - chrono::Duration::days(8)).to_rfc3339()],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(store.prune_stand_in_history(7, at).unwrap(), CLEANUP_BATCH);
    assert_eq!(store.stand_in_actions(7).unwrap().len(), 1);
    assert_eq!(store.prune_stand_in_history(7, at).unwrap(), 1);
    assert_eq!(store.prune_stand_in_history(7, at).unwrap(), 0);
}
