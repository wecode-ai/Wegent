use axum::{
    extract::{Json, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use serde_json::{json, Value};
use tokio::{net::TcpListener, sync::mpsc};
use wegent_model_proxy::local_model_proxy::{
    bind_thread, register_with_vision_sidecar, token_route, TOKEN_ROUTE,
};

async fn strict_responses_model(
    State(received): State<mpsc::Sender<Value>>,
    Json(body): Json<Value>,
) -> Response {
    let Some(input) = body["input"].as_array() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if input.iter().any(|item| {
        matches!(
            item["type"].as_str(),
            Some("function_call" | "function_call_output")
        ) && !item["call_id"].as_str().is_some_and(|id| !id.is_empty())
    }) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": {"message": "Invalid request: tool_call_id  is not found"}})),
        )
            .into_response();
    }
    received.send(body).await.unwrap();
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"output\":[]}}\n\n",
    )
        .into_response()
}

#[tokio::test]
async fn replays_server_tool_search_history_to_a_function_only_responses_model() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/responses", listener.local_addr().unwrap());
    let (capture, mut received) = mpsc::channel(1);
    let model = Router::new()
        .route("/responses", post(strict_responses_model))
        .with_state(capture);
    let model_server = tokio::spawn(async move { axum::serve(listener, model).await.unwrap() });
    let upstream = serde_json::from_value(json!({
        "base_url": upstream,
        "request_url": upstream,
        "api_format": "openai-responses",
        "codex_request_mode": "standard",
        "model_id": "moonshot-kimi-k3.1-pro",
        "convert_custom_tools": true,
        "native_tool_search": false,
        "native_namespace_tools": false,
        "api_key": "",
        "default_headers": []
    }))
    .unwrap();
    let token = register_with_vision_sidecar("server-tool-search-history", upstream, None);
    bind_thread(&token, "server-tool-search-history").unwrap();
    let request = json!({
        "model": "wework-kimi-k3-1-pro",
        "client_metadata": {"thread_id": "server-tool-search-history"},
        "input": [
            {"type": "message", "role": "user", "content": "Find and use the read-only tool."},
            {"type": "tool_search_call", "execution": "server", "call_id": null,
             "arguments": {"paths": ["lookup"]}, "status": "completed"},
            {"type": "tool_search_output", "execution": "server", "call_id": null,
             "status": "completed", "tools": [
                {"type": "namespace", "name": "lookup", "tools": [
                    {"type": "function", "name": "read", "parameters": {"type": "object"}}
                ]}
             ]},
            {"type": "function_call", "namespace": "lookup", "name": "read",
             "call_id": "call_read", "arguments": "{}"},
            {"type": "function_call_output", "call_id": "call_read", "output": "found"},
            {"type": "message", "role": "user", "content": "Continue the conversation."}
        ]
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!(
        "http://{}/v1/codex-router/{token}/responses",
        listener.local_addr().unwrap()
    );
    let proxy = Router::new().route(TOKEN_ROUTE, token_route());
    let proxy_server = tokio::spawn(async move { axum::serve(listener, proxy).await.unwrap() });
    let reply = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap()
        .post(proxy_url)
        .json(&request)
        .send()
        .await
        .unwrap();
    let status = reply.status();
    let body = reply.text().await.unwrap();
    proxy_server.abort();
    model_server.abort();
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.contains("\"type\":\"response.completed\""), "{body}");
    let received = received
        .try_recv()
        .expect("proxy must reach the model service");
    let input = received["input"].as_array().unwrap();
    assert_eq!(input.len(), 4);
    assert_eq!(input[0], request["input"][0]);
    assert_eq!(input[1]["type"], "function_call");
    assert_eq!(input[1]["call_id"], "call_read");
    assert_eq!(input[2], request["input"][4]);
    assert_eq!(input[3], request["input"][5]);
    assert!(received["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| { tool["type"] == "function" && tool["name"] == input[1]["name"] }));
}
