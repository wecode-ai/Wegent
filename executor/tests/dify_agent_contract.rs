// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
use serde_json::{json, Value};
use wegent_executor::{
    agents::{build_dify_config, saved_dify_task_id, DifyEngine},
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

#[test]
fn dify_config_merges_bot_env_and_prompt_params() {
    let request = ExecutionRequest {
        task_id: "123".to_owned(),
        prompt: json!(
            "[EXTERNAL_API_PARAMS]{\"language\":\"zh-CN\",\"priority\":10}[/EXTERNAL_API_PARAMS] Hello Dify"
        ),
        bot: json!([{
            "shell_type": "Dify",
            "bot_prompt": "{\"difyAppId\":\"app-from-bot\",\"params\":{\"language\":\"en-US\",\"customer\":\"Alice\"}}",
            "agent_config": {
                "env": {
                    "DIFY_API_KEY": "app-test-api-key",
                    "DIFY_BASE_URL": "https://api.dify.ai",
                    "DIFY_APP_ID": "app-from-env",
                    "DIFY_PARAMS": "{\"customer\":\"Bob\",\"region\":\"cn\"}"
                }
            }
        }]),
        ..ExecutionRequest::default()
    };

    let config = build_dify_config(&request);

    assert_eq!(config.api_key, "app-test-api-key");
    assert_eq!(config.base_url, "https://api.dify.ai");
    assert_eq!(config.app_id, "app-from-bot");
    assert_eq!(config.prompt, "Hello Dify");
    assert_eq!(config.params["language"], "zh-CN");
    assert_eq!(config.params["customer"], "Bob");
    assert_eq!(config.params["region"], "cn");
    assert_eq!(config.params["priority"], 10);
}

#[tokio::test]
async fn dify_engine_calls_chat_streaming_api() {
    let captured_request = Arc::new(Mutex::new(None));
    let app = Router::new()
        .route("/v1/info", get(|| async { Json(json!({"mode": "chat"})) }))
        .route("/v1/chat-messages", axum::routing::post(chat_messages))
        .with_state(Arc::clone(&captured_request));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr: SocketAddr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let request = ExecutionRequest {
        task_id: "321".to_owned(),
        prompt: json!("Hello Dify"),
        bot: json!([{
            "shell_type": "Dify",
            "agent_config": {
                "env": {
                    "DIFY_API_KEY": "app-test-api-key",
                    "DIFY_BASE_URL": format!("http://{addr}")
                }
            }
        }]),
        ..ExecutionRequest::default()
    };

    let outcome = DifyEngine::new().run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "Hello World".to_owned()
        }
    );
    let payload = captured_request.lock().unwrap().clone().unwrap();
    assert_eq!(payload["query"], "Hello Dify");
    assert_eq!(payload["response_mode"], "streaming");
    assert_eq!(payload["user"], "task-321");
    assert_eq!(payload["auto_generate_name"], true);
    assert_eq!(saved_dify_task_id("321").as_deref(), Some("dify-task-1"));
    server.abort();
}

async fn chat_messages(
    State(captured_request): State<Arc<Mutex<Option<Value>>>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> String {
    assert_eq!(
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
        Some("Bearer app-test-api-key")
    );
    *captured_request.lock().unwrap() = Some(payload);
    [
        r#"data: {"event":"message","answer":"Hello","conversation_id":"conv-1","task_id":"dify-task-1"}"#,
        r#"data: {"event":"message","answer":" World"}"#,
        r#"data: {"event":"message_end"}"#,
        "",
    ]
    .join("\n")
}
