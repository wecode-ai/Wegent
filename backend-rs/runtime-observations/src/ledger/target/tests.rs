use super::*;

#[test]
fn device_delivery_keeps_its_exact_native_target() {
    let value = json!({"deviceId":"remote-device","taskId":"task","session":{"engine":"Codex","id":"original-thread"}});
    let target = Target::parse(&value).unwrap();
    assert_eq!(target.value(), value);
    assert_eq!(
        target.subscription_id(&json!("wait")),
        super::super::state::subscription_identity(
            &json!("remote-device"),
            &json!("task"),
            &json!("wait")
        )
    );
    for invalid in [
        json!({"kind":"backend_task","taskId":42,"botId":23,"session":{"engine":"Codex","id":"thread"}}),
        json!({"deviceId":"","taskId":"task","session":{"engine":"Codex","id":"thread"}}),
        json!({"deviceId":"remote-device","taskId":"task","session":{"engine":"unknown","id":"thread"}}),
        json!({"deviceId":"remote-device","taskId":"task","session":{"engine":"Codex","id":" "}}),
    ] {
        assert!(Target::parse(&invalid).is_err());
    }
}

#[test]
fn registration_cannot_supply_another_execution_or_collector_identity() {
    let input = super::super::tests::attach("task", "wait");
    assert!(Target::registration(&input["subscription"]).is_ok());
    for field in ["collector", "collector_device_id", "target", "preparation"] {
        let mut changed = input["subscription"].clone();
        changed[field] = json!({"deviceId":"another-device"});
        assert!(Target::registration(&changed).is_err());
    }
}
