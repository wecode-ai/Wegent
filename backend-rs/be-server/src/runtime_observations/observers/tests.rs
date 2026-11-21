use super::*;
use crate::runtime_observations::{state, validation};

fn source() -> Value {
    json!({"providerId":"documents","profile":"account","kind":"document","id":"release","name":"Release","enabledAfter":"2026-11-15T00:00:00Z"})
}
fn observe_input(key: &str) -> Value {
    json!({"action":"observe","observer":{"deviceId":"device","consumerKey":key,"generation":"first","source":source()},"initialCheckpoint":{"cursor":4}})
}
fn run(state: &mut Value, input: Value, now: i64) -> Value {
    let result = state::apply(state, &input, now).unwrap();
    validation::validate(state).unwrap();
    result
}
fn page(claim: &Value) -> Value {
    json!({"action":"commit","observationId":claim["observation"]["id"],"leaseId":claim["lease"]["id"],"page":{"events":[{"id":"changed","eventType":"document.updated","at":"2026-11-15T00:00:01Z"}],"resourceStates":[{"kind":"document","data":{"version":2}}],"nextCheckpoint":{"cursor":5}}})
}

#[test]
fn stopping_an_unknown_observer_does_not_modify_an_empty_ledger() {
    let mut state = state::empty();
    state.as_object_mut().unwrap().remove("observers");
    let before = state.clone();
    let result = run(
        &mut state,
        json!({"action":"stop_observer","observerId":"unknown","generation":"one"}),
        1,
    );
    assert_eq!(result, json!({"stopped":true}));
    assert_eq!(state, before);
    assert_eq!(state::apply(&mut state, &json!({"action":"renew_observer","observerId":"unknown","deviceId":"device","generation":"one"}), 2).unwrap_err(), "observation_observer_unavailable");
    assert_eq!(state, before);
}

#[test]
fn stop_before_an_uncertain_registration_fences_its_late_arrival() {
    let mut state = state::empty();
    let input = observe_input("window");
    let id = hash(&json!(["observer", "device", "window", "first"]));
    let stop = json!({"action":"stop_observer","observerId":id,"generation":"first","observer":input["observer"],"initialCheckpoint":input["initialCheckpoint"]});
    run(&mut state, stop.clone(), 1);
    let before = state.clone();
    assert_eq!(
        state::apply(&mut state, &input, 2).unwrap_err(),
        "observation_observer_lease_lost"
    );
    assert_eq!(state, before);
    run(&mut state, stop, 3);
    assert_eq!(state, before);
    assert!(run(&mut state, json!({"action":"claim"}), 4)["lease"].is_null());
    assert!(state["subscriptions"].as_object().unwrap().is_empty());
    assert!(state["deliveries"].as_object().unwrap().is_empty());
}

#[test]
fn leased_ui_consumer_collects_shared_facts_without_any_model_delivery() {
    let mut state = state::empty();
    let watched = run(&mut state, observe_input("window-1"), 0);
    let claimed = run(&mut state, json!({"action":"claim"}), 1);
    run(&mut state, page(&claimed), 2);
    assert!(state["subscriptions"].as_object().unwrap().is_empty());
    assert!(state["deliveries"].as_object().unwrap().is_empty());
    let renewed = run(
        &mut state,
        json!({"action":"renew_observer","observerId":watched["observer"]["id"],"deviceId":"device","generation":"first"}),
        1000,
    );
    assert_eq!(
        renewed["observation"]["resourceStates"][0]["data"]["version"],
        2
    );
    for field in [
        "events",
        "checkpoint",
        "lease",
        "collectorDeviceId",
        "collector",
    ] {
        assert!(renewed["observation"].get(field).is_none(), "{field}");
    }
    let inflight = run(&mut state, json!({"action":"claim"}), 89_000);
    assert!(inflight["lease"].is_object());
    let before = state.clone();
    assert_eq!(
        state::apply(&mut state, &page(&inflight), 91_000).unwrap_err(),
        "observation_lease_lost"
    );
    assert_eq!(state, before);
    assert!(run(&mut state, json!({"action":"claim"}), 91_000)["lease"].is_null());
    assert_eq!(
        state["observations"][watched["observer"]["observationId"].as_str().unwrap()]["idle"],
        true
    );
    assert!(state["deliveries"].as_object().unwrap().is_empty());
}

#[test]
fn ui_keeps_the_same_collector_after_one_shot_model_delivery_then_releases_it() {
    let mut state = state::empty();
    let subscription = run(
        &mut state,
        json!({"action":"attach","initialCheckpoint":{"cursor":4},"subscription":{"subscription_key":"wait","device_id":"device","task_id":"task","session":{"engine":"Codex","id":"original-thread"},"source":source(),"match":{},"continuation":"Continue"}}),
        0,
    );
    let mut input = observe_input("window-1");
    input["initialCheckpoint"] = json!({"cursor":999});
    let watched = run(&mut state, input, 1);
    let claimed = run(&mut state, json!({"action":"claim"}), 2);
    assert_eq!(claimed["observation"]["checkpoint"], json!({"cursor":4}));
    assert_eq!(state["observations"].as_object().unwrap().len(), 1);
    run(&mut state, page(&claimed), 3);
    assert_eq!(state["deliveries"].as_object().unwrap().len(), 1);
    let delivery = run(&mut state, json!({"action":"claim_delivery"}), 4)["delivery"].clone();
    run(
        &mut state,
        json!({"action":"admit_delivery","subscriptionId":subscription["subscriptionId"],"deliveryId":delivery["id"],"leaseId":delivery["lease"]["id"],"deviceId":"device","taskId":"task","operationId":"operation"}),
        5,
    );
    run(
        &mut state,
        json!({"action":"ack_delivery","deliveryId":delivery["id"],"leaseId":delivery["lease"]["id"],"receipt":{"accepted":true,"operationId":"operation"}}),
        6,
    );
    let next = run(&mut state, json!({"action":"claim"}), 15_004);
    assert!(next["lease"].is_object());
    assert_eq!(next["observation"]["checkpoint"], json!({"cursor":5}));
    let stop = json!({"action":"stop_observer","observerId":watched["observer"]["id"],"generation":"first"});
    assert_eq!(
        run(&mut state, stop.clone(), 15_005),
        json!({"stopped":true})
    );
    assert!(state::apply(&mut state, &page(&next), 15_006).is_err());
    let before = state.clone();
    run(&mut state, stop, 15_007);
    assert_eq!(state, before);
    assert_eq!(
        state["subscriptions"][subscription["subscriptionId"].as_str().unwrap()]["status"],
        "delivered"
    );
}

#[test]
fn observer_identity_and_expiry_cannot_retarget_a_collector_or_renew_a_stale_lease() {
    let mut state = state::empty();
    let watched = run(&mut state, observe_input("window"), 0);
    let before = state.clone();
    let mut different = observe_input("window");
    different["observer"]["source"]["profile"] = json!("another-account");
    assert_eq!(
        state::apply(&mut state, &different, 1).unwrap_err(),
        "observation_observer_conflict"
    );
    assert_eq!(state, before);
    for (device, now) in [("other-device", 2), ("device", 90_000)] {
        assert_eq!(state::apply(&mut state,&json!({"action":"renew_observer","observerId":watched["observer"]["id"],"deviceId":device,"generation":"first"}),now).unwrap_err(),"observation_observer_lease_lost");
        assert_eq!(state, before);
    }
    let mut restarted = serde_json::from_str::<Value>(&state.to_string()).unwrap();
    assert_eq!(
        state::apply(&mut restarted, &observe_input("window"), 90_001).unwrap_err(),
        "observation_observer_lease_lost"
    );
    let mut next = observe_input("window");
    next["observer"]["generation"] = json!("second");
    let renewed = run(&mut restarted, next.clone(), 90_001);
    assert_ne!(renewed["observer"]["id"], watched["observer"]["id"]);
    let before = restarted.clone();
    for input in [
        json!({"action":"renew_observer","observerId":watched["observer"]["id"],"deviceId":"device","generation":"first"}),
        json!({"action":"stop_observer","observerId":watched["observer"]["id"],"generation":"first"}),
    ] {
        assert_eq!(
            state::apply(&mut restarted, &input, 90_002).unwrap_err(),
            "observation_observer_lease_lost"
        );
        assert_eq!(restarted, before);
    }
    assert_eq!(
        state::apply(&mut restarted, &observe_input("window"), 90_003).unwrap_err(),
        "observation_observer_lease_lost"
    );
    assert_eq!(restarted, before);
    run(
        &mut restarted,
        json!({"action":"stop_observer","observerId":renewed["observer"]["id"],"generation":"second"}),
        90_004,
    );
    let stopped = restarted.clone();
    assert_eq!(
        state::apply(&mut restarted, &next, 90_005).unwrap_err(),
        "observation_observer_lease_lost"
    );
    assert_eq!(restarted, stopped);
    assert_eq!(
        state::apply(&mut restarted, &observe_input("window"), 90_006).unwrap_err(),
        "observation_observer_lease_lost"
    );
    assert_eq!(
        restarted, stopped,
        "An earlier generation cannot revive after the newer one stops"
    );
    let mut third = observe_input("window");
    third["observer"]["generation"] = json!("third");
    run(&mut restarted, third, 90_007);
    let before_expired = restarted.clone();
    for old in [observe_input("window"), next] {
        assert_eq!(
            state::apply(&mut restarted, &old, 180_008).unwrap_err(),
            "observation_observer_lease_lost"
        );
        assert_eq!(
            restarted, before_expired,
            "Retired generations cannot revive after another activation expires"
        );
    }
    restarted["observers"][watched["observer"]["id"].as_str().unwrap()]["expiresAt"] = json!(-1);
    assert_eq!(
        validation::validate(&restarted).unwrap_err(),
        "observation_storage_conflict"
    );
}
