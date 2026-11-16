use super::*;

#[tokio::test]
async fn versioned_intake_deduplicates_replay_and_only_advances_after_durable_intake() {
    let root = tempfile::tempdir().unwrap();
    let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
    handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
    handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
    let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
    let source = json!({"providerId":"calendar-plugin/events","profile":"account","kind":"calendar","id":"work","enabledAfter":"2026-11-04T00:00:00Z","policy":{"automatic":true,"askBeforeAct":true}});
    let roles = vec![json!({"id":"@primary","enabled":true,"connections":[source]})];
    let mut message = json!({"id":"one-delivery","objectId":"work/event:42","version":"v1","text":"A meeting was rescheduled","at":"2026-11-05T00:00:00Z"});
    let before = json!({"checkpoint":{"cursor":"before"}});
    store.save_stand_in_source(7, &source, &before).unwrap();
    let next = handler
        .collect_connection_page(
            &store,
            7,
            &source,
            &roles,
            (
                vec![message.clone()],
                json!({"checkpoint":{"cursor":"after"}}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(store.stand_in_events(7).unwrap().len(), 1);
    assert_eq!(
        store.stand_in_source(7, &source).unwrap()["checkpoint"],
        before["checkpoint"]
    );
    save_collection_result(&store, 7, &source, &json!(1), &before, Ok(next)).unwrap();
    let saved = store.stand_in_source(7, &source).unwrap();
    assert_eq!(saved["checkpoint"]["cursor"], "after");
    let mut original = store.stand_in_events(7).unwrap().remove(0);
    original["status"] = json!("handled");
    store.save_stand_in_event(7, &original).unwrap();
    message["id"] = json!("another-delivery");
    let mut changed = message.clone();
    changed["id"] = json!("one-delivery");
    changed["version"] = json!("v2");
    handler
        .collect_connection_page(
            &store,
            7,
            &source,
            &roles,
            (
                vec![message, changed],
                json!({"checkpoint":{"cursor":"later"}}),
            ),
        )
        .await
        .unwrap();
    let events = store.stand_in_events(7).unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events
            .iter()
            .find(|event| event["id"] == original["id"])
            .unwrap()["status"],
        "handled"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| event["status"] == "pending")
            .count(),
        1
    );
    let failure = handler
        .collect_connection_page(&store, 7, &source, &roles, (vec![json!({"id":"bad","text":"Missing version","at":"2026-11-05T00:00:00Z","objectId":"work/event:42"})], json!({"checkpoint":{"cursor":"must-not-save"}})))
        .await;
    assert!(failure.is_err());
    save_collection_result(&store, 7, &source, &json!(1), &saved, failure).unwrap();
    assert_eq!(
        store.stand_in_source(7, &source).unwrap()["checkpoint"]["cursor"],
        "after"
    );
    assert_eq!(store.stand_in_events(7).unwrap().len(), 2);
    assert!(store.list_stand_in_work(7, None).unwrap().is_empty());
}
