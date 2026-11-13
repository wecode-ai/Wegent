// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn submitted_interface_is_bound_to_the_authenticated_runtime_command() {
    let config = json!({"wework_model_kind":"model-interface","model_id":"local-model:test","model_provider":"test"});
    let payload = json!({"executionRequest":{"user_id":23,"model_config":config},
        "address":{"taskId":"existing-task"},"commandId":"existing-command"});
    let envelope = runtime_request_envelope("runtime.tasks.send", payload.clone(), 23, "runner")
        .expect("a valid task command");
    assert_eq!(envelope["payload"], payload);
    assert_eq!(
        envelope["modelBinding"],
        json!({
            "kind":"submitted_interface", "actorUserId":23, "deviceId":"runner",
            "taskId":"existing-task", "commandId":"existing-command", "modelConfig":config,
        })
    );
    let create = runtime_request_envelope(
        "runtime.tasks.create",
        json!({"executionRequest":{"user_id":23,"model_config":config}}),
        23,
        "runner",
    )
    .expect("task and command IDs are generated for creation");
    assert!(
        create["payload"]["taskId"]
            .as_str()
            .unwrap()
            .starts_with("remote-task-")
    );
    assert_eq!(
        create["modelBinding"]["taskId"],
        create["payload"]["taskId"]
    );
    assert_eq!(
        create["modelBinding"]["commandId"],
        create["payload"]["commandId"]
    );
}
use serde_json::json;

#[test]
fn timeouts_clamp_to_the_source_default_and_cap() {
    assert_eq!(normalize_timeout(0), 30);
    assert_eq!(normalize_timeout(-1), 30);
    assert_eq!(normalize_timeout(75), 75);
    assert_eq!(normalize_timeout(900), 600);
}

#[test]
fn schema_version_one_drops_the_version_keys() {
    let negotiated = negotiate_runtime_task_create_payload(
        json!({"schemaVersion": 1, "schema_version": 1, "taskId": "t"}),
        None,
    )
    .unwrap();
    assert_eq!(negotiated, json!({"taskId": "t"}));
}

#[test]
fn v2_payloads_require_an_advertising_runtime() {
    let payload = json!({"schemaVersion": 2, "attachments": [{"name": "a"}]});
    // Only an explicit `false` advertisement blocks the feature; a runtime
    // that omits it keeps the requested payload.
    let declined =
        json!({"runtimeTaskCreate": {"schemaVersions": [2], "features": {"attachments": false}}});
    assert_eq!(
        negotiate_runtime_task_create_payload(payload.clone(), Some(&declined)).unwrap_err(),
        vec!["attachments".to_string()]
    );
    let silent = json!({"runtimeTaskCreate": {"schemaVersions": [2], "features": {}}});
    assert_eq!(
        negotiate_runtime_task_create_payload(payload.clone(), Some(&silent)).unwrap(),
        payload
    );
    let advertised =
        json!({"runtimeTaskCreate": {"schemaVersions": [2], "features": {"attachments": true}}});
    assert_eq!(
        negotiate_runtime_task_create_payload(payload.clone(), Some(&advertised)).unwrap(),
        payload
    );
}

#[test]
fn v1_runtimes_downgrade_a_feature_free_v2_payload() {
    let payload = json!({"schemaVersion": 2, "taskId": "t"});
    let v1 = json!({"runtimeTaskCreate": {"schemaVersions": [1]}});
    assert_eq!(
        negotiate_runtime_task_create_payload(payload, Some(&v1)).unwrap(),
        json!({"taskId": "t"})
    );
    let v3 = json!({"runtimeTaskCreate": {"schemaVersions": [3]}});
    assert_eq!(
        negotiate_runtime_task_create_payload(json!({"schemaVersion": 2}), Some(&v3)).unwrap_err(),
        vec!["schemaVersion:2".to_string()]
    );
}

#[test]
fn nested_skill_and_worktree_uses_require_features() {
    let payload = json!({
        "schemaVersion": 2,
        "executionRequest": {"preload_skills": ["a"]},
        "execution": {"workspace": {"source": "git_worktree"}},
    });
    assert_eq!(
        negotiate_runtime_task_create_payload(payload, None).unwrap_err(),
        vec!["skills".to_string(), "worktree".to_string()]
    );
}

#[test]
fn small_responses_are_returned_unencoded() {
    let response = json!({"success": true, "workspaces": []});
    assert_eq!(encode_response(response.clone(), "m").unwrap(), response);
}

#[test]
fn large_responses_use_the_gzip_envelope() {
    let response = json!({"success": true, "payload": "x".repeat(COMPRESSION_THRESHOLD_BYTES)});
    let encoded = encode_response(response.clone(), "m").unwrap();
    assert_eq!(
        encoded
            .get(RUNTIME_RPC_ENCODING_KEY)
            .and_then(Value::as_str),
        Some(RUNTIME_RPC_COMPRESSED_ENCODING)
    );
    assert!(encoded.get("rawBytes").and_then(Value::as_u64).unwrap() > 0);
    assert_eq!(decode_response(encoded).unwrap(), response);
}

#[test]
fn unreadable_envelopes_report_the_source_codes() {
    let error = decode_response(json!({RUNTIME_RPC_ENCODING_KEY: RUNTIME_RPC_COMPRESSED_ENCODING}))
        .unwrap_err();
    assert_eq!(error.code, "runtime_rpc_invalid_response");
    assert_eq!(
        error.message,
        "Runtime RPC returned an invalid compressed payload"
    );
    let error = decode_response(json!({
        RUNTIME_RPC_ENCODING_KEY: RUNTIME_RPC_COMPRESSED_ENCODING,
        "payload": "not-base64",
    }))
    .unwrap_err();
    assert_eq!(error.message, "Runtime RPC returned an unreadable payload");
}

#[test]
fn device_identities_project_onto_the_logical_id() {
    let result = json!({"deviceId": "runtime-1", "device_id": "runtime-1", "items": [{"deviceId": "runtime-1"}]});
    let projected = project_response_device_ids(
        result.as_object().unwrap(),
        "runtime.tasks.list",
        "runtime-1",
        "logical-1",
    );
    assert_eq!(projected["deviceId"], json!("logical-1"));
    assert_eq!(projected["items"][0]["deviceId"], json!("runtime-1"));
}

#[test]
fn worktree_responses_project_nested_device_identities() {
    let result =
        json!({"worktrees": [{"deviceId": "runtime-1", "meta": {"device_id": "runtime-1"}}]});
    let projected = project_response_device_ids(
        result.as_object().unwrap(),
        "runtime.worktrees.list",
        "runtime-1",
        "logical-1",
    );
    assert_eq!(projected["worktrees"][0]["deviceId"], json!("logical-1"));
    assert_eq!(
        projected["worktrees"][0]["meta"]["device_id"],
        json!("logical-1")
    );
}

#[test]
fn model_configs_nested_in_the_payload_receive_the_account_proxy() {
    let mut payload = json!({
        "modelConfig": {"base_url": "http://provider"},
        "nested": {"model_config": {"base_url": "http://provider"}, "other": 1},
    });
    apply_runtime_proxy(&mut payload, "http://proxy:8080");
    assert_eq!(
        payload["modelConfig"]["proxy"],
        json!({"url": "http://proxy:8080"})
    );
    assert_eq!(
        payload["modelConfig"]["runtime_config"]["codex"]["use_proxy"],
        json!(true)
    );
    assert_eq!(
        payload["nested"]["model_config"]["proxy"],
        json!({"url": "http://proxy:8080"})
    );
}

#[test]
fn backend_model_gateway_configurations_keep_the_device_off_the_proxy() {
    let mut model_config = json!({
        "base_url": "http://backend/api/runtime-work/llm-responses-proxy/",
        "default_headers": {"X-Wegent-Model-Type": "public"},
    });
    let Value::Object(ref mut object) = model_config else {
        unreachable!()
    };
    set_runtime_proxy(object, "http://proxy:8080");
    assert!(model_config.get("proxy").is_none());
    assert_eq!(
        model_config["runtime_config"]["codex"]["use_proxy"],
        json!(false)
    );
}

#[test]
fn url_path_trims_the_gateway_suffix() {
    assert_eq!(
        url_path("https://wegent.example/api/runtime-work/llm-responses-proxy/").as_deref(),
        Some("/api/runtime-work/llm-responses-proxy")
    );
    assert_eq!(url_path("https://host").as_deref(), Some(""));
}
