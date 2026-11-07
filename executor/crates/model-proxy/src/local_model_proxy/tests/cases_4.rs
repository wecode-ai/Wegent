use super::*;

#[tokio::test]
async fn native_responses_tool_search_passes_through_end_to_end() {
    let (request_tx, mut request_rx) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/responses",
                post(move |Json(body): Json<Value>| {
                    let request_tx = request_tx.clone();
                    async move {
                        let has_app_result = body["input"].as_array().is_some_and(|items| {
                            items.iter().any(|item| {
                                item.get("type").and_then(Value::as_str)
                                    == Some("function_call_output")
                                    && item.get("call_id").and_then(Value::as_str)
                                        == Some("app_1")
                            })
                        });
                        let loaded_app = body["input"].as_array().is_some_and(|items| {
                            items.iter().any(|item| {
                                item.get("type").and_then(Value::as_str)
                                    == Some("tool_search_output")
                            })
                        });
                        request_tx.send(body).expect("request receiver");
                        let response = if has_app_result {
                            concat!(
                                "event: response.completed\n",
                                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_done\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Created\"}]}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"input_tokens_details\":{},\"output_tokens_details\":{}}}}\n\n"
                            )
                        } else if loaded_app {
                            concat!(
                                "event: response.output_item.done\n",
                                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_app\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"app_1\",\"namespace\":\"github\",\"name\":\"create_issue\",\"arguments\":\"{\\\"title\\\":\\\"Bug\\\"}\"}}\n\n",
                                "event: response.completed\n",
                                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_app\",\"status\":\"completed\",\"output\":[{\"id\":\"fc_app\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"app_1\",\"namespace\":\"github\",\"name\":\"create_issue\",\"arguments\":\"{\\\"title\\\":\\\"Bug\\\"}\"}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"input_tokens_details\":{},\"output_tokens_details\":{}}}}\n\n"
                            )
                        } else {
                            concat!(
                                "event: response.output_item.done\n",
                                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"ts_1\",\"type\":\"tool_search_call\",\"status\":\"completed\",\"call_id\":\"search_1\",\"execution\":\"client\",\"arguments\":{\"query\":\"GitHub create issue\"}}}\n\n",
                                "event: response.completed\n",
                                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_search\",\"status\":\"completed\",\"output\":[{\"id\":\"ts_1\",\"type\":\"tool_search_call\",\"status\":\"completed\",\"call_id\":\"search_1\",\"execution\":\"client\",\"arguments\":{\"query\":\"GitHub create issue\"}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"input_tokens_details\":{},\"output_tokens_details\":{}}}}\n\n"
                            )
                        };
                        (
                            [(
                                header::CONTENT_TYPE,
                                HeaderValue::from_static("text/event-stream"),
                            )],
                            response,
                        )
                    }
                }),
            ),
        )
        .await
        .expect("upstream server");
    });
    let token = register(
        "native-responses-tool-search-e2e",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/responses")),
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            native_tool_search: true,
            native_namespace_tools: true,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: None,
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );

    let response = handle(
        proxy_headers(&token),
        Bytes::from(serde_json::to_vec(&app_tool_search_request(false)).expect("request body")),
    )
    .await
    .expect("proxy response");
    let response = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    let upstream_request = request_rx.recv().await.expect("captured upstream request");

    assert_eq!(upstream_request["tools"][0]["type"], "tool_search");
    assert_eq!(upstream_request["tools"][0]["execution"], "client");
    assert!(upstream_request["tools"][0].get("name").is_none());
    assert!(
        serde_json::to_vec(upstream_request["tools"].as_array().expect("tools"))
            .expect("serialize tools")
            .len()
            < 1_024
    );
    let response = String::from_utf8_lossy(&response);
    assert!(
        response.contains("\"type\":\"tool_search_call\""),
        "{response}"
    );
    assert!(
        response.contains("\"arguments\":{\"query\":\"GitHub create issue\"}"),
        "{response}"
    );

    let second_response = handle(
        proxy_headers(&token),
        Bytes::from(
            serde_json::to_vec(&app_tool_search_request(true)).expect("second request body"),
        ),
    )
    .await
    .expect("second proxy response");
    let second_response = to_bytes(second_response.into_body(), usize::MAX)
        .await
        .expect("second response body");
    let second_upstream = request_rx.recv().await.expect("second upstream request");
    assert_eq!(
        second_upstream["tools"]
            .as_array()
            .expect("second tools")
            .len(),
        1
    );
    assert_eq!(second_upstream["tools"][0]["type"], "tool_search");
    let second_response = String::from_utf8_lossy(&second_response);
    assert!(second_response.contains("\"namespace\":\"github\""));
    assert!(second_response.contains("\"name\":\"create_issue\""));

    let third_response = handle(
        proxy_headers(&token),
        Bytes::from(serde_json::to_vec(&app_tool_result_request()).expect("third request body")),
    )
    .await
    .expect("third proxy response");
    let _third_response = to_bytes(third_response.into_body(), usize::MAX)
        .await
        .expect("third response body");
    let third_upstream = request_rx.recv().await.expect("third upstream request");
    assert_eq!(
        third_upstream["input"]
            .as_array()
            .expect("third input")
            .iter()
            .find(|item| {
                item.get("type").and_then(Value::as_str) == Some("function_call_output")
                    && item.get("call_id").and_then(Value::as_str) == Some("app_1")
            })
            .expect("App result")["output"]["structuredContent"],
        json!({"id": 42, "url": "https://github.example/issues/42"})
    );

    unregister(&token);
    server.abort();
}

#[tokio::test]
async fn anthropic_bridge_loads_apps_on_demand_and_preserves_results_end_to_end() {
    let (request_tx, mut request_rx) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/messages",
                post(move |Json(body): Json<Value>| {
                    let request_tx = request_tx.clone();
                    async move {
                        let has_app_result =
                            body["messages"].as_array().is_some_and(|messages| {
                                messages.iter().any(|message| {
                                    message["content"].as_array().is_some_and(|content| {
                                        content.iter().any(|block| {
                                            block.get("type").and_then(Value::as_str)
                                                == Some("tool_result")
                                                && block
                                                    .get("tool_use_id")
                                                    .and_then(Value::as_str)
                                                    == Some("app_1")
                                        })
                                    })
                                })
                            });
                        let loaded_app = body["tools"].as_array().is_some_and(|tools| {
                            tools.iter().any(|tool| {
                                tool.get("name").and_then(Value::as_str) == Some("create_issue")
                            })
                        });
                        request_tx.send(body).expect("request receiver");
                        let response = if has_app_result {
                            concat!(
                                "event: message_start\n",
                                "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_done\",\"model\":\"kimi-k3\",\"usage\":{\"input_tokens\":1}}}\n\n",
                                "event: content_block_start\n",
                                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                                "event: content_block_delta\n",
                                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Created\"}}\n\n",
                                "event: content_block_stop\n",
                                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                                "event: message_delta\n",
                                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
                                "event: message_stop\n",
                                "data: {\"type\":\"message_stop\"}\n\n"
                            )
                        } else if loaded_app {
                            concat!(
                                "event: message_start\n",
                                "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_app\",\"model\":\"kimi-k3\",\"usage\":{\"input_tokens\":1}}}\n\n",
                                "event: content_block_start\n",
                                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"app_1\",\"name\":\"create_issue\",\"input\":{}}}\n\n",
                                "event: content_block_delta\n",
                                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"title\\\":\\\"Bug\\\"}\"}}\n\n",
                                "event: content_block_stop\n",
                                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                                "event: message_delta\n",
                                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":1}}\n\n",
                                "event: message_stop\n",
                                "data: {\"type\":\"message_stop\"}\n\n"
                            )
                        } else {
                            concat!(
                                "event: message_start\n",
                                "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_search\",\"model\":\"kimi-k3\",\"usage\":{\"input_tokens\":1}}}\n\n",
                                "event: content_block_start\n",
                                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"search_1\",\"name\":\"search_deferred_tools\",\"input\":{}}}\n\n",
                                "event: content_block_delta\n",
                                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"query\\\":\\\"GitHub create issue\\\"}\"}}\n\n",
                                "event: content_block_stop\n",
                                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                                "event: message_delta\n",
                                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":1}}\n\n",
                                "event: message_stop\n",
                                "data: {\"type\":\"message_stop\"}\n\n"
                            )
                        };
                        (
                            [(
                                header::CONTENT_TYPE,
                                HeaderValue::from_static("text/event-stream"),
                            )],
                            response,
                        )
                    }
                }),
            ),
        )
        .await
        .expect("upstream server");
    });
    let token = register(
        "anthropic-app-tool-search-e2e",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/messages")),
            api_format: "anthropic-messages".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: None,
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );

    let first_response = handle(
        proxy_headers(&token),
        Bytes::from(
            serde_json::to_vec(&app_tool_search_request(false)).expect("first request body"),
        ),
    )
    .await
    .expect("first proxy response");
    let first_response = to_bytes(first_response.into_body(), usize::MAX)
        .await
        .expect("first response body");
    let first_upstream = request_rx.recv().await.expect("first upstream request");
    assert_compact_bridged_app_tools(&first_upstream, "/name");
    assert!(String::from_utf8_lossy(&first_response).contains("\"type\":\"tool_search_call\""));

    let second_response = handle(
        proxy_headers(&token),
        Bytes::from(
            serde_json::to_vec(&app_tool_search_request(true)).expect("second request body"),
        ),
    )
    .await
    .expect("second proxy response");
    let second_response = to_bytes(second_response.into_body(), usize::MAX)
        .await
        .expect("second response body");
    let second_upstream = request_rx.recv().await.expect("second upstream request");
    assert_single_loaded_app_tool(&second_upstream, "/name", "create_issue");
    let second_response = String::from_utf8_lossy(&second_response);
    assert!(second_response.contains("\"namespace\":\"github\""));
    assert!(second_response.contains("\"name\":\"create_issue\""));

    let third_response = handle(
        proxy_headers(&token),
        Bytes::from(serde_json::to_vec(&app_tool_result_request()).expect("third request body")),
    )
    .await
    .expect("third proxy response");
    let _third_response = to_bytes(third_response.into_body(), usize::MAX)
        .await
        .expect("third response body");
    let third_upstream = request_rx.recv().await.expect("third upstream request");
    let app_result = third_upstream["messages"]
        .as_array()
        .expect("third messages")
        .iter()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|block| {
            block.get("type").and_then(Value::as_str) == Some("tool_result")
                && block.get("tool_use_id").and_then(Value::as_str) == Some("app_1")
        })
        .and_then(|block| block.get("content"))
        .and_then(Value::as_str)
        .expect("structured App result");
    assert_eq!(
        serde_json::from_str::<Value>(app_result).expect("App result JSON"),
        json!({"id": 42, "url": "https://github.example/issues/42"})
    );

    unregister(&token);
    server.abort();
}

#[tokio::test]
async fn anthropic_messages_bridge_preserves_mixed_assistant_tool_turns_end_to_end() {
    let (request_tx, request_rx) = oneshot::channel();
    let request_tx = Arc::new(Mutex::new(Some(request_tx)));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let server = tokio::spawn({
        let request_tx = request_tx.clone();
        async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/messages",
                    post(move |Json(body): Json<Value>| {
                        let request_tx = request_tx.clone();
                        async move {
                            request_tx
                                .lock()
                                .expect("request sender")
                                .take()
                                .expect("single request")
                                .send(body)
                                .expect("request receiver");
                            (
                                [(
                                    header::CONTENT_TYPE,
                                    HeaderValue::from_static("text/event-stream"),
                                )],
                                concat!(
                                    "event: message_start\n",
                                    "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_e2e\",\"model\":\"kimi-k3\",\"usage\":{\"input_tokens\":10}}}\n\n",
                                    "event: content_block_start\n",
                                    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                                    "event: content_block_delta\n",
                                    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"I will inspect it.\"}}\n\n",
                                    "event: content_block_stop\n",
                                    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                                    "event: content_block_start\n",
                                    "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_next\",\"name\":\"exec_command\",\"input\":{}}}\n\n",
                                    "event: content_block_delta\n",
                                    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}}\n\n",
                                    "event: content_block_stop\n",
                                    "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                                    "event: message_delta\n",
                                    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":8}}\n\n",
                                    "event: message_stop\n",
                                    "data: {\"type\":\"message_stop\"}\n\n"
                                ),
                            )
                        }
                    }),
                ),
            )
            .await
            .expect("upstream server");
        }
    });
    let token = register(
        "anthropic-mixed-turn-e2e",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/messages")),
            api_format: "anthropic-messages".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: None,
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    let response = handle(
        proxy_headers(&token),
        Bytes::from(serde_json::to_vec(&mixed_tool_turn_request()).expect("request body")),
    )
    .await
    .expect("proxy response");
    let response_body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    let upstream_request = request_rx.await.expect("captured upstream request");
    let messages = upstream_request["messages"].as_array().expect("messages");
    let assistant = messages
        .iter()
        .find(|message| {
            message.get("role").and_then(Value::as_str) == Some("assistant")
                && message
                    .get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|content| {
                        content.iter().any(|block| {
                            block.get("type").and_then(Value::as_str) == Some("text")
                                && block.get("text").and_then(Value::as_str)
                                    == Some("I will inspect it.")
                        })
                    })
        })
        .expect("assistant tool turn");
    let content = assistant["content"].as_array().expect("assistant content");

    assert!(content
        .iter()
        .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_use")));
    assert!(!messages
        .windows(2)
        .any(|pair| pair[0]["role"] == "assistant" && pair[1]["role"] == "assistant"));
    let response_body = String::from_utf8_lossy(&response_body);
    assert!(response_body.contains("response.output_text.delta"));
    assert!(response_body.contains("\"type\":\"function_call\""));
    assert!(response_body.contains("\"name\":\"exec_command\""));

    unregister(&token);
    server.abort();
}

#[tokio::test]
async fn streams_native_responses_without_interpreting_content_type() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/responses",
                post(|| async {
                    (
                        [(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))],
                        concat!(
                            "event: response.created\n",
                            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_mislabeled\",\"status\":\"in_progress\",\"output\":[]}}\n\n",
                            "event: response.completed\n",
                            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_mislabeled\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hi\"}]}]}}\n\n"
                        ),
                    )
                }),
            ),
        )
        .await
        .expect("upstream server");
    });
    let token = register(
        "native-mislabeled-sse-test",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/responses")),
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: None,
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).expect("authorization"),
    );

    let response = handle(
        headers,
        Bytes::from_static(br#"{"model":"m","input":"hi","stream":true}"#),
    )
    .await
    .expect("native Responses stream should pass through");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE),
        Some(&HeaderValue::from_static("application/json"))
    );
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("normalized response body");
    let body = String::from_utf8_lossy(&body);
    assert!(body.contains("event: response.completed"), "{body}");
    assert!(body.contains("resp_mislabeled"), "{body}");

    unregister(&token);
    server.abort();
}

#[tokio::test]
#[ignore = "requires an external model and Codex binary"]
async fn external_model_completes_a_codex_tool_loop() {
    let base_url =
        env::var("WEWORK_TEST_MODEL_BASE_URL").expect("WEWORK_TEST_MODEL_BASE_URL is required");
    let api_key =
        env::var("WEWORK_TEST_MODEL_API_KEY").expect("WEWORK_TEST_MODEL_API_KEY is required");
    let model_id = env::var("WEWORK_TEST_MODEL_ID").expect("WEWORK_TEST_MODEL_ID is required");
    let api_format = env::var("WEWORK_TEST_MODEL_API_FORMAT")
        .unwrap_or_else(|_| "openai-chat-completions".to_owned());
    let default_path = if api_format == "anthropic-messages" {
        "/v1/messages"
    } else {
        "/chat/completions"
    };
    let request_url = format!("{}{default_path}", base_url.trim_end_matches('/'));
    let token = register(
        "external-model-test",
        LocalModelProxyUpstream {
            base_url,
            request_url: Some(request_url),
            api_format,
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key,
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some(model_id.clone()),
            routing_model_id: None,
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("test proxy should bind");
    let address = listener
        .local_addr()
        .expect("test proxy address should exist");
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().route(ROUTE, post(handle)))
            .await
            .expect("test proxy should serve");
    });
    let workspace = tempfile::tempdir().expect("temporary workspace should exist");
    let codex_home = workspace.path().join("codex-home");
    fs::create_dir_all(&codex_home).expect("Codex home should be created");
    fs::write(workspace.path().join("README.md"), "# Verification\n")
        .expect("seed file should be written");

    let output = tokio::process::Command::new("codex")
        .current_dir(workspace.path())
        .env("CODEX_HOME", &codex_home)
        .args([
            "exec",
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "-m",
            &model_id,
            "-c",
            "model_provider=\"verification\"",
            "-c",
            "model_providers.verification.name=\"Wework verification\"",
            "-c",
            &format!(
                "model_providers.verification.base_url=\"http://{address}/v1/codex-responses-proxy\""
            ),
            "-c",
            "model_providers.verification.wire_api=\"responses\"",
            "-c",
            &format!(
                "model_providers.verification.experimental_bearer_token=\"{token}\""
            ),
            "Use apply_patch to create verification.txt containing exactly WEWORK_MODEL_TOOL_OK, then read the file and reply with exactly complete.",
        ])
        .output()
        .await
        .expect("Codex should run");
    server.abort();

    assert!(
        output.status.success(),
        "Codex failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(workspace.path().join("verification.txt"))
            .expect("verification file should exist")
            .trim(),
        "WEWORK_MODEL_TOOL_OK"
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("complete"));
}

#[test]
fn rewrite_responses_event_adds_namespace_to_browser_calls() {
    let event = concat!(
        "event: response.output_item.added\n",
        "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call-1\",\"name\":\"browser_navigate\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}"
    );
    let expanded = HashSet::from(["browser_navigate".to_owned()]);

    let rewritten = rewrite_responses_event(event, &expanded);
    let data = rewritten
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .expect("rewritten event should contain data");
    let value = serde_json::from_str::<Value>(data).unwrap();

    assert_eq!(value["item"]["namespace"], "wework_browser");
    assert_eq!(value["item"]["name"], "browser_navigate");
}

#[test]
fn rewrite_responses_event_leaves_non_browser_calls_unchanged() {
    let event = "data: {\"type\":\"function_call\",\"name\":\"exec_command\",\"arguments\":\"{}\"}";
    let expanded = HashSet::from(["browser_navigate".to_owned()]);

    assert_eq!(rewrite_responses_event(event, &expanded), event);
}

#[test]
fn rewrite_responses_event_combines_with_completed_usage_normalization() {
    let event = concat!(
        "event: response.completed\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-1\",\"output\":[{\"type\":\"function_call\",\"name\":\"browser_snapshot\",\"arguments\":\"{}\"}],\"usage\":{\"input_tokens\":1,\"input_tokens_details\":{},\"output_tokens\":2,\"output_tokens_details\":{},\"total_tokens\":3}}}"
    );
    let expanded = HashSet::from(["browser_snapshot".to_owned()]);

    let normalized = if expanded.is_empty() {
        normalize_responses_event(event)
    } else {
        let rewritten = rewrite_responses_event(event, &expanded);
        normalize_responses_event(&rewritten)
    };
    let data = normalized
        .lines()
        .find_map(|line| line.strip_prefix("data: "))
        .expect("normalized event should contain data");
    let value = serde_json::from_str::<Value>(data).unwrap();

    assert_eq!(
        value["response"]["output"][0]["namespace"],
        "wework_browser"
    );
    assert_eq!(
        value["response"]["usage"]["input_tokens_details"]["cached_tokens"],
        json!(0)
    );
    assert_eq!(
        value["response"]["usage"]["output_tokens_details"]["reasoning_tokens"],
        json!(0)
    );
}
