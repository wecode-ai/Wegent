use super::*;
use wegent_protocol::connection_events::observation_identity;

pub(super) fn attach(task: &str, key: &str) -> Value {
    json!({"action":"attach","initialCheckpoint":{"cursor":0},"subscription":{"subscription_key":key,"device_id":"device","task_id":task,"session":{"engine":"Codex","id":"original-thread"},"source":{"providerId":"documents","profile":"account","kind":"document","id":"document","name":"Document","enabledAfter":"2026-11-15T00:00:00Z"},"match":{"/eventType":"document.updated"},"continuation":"Continue the original work"}})
}
pub(super) fn run(state: &mut Value, input: Value, now: i64) -> Value {
    state::apply(state, &input, now).unwrap()
}

#[test]
fn a_device_subscription_cannot_be_retargeted_to_a_new_native_session() {
    let mut document = state::empty();
    let input = attach("task", "wait");
    let attached = run(&mut document, input.clone(), 0);
    let before = document.clone();
    for (field, value) in [
        ("id", json!("replacement-thread")),
        ("engine", json!("ClaudeCode")),
    ] {
        let mut replacement = input.clone();
        replacement["subscription"]["session"][field] = value;
        assert_eq!(
            state::apply(&mut document, &replacement, 1).unwrap_err(),
            "observation_subscription_conflict"
        );
        assert_eq!(document, before);
    }
    assert_eq!(
        document["subscriptions"][attached["subscriptionId"].as_str().unwrap()]["intent"]["target"]
            ["session"]["id"],
        "original-thread"
    );
}
pub(super) fn commit_input(lease: &Value, mut event: Value) -> Value {
    if event.get("at").is_none() {
        event["at"] = json!("2026-11-15T00:00:01Z");
    }
    json!({"action":"commit","observationId":lease["observation"]["id"],"leaseId":lease["lease"]["id"],"page":{"events":[event.clone(),event],"nextCheckpoint":{"cursor":1}}})
}

#[test]
fn collection_and_delivery_have_independent_fenced_leases_and_durable_batches() {
    let mut state = state::empty();
    let first = run(&mut state, attach("task-a", "wait"), 0);
    let second = run(&mut state, attach("task-b", "wait"), 0);
    assert_eq!(state["observations"].as_object().unwrap().len(), 1);
    assert_eq!(run(&mut state, attach("task-a", "wait"), 0), first);
    let lease = run(&mut state, json!({"action":"claim"}), 1000);
    assert!(run(&mut state, json!({"action":"claim"}), 1001)["lease"].is_null());
    let late = commit_input(
        &lease,
        json!({"id":"event-1","eventType":"document.updated","text":"Changed"}),
    );
    assert_eq!(
        state::apply(&mut state, &late, 61000).unwrap_err(),
        "observation_lease_lost"
    );
    let replacement = run(&mut state, json!({"action":"claim"}), 61001);
    assert_ne!(replacement["lease"]["id"], lease["lease"]["id"]);
    assert!(state::apply(&mut state, &late, 61002).is_err());
    let input = commit_input(
        &replacement,
        json!({"id":"event-1","eventType":"document.updated","text":"Changed"}),
    );
    let receipt = run(&mut state, input.clone(), 61003);
    assert_eq!(run(&mut state, input, 61004), receipt);
    assert_eq!(state["deliveries"].as_object().unwrap().len(), 2);
    assert_eq!(
        state["observations"][replacement["observation"]["id"].as_str().unwrap()]["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // A pending consumer owns its captured batch after shared history is compacted.
    let original = state["deliveries"].clone();
    state["observations"][replacement["observation"]["id"].as_str().unwrap()]["events"] = json!([]);
    let mut restarted: Value = serde_json::from_str(&state.to_string()).unwrap();
    assert_eq!(restarted["deliveries"], original);
    let pending =
        run(&mut restarted, json!({"action":"claim_delivery"}), 61005)["delivery"].clone();
    assert_eq!(pending["events"].as_array().unwrap().len(), 1);
    run(
        &mut restarted,
        json!({"action":"cancel","subscriptionId":pending["subscriptionId"]}),
        61006,
    );
    assert!(state::apply(&mut restarted,&json!({"action":"ack_delivery","deliveryId":pending["id"],"leaseId":pending["lease"]["id"],"receipt":{"accepted":true}}),61007).is_err());
    let other_id = if pending["subscriptionId"] == first["subscriptionId"] {
        &second["subscriptionId"]
    } else {
        &first["subscriptionId"]
    };
    assert_eq!(
        restarted["subscriptions"][other_id.as_str().unwrap()]["status"],
        "pending"
    );
}

#[test]
fn manual_refresh_projection_waits_for_the_requested_collection_version() {
    let mut state = state::empty();
    let attached = run(&mut state, attach("task", "wait"), 0);
    let query = json!({"action":"get_subscription","subscriptionId":attached["subscriptionId"]});
    let old = run(&mut state, json!({"action":"claim"}), 1);
    run(
        &mut state,
        json!({"action":"refresh","observationId":old["observation"]["id"]}),
        2,
    );
    assert_eq!(
        run(&mut state, query.clone(), 3)["observation"]["refreshPending"],
        true
    );
    run(
        &mut state,
        commit_input(&old, json!({"id":"ignored","eventType":"document.created"})),
        4,
    );
    assert_eq!(
        run(&mut state, query.clone(), 5)["observation"]["refreshPending"],
        true
    );
    let requested = run(&mut state, json!({"action":"claim"}), 6);
    run(
        &mut state,
        commit_input(
            &requested,
            json!({"id":"newer","eventType":"document.created"}),
        ),
        7,
    );
    assert_eq!(
        run(&mut state, query, 8)["observation"]["refreshPending"],
        false
    );
}

#[test]
fn refresh_during_collection_is_not_lost_and_account_identity_isolated() {
    let mut state = state::empty();
    run(&mut state, attach("task", "wait"), 0);
    let lease = run(&mut state, json!({"action":"claim"}), 1);
    run(
        &mut state,
        json!({"action":"refresh","observationId":lease["observation"]["id"]}),
        2,
    );
    run(
        &mut state,
        commit_input(
            &lease,
            json!({"id":"ignored","eventType":"document.created"}),
        ),
        3,
    );
    assert!(!run(&mut state, json!({"action":"claim"}), 4)["lease"].is_null());
    let mut other = attach("other", "wait");
    other["subscription"]["source"]["profile"] = json!("other-account");
    run(&mut state, other, 5);
    assert_eq!(state["observations"].as_object().unwrap().len(), 2);
    let mut forged = attach("task", "wait");
    forged["subscription"]["continuation"] = json!("Different work");
    assert_eq!(
        state::apply(&mut state, &forged, 6).unwrap_err(),
        "observation_subscription_conflict"
    );
}

#[test]
fn nested_corruption_is_rejected_without_repairing_or_resetting_durable_state() {
    let mut original = state::empty();
    run(&mut original, attach("task", "wait"), 0);
    let observation = original["observations"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    let subscription = original["subscriptions"]
        .as_object()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    for (path, value) in [
        (format!("/observations/{observation}/events"), json!({})),
        (
            format!("/observations/{observation}/sequence"),
            json!("broken"),
        ),
        (
            format!("/observations/{observation}/lease"),
            json!({"id":"missing-expiry"}),
        ),
        (
            format!("/subscriptions/{subscription}/observationId"),
            json!("missing-source"),
        ),
    ] {
        let mut broken = original.clone();
        *broken.pointer_mut(&path).unwrap() = value;
        let before = broken.clone();
        assert_eq!(
            state::apply(&mut broken, &json!({"action":"claim"}), 1).unwrap_err(),
            "observation_storage_conflict"
        );
        assert_eq!(broken, before);
    }
}

#[test]
fn cancelling_the_last_consumer_fences_collection_and_a_new_wait_uses_a_fresh_boundary() {
    let mut state = state::empty();
    let first = run(&mut state, attach("first", "wait"), 0);
    let second = run(&mut state, attach("second", "wait"), 0);
    let lease = run(&mut state, json!({"action":"claim"}), 1);
    let renew = json!({"action":"renew","observationId":lease["observation"]["id"],"leaseId":lease["lease"]["id"]});
    run(
        &mut state,
        json!({"action":"cancel","subscriptionId":first["subscriptionId"]}),
        2,
    );
    run(&mut state, renew.clone(), 3);
    run(
        &mut state,
        json!({"action":"cancel","subscriptionId":second["subscriptionId"]}),
        4,
    );
    assert_eq!(
        state::apply(&mut state, &renew, 5).unwrap_err(),
        "observation_lease_lost"
    );
    assert!(
        state::apply(
            &mut state,
            &commit_input(&lease, json!({"id":"stale","eventType":"document.updated"})),
            6
        )
        .is_err()
    );
    let mut fresh = attach("third", "new-wait");
    fresh["initialCheckpoint"] = json!({"cursor":99});
    fresh["subscription"]["source"]["enabledAfter"] = json!("2026-11-16T00:00:00Z");
    run(&mut state, fresh, 7);
    let resumed = run(&mut state, json!({"action":"claim"}), 8);
    assert_eq!(resumed["observation"]["checkpoint"], json!({"cursor":99}));
    assert_eq!(
        resumed["observation"]["source"]["enabledAfter"],
        "2026-11-16T00:00:00Z"
    );
}

#[test]
fn repeated_commit_and_ack_require_the_same_canonical_input() {
    let mut state = state::empty();
    run(&mut state, attach("task", "wait"), 0);
    let lease = run(&mut state, json!({"action":"claim"}), 1);
    let input = commit_input(&lease, json!({"id":"event","eventType":"document.updated"}));
    let accepted = run(&mut state, input.clone(), 2);
    assert_eq!(run(&mut state, input.clone(), 3), accepted);
    let mut conflict = input;
    conflict["page"]["nextCheckpoint"] = json!({"cursor":999});
    let before = state.clone();
    assert_eq!(
        state::apply(&mut state, &conflict, 4).unwrap_err(),
        "observation_commit_conflict"
    );
    assert_eq!(state, before);
    let pending = run(&mut state, json!({"action":"claim_delivery"}), 5)["delivery"].clone();
    let mut ack = json!({"action":"ack_delivery","deliveryId":pending["id"],"leaseId":pending["lease"]["id"],"receipt":{"accepted":true,"operationId":"original"}});
    assert_eq!(
        state::apply(&mut state, &ack, 6).unwrap_err(),
        "observation_delivery_admission_conflict"
    );
    run(
        &mut state,
        json!({"action":"admit_delivery","subscriptionId":pending["subscriptionId"],"deliveryId":pending["id"],"leaseId":pending["lease"]["id"],"deviceId":"device","taskId":"task","operationId":"original"}),
        6,
    );
    let receipt = run(&mut state, ack.clone(), 6);
    assert_eq!(run(&mut state, ack.clone(), 7), receipt);
    ack["receipt"]["operationId"] = json!("different");
    assert_eq!(
        state::apply(&mut state, &ack, 8).unwrap_err(),
        "observation_delivery_conflict"
    );
}

#[test]
fn collection_backoff_preserves_the_cursor_and_manual_refresh_recovers_suspended_sources() {
    let mut state = state::empty();
    run(&mut state, attach("task", "wait"), 0);
    let first = run(&mut state, json!({"action":"claim"}), 1);
    let observation_id = first["observation"]["id"].clone();
    let fail = |lease: &Value, retry: Option<i64>| {
        let mut input = json!({"action":"fail","observationId":observation_id,"leaseId":lease["lease"]["id"],"errorCode":"connection_unavailable"});
        if let Some(retry) = retry {
            input["retryAfterMs"] = json!(retry);
        }
        input
    };
    run(&mut state, fail(&first, Some(30_000)), 2);
    assert!(run(&mut state, json!({"action":"claim"}), 30_001)["lease"].is_null());
    let second = run(&mut state, json!({"action":"claim"}), 30_002);
    assert_eq!(second["observation"]["checkpoint"], json!({"cursor":0}));
    run(&mut state, fail(&second, Some(30_000)), 30_003);
    assert!(run(&mut state, json!({"action":"claim"}), 90_002)["lease"].is_null());
    let third = run(&mut state, json!({"action":"claim"}), 90_003);
    run(&mut state, fail(&third, None), 90_004);
    assert!(run(&mut state, json!({"action":"claim"}), 9_000_000)["lease"].is_null());
    run(
        &mut state,
        json!({"action":"refresh","observationId":observation_id}),
        9_000_001,
    );
    let recovery = run(&mut state, json!({"action":"claim"}), 9_000_002);
    let before = state.clone();
    assert_eq!(
        state::apply(&mut state, &fail(&third, Some(1)), 9_000_003).unwrap_err(),
        "observation_lease_lost"
    );
    assert_eq!(state, before);
    run(
        &mut state,
        json!({"action":"commit","observationId":observation_id,"leaseId":recovery["lease"]["id"],"page":{"events":[],"nextCheckpoint":{"cursor":1}}}),
        9_000_004,
    );
    let row = &state["observations"][observation_id.as_str().unwrap()];
    assert_eq!(row["failureCount"], 0);
    assert_eq!(row["suspended"], false);
    assert!(row["errorCode"].is_null());
    assert_eq!(row["checkpoint"], json!({"cursor":1}));
    assert_eq!(row["nextPollAt"], 9_015_004);
}

#[test]
fn joining_an_active_collector_does_not_deliver_its_inflight_historical_events() {
    let mut state = state::empty();
    let first = run(&mut state, attach("first", "wait"), 0);
    let lease = run(&mut state, json!({"action":"claim"}), 1);
    let mut later = attach("second", "wait");
    later["subscription"]["source"]["enabledAfter"] = json!("2026-11-15T08:00:10+08:00");
    later["initialCheckpoint"] = json!({"cursor":99});
    let second = run(&mut state, later, 2);
    assert_eq!(state["observations"].as_object().unwrap().len(), 1);
    let mut input = commit_input(&lease, json!({"id":"old","eventType":"document.updated"}));
    input["page"]["events"] = json!([
        {"id":"old","eventType":"document.updated","at":"2026-11-15T00:00:09.999Z"},
        {"id":"new","eventType":"document.updated","at":"2026-11-15T00:00:10Z"}
    ]);
    run(&mut state, input, 3);
    for (subscription, expected) in [(first, json!(["old", "new"])), (second, json!(["new"]))] {
        let id = subscription["subscriptionId"].as_str().unwrap();
        let delivery =
            &state["deliveries"][state["subscriptions"][id]["deliveryId"].as_str().unwrap()];
        assert_eq!(
            json!(
                delivery["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|event| &event["id"])
                    .collect::<Vec<_>>()
            ),
            expected
        );
    }
}

#[test]
fn shared_ordered_consumers_keep_independent_activation_positions() {
    let mut state = state::empty();
    let mut first = attach("first", "wait");
    first["subscription"]["source"]["boundary"] = json!({"partition":"inbox","sequence":0});
    run(&mut state, first, 0);
    let lease = run(&mut state, json!({"action":"claim"}), 1);
    let mut later = attach("second", "wait");
    later["subscription"]["source"]["boundary"] = json!({"partition":"inbox","sequence":99});
    let second = run(&mut state, later, 2);
    assert_eq!(state["observations"].as_object().unwrap().len(), 1);
    let mut input = commit_input(
        &lease,
        json!({"id":"unused","eventType":"document.updated"}),
    );
    input["page"]["events"] = json!([
        {"id":"equal","eventType":"document.updated","at":"2026-11-15T00:00:00Z","position":{"partition":"inbox","sequence":99}},
        {"id":"foreign","eventType":"document.updated","at":"2026-11-15T00:00:00Z","position":{"partition":"other","sequence":100}},
        {"id":"new","eventType":"document.updated","at":"2026-11-14T23:59:59Z","position":{"partition":"inbox","sequence":100}}
    ]);
    run(&mut state, input, 3);
    let id = second["subscriptionId"].as_str().unwrap();
    let delivery = &state["deliveries"][state["subscriptions"][id]["deliveryId"].as_str().unwrap()];
    assert_eq!(delivery["source"], state["subscriptions"][id]["activation"]);
    assert_eq!(delivery["events"].as_array().unwrap().len(), 1);
    assert_eq!(delivery["events"][0]["id"], "new");
    let mut invalid = attach("invalid", "wait");
    invalid["subscription"]["source"]["enabledAfter"] = json!("invalid");
    let before = state.clone();
    assert_eq!(
        state::apply(&mut state, &invalid, 4).unwrap_err(),
        "invalid_observation_activation"
    );
    assert_eq!(state, before);
}

#[test]
fn recovery_retains_exact_tool_intent_and_rejects_conflicting_backfills() {
    let mut state = state::empty();
    let mut request = attach("task", "original-key");
    let subscription = &mut request["subscription"];
    let original = json!({"source":observation_identity(&subscription["source"]),"match":subscription["match"],"continuation":subscription["continuation"],"wait_for_event":false});
    subscription["source"]["boundary"] = json!({"partition":"inbox","sequence":23});
    subscription["source"]["policy"] = json!({"automatic":false,"askBeforeAct":true});
    let attached = run(&mut state, request.clone(), 0);
    let id = attached["subscriptionId"].as_str().unwrap();
    request["subscription"]["request_intent"] = original.clone();
    let backfilled = run(&mut state, request.clone(), 1);
    assert_eq!(backfilled["subscription"]["requestIntent"], original);
    assert!(
        backfilled["subscription"]["requestIntent"]["source"]
            .get("boundary")
            .is_none()
    );
    assert_eq!(
        backfilled["subscription"]["activation"]["boundary"]["sequence"],
        23
    );
    let before = state.clone();
    assert_eq!(run(&mut state, request.clone(), 2), backfilled);
    assert_eq!(state, before);
    request["subscription"]["request_intent"]["source"]["policy"] = json!({"automatic":true});
    assert_eq!(
        state::apply(&mut state, &request, 3).unwrap_err(),
        "observation_subscription_conflict"
    );
    assert_eq!(state, before);
    request["subscription"]["request_intent"]["continuation"] = json!("Different work");
    assert_eq!(
        state::apply(&mut state, &request, 4).unwrap_err(),
        "invalid_observation_request_intent"
    );
    assert_eq!(state, before);
    state["subscriptions"][id]["requestIntent"]["source"]["id"] = json!("foreign-resource");
    assert_eq!(
        validation::validate(&state).unwrap_err(),
        "observation_storage_conflict"
    );
}

#[test]
fn cold_task_recovery_preserves_captured_batches_and_terminal_state() {
    let mut state = state::empty();
    let mut request = attach("task", "original-key");
    request["subscription"]["wait_for_event"] = json!(true);
    let attached = run(&mut state, request.clone(), 0);
    let id = attached["subscriptionId"].as_str().unwrap();
    run(&mut state, attach("other-task", "private-key"), 0);
    let mut other_device = attach("task", "other-device-key");
    other_device["subscription"]["device_id"] = json!("other-device");
    run(&mut state, other_device, 0);
    let lease = run(&mut state, json!({"action":"claim"}), 1);
    run(
        &mut state,
        commit_input(&lease, json!({"id":"event","eventType":"document.updated"})),
        2,
    );
    let query = json!({"action":"get_task_subscriptions","deviceId":"device","taskId":"task"});
    let before = state.clone();
    let recovered = run(&mut state, query.clone(), 3);
    assert_eq!(state, before);
    let rows = recovered["subscriptions"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["subscription"]["subscriptionKey"], "original-key");
    assert_eq!(rows[0]["subscription"]["waitForEvent"], true);
    assert_eq!(rows[0]["delivery"]["events"][0]["id"], "event");
    for key in [
        "checkpoint",
        "events",
        "lease",
        "collectorDeviceId",
        "collector",
    ] {
        assert!(rows[0]["observation"].get(key).is_none());
    }
    run(
        &mut state,
        json!({"action":"cancel","subscriptionId":id}),
        4,
    );
    // Older records can regain their descriptors without rearming or losing a batch.
    state["subscriptions"][id]
        .as_object_mut()
        .unwrap()
        .remove("subscriptionKey");
    state["subscriptions"][id]
        .as_object_mut()
        .unwrap()
        .remove("waitForEvent");
    let mut expected = state.clone();
    expected["subscriptions"][id]["subscriptionKey"] = json!("original-key");
    expected["subscriptions"][id]["waitForEvent"] = json!(true);
    run(&mut state, request.clone(), 5);
    assert_eq!(state, expected);
    let recovered = run(&mut state, query, 6);
    assert_eq!(
        recovered["subscriptions"][0]["subscription"]["status"],
        "cancelled"
    );
    request["subscription"]["wait_for_event"] = json!(false);
    assert_eq!(
        state::apply(&mut state, &request, 7).unwrap_err(),
        "observation_subscription_conflict"
    );
    assert_eq!(state, expected);
    state["subscriptions"][id]["subscriptionKey"] = json!("corrupt-key");
    assert_eq!(
        validation::validate(&state).unwrap_err(),
        "observation_storage_conflict"
    );
}

#[test]
fn runtime_reads_only_its_subscription_and_captured_delivery() {
    let mut state = state::empty();
    let first = run(&mut state, attach("first", "wait"), 0);
    let second = run(&mut state, attach("second", "wait"), 0);
    let lease = run(&mut state, json!({"action":"claim"}), 1);
    let initial = run(
        &mut state,
        json!({"action":"get_subscription","subscriptionId":first["subscriptionId"]}),
        2,
    );
    assert!(initial["delivery"].is_null());
    assert!(initial["observation"].get("checkpoint").is_none());
    assert!(initial["observation"].get("lease").is_none());
    assert!(initial["observation"].get("events").is_none());
    run(
        &mut state,
        commit_input(&lease, json!({"id":"event","eventType":"document.updated"})),
        3,
    );
    let output = run(
        &mut state,
        json!({"action":"get_subscription","subscriptionId":first["subscriptionId"]}),
        4,
    );
    assert_eq!(output["subscription"]["id"], first["subscriptionId"]);
    assert_eq!(
        output["delivery"]["subscriptionId"],
        first["subscriptionId"]
    );
    assert_eq!(output["delivery"]["events"][0]["id"], "event");
    assert!(
        !output
            .to_string()
            .contains(second["subscriptionId"].as_str().unwrap())
    );
    let before = state.clone();
    assert_eq!(
        state::apply(
            &mut state,
            &json!({"action":"get_subscription","subscriptionId":"unknown"}),
            5
        )
        .unwrap_err(),
        "observation_subscription_unavailable"
    );
    assert_eq!(state, before);
}

#[test]
fn delivery_renewal_fences_expired_replaced_and_cancelled_workers() {
    let mut state = state::empty();
    let subscription = run(&mut state, attach("task", "wait"), 0);
    let collection = run(&mut state, json!({"action":"claim"}), 1);
    run(
        &mut state,
        commit_input(
            &collection,
            json!({"id":"event","eventType":"document.updated"}),
        ),
        2,
    );
    let delivery = run(&mut state, json!({"action":"claim_delivery"}), 3)["delivery"].clone();
    let renew = json!({"action":"renew_delivery","deliveryId":delivery["id"],"leaseId":delivery["lease"]["id"]});
    assert_eq!(
        run(&mut state, renew.clone(), 20_003)["lease"]["expiresAt"],
        80_003
    );
    assert!(run(&mut state, json!({"action":"claim_delivery"}), 60_003)["delivery"].is_null());
    let before = state.clone();
    assert_eq!(
        state::apply(&mut state, &renew, 80_003).unwrap_err(),
        "observation_delivery_lease_lost"
    );
    assert_eq!(state, before);
    let replacement =
        run(&mut state, json!({"action":"claim_delivery"}), 80_004)["delivery"].clone();
    assert_ne!(replacement["lease"]["id"], delivery["lease"]["id"]);
    assert!(state::apply(&mut state, &renew, 80_005).is_err());
    run(
        &mut state,
        json!({"action":"cancel","subscriptionId":subscription["subscriptionId"]}),
        80_006,
    );
    let before = state.clone();
    assert_eq!(state::apply(&mut state, &json!({"action":"renew_delivery","deliveryId":replacement["id"],"leaseId":replacement["lease"]["id"]}), 80_007).unwrap_err(), "observation_delivery_lease_lost");
    assert_eq!(state, before);
}

#[test]
fn cancellation_and_expiry_are_ordered_against_durable_runtime_admission() {
    let mut original = state::empty();
    let subscription = run(&mut original, attach("task", "wait"), 0);
    let collection = run(&mut original, json!({"action":"claim"}), 1);
    run(
        &mut original,
        commit_input(
            &collection,
            json!({"id":"event","eventType":"document.updated"}),
        ),
        2,
    );
    let delivery = run(&mut original, json!({"action":"claim_delivery"}), 3)["delivery"].clone();
    let admit = json!({"action":"admit_delivery","subscriptionId":subscription["subscriptionId"],"deliveryId":delivery["id"],"leaseId":delivery["lease"]["id"],"deviceId":"device","taskId":"task","operationId":"operation"});
    let cancel = json!({"action":"cancel","subscriptionId":subscription["subscriptionId"]});
    let mut cancel_first = original.clone();
    assert_eq!(
        run(&mut cancel_first, cancel.clone(), 4)["deliveryAdmitted"],
        false
    );
    assert_eq!(
        state::apply(&mut cancel_first, &admit, 5).unwrap_err(),
        "observation_delivery_lease_lost"
    );
    assert_eq!(
        state::apply(&mut original.clone(), &admit, 60_003).unwrap_err(),
        "observation_delivery_lease_lost"
    );
    for field in ["taskId", "deviceId", "subscriptionId"] {
        let mut forged = admit.clone();
        forged[field] = json!("other");
        assert!(state::apply(&mut original.clone(), &forged, 4).is_err());
    }
    let mut admitted_first = original;
    let receipt = run(&mut admitted_first, admit.clone(), 4);
    assert_eq!(receipt["admitted"], true);
    assert_eq!(run(&mut admitted_first, admit.clone(), 5), receipt);
    let mut conflicting = admit;
    conflicting["operationId"] = json!("different-operation");
    assert_eq!(
        state::apply(&mut admitted_first, &conflicting, 6).unwrap_err(),
        "observation_delivery_admission_conflict"
    );
    let cancelled = run(&mut admitted_first, cancel, 7);
    assert_eq!(
        cancelled["deliveryAdmitted"], true,
        "Cancellation must report the earlier durable admission"
    );
    let read = json!({"action":"get_subscription","subscriptionId":subscription["subscriptionId"]});
    assert_ne!(
        run(&mut admitted_first, read.clone(), 8)["subscription"]["terminalSynced"],
        true
    );
    run(
        &mut admitted_first,
        json!({"action":"ack_projection","subscriptionId":subscription["subscriptionId"]}),
        9,
    );
    assert_eq!(
        run(&mut admitted_first, read, 10)["subscription"]["terminalSynced"],
        true
    );
}

#[test]
fn cancelling_registration_before_attach_retains_a_durable_inactive_intent() {
    let mut state = state::empty();
    let registration = attach("task", "wait");
    let mut cancellation = registration.clone();
    cancellation["action"] = json!("cancel_registration");
    let cancelled = run(&mut state, cancellation.clone(), 1);
    assert_eq!(cancelled["subscription"]["status"], "cancelled");
    assert!(run(&mut state, json!({"action":"claim"}), 2)["lease"].is_null());
    assert_eq!(
        run(&mut state, registration, 3)["subscription"]["status"],
        "cancelled"
    );
    assert!(run(&mut state, json!({"action":"claim"}), 4)["lease"].is_null());
    assert_eq!(run(&mut state, cancellation, 5), cancelled);
    assert_eq!(state["subscriptions"].as_object().unwrap().len(), 1);
    assert_eq!(state["observations"].as_object().unwrap().len(), 1);
}

#[test]
fn multiple_sources_progress_fairly_after_success_and_abandoned_leases() {
    let mut initial = state::empty();
    for index in 0..3 {
        let mut input = attach(&format!("task-{index}"), "wait");
        input["subscription"]["source"]["id"] = json!(format!("document-{index}"));
        run(&mut initial, input, 0);
    }
    for abandon in [false, true] {
        let mut state = initial.clone();
        let mut observed = Vec::new();
        for cycle in 0..6 {
            let now = 1 + cycle * if abandon { 60_001 } else { 15_001 };
            let lease = run(&mut state, json!({"action":"claim"}), now);
            observed.push(lease["observation"]["id"].as_str().unwrap().to_owned());
            if !abandon {
                run(
                    &mut state,
                    json!({"action":"commit","observationId":lease["observation"]["id"],"leaseId":lease["lease"]["id"],"page":{"events":[],"nextCheckpoint":{"cursor":cycle+1}}}),
                    now + 1,
                );
            }
        }
        assert_eq!(
            observed[..3]
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            3,
            "Every source must advance before an earlier source is reclaimed"
        );
        assert_eq!(
            observed[..3],
            observed[3..],
            "Source priority must remain fair across repeated scheduler cycles"
        );
    }
}

#[test]
fn offline_deliveries_do_not_starve_other_conversations() {
    let mut state = state::empty();
    for index in 0..5 {
        run(&mut state, attach(&format!("task-{index}"), "wait"), 0);
    }
    let collection = run(&mut state, json!({"action":"claim"}), 1);
    run(
        &mut state,
        commit_input(
            &collection,
            json!({"id":"event","eventType":"document.updated"}),
        ),
        2,
    );
    let mut deliveries = Vec::new();
    for cycle in 0..10 {
        let delivery = run(
            &mut state,
            json!({"action":"claim_delivery"}),
            3 + cycle * 60_001,
        );
        deliveries.push(
            delivery["delivery"]["subscriptionId"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    assert_eq!(
        deliveries[..5]
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        5
    );
    assert_eq!(deliveries[..5], deliveries[5..]);
}

#[test]
fn sharing_a_source_does_not_retarget_its_account_capabilities_to_another_device() {
    let mut state = state::empty();
    run(&mut state, attach("first", "wait"), 0);
    let mut other = attach("second", "wait");
    other["subscription"]["device_id"] = json!("other-device");
    let attached = run(&mut state, other, 1);
    assert_eq!(
        attached["subscription"]["intent"]["target"]["deviceId"],
        "other-device"
    );
    let claim = run(&mut state, json!({"action":"claim"}), 2);
    assert_eq!(state["observations"].as_object().unwrap().len(), 1);
    assert_eq!(
        claim["observation"]["collector"],
        json!({"kind":"device","deviceId":"device"})
    );
}

#[test]
fn attaching_during_collection_delivers_retained_completion_once_without_old_history() {
    let mut state = state::empty();
    run(&mut state, attach("existing", "wait"), 0);
    let lease = run(&mut state, json!({"action":"claim"}), 1);
    run(
        &mut state,
        commit_input(
            &lease,
            json!({"id":"completed","eventType":"document.updated","at":"2026-11-15T00:00:01Z"}),
        ),
        2,
    );
    let input = attach("new-consumer", "wait");
    let first = run(&mut state, input.clone(), 3);
    assert_eq!(first["subscription"]["status"], "pending");
    let delivery = &state["deliveries"][first["subscription"]["deliveryId"].as_str().unwrap()];
    assert_eq!(delivery["events"][0]["id"], "completed");
    assert_eq!(delivery["events"].as_array().unwrap().len(), 1);
    let count = state["deliveries"].as_object().unwrap().len();
    assert_eq!(run(&mut state, input, 4), first);
    assert_eq!(state["deliveries"].as_object().unwrap().len(), count);
    let mut later = attach("later", "wait");
    later["subscription"]["source"]["enabledAfter"] = json!("2026-11-15T00:00:02Z");
    assert_eq!(run(&mut state, later, 5)["subscription"]["status"], "armed");
}
