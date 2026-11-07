use super::*;

#[test]
fn makes_structured_model_overload_failures_retryable() {
    for code in ["server_is_overloaded", "slow_down"] {
        let event = format!(
            "event: response.failed\ndata: {}",
            json!({
                "type": "response.failed",
                "response": {
                    "status": "failed",
                    "error": {
                        "code": code,
                        "message": "Selected model is at capacity. Please try a different model."
                    }
                }
            })
        );

        let normalized = normalize_responses_event(&event);
        let value = responses_event_values(&normalized)
            .into_iter()
            .next()
            .expect("normalized failure event");

        assert_eq!(
            value
                .pointer("/response/error/code")
                .and_then(Value::as_str),
            Some("server_overloaded_retryable")
        );
        assert_eq!(
            value
                .pointer("/response/error/message")
                .and_then(Value::as_str),
            Some("Selected model is at capacity. Please try a different model.")
        );
    }
}

#[test]
fn preserves_non_retryable_responses_failures() {
    let event = format!(
        "event: response.failed\ndata: {}",
        json!({
            "type": "response.failed",
            "response": {
                "status": "failed",
                "error": {
                    "code": "context_length_exceeded",
                    "message": "Input is too long."
                }
            }
        })
    );

    assert_eq!(normalize_responses_event(&event), event);
}

#[test]
fn buffers_incomplete_utf8_until_the_next_stream_chunk() {
    let mut buffer = String::new();
    let mut pending_utf8 = Vec::new();

    for byte in "在".as_bytes() {
        append_stream_utf8(&mut buffer, &mut pending_utf8, &[*byte])
            .expect("split UTF-8 should remain valid");
    }

    finish_stream_utf8(&pending_utf8).expect("all UTF-8 bytes should be consumed");
    assert_eq!(buffer, "在");
}

#[test]
fn rejects_an_incomplete_utf8_sequence_at_stream_end() {
    let mut buffer = String::new();
    let mut pending_utf8 = Vec::new();
    append_stream_utf8(&mut buffer, &mut pending_utf8, &["在".as_bytes()[0]])
        .expect("an incomplete trailing sequence should be buffered");

    let error = finish_stream_utf8(&pending_utf8).expect_err("stream should be incomplete");

    assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
    assert!(buffer.is_empty());
}

#[tokio::test]
async fn reports_truncated_native_responses_stream_as_failed() {
    let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from_static(
        b"event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
    ))]);
    let output = collect_responses_stream(stream).await;

    assert!(output.contains("response.created"));
    assert!(output.contains("response.failed"));
    assert!(output.contains("ended before a terminal event"));
}

#[tokio::test]
async fn accepts_native_responses_terminal_event_without_blank_tail() {
    let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from_static(
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{}}",
    ))]);
    let output = collect_responses_stream(stream).await;

    assert!(output.contains("response.completed"));
    assert!(!output.contains("response.failed"));
}

#[tokio::test]
async fn converts_native_responses_read_error_to_failed_event() {
    let stream = futures_util::stream::iter(vec![Err::<Bytes, _>(std::io::Error::other(
        "connection reset",
    ))]);
    let output = collect_responses_stream(stream).await;

    assert!(output.contains("response.failed"));
    assert!(output.contains("connection reset"));
}

#[tokio::test]
async fn ignores_transport_error_after_native_terminal_event() {
    let stream = futures_util::stream::iter(vec![
        Ok(Bytes::from_static(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n",
        )),
        Err(std::io::Error::other("late connection reset")),
    ]);
    let output = collect_responses_stream(stream).await;

    assert!(output.contains("response.completed"));
    assert!(!output.contains("response.failed"));
    assert!(!output.contains("late connection reset"));
}

#[test]
fn registration_is_stable_and_updates_upstream_for_a_task() {
    let initial = LocalModelProxyUpstream {
        base_url: "https://luna.example.com".to_owned(),
        request_url: None,
        api_format: "openai-responses".to_owned(),
        convert_custom_tools: false,
        native_tool_search: false,
        native_namespace_tools: false,
        api_key: "luna-secret".to_owned(),
        default_headers: Vec::new(),
        proxy_url: None,
        model_id: Some("gpt-5.6-luna".to_owned()),
        routing_model_id: Some("wework-gpt-5.6-luna".to_owned()),
        codex_request_mode: Default::default(),
        max_output_tokens: None,
        model_context_window: None,
    };
    let token = register("stable-task-route", initial);
    let original_history = registry()
        .lock()
        .expect("registry lock")
        .routes
        .get(&token)
        .expect("task route")
        .history
        .clone();
    let updated = LocalModelProxyUpstream {
        base_url: "https://sol.example.com".to_owned(),
        request_url: Some("https://sol.example.com/v1/responses".to_owned()),
        api_format: "openai-responses".to_owned(),
        convert_custom_tools: false,
        native_tool_search: false,
        native_namespace_tools: false,
        api_key: "sol-secret".to_owned(),
        default_headers: vec![("x-route".to_owned(), "sol".to_owned())],
        proxy_url: None,
        model_id: Some("gpt-5.6-sol".to_owned()),
        routing_model_id: Some("gpt-5.6-sol".to_owned()),
        codex_request_mode: Default::default(),
        max_output_tokens: None,
        model_context_window: None,
    };
    let repeated_token = register("stable-task-route", updated.clone());

    assert_eq!(repeated_token, token);
    {
        let entries = registry().lock().expect("registry lock");
        let route = entries.routes.get(&token).expect("updated task route");
        assert_eq!(route.upstream.base_url, updated.base_url);
        assert_eq!(route.upstream.api_key, updated.api_key);
        assert_eq!(route.upstream.model_id, updated.model_id);
        assert!(std::sync::Arc::ptr_eq(&route.history, &original_history));
    }

    unregister(&token);
    assert!(registry()
        .lock()
        .expect("registry lock")
        .routes
        .contains_key(&token));

    unregister(&token);

    {
        let mut entries = registry().lock().expect("registry lock");
        let entry = entries
            .routes
            .get_mut(&token)
            .expect("idle registration retained");
        assert_eq!(entry.active_references, 0);
        entry.last_used = Instant::now() - REGISTRY_IDLE_TTL - Duration::from_secs(1);
        prune_registry(&mut entries);
        assert!(!entries.routes.contains_key(&token));
    }

    let resumed_token = register("stable-task-route", updated);
    assert_eq!(resumed_token, token);
    unregister(&resumed_token);
}

#[test]
fn task_routes_use_distinct_stable_tokens() {
    let upstream = LocalModelProxyUpstream {
        base_url: "https://example.com".to_owned(),
        request_url: None,
        api_format: "openai-responses".to_owned(),
        convert_custom_tools: false,
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
    };
    let task_a = register("stable-random-token-task-a", upstream.clone());
    let repeated_task_a = register("stable-random-token-task-a", upstream.clone());
    let task_b = register("stable-random-token-task-b", upstream);

    assert_eq!(repeated_task_a, task_a);
    assert_ne!(task_a, task_b);
    assert!(!task_a.contains("stable-random-token-task-a"));

    unregister(&task_a);
    unregister(&repeated_task_a);
    unregister(&task_b);
}

#[test]
fn model_switch_cleanup_is_consumed_once_per_routed_model_change() {
    let marker_body = br#"{
        "model":"stale-codex-model",
        "input":[{
            "type":"message",
            "role":"developer",
            "content":[{
                "type":"input_text",
                "text":"<model_switch>Use the selected model.</model_switch>"
            }]
        }]
    }"#;
    let token = register(
        "model-switch-consumed-once",
        LocalModelProxyUpstream {
            base_url: "https://luna.example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "luna-secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("gpt-5.6-luna".to_owned()),
            routing_model_id: Some("wework-gpt-5.6-luna".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    {
        let entries = registry().lock().expect("registry lock");
        let route = entries.routes.get(&token).expect("task route");
        let routing = begin_model_request(route, marker_body);
        assert!(!routing.model_switched);
        assert_eq!(
            routing.model_to_commit.as_deref(),
            Some("wework-gpt-5.6-luna")
        );
    }
    commit_model_request(
        &token,
        &ModelRequestRouting {
            model_switched: false,
            model_to_commit: Some("wework-gpt-5.6-luna".to_owned()),
            clear_pending_model_switch: false,
        },
    );
    let repeated_token = register(
        "model-switch-consumed-once",
        LocalModelProxyUpstream {
            base_url: "https://sol.example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "sol-secret".to_owned(),
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
    {
        let entries = registry().lock().expect("registry lock");
        let route = entries.routes.get(&token).expect("updated task route");
        let routing = begin_model_request(route, marker_body);
        assert!(routing.model_switched);
        assert_eq!(routing.model_to_commit.as_deref(), Some("gpt-5.6-sol"));
        assert!(begin_model_request(route, marker_body).model_switched);
    }
    commit_model_request(
        &token,
        &ModelRequestRouting {
            model_switched: true,
            model_to_commit: Some("gpt-5.6-sol".to_owned()),
            clear_pending_model_switch: false,
        },
    );
    {
        let entries = registry().lock().expect("registry lock");
        let route = entries.routes.get(&token).expect("updated task route");
        assert!(!begin_model_request(route, marker_body).model_switched);
    }

    unregister(&token);
    unregister(&repeated_token);
}

#[test]
fn task_route_recognizes_the_model_selected_for_that_task() {
    let upstream = LocalModelProxyUpstream {
        base_url: "https://example.com".to_owned(),
        request_url: None,
        api_format: "openai-responses".to_owned(),
        convert_custom_tools: false,
        native_tool_search: false,
        native_namespace_tools: false,
        api_key: "secret".to_owned(),
        default_headers: Vec::new(),
        proxy_url: None,
        model_id: Some("upstream-sol".to_owned()),
        routing_model_id: Some("gpt-5.6-sol".to_owned()),
        codex_request_mode: Default::default(),
        max_output_tokens: None,
        model_context_window: None,
    };

    assert_eq!(
        stale_requested_model(&upstream, br#"{"model":"gpt-5.6-sol"}"#),
        None
    );
}

#[test]
fn task_route_detects_but_does_not_select_by_a_stale_requested_model() {
    let upstream = LocalModelProxyUpstream {
        base_url: "https://example.com".to_owned(),
        request_url: None,
        api_format: "openai-responses".to_owned(),
        convert_custom_tools: false,
        native_tool_search: false,
        native_namespace_tools: false,
        api_key: "secret".to_owned(),
        default_headers: Vec::new(),
        proxy_url: None,
        model_id: Some("upstream-sol".to_owned()),
        routing_model_id: Some("gpt-5.6-sol".to_owned()),
        codex_request_mode: Default::default(),
        max_output_tokens: None,
        model_context_window: None,
    };

    assert_eq!(
        stale_requested_model(&upstream, br#"{"model":"gpt-5.6-luna"}"#),
        Some(("gpt-5.6-luna".to_owned(), "gpt-5.6-sol".to_owned()))
    );
}

#[test]
fn task_route_only_accepts_bound_threads_and_their_children() {
    let token = register(
        "thread-bound-task-route",
        LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: Some("gpt-5.6-sol".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    bind_thread(&token, "thread-bound-root").expect("root thread should bind");
    let mut entries = registry().lock().expect("registry lock");
    let route = entries.routes.get_mut(&token).expect("task route");

    authorize_task_thread(
        route,
        br#"{"client_metadata":{"thread_id":"thread-bound-root"}}"#,
    )
    .expect("bound root should be accepted");
    authorize_task_thread(
        route,
        br#"{"client_metadata":{"thread_id":"thread-bound-child","x-codex-turn-metadata":"{\"parent_thread_id\":\"thread-bound-root\"}"}}"#,
    )
    .expect("child of a bound root should be accepted");
    assert!(route.thread_ids.contains("thread-bound-child"));

    let error = authorize_task_thread(
        route,
        br#"{"client_metadata":{"thread_id":"thread-bound-unrelated"}}"#,
    )
    .expect_err("unrelated thread must not use the task route");
    assert_eq!(error.status, StatusCode::CONFLICT);

    drop(entries);
    unregister(&token);
}

#[test]
fn fork_thread_route_is_reused_by_subsequent_sends() {
    let token = register(
        "temporary-fork-task-route",
        LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("upstream-model".to_owned()),
            routing_model_id: Some("routing-model".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    bind_fork_thread(&token, "forked-thread").expect("forked thread should bind");
    let entries = registry().lock().expect("registry lock");
    assert!(!entries
        .tokens_by_scope
        .contains_key("temporary-fork-task-route"));
    let route = entries.routes.get(&token).expect("forked route");
    assert_eq!(route.upstream.api_key, "secret");
    let upstream = route.upstream.clone();
    drop(entries);

    unregister(&token);
    let resumed = register("forked-thread", upstream);
    assert_eq!(resumed, token);
    assert_eq!(
        bound_thread_token(br#"{"client_metadata":{"thread_id":"forked-thread"}}"#)
            .expect("forked thread should have exactly one route"),
        token
    );
    unregister(&resumed);
}

#[test]
fn generic_route_resolves_the_task_from_the_bound_codex_thread() {
    let token = register(
        "generic-bound-thread-task-route",
        LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: Some("gpt-5.6-luna".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    bind_thread(&token, "generic-bound-thread-root").expect("root thread should bind");

    assert_eq!(
        bound_thread_token(br#"{"client_metadata":{"thread_id":"generic-bound-thread-root"}}"#)
            .expect("bound root should resolve"),
        token
    );
    assert_eq!(
        bound_thread_token(
            br#"{"client_metadata":{"thread_id":"generic-bound-thread-child","parent_thread_id":"generic-bound-thread-root"}}"#
        )
        .expect("child of bound root should resolve"),
        token
    );

    unregister(&token);
}

#[test]
fn token_route_recovers_a_stale_persisted_token_from_the_bound_thread() {
    let token = register(
        "stale-token-recovery-task-route",
        LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: Some("gpt-5.6-luna".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    bind_thread(&token, "stale-token-thread").expect("root thread should bind");

    assert_eq!(
        token_route_token(
            "task-expired-from-previous-executor".to_owned(),
            br#"{"client_metadata":{"thread_id":"stale-token-thread"}}"#,
        )
        .expect("stale token should recover through the bound thread"),
        token
    );

    unregister(&token);
}

#[test]
fn token_route_keeps_unknown_token_semantics_without_thread_metadata() {
    let error = token_route_token(
        "task-unknown".to_owned(),
        br#"{"input":"request without task thread metadata"}"#,
    )
    .expect_err("unknown token without thread metadata must remain not found");

    assert_eq!(error.status, StatusCode::NOT_FOUND);
    assert_eq!(error.detail, "unknown or expired local model proxy token");
}

#[test]
fn generic_route_rejects_unbound_threads_and_uses_the_latest_binding() {
    let unbound_error =
        bound_thread_token(br#"{"client_metadata":{"thread_id":"generic-unbound-thread"}}"#)
            .expect_err("unbound thread must not resolve");
    assert_eq!(unbound_error.status, StatusCode::NOT_FOUND);

    let upstream = LocalModelProxyUpstream {
        base_url: "https://example.com".to_owned(),
        request_url: None,
        api_format: "openai-responses".to_owned(),
        convert_custom_tools: false,
        native_tool_search: false,
        native_namespace_tools: false,
        api_key: "secret".to_owned(),
        default_headers: Vec::new(),
        proxy_url: None,
        model_id: None,
        routing_model_id: Some("gpt-5.6-luna".to_owned()),
        codex_request_mode: Default::default(),
        max_output_tokens: None,
        model_context_window: None,
    };
    let first = register("generic-ambiguous-thread-task-a", upstream.clone());
    let second = register("generic-ambiguous-thread-task-b", upstream);
    bind_thread(&first, "generic-ambiguous-thread").expect("first route should bind");
    bind_thread(&second, "generic-ambiguous-thread").expect("second route should bind");

    assert_eq!(
        bound_thread_token(br#"{"client_metadata":{"thread_id":"generic-ambiguous-thread"}}"#)
            .expect("the latest route binding should replace the stale binding"),
        second
    );
    let entries = registry().lock().expect("registry lock");
    assert!(!entries
        .routes
        .get(&first)
        .expect("first route")
        .thread_ids
        .contains("generic-ambiguous-thread"));
    drop(entries);

    unregister(&first);
    unregister(&second);
}

#[test]
fn task_route_rejects_missing_thread_metadata_after_binding() {
    let token = register(
        "missing-thread-metadata-task-route",
        LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: Some("gpt-5.6-sol".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    bind_thread(&token, "missing-metadata-thread-root").expect("root thread should bind");
    let mut entries = registry().lock().expect("registry lock");
    let route = entries.routes.get_mut(&token).expect("task route");

    let error = authorize_task_thread(route, br#"{"model":"gpt-5.6-sol"}"#)
        .expect_err("bound task route requires thread metadata");
    assert_eq!(error.status, StatusCode::CONFLICT);

    drop(entries);
    unregister(&token);
}

#[test]
fn rewrites_internal_catalog_model_to_real_upstream_model() {
    let body = serde_json::to_vec(&json!({
        "model": "wework-custom-user-model",
        "input": "hello"
    }))
    .expect("request body");

    let rewritten = rewrite_request_model(&body, "k3").expect("rewritten request");
    let request: Value = serde_json::from_slice(&rewritten).expect("request JSON");

    assert_eq!(request["model"], "k3");
    assert_eq!(request["input"], "hello");
}

#[tokio::test]
async fn preserves_non_success_status_and_body() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/chat/completions",
                post(|| async {
                    (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error": {"message": "tools are unsupported"}})),
                    )
                }),
            ),
        )
        .await
        .expect("upstream server");
    });
    let token = register(
        "non-success-test",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/chat/completions")),
            api_format: "openai-chat-completions".to_owned(),
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
    .expect("proxy response");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    assert!(String::from_utf8_lossy(&body).contains("tools are unsupported"));

    unregister(&token);
    server.abort();
}

#[tokio::test]
async fn harness_route_keeps_tool_calls_adjacent_to_their_outputs() {
    let (body_tx, mut body_rx) = mpsc::channel(1);
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
                    let body_tx = body_tx.clone();
                    async move {
                        let rejection = upstream_rejects_interleaved_tool_items(&body);
                        let _ = body_tx.send(rejection).await;
                        Json(json!({
                            "output": [{
                                "type": "message",
                                "content": [{"type": "output_text", "text": "ok"}]
                            }]
                        }))
                    }
                }),
            ),
        )
        .await
        .expect("upstream server");
    });
    let token = register_harness(
        "harness-tool-order-test",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "upstream-secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("deepseek-v4-flash".to_owned()),
            routing_model_id: None,
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    let request = json!({
        "model": "wework-selected",
        "max_tokens": 64,
        "system": "You are a builder.",
        "messages": [
            {"role": "user", "content": "build the dashboard"},
            {"role": "assistant", "content": [
                {"type": "text", "text": "I will start by inspecting the dataset."},
                {"type": "tool_use", "id": "call_00_stub00000000000000000001", "name": "read_dataset", "input": {}}
            ]},
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call_00_stub00000000000000000001", "content": "ok"}
            ]}
        ],
        "tools": [{
            "name": "read_dataset",
            "description": "Read.",
            "input_schema": {"type": "object"}
        }]
    });

    let response = handle_harness_messages(
        Path(token.clone()),
        proxy_headers(&token),
        Bytes::from(serde_json::to_vec(&request).expect("request body")),
    )
    .await
    .expect("harness response");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        body_rx.recv().await.expect("captured upstream body"),
        None,
        "the upstream must accept the encoded tool call/output group"
    );

    unregister_harness(&token);
    server.abort();
}

#[tokio::test]
async fn harness_route_strips_long_context_suffix_and_normalizes_overflow() {
    let (body_tx, mut body_rx) = mpsc::channel(1);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/v1/messages",
                post(move |Json(body): Json<Value>| {
                    let body_tx = body_tx.clone();
                    async move {
                        let _ = body_tx.send(body).await;
                        (
                            StatusCode::BAD_REQUEST,
                            Json(json!({
                                "error": {
                                    "code": "InvalidParameter",
                                    "message": "Input exceeds the context limit (1048568 tokens). Please shorten the input."
                                }
                            })),
                        )
                    }
                }),
            ),
        )
        .await
        .expect("upstream server");
    });
    let token = register_harness(
        "harness-context-overflow-test",
        LocalModelProxyUpstream {
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/v1/messages")),
            api_format: "anthropic-messages".to_owned(),
            convert_custom_tools: false,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "upstream-secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: None,
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: Some(1_000_000),
        },
    );
    let request = json!({
        "model": "deepseek-v4.1-flash[1m]",
        "max_tokens": 64,
        "messages": [{"role": "user", "content": "hello"}]
    });

    let response = handle_harness_messages(
        Path(token.clone()),
        proxy_headers(&token),
        Bytes::from(serde_json::to_vec(&request).expect("request body")),
    )
    .await
    .expect("harness response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let upstream_body = body_rx.recv().await.expect("captured upstream body");
    assert_eq!(upstream_body["model"], "deepseek-v4.1-flash");
    let body = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    let normalized: Value = serde_json::from_slice(&body).expect("normalized error");
    assert_eq!(normalized["type"], "error");
    assert_eq!(normalized["error"]["type"], "invalid_request_error");
    assert_eq!(
        normalized["error"]["message"],
        "prompt is too long: 1048568 tokens > 1000000 maximum"
    );

    unregister_harness(&token);
    server.abort();
}
