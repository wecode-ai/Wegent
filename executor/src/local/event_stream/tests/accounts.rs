use super::*;

#[test]
fn backend_replay_keeps_original_accounts_while_local_history_remains_available() {
    let root = tempfile::tempdir().unwrap();
    let hub = event_hub();
    hub.enable_terminal_event_journal(root.path().to_owned());
    hub.bind_backend_journal("account-a");
    hub.publish(scoped(json!({"event":"response.output_text.delta","payload":{"taskId":"a","data":{"delta":"private-a"}}}), "account-a"));
    hub.bind_backend_journal("account-b");
    hub.publish(scoped(
        json!({"event":"response.completed","payload":{"taskId":"a","data":{"value":"late-a"}}}),
        "account-a",
    ));
    hub.publish(scoped(json!({"event":"response.output_text.delta","payload":{"taskId":"b","data":{"delta":"private-b"}}}), "account-b"));
    hub.publish(json!({"event":"runtime.work.changed","payload":{"taskId":"unowned-local"}}));

    let a = hub.subscribe_backend("account-a", 0).replay;
    let b = hub.subscribe_backend("account-b", 0).replay;
    assert_eq!(a.len(), 1);
    assert_eq!(a[0]["payload"]["taskId"], "a");
    assert_eq!(b.len(), 1);
    assert_eq!(b[0]["payload"]["taskId"], "b");
    assert!(hub
        .pending_backend_terminals("account-b")
        .unwrap()
        .is_empty());
    let pending = hub.pending_backend_terminals("account-a").unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["payload"]["data"]["value"], "late-a");
    let local = hub.subscribe_after(0).replay;
    assert_eq!(local.len(), 4);
    assert_eq!(local[3]["payload"]["taskId"], "unowned-local");
    assert!(local
        .iter()
        .chain(a.iter())
        .chain(b.iter())
        .chain(pending.iter())
        .all(|event| event.get(super::super::RAW_ACCOUNT).is_none()));
    drop(hub);

    let reopened = event_hub();
    reopened.enable_terminal_event_journal(root.path().to_owned());
    reopened.bind_backend_journal("account-b");
    assert!(reopened
        .pending_backend_terminals("account-b")
        .unwrap()
        .is_empty());
    assert_eq!(
        reopened.pending_backend_terminals("account-a").unwrap(),
        pending
    );
}

#[test]
fn coalescing_cannot_merge_events_from_different_accounts() {
    let event = json!({"event":"response.block.updated","payload":{"taskId":"same-task","subtaskId":"same-turn","data":{"block_id":"same-block"}}});
    assert_ne!(
        coalescing_key(&scoped(event.clone(), "account-a")),
        coalescing_key(&scoped(event, "account-b")),
    );
}

#[test]
fn a_late_accounts_persisted_sequence_is_loaded_before_allocating_a_terminal() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("account-a");
    std::fs::create_dir_all(&directory).unwrap();
    let original =
        json!({"event":"response.completed","sequence":41,"payload":{"taskId":"original-a"}});
    std::fs::write(
        directory.join("41.json"),
        serde_json::to_vec(&original).unwrap(),
    )
    .unwrap();
    let hub = event_hub();
    hub.enable_terminal_event_journal(root.path().to_owned());
    hub.bind_backend_journal("account-b");
    // Simulate a clock rollback across a restart while A remains disconnected.
    hub.state.lock().unwrap().next_sequence = 41;
    hub.publish(scoped(
        json!({"event":"response.completed","payload":{"taskId":"late-a"}}),
        "account-a",
    ));
    let pending = hub.pending_backend_terminals("account-a").unwrap();
    assert_eq!(pending.len(), 2);
    assert!(pending.contains(&original));
    let late = pending
        .iter()
        .find(|event| event["payload"]["taskId"] == "late-a")
        .unwrap();
    assert!(event_sequence(late).unwrap() > 41);
    assert!(hub
        .pending_backend_terminals("account-b")
        .unwrap()
        .is_empty());
}
