// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn upstream(endpoint: &str, mode: &str) -> LocalModelProxyUpstream {
    upstream_from_model_config(&json!({
        "base_url": endpoint,
        "codex_request_mode": mode,
        "tool_profile": "custom",
        "api_key": "synthetic-key"
    }))
    .unwrap()
    .unwrap()
}

#[test]
fn deepseek_custom_tool_policy_is_endpoint_bound_and_respects_explicit_modes() {
    use chat::CustomToolConversion::{All, ExceptApplyPatch, None};
    for (endpoint, mode, expected) in [
        ("https://api.deepseek.com", "auto", ExceptApplyPatch),
        ("https://api.deepseek.com/v1", "auto", ExceptApplyPatch),
        ("https://api.deepseek.com", "standard", All),
        ("https://api.deepseek.com", "passthrough", None),
        ("https://api.deepseek.com.example.org", "auto", None),
        ("https://other.example/deepseek", "auto", None),
    ] {
        let capabilities = upstream(endpoint, mode).responses_tool_capabilities();
        assert_eq!(capabilities.custom_tools, expected, "{endpoint}: {mode}");
        if expected == ExceptApplyPatch {
            assert!(!capabilities.native_namespace_tools);
            assert!(!capabilities.native_tool_search);
            assert!(!capabilities.function_tools_only);
        }
    }
}

fn mixed_tool_request() -> Value {
    json!({
        "model":"deepseek-flash", "stream":true,
        "tools":[
            {"type":"custom","name":"apply_patch","format":{"type":"text"}},
            {"type":"custom","name":"exec","format":{"type":"text"}},
            {"type":"namespace","name":"functions","tools":[
                {"type":"custom","name":"exec","format":{"type":"text"}}
            ]},
            {"type":"web_search"}
        ],
        "input":[
            {"type":"custom_tool_call","name":"apply_patch","call_id":"patch1","input":"*** Begin Patch\n*** End Patch"},
            {"type":"custom_tool_call_output","call_id":"patch1","output":"done"},
            {"type":"custom_tool_call","name":"exec","call_id":"exec1","input":"text('中文')"},
            {"type":"custom_tool_call_output","call_id":"exec1","output":"中文"},
            {"type":"custom_tool_call","namespace":"functions","name":"exec","call_id":"exec2","input":"text(42)"},
            {"type":"custom_tool_call_output","call_id":"exec2","output":"42"}
        ]
    })
}

#[tokio::test]
async fn deepseek_custom_tool_protocol_rejects_raw_exec_and_accepts_bridged_exec() {
    use axum::{body::Body, http::Request, response::IntoResponse};
    use tower::ServiceExt;

    async fn deepseek_protocol(Json(body): Json<Value>) -> axum::response::Response {
        // Enforce the documented upstream rule rather than accepting every mock request.
        if body["tools"].as_array().unwrap().iter().any(|tool| {
            tool["type"] == "namespace"
                || (tool["type"] == "custom" && tool["name"] != "apply_patch")
        }) {
            return (StatusCode::BAD_REQUEST, "Unsupported custom tool: 'exec'").into_response();
        }
        assert_eq!(body["tools"][0]["type"], "custom");
        assert_eq!(body["tools"][1]["type"], "function");
        assert_eq!(body["tools"][3]["type"], "web_search");
        let item = json!({"type":"function_call", "id":"fc_1", "call_id":"call_1",
            "name":"functions__exec", "arguments":"{\"input\":\"text(42)\"}"});
        let events = [
            json!({"type":"response.output_item.added","output_index":0,"item":item}),
            json!({"type":"response.function_call_arguments.done","output_index":0,
                "item_id":"fc_1","arguments":"{\"input\":\"text(42)\"}"}),
            json!({"type":"response.output_item.done","output_index":0,"item":item}),
            json!({"type":"response.completed","response":{"status":"completed","output":[item]}}),
        ];
        let stream = events
            .iter()
            .map(|event| {
                format!(
                    "event: {}\ndata: {event}\n\n",
                    event["type"].as_str().unwrap()
                )
            })
            .collect::<String>();
        ([(header::CONTENT_TYPE, "text/event-stream")], stream).into_response()
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}", listener.local_addr().unwrap());
    let fixture = tokio::spawn(async move {
        axum::serve(listener, Router::new().fallback(deepseek_protocol))
            .await
            .unwrap();
    });
    // A loopback HTTP forward proxy keeps the production endpoint identity without
    // external traffic, credentials, or TLS verification exceptions.
    let mut upstream = upstream("http://api.deepseek.com", "auto");
    upstream.proxy_url = Some(proxy_url.clone());
    let raw_response = proxy_client(Some(&proxy_url))
        .unwrap()
        .post("http://api.deepseek.com/responses")
        .json(&mixed_tool_request())
        .send()
        .await
        .unwrap();
    assert_eq!(raw_response.status(), StatusCode::BAD_REQUEST);

    let token = register("deepseek-custom-tool-protocol", upstream);
    let request = Request::builder()
        .method("POST")
        .uri(ROUTE)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&mixed_tool_request()).unwrap(),
        ))
        .unwrap();
    let response = Router::new()
        .route(ROUTE, post(handle))
        .oneshot(request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let output = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let output = String::from_utf8(output.to_vec()).unwrap();
    assert!(output.contains("custom_tool_call"), "{output}");
    assert!(output.contains("\"namespace\":\"functions\""), "{output}");
    assert!(output.contains("text(42)"), "{output}");
    unregister(&token);
    fixture.abort();
}
