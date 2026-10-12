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
async fn passthrough_preserves_every_field_except_the_routed_model() {
    let original = codex_request();
    let prepared = prepare(
        &upstream("passthrough"),
        &serde_json::to_vec(&original).unwrap(),
        None,
        &Default::default(),
        true,
        true,
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
    let original = b"{ \"model\": \"actual-model\", \"input\": [], \"store\": true }";
    let prepared = prepare(&config, original, None, &Default::default(), true, true)
        .await
        .unwrap();
    assert_eq!(prepared.body, original);
}

#[tokio::test]
async fn passthrough_skips_image_sidecar_requests() {
    let sidecar = VisionSidecarUpstream {
        request_url: "http://127.0.0.1:1/responses".to_owned(),
        api_format: "openai-responses".to_owned(),
        api_key: String::new(),
        default_headers: Vec::new(),
        proxy_url: None,
        model_id: "sidecar".to_owned(),
        max_descriptions_per_turn: 1,
        timeout: std::time::Duration::from_millis(1),
    };
    let original = json!({
        "model": "catalog",
        "input": [{"role": "user", "content": [
            {"type": "input_image", "image_url": "data:image/png;base64,original"}
        ]}],
    });
    let prepared = prepare(
        &upstream("passthrough"),
        &serde_json::to_vec(&original).unwrap(),
        Some(&sidecar),
        &Default::default(),
        false,
        false,
    )
    .await
    .expect("sidecar must not be contacted");
    let result: Value = serde_json::from_slice(&prepared.body).unwrap();
    assert_eq!(result["input"], original["input"]);
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
async fn auto_mode_preserves_hosted_tools() {
    let original = codex_request();
    let prepared = prepare(
        &upstream("auto"),
        &serde_json::to_vec(&original).unwrap(),
        None,
        &Default::default(),
        false,
        false,
    )
    .await
    .unwrap();
    let request: Value = serde_json::from_slice(&prepared.body).unwrap();
    for tool_type in ["web_search", "image_generation"] {
        let find_tool = |body: &Value| {
            body["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["type"] == tool_type)
                .unwrap()
                .clone()
        };
        assert_eq!(find_tool(&request), find_tool(&original));
    }
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
        )
        .await
        .err()
        .expect("a forced hosted tool is unavailable in standard mode");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        assert!(error.detail.contains("tool_choice"));
    }
}

#[tokio::test]
async fn standard_mode_preserves_supported_tool_choices() {
    for choice in [
        json!("auto"),
        json!("none"),
        json!("required"),
        json!({"type": "function", "name": "read"}),
        json!({"type": "allowed_tools", "mode": "required", "tools": [
            {"type": "function", "name": "read"}
        ]}),
    ] {
        let request = json!({
            "model": "catalog",
            "tools": [
                {"type": "function", "name": "read", "parameters": {"type": "object"}},
                {"type": "web_search"}
            ],
            "tool_choice": choice,
        });
        let prepared = prepare(
            &upstream("standard"),
            &serde_json::to_vec(&request).unwrap(),
            None,
            &Default::default(),
            false,
            false,
        )
        .await
        .unwrap();
        let result: Value = serde_json::from_slice(&prepared.body).unwrap();
        assert_eq!(result["tool_choice"], choice);
        assert_eq!(result["tools"].as_array().unwrap().len(), 1);
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

#[test]
fn valid_unconfigured_models_keep_the_direct_provider_path() {
    for config in [
        json!({}),
        json!({"base_url": ""}),
        json!({"baseUrl": "  ", "codex_request_mode": "auto"}),
        json!({"codex_request_mode": "standard"}),
        json!({"codex_request_mode": "passthrough"}),
    ] {
        assert!(super::super::upstream_from_model_config(&config)
            .expect("unconfigured proxy with a valid request policy")
            .is_none());
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
                    *capture.lock().await =
                        Some((headers, serde_json::from_slice::<Value>(&body).unwrap()));
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
        let original = codex_request();
        let response =
            super::super::handle(headers, Bytes::from(serde_json::to_vec(&original).unwrap()))
                .await
                .expect("proxy response");
        assert_eq!(
            to_bytes(response.into_body(), usize::MAX).await.unwrap(),
            raw_response.as_slice()
        );
        let (headers, mut received) = captured.lock().await.take().expect("upstream request");
        assert_eq!(headers[header::AUTHORIZATION], "Bearer model-key");
        received["model"] = original["model"].clone();
        let mut expected = original.clone();
        if text_only {
            expected["tools"] = json!([]);
            expected["tool_choice"] = json!("none");
            expected
                .as_object_mut()
                .unwrap()
                .remove("parallel_tool_calls");
        }
        assert_eq!(received, expected);
        super::super::unregister(&token);
        server.abort();
    }
}
