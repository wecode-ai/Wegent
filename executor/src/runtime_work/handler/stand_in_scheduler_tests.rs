use super::tests::{connection_event, fixture};
use super::*;

#[tokio::test]
async fn explicit_check_recovers_an_assessment_that_failed_before_command_acceptance() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    let event = store
        .enqueue_stand_in_event(7, json!("failed-assessment"), connection_event())
        .unwrap();
    store
        .save_stand_in_processing_state(7, &json!({"batchId":"batch"}))
        .unwrap();
    let mut action = store
        .queue_stand_in_action(
            7,
            "mac",
            "batch",
            "create_work",
            json!({"eventIds":[event["id"]]}),
        )
        .unwrap();
    action["kind"] = json!("assess");
    action["status"] = json!("failed");
    store.save_stand_in_action(7, &action).unwrap();
    assert!(handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap()["events"]
        .as_array()
        .unwrap()
        .is_empty());
    handler
        .coordination_rpc(
            "runtime.coordination.wake",
            json!({"contextId":"personal:7"}),
        )
        .await
        .unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "cancelled");
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["events"][0]["id"], event["id"]);
}

#[tokio::test]
async fn failed_routing_is_not_replanned_but_new_direct_events_still_reach_the_router() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, mut settings) = fixture(root.path());
    settings["roles"][0]["connections"][0]["policy"]["immediate"] = json!(true);
    let settings = store.save_personal_stand_in(7, "mac", settings).unwrap();
    let failed = store
        .enqueue_stand_in_event(7, json!("failed-event"), connection_event())
        .unwrap();
    store
        .save_stand_in_processing_state(7, &json!({"batchId":"batch"}))
        .unwrap();
    store
        .queue_stand_in_action(
            7,
            "mac",
            "batch",
            "create_work",
            json!({"roleId":"removed-role","title":"Work","eventIds":[failed["id"]]}),
        )
        .unwrap();
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "failed");
    for _ in 0..3 {
        let snapshot = handler
            .coordination_snapshot_for_test(&store, 7)
            .await
            .unwrap();
        assert_eq!(snapshot["events"], json!([]));
        assert_eq!(store.stand_in_actions(7).unwrap().len(), 1);
    }
    assert_eq!(
        store
            .stand_in_event(7, failed["id"].as_str().unwrap())
            .unwrap()["status"],
        "pending"
    );
    let fresh = store
        .enqueue_stand_in_event(7, json!("fresh-event"), connection_event())
        .unwrap();
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["events"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["events"][0]["id"], fresh["id"]);
}
