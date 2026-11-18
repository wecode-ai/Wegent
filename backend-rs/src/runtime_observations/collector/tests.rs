use super::super::{
    state,
    tests::{attach, commit_input, run},
    validation,
};
use super::*;

#[test]
fn typed_collector_rejects_mixed_routes_and_caller_selected_owners() {
    for invalid in [
        json!("managed"),
        json!({"kind":"device","deviceId":" "}),
        json!({"kind":"managed","deviceId":"other"}),
        json!({"kind":"managed","owner":8}),
        json!({"kind":"managed","backendUrl":"https://other"}),
        json!({"kind":"other"}),
    ] {
        assert!(Collector::parse(&invalid).is_err(), "{invalid}");
    }
    let mut input = attach("device-task", "wait");
    input["subscription"]["collector"] = json!({"kind":"managed"});
    assert!(super::super::target::Target::registration(&input["subscription"]).is_err());
}

#[test]
fn upgrading_device_ledgers_preserves_source_cursor_delivery_admission_and_deadlines() {
    let mut expected = state::empty();
    let attached = run(&mut expected, attach("original-task", "wait"), 0);
    let lease = run(&mut expected, json!({"action":"claim"}), 1);
    run(
        &mut expected,
        commit_input(
            &lease,
            json!({"id":"change","eventType":"document.updated"}),
        ),
        2,
    );
    let delivery = run(&mut expected, json!({"action":"claim_delivery"}), 3);
    run(
        &mut expected,
        json!({"action":"admit_delivery","subscriptionId":attached["subscriptionId"],"deliveryId":delivery["delivery"]["id"],"leaseId":delivery["delivery"]["lease"]["id"],"deviceId":"device","taskId":"original-task","operationId":"accepted-original-operation"}),
        4,
    );
    let mut legacy = expected.clone();
    legacy["version"] = json!(1);
    for row in legacy["observations"].as_object_mut().unwrap().values_mut() {
        let device = row["collector"]["deviceId"].clone();
        row.as_object_mut().unwrap().remove("collector");
        row["collectorDeviceId"] = device;
    }
    validation::validate(&legacy).unwrap();
    run(&mut legacy, json!({"action":"list"}), 50_000);
    assert_eq!(legacy, expected);
    validation::validate(&legacy).unwrap();
    let row = legacy["observations"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    row["collector"] = json!({"kind":"managed"});
    assert!(
        validation::validate(&legacy).is_err(),
        "A changed credential realm cannot inherit a device cursor or lease"
    );
}
