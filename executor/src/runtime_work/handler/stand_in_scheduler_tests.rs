use super::tests::{connection_event, fixture};
use super::*;

async fn personal_processing_needed(handler: &RuntimeWorkRpcHandler) -> bool {
    let response = handler
        .coordination_rpc("runtime.coordination.contexts", json!({}))
        .await
        .unwrap();
    let context = response["contexts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|context| context["id"] == "personal:7")
        .unwrap();
    context["needsProcessing"].as_bool().unwrap()
}

#[tokio::test]
async fn discovery_is_idle_until_intake_is_due() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    let previous = store.stand_in_processing_state(7).unwrap();
    assert!(!personal_processing_needed(&handler).await);
    assert_eq!(store.stand_in_processing_state(7).unwrap(), previous);

    let mut event = connection_event();
    event["notBefore"] = json!((chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
    let mut event = store
        .enqueue_stand_in_event(7, json!("deferred-intake"), event)
        .unwrap();
    assert!(!personal_processing_needed(&handler).await);

    event["notBefore"] = json!((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339());
    store.save_stand_in_event(7, &event).unwrap();
    assert!(personal_processing_needed(&handler).await);
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["events"][0]["id"], event["id"]);
}

#[tokio::test]
async fn discovery_notices_work_state_changes_and_returns_to_idle() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    let mut link = RuntimeTaskLink {
        local_task_id: "stand-in-work".into(),
        status: "queued".into(),
        created_at: chrono::Utc::now().timestamp_millis(),
        runtime_handle: json!({"origin":{"initiatedBy":"stand_in","userId":7,"standInId":"default"}}),
        ..Default::default()
    };
    handler.upsert_local_task(link.clone());
    assert!(personal_processing_needed(&handler).await);
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["skip"], true);
    assert!(!personal_processing_needed(&handler).await);

    link.status = "done".into();
    handler.upsert_local_task(link);
    assert!(personal_processing_needed(&handler).await);
    handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    let events = store.stand_in_events(7).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["kind"], "work_state");
    assert_eq!(events[0]["taskId"], "stand-in-work");
    assert_eq!(events[0]["state"][3], "done");
}

#[tokio::test]
async fn explicit_check_admits_one_snapshot_when_idle() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, _) = fixture(root.path());
    assert!(!personal_processing_needed(&handler).await);
    handler
        .coordination_rpc(
            "runtime.coordination.wake",
            json!({"contextId":"personal:7"}),
        )
        .await
        .unwrap();
    assert!(personal_processing_needed(&handler).await);
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["skip"], true);
    assert!(!personal_processing_needed(&handler).await);
}

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
    assert!(!personal_processing_needed(&handler).await);
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
    assert!(personal_processing_needed(&handler).await);
    let snapshot = handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap();
    assert_eq!(snapshot["events"].as_array().unwrap().len(), 1);
    assert_eq!(snapshot["events"][0]["id"], fresh["id"]);
}

#[tokio::test]
async fn explicit_check_retries_precreation_failure_with_the_original_intent_identity() {
    let root = tempfile::tempdir().unwrap();
    let (handler, store, settings) = fixture(root.path());
    let event = store
        .enqueue_stand_in_event(7, json!("precreation"), connection_event())
        .unwrap();
    store
        .save_stand_in_processing_state(7, &json!({"batchId":"batch"}))
        .unwrap();
    let action = store
        .queue_stand_in_action(
            7,
            "mac",
            "batch",
            "create_work",
            json!({"roleId":"removed-role","title":"Work","eventIds":[event["id"]]}),
        )
        .unwrap();
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    assert!(handler.local_task_links(true).is_empty());
    assert_eq!(store.pending_stand_in_actions(7).unwrap().len(), 0);
    handler
        .coordination_rpc(
            "runtime.coordination.wake",
            json!({"contextId":"personal:7"}),
        )
        .await
        .unwrap();
    assert_eq!(store.retry_failed_stand_in_routing(7).unwrap(), 1);
    let retried = store.pending_stand_in_actions(7).unwrap();
    assert_eq!(retried.len(), 1);
    assert_eq!(retried[0]["id"], action["id"]);
    assert_eq!(retried[0]["resolution"], "explicit_retry");
    handler
        .execute_coordinator_actions(&store, 7, &settings)
        .await
        .unwrap();
    assert_eq!(store.stand_in_actions(7).unwrap().len(), 1);
    assert_eq!(store.stand_in_actions(7).unwrap()[0]["status"], "failed");
    assert!(handler
        .coordination_snapshot_for_test(&store, 7)
        .await
        .unwrap()["events"]
        .as_array()
        .unwrap()
        .is_empty());
}
