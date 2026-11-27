// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use super::*;
use axum::{
    body::{to_bytes, Bytes},
    http::{header, HeaderMap, HeaderValue},
    routing::post,
    Router,
};
use serde_json::{json, Value};
use tokio::sync::Mutex;

fn upstream(mode: &str) -> LocalModelProxyUpstream {
    super::super::upstream_from_model_config(&json!({
        "base_url": "http://127.0.0.1:1",
        "model_id": "moonshot-kimi-k3",
        "api_key": "model-key",
        "codex_request_mode": mode,
        "native_tool_search": true,
        "native_namespace_tools": true,
        "tool_profile": "function",
        "max_output_tokens": 12345,
    }))
    .expect("valid policy")
    .expect("upstream")
}

fn codex_request() -> Value {
    json!({
        "model": "wework-gpt-5.6-sol",
        "stream": true,
        "store": true,
        "previous_response_id": "previous/response",
        "include": ["reasoning.encrypted_content"],
        "reasoning": {"effort": "high", "summary": "detailed"},
        "client_metadata": {"thread_id": "request-policy-thread"},
        "provider_extension": {"value": [true, 3]},
        "input": [
            {"type": "reasoning", "id": "reasoning/one", "encrypted_content": "encrypted"},
            {"type": "function_call", "id": "call/one", "call_id": "call/one",
             "name": "read", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "call/one", "output": "result"}
        ],
        "tools": [
            {"type": "tool_search", "execution": "client"},
            {"type": "namespace", "name": "app", "tools": [
                {"type": "function", "name": "read", "parameters": {"type": "object"}}
            ]},
            {"type": "custom", "name": "apply_patch", "format": {"type": "text"}},
            {"type": "web_search", "external_web_access": true},
            {"type": "image_generation", "quality": "high"}
        ]
    })
}

#[tokio::test]
async fn official_chatgpt_normalizes_foreign_reasoning_before_forwarding() {
    let upstream = super::super::upstream_from_model_config(&json!({
        "base_url": super::super::OFFICIAL_CHATGPT_CODEX_BASE_URL,
        "codex_request_mode": "auto",
        "tool_profile": "custom",
        "native_tool_search": true,
        "native_namespace_tools": true
    }))
    .unwrap()
    .unwrap();
    let original = json!({
        "model": "gpt-6.1-sol",
        "input": [
            {
                "type": "reasoning",
                "id": "rs_foreign",
                "summary": [],
                "content": [{"type": "reasoning_text", "text": "foreign thought"}],
                "encrypted_content": "foreign-seal"
            },
            {
                "type": "message",
                "role": "user",
                "id": "wework_event_4d7b7f0ca34416937adf4da7ab5046a3",
                "content": [{"type": "input_text", "text": "continue"}]
            }
        ]
    });

    let encoded = serde_json::to_string(&original)
        .unwrap()
        .replace("wework_event_", r"\u0077ework_event_");
    let prepared = prepare(
        &upstream,
        encoded.as_bytes(),
        None,
        &Default::default(),
        false,
        false,
        &Default::default(),
    )
    .await
    .unwrap();
    let request: Value = serde_json::from_slice(&prepared.body).unwrap();

    assert_eq!(prepared.normalized_reasoning_items, 1);
    assert_eq!(request["input"][0]["content"], json!([]));
    assert_eq!(request["input"][0]["summary"][0]["text"], "foreign thought");
    assert!(request["input"][0].get("id").is_none());
    assert!(request["input"][0].get("encrypted_content").is_none());
    assert!(request["input"][1].get("id").is_none());
    assert_eq!(request["input"][1]["content"][0]["text"], "continue");
}

#[tokio::test]
async fn official_chatgpt_auto_removes_old_provider_state_on_switch() {
    let upstream = super::super::upstream_from_model_config(&json!({
        "base_url": super::super::OFFICIAL_CHATGPT_CODEX_BASE_URL,
        "codex_request_mode": "auto"
    }))
    .unwrap()
    .unwrap();
    let original = json!({
        "model": "gpt-6.1-sol",
        "previous_response_id": "resp_old_provider",
        "input": [
            {
                "type": "reasoning",
                "id": "rs_foreign",
                "summary": [],
                "content": [{"type": "reasoning_text", "text": "foreign thought"}],
                "encrypted_content": "foreign-seal"
            },
            {
                "type": "context_compaction",
                "encrypted_content": "old-compaction"
            },
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "continue"}]
            }
        ]
    });

    let prepared = prepare(
        &upstream,
        &serde_json::to_vec(&original).unwrap(),
        None,
        &Default::default(),
        true,
        false,
        &Default::default(),
    )
    .await
    .unwrap();
    let request: Value = serde_json::from_slice(&prepared.body).unwrap();

    assert!(request.get("previous_response_id").is_none());
    assert_eq!(request["input"].as_array().unwrap().len(), 2);
    assert_eq!(request["input"][0]["content"], json!([]));
    assert_eq!(request["input"][0]["summary"][0]["text"], "foreign thought");
    assert_eq!(request["input"][1]["role"], "user");
}

#[tokio::test]
async fn passthrough_preserves_every_field_except_the_routed_model() {
    let original = codex_request();
    let prepared = prepare(
        &upstream("passthrough"),
        &serde_json::to_vec(&original).unwrap(),
        None,
        &Default::default(),
        true,
        true,
        &Default::default(),
    )
    .await
    .expect("passthrough request");
    let mut expected = original;
    expected["model"] = json!("moonshot-kimi-k3");
    assert_eq!(
        serde_json::from_slice::<Value>(&prepared.body).unwrap(),
        expected
    );
    assert!(prepared.conversion.is_none());
    assert_eq!(prepared.stripped_encrypted_content, 0);
    assert!(expected.get("max_output_tokens").is_none());
}

#[tokio::test]
async fn passthrough_without_model_mapping_preserves_request_bytes() {
    let mut config = upstream("passthrough");
    config.model_id = None;
    let original = br#"{ "model": "actual-model", "input": [
        {"type":"function_call","call_id":"x","name":"exec","arguments":"{}"},
        {"type":"function_call_output","call_id":"x","output":"running"},
        {"type":"function_call_output","call_id":"x","name":"exec","output":"queued"}
    ], "store": true }"#;
    let prepared = prepare(
        &config,
        original,
        None,
        &Default::default(),
        true,
        true,
        &Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(prepared.body, original);
}

#[tokio::test]
async fn responses_omits_mismatched_history_ids_and_keeps_call_pairing() {
    let original = json!({"input": [
        {"type": "custom_tool_call", "id": "fc_old", "call_id": "call_old",
         "name": "apply_patch", "input": "patch"},
        {"type": "custom_tool_call_output", "call_id": "call_old", "output": "done"},
        {"type": "function_call", "id": "fc_valid", "call_id": "call_valid",
         "name": "read", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "call_valid", "output": "result"}
    ]});
    let mut expected = original["input"].clone();
    expected[0].as_object_mut().unwrap().remove("id");

    for mode in ["auto", "passthrough"] {
        let upstream = super::super::upstream_from_model_config(&json!({
            "base_url": "http://127.0.0.1:1",
            "codex_request_mode": mode,
            "tool_profile": "custom"
        }))
        .unwrap()
        .unwrap();
        let prepared = prepare(
            &upstream,
            &serde_json::to_vec(&original).unwrap(),
            None,
            &Default::default(),
            false,
            false,
            &Default::default(),
        )
        .await
        .unwrap();
        let request: Value = serde_json::from_slice(&prepared.body).unwrap();
        assert_eq!(
            request["input"],
            if mode == "passthrough" {
                &original["input"]
            } else {
                &expected
            }
            .clone(),
            "mode {mode}"
        );
    }
}

#[tokio::test]
async fn responses_adapts_agent_messages_in_auto_and_standard_modes() {
    let original = json!({"input": [
        {"type": "message", "role": "user",
         "content": [{"type": "input_text", "text": "User input"}]},
        {"type": "agent_message", "author": "/root", "recipient": "/root/worker",
         "id": "amsg_one", "content": [{"type": "input_text", "text": "Continue the task"}]}
    ]});
    let mut compatible = original.clone();
    compatible["input"][1] = json!({
        "type": "message", "role": "developer",
        "content": original["input"][1]["content"]
    });

    for (mode, model, forked, expected) in [
        ("auto", "moonshot-kimi-k3", false, &compatible),
        ("standard", "another-provider", true, &compatible),
        ("passthrough", "another-provider", true, &original),
    ] {
        let mut config = upstream(mode);
        config.model_id = Some(model.to_owned());
        let mut input = original.clone();
        if mode == "standard" {
            input["input"][1]["encrypted_content"] = json!("stale-fork-state");
        }
        let prepared = prepare(
            &config,
            &serde_json::to_vec(&input).unwrap(),
            None,
            &Default::default(),
            false,
            forked,
            &Default::default(),
        )
        .await
        .unwrap();
        let request: Value = serde_json::from_slice(&prepared.body).unwrap();
        assert_eq!(request["input"], expected["input"], "mode {mode}");
    }
}

#[tokio::test]
async fn chat_completions_preserves_subagent_messages_as_system_context() {
    let upstream = super::super::upstream_from_model_config(&json!({
        "base_url": "http://127.0.0.1:1",
        "model_id": "provider-model",
        "upstream_api_format": "openai-chat-completions"
    }))
    .unwrap()
    .unwrap();
    let task = "Message Type: NEW_TASK\nTask name: /root/worker\nSender: /root\nPayload:\nReview the change";
    let completion = "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nReview complete";
    let original = json!({"input": [
        {"type": "agent_message", "author": "/root", "recipient": "/root/worker",
         "content": [{"type": "input_text", "text": task}]},
        {"type": "message", "role": "user",
         "content": [{"type": "input_text", "text": "User input"}]},
        {"type": "agent_message", "author": "/root/worker", "recipient": "/root",
         "content": [{"type": "input_text", "text": completion}]}
    ]});
    let prepared = prepare(
        &upstream,
        &serde_json::to_vec(&original).unwrap(),
        None,
        &Default::default(),
        false,
        false,
        &Default::default(),
    )
    .await
    .unwrap();
    let request: Value = serde_json::from_slice(&prepared.body).unwrap();
    assert_eq!(
        request["messages"],
        json!([
            {"role": "system", "content": format!("{task}\n\n{completion}")},
            {"role": "user", "content": "User input"}
        ])
    );
}

#[tokio::test]
async fn standard_mode_bridges_client_tools_and_omits_hosted_tools() {
    let prepared = prepare(
        &upstream("standard"),
        &serde_json::to_vec(&codex_request()).unwrap(),
        None,
        &Default::default(),
        false,
        false,
        &Default::default(),
    )
    .await
    .expect("standard request");
    let request: Value = serde_json::from_slice(&prepared.body).unwrap();
    assert_eq!(request["tools"].as_array().unwrap().len(), 3);
    assert!(request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tool| tool["type"] == "function"));
    assert!(matches!(
        prepared.conversion,
        Some(Conversion::Responses(_))
    ));
    assert_eq!(request["max_output_tokens"], 12345);
}

#[tokio::test]
async fn standard_mode_rejects_forced_hosted_tools_before_sending() {
    for choice in [
        json!({"type": "web_search"}),
        json!({"type": "image_generation"}),
        json!({"type": "allowed_tools", "mode": "required", "tools": [
            {"type": "web_search"}
        ]}),
        json!("required"),
    ] {
        let request = json!({
            "model": "catalog",
            "tools": [{"type": "web_search"}],
            "tool_choice": choice,
        });
        let error = prepare(
            &upstream("standard"),
            &serde_json::to_vec(&request).unwrap(),
            None,
            &Default::default(),
            false,
            false,
            &Default::default(),
        )
        .await
        .err()
        .expect("a forced hosted tool is unavailable in standard mode");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        assert!(error.detail.contains("tool_choice"));
    }
}

#[test]
fn invalid_modes_and_non_responses_passthrough_fail_before_registration() {
    for config in [
        json!({"base_url": "http://localhost", "codex_request_mode": "unknown"}),
        json!({"base_url": "http://localhost", "codex_request_mode": true}),
        json!({"base_url": "http://localhost", "codex_request_mode": "passthrough",
               "upstream_api_format": "anthropic-messages"}),
    ] {
        assert!(super::super::upstream_from_model_config(&config).is_err());
    }
}

#[test]
fn invalid_modes_cannot_select_the_direct_provider_path() {
    for config in [
        json!({"codex_request_mode": "unknown"}),
        json!({"base_url": "", "codex_request_mode": true}),
        json!({"baseUrl": "  ", "codex_request_mode": {}}),
        json!({"codex_request_mode": []}),
        json!({"codex_request_mode": "passthrough",
               "upstream_api_format": "openai-chat-completions"}),
    ] {
        assert!(super::super::upstream_from_model_config(&config).is_err());
    }
}

#[tokio::test]
async fn passthrough_http_forwards_business_fields_and_raw_response_with_provider_auth() {
    for text_only in [false, true] {
        let captured = Arc::new(Mutex::new(None));
        let capture = Arc::clone(&captured);
        let raw_response =
            b"data: {\"type\":\"provider.extension\",\"unknown\":true}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"provider/response\",\"output\":[],\"opaque\":true}}\n\ndata: [DONE]\n\n";
        let app = Router::new().route(
            "/responses",
            post(move |headers: HeaderMap, body: Bytes| {
                let capture = Arc::clone(&capture);
                async move {
                    *capture.lock().await = Some((headers, body));
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        raw_response.as_slice(),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut config = upstream("passthrough");
        config.base_url = format!("http://{address}");
        let token = super::super::register("request-policy-http", config);
        if text_only {
            super::super::set_text_only(&token);
        }
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        headers.insert(
            "x-codex-forked-from-thread-id",
            HeaderValue::from_static("parent-thread"),
        );
        let mut original = codex_request();
        original["tools"][2]["name"] = json!("exec");
        let encoded = serde_json::to_string_pretty(&original).unwrap();
        let response = super::super::handle(headers, Bytes::from(encoded.clone()))
            .await
            .expect("proxy response");
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX).await.unwrap(),
            raw_response.as_slice()
        );
        let (headers, received) = captured.lock().await.take().expect("upstream request");
        assert_eq!(headers[header::AUTHORIZATION], "Bearer model-key");
        let mapped = encoded.replace("wework-gpt-5.6-sol", "moonshot-kimi-k3");
        assert_eq!(received.as_ref(), mapped.as_bytes());
        super::super::unregister(&token);
        server.abort();
    }
}
