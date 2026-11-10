use super::*;

#[tokio::test]
async fn retries_rate_limited_model_requests_until_success() {
    let request_count = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let server = tokio::spawn({
        let request_count = request_count.clone();
        async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/chat/completions",
                    post(move || {
                        let request_count = request_count.clone();
                        async move {
                            if request_count.fetch_add(1, Ordering::SeqCst) < 2 {
                                return (
                                    StatusCode::TOO_MANY_REQUESTS,
                                    [(header::RETRY_AFTER, "0")],
                                    Json(json!({"error": {"message": "rate limited"}})),
                                );
                            }
                            (
                                StatusCode::OK,
                                [(header::RETRY_AFTER, "0")],
                                Json(json!({"choices": [{"message": {"content": "hi"}}]})),
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
        "rate-limit-retry-success",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/chat/completions")),
            api_format: "openai-chat-completions".to_owned(),
            custom_tool_conversion: CustomToolConversion::None,
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

    let (retry_tx, mut retry_rx) = tokio::sync::mpsc::unbounded_channel();
    let _retry_subscription =
        retry_notifications::subscribe("rate-limit-success-thread", Some(&retry_tx));
    bind_thread(&token, "rate-limit-success-thread").expect("bind retry thread");
    let response = handle(
        proxy_headers(&token),
        Bytes::from_static(br#"{"model":"m","input":"hi","stream":true,"client_metadata":{"thread_id":"rate-limit-success-thread"}}"#),
    )
    .await
    .expect("proxy response");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(request_count.load(Ordering::SeqCst), 3);
    assert_eq!(retry_rx.try_recv().unwrap()["params"]["waiting"], true);
    assert_eq!(retry_rx.try_recv().unwrap()["params"]["waiting"], false);

    unregister(&token);
    server.abort();
}

#[tokio::test]
async fn returns_last_rate_limit_response_after_retry_budget_is_exhausted() {
    let request_count = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let server = tokio::spawn({
        let request_count = request_count.clone();
        async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/responses",
                    post(move || {
                        request_count.fetch_add(1, Ordering::SeqCst);
                        async {
                            (
                                StatusCode::TOO_MANY_REQUESTS,
                                [(header::RETRY_AFTER, "0")],
                                Json(json!({"error": {"message": "still rate limited"}})),
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
        "rate-limit-retry-exhausted",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/responses")),
            api_format: "openai-responses".to_owned(),
            custom_tool_conversion: CustomToolConversion::None,
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
        Bytes::from_static(br#"{"model":"m","input":"hi","stream":true}"#),
    )
    .await
    .expect("proxy response");

    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        request_count.load(Ordering::SeqCst),
        (MAX_RATE_LIMIT_RETRIES + 1) as usize
    );
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    assert!(String::from_utf8_lossy(&body).contains("still rate limited"));

    unregister(&token);
    server.abort();
}

#[tokio::test]
async fn failed_model_switch_remains_pending_for_retry() {
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
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error": {"message": "request rejected"}})),
                    )
                }),
            ),
        )
        .await
        .expect("upstream server");
    });
    let token = register(
        "failed-model-switch",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/responses")),
            api_format: "openai-responses".to_owned(),
            custom_tool_conversion: CustomToolConversion::None,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("gpt-5.6-luna".to_owned()),
            routing_model_id: Some("gpt-5.6-luna".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    {
        let mut entries = registry().lock().expect("registry lock");
        entries
            .routes
            .get_mut(&token)
            .expect("task route")
            .last_routed_model = Some("gpt-5.6-luna".to_owned());
    }
    let repeated_token = register(
        "failed-model-switch",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/responses")),
            api_format: "openai-responses".to_owned(),
            custom_tool_conversion: CustomToolConversion::None,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("gpt-5.6-sol".to_owned()),
            routing_model_id: Some("gpt-5.6-sol".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    assert_eq!(repeated_token, token);
    let body = serde_json::to_vec(&json!({
        "model": "stale-codex-model",
        "previous_response_id": "resp_luna",
        "input": [
            {
                "type": "reasoning",
                "summary": [],
                "encrypted_content": "encrypted-luna-state"
            },
            {
                "type": "message",
                "role": "developer",
                "content": [{
                    "type": "input_text",
                    "text": "<model_switch>Use the selected model.</model_switch>"
                }]
            }
        ]
    }))
    .expect("request body");
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).expect("authorization"),
    );

    let response = handle(headers, Bytes::from(body.clone()))
        .await
        .expect("upstream rejection should be preserved");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    {
        let entries = registry().lock().expect("registry lock");
        let route = entries.routes.get(&token).expect("task route");
        assert_eq!(route.last_routed_model.as_deref(), Some("gpt-5.6-luna"));
        assert!(begin_model_request(route, &body).model_switched);
    }

    unregister(&token);
    unregister(&repeated_token);
    server.abort();
}

#[tokio::test]
async fn converts_successful_non_sse_response() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/chat/completions",
                post(|| async { Json(json!({"choices": [{"message": {"content": "hi"}}]})) }),
            ),
        )
        .await
        .expect("upstream server");
    });
    let token = register(
        "non-sse-test",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/chat/completions")),
            api_format: "openai-chat-completions".to_owned(),
            custom_tool_conversion: CustomToolConversion::None,
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
    .expect("non-SSE JSON should be converted");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE),
        Some(&HeaderValue::from_static("text/event-stream"))
    );
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("converted response body");
    let body = String::from_utf8_lossy(&body);
    assert!(body.contains("response.output_text.delta"));
    assert!(body.contains("response.completed"));

    unregister(&token);
    server.abort();
}

#[tokio::test]
async fn chat_completion_bridge_preserves_mixed_assistant_tool_turns_end_to_end() {
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
                    "/chat/completions",
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
                                    "data: {\"id\":\"chatcmpl-e2e\",\"model\":\"kimi-k3\",\"choices\":[{\"delta\":{\"content\":\"I will inspect it.\"},\"finish_reason\":null}]}\n\n",
                                    "data: {\"id\":\"chatcmpl-e2e\",\"model\":\"kimi-k3\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_next\",\"type\":\"function\",\"function\":{\"name\":\"exec_command\",\"arguments\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                                    "data: [DONE]\n\n"
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
        "chat-mixed-turn-e2e",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/chat/completions")),
            api_format: "openai-chat-completions".to_owned(),
            custom_tool_conversion: CustomToolConversion::None,
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
                && message.get("content").and_then(Value::as_str) == Some("I will inspect it.")
        })
        .expect("assistant tool turn");

    assert_eq!(
        assistant["tool_calls"][0]["function"]["name"],
        "exec_command"
    );
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
async fn chat_completion_bridge_keeps_first_turn_compact_and_loads_apps_on_demand_end_to_end() {
    let (request_tx, mut request_rx) = mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/chat/completions",
                post(move |Json(body): Json<Value>| {
                    let request_tx = request_tx.clone();
                    async move {
                        let loaded_app = body["tools"].as_array().is_some_and(|tools| {
                            tools.iter().any(|tool| {
                                tool.pointer("/function/name").and_then(Value::as_str)
                                    == Some("github__create_issue")
                            })
                        });
                        request_tx.send(body).expect("request receiver");
                        let response = if loaded_app {
                            concat!(
                                "data: {\"id\":\"chatcmpl-app\",\"model\":\"third-party-chat\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"app_1\",\"type\":\"function\",\"function\":{\"name\":\"github__create_issue\",\"arguments\":\"{\\\"title\\\":\\\"Bug\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                                "data: [DONE]\n\n"
                            )
                        } else {
                            concat!(
                                "data: {\"id\":\"chatcmpl-search\",\"model\":\"third-party-chat\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"search_1\",\"type\":\"function\",\"function\":{\"name\":\"search_deferred_tools\",\"arguments\":\"{\\\"query\\\":\\\"GitHub create issue\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                                "data: [DONE]\n\n"
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
        "chat-app-tool-search-e2e",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/chat/completions")),
            api_format: "openai-chat-completions".to_owned(),
            custom_tool_conversion: CustomToolConversion::None,
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
    let first_tools = first_upstream["tools"].as_array().expect("first tools");
    let first_tools_bytes = serde_json::to_vec(first_tools).expect("serialize first-turn tools");

    assert_eq!(first_tools.len(), 1);
    assert_eq!(
        first_tools[0]["function"]["name"],
        chat::BRIDGED_TOOL_SEARCH_NAME
    );
    assert!(
        first_tools_bytes.len() < 1_024,
        "deferred App discovery must keep the first-turn tool payload compact: {} bytes",
        first_tools_bytes.len()
    );
    assert!(
        first_tools
            .iter()
            .all(|tool| tool.get("type").and_then(Value::as_str) != Some("namespace")),
        "App namespace schemas must not be injected before tool search"
    );
    assert!(
        !first_upstream.to_string().contains("github__create_issue"),
        "App schema must not be injected before search"
    );
    let first_response = String::from_utf8_lossy(&first_response);
    assert!(
        first_response.contains("\"type\":\"tool_search_call\""),
        "{first_response}"
    );
    assert!(
        first_response.contains("\"arguments\":{\"query\":\"GitHub create issue\"}"),
        "{first_response}"
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
    let second_tools = second_upstream["tools"].as_array().expect("second tools");

    assert_eq!(second_tools.len(), 2);
    assert!(second_tools.iter().any(|tool| {
        tool.pointer("/function/name").and_then(Value::as_str)
            == Some(chat::BRIDGED_TOOL_SEARCH_NAME)
    }));
    assert!(second_tools.iter().any(|tool| {
        tool.pointer("/function/name").and_then(Value::as_str) == Some("github__create_issue")
    }));
    assert_eq!(
        second_tools
            .iter()
            .filter(|tool| {
                tool.pointer("/function/name").and_then(Value::as_str)
                    == Some("github__create_issue")
            })
            .count(),
        1,
        "only the App tool selected by tool_search should be expanded"
    );
    assert!(second_upstream["messages"]
        .as_array()
        .is_some_and(|messages| messages.iter().any(|message| {
            message.get("role").and_then(Value::as_str) == Some("tool")
                && message
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| content.contains("\"tools\""))
        })));
    let second_response = String::from_utf8_lossy(&second_response);
    assert!(
        second_response.contains("\"namespace\":\"github\""),
        "{second_response}"
    );
    assert!(
        second_response.contains("\"name\":\"create_issue\""),
        "{second_response}"
    );
    assert!(
        !second_response.contains("\"name\":\"github__create_issue\""),
        "{second_response}"
    );

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
        .expect("third request messages")
        .iter()
        .find(|message| {
            message.get("role").and_then(Value::as_str) == Some("tool")
                && message.get("tool_call_id").and_then(Value::as_str) == Some("app_1")
        })
        .and_then(|message| message.get("content"))
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
async fn responses_bridge_loads_apps_on_demand_and_preserves_results_end_to_end() {
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
                                item.get("call_id").and_then(Value::as_str) == Some("app_1")
                                    && item.get("type").and_then(Value::as_str)
                                        == Some("function_call_output")
                            })
                        });
                        let loaded_app = body["tools"].as_array().is_some_and(|tools| {
                            tools.iter().any(|tool| {
                                tool.get("name").and_then(Value::as_str)
                                    == Some("github__create_issue")
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
                                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_app\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"app_1\",\"name\":\"github__create_issue\",\"arguments\":\"{\\\"title\\\":\\\"Bug\\\"}\"}}\n\n",
                                "event: response.completed\n",
                                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_app\",\"status\":\"completed\",\"output\":[{\"id\":\"fc_app\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"app_1\",\"name\":\"github__create_issue\",\"arguments\":\"{\\\"title\\\":\\\"Bug\\\"}\"}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"input_tokens_details\":{},\"output_tokens_details\":{}}}}\n\n"
                            )
                        } else {
                            concat!(
                                "event: response.output_item.done\n",
                                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_search\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"search_1\",\"name\":\"search_deferred_tools\",\"arguments\":\"{\\\"query\\\":\\\"GitHub create issue\\\"}\"}}\n\n",
                                "event: response.completed\n",
                                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_search\",\"status\":\"completed\",\"output\":[{\"id\":\"fc_search\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"search_1\",\"name\":\"search_deferred_tools\",\"arguments\":\"{\\\"query\\\":\\\"GitHub create issue\\\"}\"}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"input_tokens_details\":{},\"output_tokens_details\":{}}}}\n\n"
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
        "responses-app-tool-search-e2e",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/responses")),
            api_format: "responses".to_owned(),
            custom_tool_conversion: CustomToolConversion::None,
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
    assert_single_loaded_app_tool(&second_upstream, "/name", "github__create_issue");
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
