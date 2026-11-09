// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework branch focused tests.
use super::models::*;
use super::runtime::*;
use super::*;

fn body(value: serde_json::Value) -> Value {
    value
}

#[test]
fn discriminates_wework_requests() {
    assert!(is_wework_request(&body(json!({
        "model": "m",
        "input": "x",
        "execution": {"type": "wework", "device_id": "d"}
    }))));
    assert!(is_wework_request(&body(json!({
        "model": "m",
        "input": "x",
        "conversation": "conv_abc"
    }))));
    assert!(is_wework_request(&body(json!({
        "model": "m",
        "input": "x",
        "previous_response_id": "resp_WyJ..."
    }))));
    assert!(!is_wework_request(&body(json!({
        "model": "default#team",
        "input": "x"
    }))));
    assert!(!is_wework_request(&body(json!({
        "model": "default#team",
        "input": "x",
        "previous_response_id": "resp_123"
    }))));
}

#[test]
fn parses_input_text_from_string_and_messages() {
    let string_body: WeworkResponseCreate =
        serde_json::from_value(json!({"model": "m", "input": "hello"})).expect("body");
    assert_eq!(string_body.input_text(), "hello");
    let messages: WeworkResponseCreate = serde_json::from_value(json!({
        "model": "m",
        "input": [
            {"type": "message", "role": "user", "content": "a"},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "b"}]}
        ]
    }))
    .expect("body");
    assert_eq!(messages.input_text(), "a\nb");
}

#[test]
fn validates_intent_like_the_source() {
    let mut parsed: WeworkResponseCreate = serde_json::from_value(json!({
        "model": "m",
        "input": "x",
        "background": "true",
        "execution": {"type": "wework", "device_id": "d"}
    }))
    .expect("body");
    assert!(parsed.background);
    assert!(parsed.validate_intent().is_ok());

    parsed.input = json!("   ");
    assert!(parsed.validate_intent().is_err());
    parsed.input = json!("x");
    parsed.execution = Some(WeworkExecution {
        execution_type: "wework".into(),
        device_id: None,
        title: None,
        model_type: None,
        model_options: Map::new(),
    });
    assert!(parsed.validate_intent().is_err());
}

#[test]
fn encodes_response_and_conversation_identity() {
    assert_eq!(
        conversation_id("device-1", "task-1"),
        format!(
            "conv_{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"["device-1","task-1"]"#)
        )
    );
    assert_eq!(
        encode_identity("resp_", &["device-1", "task-1", "message-1"]),
        format!(
            "resp_{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(br#"["device-1","task-1","message-1"]"#)
        )
    );
}

#[test]
fn parses_persisted_model_identifiers_without_splitting_the_name() {
    assert_eq!(
        parse_model_identifier("public:default:0:example:model"),
        Some(("public", "default", 0, "example:model"))
    );
    assert_eq!(
        parse_model_identifier("group:team-a:42:team-model"),
        Some(("group", "team-a", 42, "team-model"))
    );
    assert_eq!(parse_model_identifier("runtime:default:0:model"), None);
    assert_eq!(parse_model_identifier("public:default:owner:model"), None);
    assert_eq!(parse_model_identifier("model-without-identifier"), None);
}

#[test]
fn derives_model_type_from_the_persisted_owner_and_namespace() {
    let row = |user_id: i64, namespace: &str| crate::responses::create::resolution::KindRow {
        id: 1,
        user_id,
        kind: "Model".into(),
        name: "m".into(),
        namespace: namespace.into(),
        json: brz_mysql::Json(serde_json::json!({})),
        is_active: 1,
        created_at: None,
        updated_at: None,
    };
    assert_eq!(model_type_from_row(&row(0, "default")), "public");
    assert_eq!(model_type_from_row(&row(7, "default")), "user");
    assert_eq!(model_type_from_row(&row(7, "team-a")), "group");
}

#[test]
fn model_identifier_matches_the_source_join() {
    let model = crate::models_unified::models::UnifiedModel {
        name: "example-claude".into(),
        model_type: "public",
        display_name: None,
        provider: None,
        model_id: None,
        config: Default::default(),
        is_active: true,
        namespace: "default".into(),
        model_category_type: "llm".into(),
        is_advanced: false,
        model_group: None,
        model_sub_group: None,
        context_window: None,
        max_output_tokens: None,
        cost_index: None,
        capability: None,
        model_capabilities: None,
        resource_id: None,
        resource_user_id: Some(0),
        created_at: None,
        updated_at: None,
        is_reference: false,
    };
    assert_eq!(model_identifier(&model), "public:default:0:example-claude");
}

#[test]
fn assembles_the_runtime_create_payload_top_level() {
    let selection = ModelSelection {
        model_name: "example-claude".into(),
        model_type: "public".into(),
        options: serde_json::from_value(json!({
            "weworkCloudModelNamespace": "default",
            "weworkCloudModelResourceUserId": 0
        }))
        .expect("options"),
        from_persisted: false,
    };
    let payload = assemble_create_payload(
        json!({"prompt": "测试"}),
        "测试",
        "12312",
        "task-1",
        "message-1",
        &selection,
    );
    let object = payload.as_object().expect("payload");
    let keys: Vec<&str> = object.keys().map(String::as_str).collect();
    assert!(keys.contains(&"executionRequest"));
    assert_eq!(payload["runtime"], "codex");
    assert_eq!(payload["message"], "测试");
    assert_eq!(payload["title"], "12312");
    assert_eq!(payload["taskId"], "task-1");
    assert_eq!(payload["clientUserMessageId"], "message-1");
    assert_eq!(payload["standaloneChatWorkspace"], true);
    assert_eq!(payload["modelId"], "example-claude");
    assert_eq!(payload["modelType"], "public");
    assert_eq!(payload["modelSelection"]["modelName"], "example-claude");
    assert_eq!(
        payload["modelSelection"]["options"]["weworkCloudModelNamespace"],
        "default"
    );
}

#[test]
fn queued_snapshot_matches_the_wework_response_object() {
    let snapshot = queued_snapshot(
        "resp_abc",
        1793767134,
        "public:default:0:model",
        None,
        "conv_abc",
    );
    assert_eq!(snapshot["id"], "resp_abc");
    assert_eq!(snapshot["object"], "response");
    assert_eq!(snapshot["created_at"], 1793767134);
    assert_eq!(snapshot["status"], "queued");
    assert!(snapshot["error"].is_null());
    assert_eq!(snapshot["model"], "public:default:0:model");
    assert_eq!(snapshot["output"], json!([]));
    assert!(snapshot["pending_user_input"].is_null());
    assert!(snapshot["pending_user_input_payload"].is_null());
    assert!(snapshot["previous_response_id"].is_null());
    assert_eq!(snapshot["conversation"]["id"], "conv_abc");
    assert_eq!(snapshot["cancellation_requested"], false);
    assert_eq!(snapshot["is_latest"], true);
}

/// The recorded 5b95 Model CRD budgets and native-tool flags.
#[test]
fn cloud_model_options_match_the_recorded_spec() {
    let spec = json!({
        "modelConfig": {
            "context_window": 1000000,
            "max_output_tokens": 128000,
            "env": {
                "native_tool_search": false,
                "nativeNamespaceTools": false,
                "model_id": "example-claude-example-model"
            }
        }
    });
    let limits = wework_model_token_limits(&spec);
    assert_eq!(limits.get("model_context_window"), Some(&json!(1000000)));
    assert_eq!(limits.get("max_output_tokens"), Some(&json!(128000)));
    let options = wework_model_config_options(&spec, "anthropic-messages").expect("options");
    assert_eq!(options.get("native_tool_search"), Some(&json!(false)));
    assert_eq!(options.get("native_namespace_tools"), Some(&json!(false)));
    assert_eq!(
        catalog_model_id_from_spec(&spec).as_deref(),
        Some("wework-gpt-5.6-sol")
    );
}

#[test]
fn codex_request_mode_overrides_native_tool_flags() {
    let spec = json!({
        "modelConfig": {"codex_request_mode": "passthrough", "env": {}}
    });
    let options = wework_model_config_options(&spec, "openai-responses").expect("options");
    assert_eq!(
        options.get("codex_request_mode"),
        Some(&json!("passthrough"))
    );
    assert_eq!(options.get("native_tool_search"), Some(&json!(true)));
    assert_eq!(options.get("native_namespace_tools"), Some(&json!(true)));
    assert!(
        wework_model_config_options(&spec, "anthropic-messages").is_err(),
        "passthrough requires an OpenAI Responses upstream"
    );
}

#[test]
fn decodes_conversation_and_response_identity() {
    let conversation = encode_identity("conv_", &["device-1", "task-1"]);
    assert_eq!(
        conversation_address(&conversation).expect("conversation"),
        ("device-1".to_string(), "task-1".to_string())
    );
    let response = encode_identity("resp_", &["device-1", "task-1", "message-1"]);
    assert_eq!(
        response_identity(&response).expect("response"),
        (
            "device-1".to_string(),
            "task-1".to_string(),
            "message-1".to_string()
        )
    );
    assert!(conversation_address("resp_x").is_err());
    assert!(response_identity("conv_x").is_err());
}

#[test]
fn live_channel_hashes_the_source_identity() {
    use sha2::{Digest as _, Sha256};
    let mut hex = String::new();
    for byte in Sha256::digest(br#"[1,"d","t"]"#) {
        hex.push_str(&format!("{byte:02x}"));
    }
    assert_eq!(live_channel(1, "d", "t"), format!("wework-api:live:{hex}"));
}

#[test]
fn projects_text_deltas_and_terminal_events() {
    let mut snapshot = queued_snapshot("resp_abc", 1, "m", None, "conv_abc");
    let delta = json!({
        "event": "response.output_text.delta",
        "payload": {"taskId": "t", "clientUserMessageId": "m", "data": {"delta": "你好"}}
    });
    let mut runtime_turn_id = None;
    assert!(envelope_matches(&delta, "t", "m", &mut runtime_turn_id));
    assert!(!project_envelope(&mut snapshot, &delta));
    assert_eq!(snapshot["status"], "in_progress");
    assert_eq!(snapshot["output"][0]["content"][0]["text"], "你好");
    assert_eq!(
        snapshot["output"][0]["id"], "msg_resp_abc",
        "the text item id is stable across snapshots and live output"
    );
    let done = json!({
        "event": "response.completed",
        "payload": {"taskId": "t", "clientUserMessageId": "m", "data": {}}
    });
    assert!(project_envelope(&mut snapshot, &done));
    assert_eq!(snapshot["status"], "completed");
    assert_eq!(snapshot["output"][0]["status"], "completed");
}

#[test]
fn hidden_fallback_must_match_the_conversation_model() {
    let selection = ModelSelection {
        model_name: "hidden-model".into(),
        model_type: "public".into(),
        options: serde_json::from_value(json!({
            "weworkCloudModelNamespace": "default",
            "weworkCloudModelResourceUserId": 0
        }))
        .expect("options"),
        from_persisted: true,
    };
    assert!(recorded_selection_matches(
        Some(&json!({
            "modelName": "hidden-model",
            "modelType": "public",
            "options": {
                "weworkCloudModelNamespace": "default",
                "weworkCloudModelResourceUserId": 0
            }
        })),
        &selection
    ));
    assert!(
        recorded_selection_matches(
            Some(&json!({
                "modelName": "hidden-model",
                "modelType": "public",
                "options": {
                    "weworkCloudModelNamespace": "default",
                    "weworkCloudModelResourceUserId": "0"
                }
            })),
            &selection
        ),
        "a recorded string owner matches the numeric resolved owner"
    );
    assert!(
        !recorded_selection_matches(
            Some(&json!({
                "modelName": "hidden-model",
                "modelType": "public",
                "options": {}
            })),
            &selection
        ),
        "a name-and-type-only record has no identity to compare"
    );
    assert!(
        !recorded_selection_matches(
            Some(&json!({
                "modelName": "hidden-model",
                "modelType": "public",
                "options": {"weworkCloudModelNamespace": "default"}
            })),
            &selection
        ),
        "a recorded selection without the owner cannot prove which model row it used"
    );
    assert!(!recorded_selection_matches(
        Some(&json!({"modelName": "other-model", "modelType": "public"})),
        &selection
    ));
    assert!(!recorded_selection_matches(None, &selection));
}

#[test]
fn merges_previous_selection_options_under_the_new() {
    let previous = json!({
        "options": {
            "reasoning": "x",
            "weworkCloudModelNativeToolSearch": "true"
        }
    });
    let selection = ModelSelection {
        model_name: "m".into(),
        model_type: "public".into(),
        options: serde_json::from_value(json!({
            "weworkCloudModelNamespace": "default"
        }))
        .expect("options"),
        from_persisted: false,
    };
    let merged = merged_selection(Some(&previous), &selection);
    assert_eq!(merged.options.get("reasoning"), Some(&json!("x")));
    assert_eq!(
        merged.options.get("weworkCloudModelNativeToolSearch"),
        Some(&json!("true"))
    );
    assert_eq!(
        merged.options.get("weworkCloudModelNamespace"),
        Some(&json!("default"))
    );
}

/// The recorded Model CRD stores the budgets at `modelConfig` top level and
/// carries no native flags; the gateway defaults them to false.
#[test]
fn recorded_model_config_defaults_the_token_limits_and_native_flags() {
    let spec = json!({
        "modelConfig": {
            "env": {"model": "claude", "model_id": "example-model"},
            "context_window": 1000000,
            "max_output_tokens": 128000,
            "visionSidecarModel": {"apiFormat": "anthropic-messages"}
        }
    });
    let limits = wework_model_token_limits(&spec);
    assert_eq!(limits.get("model_context_window"), Some(&json!(1000000)));
    assert_eq!(limits.get("max_output_tokens"), Some(&json!(128000)));
    let options = wework_model_config_options(&spec, "anthropic-messages").expect("options");
    assert_eq!(options.get("native_tool_search"), Some(&json!(false)));
    assert_eq!(options.get("native_namespace_tools"), Some(&json!(false)));
    assert!(!options.contains_key("reasoning"));
    assert!(!options.contains_key("codex_request_mode"));
}

/// The UI reasoning options map to the execution reasoning document.
#[test]
fn maps_ui_reasoning_options() {
    let options: Map<String, Value> =
        serde_json::from_value(json!({"summary": "detailed"})).expect("options");
    let reasoning = reasoning_from_model_options(&options).expect("reasoning");
    assert_eq!(reasoning.get("summary"), Some(&json!("detailed")));
    let options: Map<String, Value> = serde_json::from_value(json!({
        "reasoning": {"effort": "high", "summary": "concise"}
    }))
    .expect("options");
    let reasoning = reasoning_from_model_options(&options).expect("reasoning");
    assert_eq!(reasoning.get("effort"), Some(&json!("high")));
    assert_eq!(reasoning.get("summary"), Some(&json!("concise")));
    assert!(reasoning_from_model_options(&Map::new()).is_none());
}

/// The live projection follows the recorded Wework event order: created opens
/// the turn, unprojected block events are ignored, and completed carries the
/// final text in `payload.data.value`.
#[test]
fn projects_live_completed_value() {
    let mut snapshot = queued_snapshot("resp_A", 1, "m", None, "conv_A");
    let created = json!({
        "event": "response.created",
        "payload": {"taskId": "runtime-1", "clientUserMessageId": "m", "data": {}},
    });
    assert!(!project_envelope(&mut snapshot, &created));
    assert_eq!(snapshot["status"], json!("in_progress"));
    let block = json!({
        "event": "response.block.created",
        "payload": {"taskId": "runtime-1", "clientUserMessageId": "m", "data": {}},
    });
    assert!(!project_envelope(&mut snapshot, &block));
    assert_eq!(snapshot["status"], json!("in_progress"));
    let completed = json!({
        "event": "response.completed",
        "payload": {
            "taskId": "runtime-1",
            "clientUserMessageId": "m",
            "data": {"value": "测试收到，我在。"},
        },
    });
    assert!(project_envelope(&mut snapshot, &completed));
    assert_eq!(snapshot["status"], json!("completed"));
    assert_eq!(snapshot["output"][0]["id"], json!("msg_resp_A"));
    assert_eq!(snapshot["output"][0]["type"], json!("message"));
    assert_eq!(snapshot["output"][0]["role"], json!("assistant"));
    assert_eq!(snapshot["output"][0]["status"], json!("completed"));
    assert_eq!(
        snapshot["output"][0]["content"][0]["text"],
        json!("测试收到，我在。")
    );
}

/// The final response output is projected when no deltas produced items.
#[test]
fn projects_completed_output_fallback() {
    let mut snapshot = queued_snapshot("resp_B", 1, "m", None, "conv_B");
    let completed = json!({
        "event": "response.completed",
        "payload": {"data": {"response": {"output": [{
            "type": "function_call",
            "id": "call_1",
            "call_id": "c1",
            "name": "lookup",
            "arguments": "{}",
        }]}}},
    });
    assert!(project_envelope(&mut snapshot, &completed));
    assert_eq!(snapshot["output"][0]["id"], json!("call_1"));
}

/// `response.output_item.done` message content feeds the stable text item; an
/// item outside the output-item schema is ignored.
#[test]
fn projects_output_item_message_content() {
    let mut snapshot = queued_snapshot("resp_C", 1, "m", None, "conv_C");
    let done = json!({
        "event": "response.output_item.done",
        "payload": {"data": {"item": {
            "type": "message",
            "id": "msg_x",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": "hi", "annotations": []}],
        }}},
    });
    assert!(!project_envelope(&mut snapshot, &done));
    assert_eq!(snapshot["output"][0]["content"][0]["text"], json!("hi"));
    let invalid = json!({
        "event": "response.output_item.done",
        "payload": {"data": {"item": {"nope": 1}}},
    });
    assert!(!project_envelope(&mut snapshot, &invalid));
}

/// A cancelled turn settles as `cancelled` with a normalized error.
#[test]
fn projects_cancelled_and_normalizes_error() {
    let mut snapshot = queued_snapshot("resp_D", 1, "m", None, "conv_D");
    let incomplete = json!({
        "event": "response.incomplete",
        "payload": {"data": {
            "status": "cancelled",
            "error": {"code": "cancelled", "message": "stop"},
        }},
    });
    assert!(project_envelope(&mut snapshot, &incomplete));
    assert_eq!(snapshot["status"], json!("cancelled"));
    assert_eq!(snapshot["error"]["code"], json!("cancelled"));
    assert_eq!(snapshot["error"]["message"], json!("stop"));

    let mut failed = queued_snapshot("resp_E", 1, "m", None, "conv_E");
    let event = json!({
        "event": "response.failed",
        "payload": {"data": {"error": "boom"}},
    });
    assert!(project_envelope(&mut failed, &event));
    assert_eq!(failed["status"], json!("failed"));
    assert_eq!(failed["error"]["code"], json!("runtime_error"));
    assert_eq!(failed["error"]["message"], json!("boom"));
}

/// Envelopes without a client message id match by the runtime turn id and
/// remember the first bound turn; other turns are rejected.
#[test]
fn matches_runtime_turn_without_client_id() {
    let mut turn = None;
    let with_client = json!({
        "payload": {"taskId": "runtime-1", "clientUserMessageId": "m", "subtaskId": "t1"},
    });
    assert!(envelope_matches(&with_client, "runtime-1", "m", &mut turn));
    assert_eq!(turn.as_deref(), Some("t1"));
    let without_client = json!({
        "payload": {"taskId": "runtime-1", "subtaskId": "t1"},
    });
    assert!(envelope_matches(
        &without_client,
        "runtime-1",
        "m",
        &mut turn
    ));
    let other_turn = json!({
        "payload": {"taskId": "runtime-1", "subtaskId": "t2"},
    });
    assert!(!envelope_matches(&other_turn, "runtime-1", "m", &mut turn));
    let mut unbound = None;
    assert!(!envelope_matches(
        &without_client,
        "runtime-1",
        "m",
        &mut unbound
    ));
}

/// A synchronous stream projects the runtime envelopes into the Source's
/// event order: in-progress first, then the text item lifecycle, then the
/// terminal response.
#[test]
fn projects_live_events_in_sse_order() {
    let mut snapshot = queued_snapshot("resp_S", 1, "m", None, "conv_S");
    let block = json!({
        "event": "response.block.created",
        "payload": {"taskId": "t", "clientUserMessageId": "m", "data": {}},
    });
    assert!(project_events(&mut snapshot, &block).is_empty());
    let created = json!({
        "event": "response.created",
        "payload": {"taskId": "t", "clientUserMessageId": "m", "data": {}},
    });
    let events = project_events(&mut snapshot, &created);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], json!("response.in_progress"));
    assert_eq!(events[0]["response"]["status"], json!("in_progress"));

    let completed = json!({
        "event": "response.completed",
        "payload": {"taskId": "t", "clientUserMessageId": "m", "data": {"value": "收到，我在线。"}},
    });
    let events = project_events(&mut snapshot, &completed);
    let types: Vec<&str> = events
        .iter()
        .map(|event| event["type"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(
        types,
        [
            "response.output_item.added",
            "response.content_part.added",
            "response.output_text.done",
            "response.content_part.done",
            "response.output_item.done",
            "response.completed",
        ]
    );
    assert_eq!(events[0]["item"]["id"], json!("msg_resp_S"));
    assert_eq!(events[0]["item"]["content"], json!([]));
    assert_eq!(events[1]["item_id"], json!("msg_resp_S"));
    assert_eq!(events[2]["text"], json!("收到，我在线。"));
    assert_eq!(events[3]["part"]["text"], json!("收到，我在线。"));
    assert_eq!(events[4]["item"]["status"], json!("completed"));
    assert_eq!(events[5]["response"]["status"], json!("completed"));
    assert_eq!(
        events[5]["response"]["output"][0]["content"][0]["text"],
        json!("收到，我在线。")
    );
}

/// `stream_response` frames: `event: <type>\ndata: <json>\n\n`, with a
/// zero-based `sequence_number` inside the data document.
#[test]
fn renders_sse_frames_with_sequence_numbers() {
    let mut events = [
        json!({"type": "response.created", "response": {"status": "queued"}}),
        json!({"type": "response.in_progress", "response": {"status": "in_progress"}}),
    ];
    let frames: Vec<String> = events
        .iter_mut()
        .enumerate()
        .map(|(index, event)| sse_frame(event, index as u64))
        .collect();
    assert!(frames[0].starts_with("event: response.created\ndata: "));
    assert!(frames[0].contains("\"sequence_number\":0"));
    assert!(frames[1].starts_with("event: response.in_progress\ndata: "));
    assert!(frames[1].contains("\"sequence_number\":1"));
    assert!(frames[1].ends_with("\n\n"));
    let data = frames[0]
        .lines()
        .nth(1)
        .and_then(|line| line.strip_prefix("data: "))
        .expect("data line");
    let parsed: Value = serde_json::from_str(data).expect("frame data is JSON");
    assert_eq!(parsed["type"], json!("response.created"));
}
