// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Unit tests for the `GET /api/devices` projection in [`super`].

use super::*;

fn device_type(value: Value) -> DeviceType {
    let spec = JsonProjection::<DeviceSpecInput>::from(value)
        .value
        .unwrap_or_default();
    DeviceType::from_spec(&spec)
}

fn runtime_features(value: &Value) -> Option<RuntimeFeatures> {
    let online = JsonProjection::<OnlineStateInput>::from_json(value)
        .value
        .unwrap_or_default();
    project_runtime_features(&online)
}

fn online_info(capacity: Option<Value>) -> Value {
    let mut info = json!({
        "socket_id": "s",
        "name": "n",
        "status": "online",
        "executor_version": "2.0.9",
    });
    if let Some(capacity) = capacity {
        info["runtime_capacity"] = capacity;
    }
    info
}

fn capacity_slots(value: Option<&Value>) -> (i64, i64) {
    let projected = value.cloned().map(JsonProjection::<OnlineStateInput>::from);
    runtime_capacity_slot_values(projected.as_ref())
}

#[test]
fn slot_values_require_consistent_capacity() {
    let valid = online_info(Some(json!({
        "limit": 10, "active": 2, "active_task_ids": ["a", "b"],
    })));
    assert_eq!(capacity_slots(Some(&valid)), (2, 10));

    let missing_ids = online_info(Some(json!({"limit": 10, "active": 2})));
    assert_eq!(capacity_slots(Some(&missing_ids)), (0, 0));

    let count_mismatch = online_info(Some(json!({
        "limit": 10, "active": 3, "active_task_ids": ["a", "b"],
    })));
    assert_eq!(capacity_slots(Some(&count_mismatch)), (0, 0));

    let limit_out_of_range = online_info(Some(json!({
        "limit": 21, "active": 0, "active_task_ids": [],
    })));
    assert_eq!(capacity_slots(Some(&limit_out_of_range)), (0, 0));

    assert_eq!(runtime_capacity_slot_values(None), (0, 0));
}

#[test]
fn update_available_matches_source_semantics() {
    assert!(is_update_available(None, Some("2.0.16")));
    assert!(is_update_available(Some("2.0.9"), Some("2.0.16")));
    assert!(!is_update_available(Some("2.0.16"), Some("2.0.16")));
    assert!(!is_update_available(Some("2.0.17"), Some("2.0.16")));
    assert!(!is_update_available(Some("x"), Some("2.0.16")));
    assert!(!is_update_available(Some("2.0.9"), Some("x")));
}

#[test]
fn item_json_matches_device_info_shape() {
    let item = DeviceItem {
        id: 268602,
        execution_target_id: None,
        device_id: "local-device".to_string(),
        name: "local-device app".to_string(),
        status: "online".to_string(),
        is_default: false,
        last_heartbeat: Some(raw_json(&json!("2026-09-04T15:52:17.193124"))),
        device_type: DeviceType::App,
        connection_mode: "websocket".to_string(),
        capabilities: None,
        slot_used: 0,
        slot_max: 0,
        running_tasks: Vec::new(),
        executor_version: Some("1.8.5".to_string()),
        latest_version: Some("2.0.16".to_string()),
        update_available: true,
        client_ip: Some(raw_json(&json!("127.0.0.1"))),
        runtime_transfer_host: None,
        runtime_instance_id: None,
        app_device_id: None,
        socket_device_id: None,
        runtime_features: None,
        cloud_config: None,
        remote_config: None,
        bind_shell: "claudecode".to_string(),
    };
    let value = crate::json_contract_tests::serialized(item).unwrap();
    crate::json_contract_tests::assert_fixture("device", &value);
    assert_eq!(value["device_type"], "app");
    assert_eq!(value["running_tasks"], json!([]));
    assert_eq!(value["socket_device_id"], Value::Null);
    assert_eq!(value["cloud_config"], Value::Null);
    assert_eq!(value["remote_config"], Value::Null);
    assert_eq!(value["bind_shell"], "claudecode");
}

#[test]
fn device_type_defaults_to_local() {
    assert_eq!(
        device_type(json!({"deviceType": "cloud"})),
        DeviceType::Cloud
    );
    assert_eq!(
        device_type(json!({"deviceType": "remote"})),
        DeviceType::Remote
    );
    assert_eq!(device_type(json!({"deviceType": "app"})), DeviceType::App);
    assert_eq!(device_type(json!({})), DeviceType::Local);
    assert_eq!(
        device_type(json!({"deviceType": "unknown"})),
        DeviceType::Local
    );
}

#[test]
fn invalid_feature_envelopes_preserve_project_denials_without_granting_writes() {
    for schema in [Value::Null, json!("invalid"), json!(0)] {
        let features = runtime_features(&json!({
            "runtime_features": {
            "schemaVersion": schema,
            "projectEditing": {"multiRoots": false, "aiSettings": true, "plugins": false},
            "worktrees": {"version": "invalid"},
            }
        }))
        .expect("explicit project advertisement must survive malformed headers");
        let projected = crate::json_contract_tests::serialized(features).unwrap();
        assert_eq!(projected["schemaVersion"], 1);
        assert_eq!(projected["projectEditing"]["multiRoots"], false);
        assert_eq!(projected["projectEditing"]["aiSettings"], Value::Null);
        assert_eq!(projected["projectEditing"]["plugins"], false);
        assert_eq!(projected["worktrees"], Value::Null);
    }
    assert!(runtime_features(&json!({"runtime_features": {"schemaVersion": "invalid"}})).is_none());
}

#[test]
fn runtime_features_preserves_independent_project_editing_flags() {
    let info = json!({
        "runtime_features": {
            "schemaVersion": 4,
            "projectEditing": {"multiRoots": true, "aiSettings": false, "defaultProjectSpace": true, "plugins": false},
        },
    });
    let projected =
        crate::json_contract_tests::serialized(runtime_features(&info).unwrap()).unwrap();
    assert_eq!(
        projected["projectEditing"],
        info["runtime_features"]["projectEditing"]
    );
}

#[test]
fn absent_project_editing_does_not_mask_legacy_runtime_contracts() {
    let info = json!({"runtime_features": {"schemaVersion": 4}});
    let projected =
        crate::json_contract_tests::serialized(runtime_features(&info).unwrap()).unwrap();
    assert!(projected.get("projectEditing").is_none());
}

#[test]
fn malformed_explicit_project_editing_is_preserved_conservatively() {
    for editing in [
        Value::Null,
        json!("invalid"),
        json!({"multiRoots": "true", "plugins": false}),
    ] {
        let info = json!({"runtime_features": {"schemaVersion": 4, "projectEditing": editing}});
        let projected =
            crate::json_contract_tests::serialized(runtime_features(&info).unwrap()).unwrap();
        assert!(projected["projectEditing"].is_object());
        assert_eq!(projected["projectEditing"]["multiRoots"], Value::Null);
        assert_eq!(projected["projectEditing"]["aiSettings"], Value::Null);
    }
}

#[test]
fn runtime_features_includes_interactive_sessions() {
    let info = json!({
        "runtime_features": {
            "schemaVersion": 3,
            "runtimeTaskCreate": {"schemaVersions": [1, 2]},
            "interactiveSessions": {"codeServer": true, "terminal": true},
            "worktrees": {"version": 1, "managed": true},
        },
    });
    let projected =
        crate::json_contract_tests::serialized(runtime_features(&info).unwrap()).unwrap();
    assert_eq!(projected["schemaVersion"], 3);
    assert!(projected["runtimeTaskCreate"].is_object());
    assert!(projected["interactiveSessions"].is_object());
    assert!(projected["worktrees"].is_object());
}

#[test]
fn runtime_features_null_interactive_sessions_when_absent() {
    let info = json!({
        "runtime_features": {
            "schemaVersion": 2,
            "runtimeTaskCreate": {"schemaVersions": [1, 2]},
        },
    });
    let projected =
        crate::json_contract_tests::serialized(runtime_features(&info).unwrap()).unwrap();
    assert_eq!(projected["schemaVersion"], 2);
    assert_eq!(projected["interactiveSessions"], Value::Null);
    assert_eq!(
        projected["runtimeTaskCreate"]["schemaVersions"],
        json!([1, 2])
    );
    // worktrees is emitted as null when not stored
    assert_eq!(projected["worktrees"], Value::Null);
}

#[test]
fn runtime_features_preserves_explicit_plugin_sync_protocol() {
    let info = json!({
        "runtime_features": {
            "schemaVersion": 4,
            "pluginSync": {"protocolVersion": 2, "unknown": true},
        },
    });
    let projected =
        crate::json_contract_tests::serialized(runtime_features(&info).unwrap()).unwrap();
    assert_eq!(projected["pluginSync"], json!({"protocolVersion": 2}));
}

#[test]
fn runtime_features_omits_absent_and_malformed_plugin_sync_protocols() {
    for advertisement in [
        Value::Null,
        json!("2"),
        json!([]),
        json!({}),
        json!({"protocolVersion": "2"}),
        json!({"protocolVersion": true}),
        json!({"protocolVersion": 0}),
    ] {
        let info = json!({
            "runtime_features": {
                "schemaVersion": 4,
                "pluginSync": advertisement,
                "projectEditing": {"plugins": false},
            },
        });
        let projected =
            crate::json_contract_tests::serialized(runtime_features(&info).unwrap()).unwrap();
        assert!(projected.get("pluginSync").is_none());
        assert_eq!(projected["projectEditing"]["plugins"], false);
    }
    let projected = crate::json_contract_tests::serialized(
        runtime_features(&json!({"runtime_features": {"schemaVersion": 4}})).unwrap(),
    )
    .unwrap();
    assert!(projected.get("pluginSync").is_none());
}

#[test]
fn runtime_features_extensions_follow_the_known_members() {
    let features = RuntimeFeatures {
        schema_version: 4,
        runtime_task_create: None,
        interactive_sessions: None,
        worktrees: None,
        project_editing: None,
        plugin_sync: None,
        extensions: std::iter::once((
            "desktop".to_string(),
            json!({
                "version": 1,
                "available": true,
                "protocol": "rfb",
                "transport": "websocket",
                "clipboard": "text",
            }),
        ))
        .collect(),
    };
    let projected = crate::json_contract_tests::serialized(features).unwrap();
    assert_eq!(
        projected,
        json!({
            "schemaVersion": 4,
            "runtimeTaskCreate": null,
            "interactiveSessions": null,
            "worktrees": null,
            "desktop": {
                "version": 1,
                "available": true,
                "protocol": "rfb",
                "transport": "websocket",
                "clipboard": "text",
            },
        })
    );
}
