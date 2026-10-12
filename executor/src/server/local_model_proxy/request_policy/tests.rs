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
            {"type": "custom", "name": "apply_patch", "format": {"type": "text"}}
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
async fn standard_mode_bridges_all_tools_even_with_native_flags_enabled() {
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

#[tokio::test]
async fn passthrough_http_forwards_business_fields_and_raw_response_with_provider_auth() {
    let captured = Arc::new(Mutex::new(None));
    let capture = Arc::clone(&captured);
    let raw_response =
        b"data: {\"type\":\"provider.extension\",\"unknown\":true}\n\ndata: [DONE]\n\n";
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
    assert_eq!(received, original);
    super::super::unregister(&token);
    server.abort();
}
