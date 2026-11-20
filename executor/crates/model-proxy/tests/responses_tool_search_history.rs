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

#[derive(Clone, Copy)]
enum Protocol {
    Responses,
    Chat,
    Anthropic,
    NativeResponses,
}

impl Protocol {
    fn endpoint(self) -> &'static str {
        match self {
            Self::Responses | Self::NativeResponses => "openai-responses",
            Self::Chat => "openai-chat-completions",
            Self::Anthropic => "anthropic-messages",
        }
    }

    fn completion(self) -> &'static str {
        match self {
            Self::Responses | Self::NativeResponses => {
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"output\":[]}}\n\n"
            }
            Self::Chat => {
                "data: {\"id\":\"chat_test\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"
            }
            Self::Anthropic => concat!(
                "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test\",",
                "\"model\":\"test\",\"usage\":{\"input_tokens\":1}}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,",
                "\"delta\":{\"type\":\"text_delta\",\"text\":\"Done\"}}\n\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},",
                "\"usage\":{\"output_tokens\":1}}\n\n",
                "data: {\"type\":\"message_stop\"}\n\n"
            ),
        }
    }

    fn tool_entries(self, body: &Value) -> Vec<(&'static str, &Value)> {
        match self {
            Self::Responses | Self::NativeResponses => body["input"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|item| match item["type"].as_str() {
                    Some("function_call") => Some(("call", &item["call_id"])),
                    Some("function_call_output") => Some(("result", &item["call_id"])),
                    _ => None,
                })
                .collect(),
            Self::Chat => body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|message| {
                    let mut entries = Vec::new();
                    if let Some(calls) = message["tool_calls"].as_array() {
                        entries.extend(calls.iter().map(|call| ("call", &call["id"])));
                    }
                    if message["role"] == "tool" {
                        entries.push(("result", &message["tool_call_id"]));
                    }
                    entries
                })
                .collect(),
            Self::Anthropic => body["messages"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|message| message["content"].as_array().into_iter().flatten())
                .filter_map(|item| match item["type"].as_str() {
                    Some("tool_use") => Some(("call", &item["id"])),
                    Some("tool_result") => Some(("result", &item["tool_use_id"])),
                    _ => None,
                })
                .collect(),
        }
    }

    fn tool_name(self, tool: &Value) -> &Value {
        match self {
            Self::Chat => &tool["function"]["name"],
            _ => &tool["name"],
        }
    }
}

async fn strict_model(
    State((protocol, received)): State<(Protocol, mpsc::Sender<Value>)>,
    Json(body): Json<Value>,
) -> Response {
    if protocol
        .tool_entries(&body)
        .iter()
        .any(|(_, id)| id.as_str().is_none_or(str::is_empty))
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": {"message": "Invalid request: tool_call_id  is not found"}})),
        )
            .into_response();
    }
    received.send(body).await.unwrap();
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        protocol.completion(),
    )
        .into_response()
}

async fn replay_server_search(protocol: Protocol) -> (Value, Value) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/model", listener.local_addr().unwrap());
    let (capture, mut received) = mpsc::channel(1);
    let model = Router::new()
        .route("/model", post(strict_model))
        .with_state((protocol, capture));
    let model_server = tokio::spawn(async move { axum::serve(listener, model).await.unwrap() });
    let mode = if matches!(protocol, Protocol::NativeResponses) {
        "passthrough"
    } else {
        "standard"
    };
    let upstream = serde_json::from_value(json!({
        "base_url": upstream,
        "request_url": upstream,
        "api_format": protocol.endpoint(),
        "codex_request_mode": if matches!(protocol, Protocol::Responses | Protocol::NativeResponses) { mode } else { "auto" },
        "model_id": "moonshot-kimi-k3.1-pro",
        "convert_custom_tools": true,
        "native_tool_search": false,
        "native_namespace_tools": false,
        "api_key": "",
        "default_headers": []
    }))
    .unwrap();
    let thread = format!("history-{}", uuid::Uuid::new_v4());
    let token = register_with_vision_sidecar(&thread, upstream, None);
    bind_thread(&token, &thread).unwrap();
    let request = json!({
        "model": "wework-kimi-k3-1-pro",
        "stream": true,
        "tools": [],
        "client_metadata": {"thread_id": thread},
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
    assert_eq!(status, StatusCode::OK, "{}: {body}", protocol.endpoint());
    assert!(body.contains("\"type\":\"response.completed\""), "{body}");
    (
        request,
        received
            .try_recv()
            .expect("proxy must reach the model service"),
    )
}

async fn assert_replayed_pair(protocol: Protocol) -> (Value, Value) {
    let (request, received) = replay_server_search(protocol).await;
    let id = json!("call_read");
    assert_eq!(
        protocol.tool_entries(&received),
        [("call", &id), ("result", &id)]
    );
    assert!(received["tools"].as_array().unwrap().iter().any(|tool| {
        protocol
            .tool_name(tool)
            .as_str()
            .is_some_and(|name| name.ends_with("read"))
    }));
    (request, received)
}

#[tokio::test]
async fn replays_server_tool_search_history_to_a_function_only_responses_model() {
    let (request, received) = assert_replayed_pair(Protocol::Responses).await;
    let input = received["input"].as_array().unwrap();
    assert_eq!(input.len(), 4);
    assert_eq!(input[0], request["input"][0]);
    assert_eq!(input[2], request["input"][4]);
    assert_eq!(input[3], request["input"][5]);
    assert!(received["tools"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tool| { tool["type"] == "function" && tool["name"] == input[1]["name"] }));
}

#[tokio::test]
async fn replays_server_tool_search_history_to_chat_completions() {
    assert_replayed_pair(Protocol::Chat).await;
}

#[tokio::test]
async fn replays_server_tool_search_history_to_anthropic_messages() {
    assert_replayed_pair(Protocol::Anthropic).await;
}

#[tokio::test]
async fn preserves_native_server_search_history_for_a_passthrough_model() {
    let (request, received) = replay_server_search(Protocol::NativeResponses).await;
    assert_eq!(received["input"], request["input"]);
    assert_eq!(received["tools"], request["tools"]);
}
