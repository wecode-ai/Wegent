use super::*;

#[test]
fn upstream_request_preserves_codex_headers_without_forwarding_proxy_credentials() {
    let upstream = LocalModelProxyUpstream {
        base_url: "https://example.com/v1".to_owned(),
        request_url: None,
        api_format: "openai-responses".to_owned(),
        convert_custom_tools: false,
        native_tool_search: true,
        native_namespace_tools: true,
        api_key: "upstream-secret".to_owned(),
        default_headers: Vec::new(),
        proxy_url: None,
        model_id: Some("gpt-5.6-sol".to_owned()),
        routing_model_id: None,
        codex_request_mode: Default::default(),
        max_output_tokens: None,
        model_context_window: None,
    };
    let mut incoming_headers = HeaderMap::new();
    incoming_headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer local-router-secret"),
    );
    incoming_headers.insert(header::COOKIE, HeaderValue::from_static("session=secret"));
    incoming_headers.insert(
        header::USER_AGENT,
        HeaderValue::from_static("codex-cli-test"),
    );
    incoming_headers.insert("originator", HeaderValue::from_static("codex_cli_rs"));
    incoming_headers.insert("session-id", HeaderValue::from_static("session-123"));
    incoming_headers.insert("thread-id", HeaderValue::from_static("thread-123"));
    incoming_headers.insert(
        "x-client-request-id",
        HeaderValue::from_static("thread-123"),
    );
    incoming_headers.insert(
        "x-codex-turn-metadata",
        HeaderValue::from_static("{\"turn_id\":\"turn-123\"}"),
    );
    incoming_headers.insert(
        "x-oai-attestation",
        HeaderValue::from_static("private-attestation"),
    );

    let request = build_upstream_request(
        &reqwest::Client::new(),
        &upstream,
        "https://example.com/v1/responses",
        br#"{"model":"gpt-5.6-sol"}"#,
        &incoming_headers,
    )
    .build()
    .expect("upstream request");

    assert_eq!(
        request.headers().get(header::AUTHORIZATION),
        Some(&HeaderValue::from_static("Bearer upstream-secret"))
    );
    assert_eq!(
        request.headers().get(header::USER_AGENT),
        Some(&HeaderValue::from_static("codex-cli-test"))
    );
    assert_eq!(
        request.headers().get("originator"),
        Some(&HeaderValue::from_static("codex_cli_rs"))
    );
    assert_eq!(
        request.headers().get("session-id"),
        Some(&HeaderValue::from_static("session-123"))
    );
    assert_eq!(
        request.headers().get("thread-id"),
        Some(&HeaderValue::from_static("thread-123"))
    );
    assert_eq!(
        request.headers().get("x-client-request-id"),
        Some(&HeaderValue::from_static("thread-123"))
    );
    assert_eq!(
        request.headers().get("x-codex-turn-metadata"),
        Some(&HeaderValue::from_static("{\"turn_id\":\"turn-123\"}"))
    );
    assert!(!request.headers().contains_key(header::COOKIE));
    assert!(!request.headers().contains_key("x-oai-attestation"));
}

#[test]
fn tool_diagnostics_find_wework_tools_without_logging_schema_values() {
    let body = serde_json::to_vec(&json!({
        "tools": [
            {
                "type": "namespace",
                "name": "wework_space",
                "description": "secret-description",
                "tools": [
                    {"type": "function", "name": "get_board_item"},
                    {"type": "function", "name": "assign_board_item"}
                ]
            },
            {"type": "tool_search", "execution": "client"}
        ]
    }))
    .unwrap();

    let fields = request_tool_diagnostic_fields(&body)
        .into_iter()
        .collect::<HashMap<_, _>>();

    assert_eq!(fields["tool_count"], "2");
    assert_eq!(fields["namespace_names"], "wework_space");
    assert_eq!(
        fields["wework_tool_names"],
        "assign_board_item,get_board_item,wework_space"
    );
    assert_eq!(fields["tool_search_present"], "true");
    assert_eq!(fields["tool_search_wire_name"], "native");
    assert_eq!(fields["tool_search_description_present"], "false");
    assert_eq!(fields["tool_search_parameter_names"], "");
    assert!(!fields
        .values()
        .any(|value| value.contains("secret-description")));
}

#[test]
fn output_budget_matches_protocol_defaults_and_validates_aliases() {
    for protocol in [
        "openai-chat-completions",
        "chat/completions",
        "anthropic-messages",
        "messages",
    ] {
        let config = json!({"base_url": "https://example.com", "upstream_api_format": protocol});
        assert_eq!(model_max_output_tokens(&config), Some(96_000));
        assert_eq!(
            upstream_from_model_config(&config)
                .unwrap()
                .unwrap()
                .max_output_tokens,
            Some(96_000)
        );
    }
    assert_eq!(
        model_max_output_tokens(&json!({"api_format": "responses"})),
        None
    );
    assert_eq!(
        model_max_output_tokens(&json!({"max_output_tokens": false, "maxOutputTokens": "8000"})),
        Some(8_000)
    );
    assert_eq!(
        model_max_output_tokens(&json!({"max_output_tokens": 16_000, "maxOutputTokens": 8_000})),
        Some(16_000)
    );
}

#[test]
fn detects_known_upstream_error_codes_in_priority_order() {
    assert_eq!(
        detect_upstream_error_code(
            br#"{"error":{"code":"invalid_encrypted_content","message":"invalid"}}"#
        )
        .as_deref(),
        Some("invalid_encrypted_content")
    );
    assert_eq!(
        detect_upstream_error_code(br#"{"error":{"code":"upstream_unavailable"}}"#),
        None
    );
    assert_eq!(
        detect_upstream_error_code(
            b"rate_limit_exceeded appeared first, then invalid_encrypted_content"
        )
        .as_deref(),
        Some("invalid_encrypted_content")
    );
}

#[test]
fn extracts_native_responses_tool_diagnostics_without_arguments() {
    let started = concat!(
        "event: response.output_item.added\n",
        "data: {\"type\":\"response.output_item.added\",\"item\":{",
        "\"type\":\"function_call\",\"name\":\"exec_command\",",
        "\"namespace\":\"functions\",\"arguments\":\"\"}}"
    );
    let completed = concat!(
        "event: response.output_item.done\n",
        "data: {\"type\":\"response.output_item.done\",\"item\":{",
        "\"type\":\"function_call\",\"name\":\"exec_command\",",
        "\"namespace\":\"functions\",\"arguments\":\"{\\\"cmd\\\":\\\"secret\\\"}\"}}"
    );
    let terminal = concat!(
        "event: response.completed\n",
        "data: {\"type\":\"response.completed\",\"response\":{",
        "\"status\":\"completed\",\"output\":[",
        "{\"type\":\"function_call\"},{\"type\":\"message\"}]}}"
    );

    assert_eq!(
        responses_event_diagnostics(started),
        vec![ResponsesEventDiagnostic::ToolCall {
            phase: "started",
            tool_name: "exec_command".to_owned(),
            namespace: "functions".to_owned(),
            custom_tool: false,
            arguments_bytes: 0,
        }]
    );
    assert_eq!(
        responses_event_diagnostics(completed),
        vec![ResponsesEventDiagnostic::ToolCall {
            phase: "completed",
            tool_name: "exec_command".to_owned(),
            namespace: "functions".to_owned(),
            custom_tool: false,
            arguments_bytes: 16,
        }]
    );
    assert_eq!(
        responses_event_diagnostics(terminal),
        vec![ResponsesEventDiagnostic::Terminal {
            status: "completed".to_owned(),
            output_items: 2,
            tool_calls: 1,
            empty_output: false,
        }]
    );
    assert!(!format!("{:?}", responses_event_diagnostics(completed)).contains("secret"));
}

#[test]
fn removes_encrypted_history_before_an_explicit_model_switch() {
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
        model_id: Some("gpt-5.6-luna".to_owned()),
        routing_model_id: Some("wework-gpt-5.6-sol".to_owned()),
        codex_request_mode: Default::default(),
        max_output_tokens: None,
        model_context_window: None,
    };
    let body = serde_json::to_vec(&json!({
        "model": "wework-gpt-5.6-sol",
        "previous_response_id": "resp_previous",
        "input": [
            {
                "type": "reasoning",
                "summary": [],
                "encrypted_content": "encrypted-old-model-state"
            },
            {
                "type": "context_compaction",
                "encrypted_content": "encrypted-old-compaction"
            },
            {
                "type": "message",
                "role": "developer",
                "content": [{
                    "type": "input_text",
                    "text": "<model_switch>Use the new model instructions.</model_switch>"
                }]
            },
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "continue"}]
            }
        ]
    }))
    .expect("request body");

    let prepared =
        prepare_model_switch_request(&upstream, body, true).expect("model switch should prepare");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared request");

    assert_eq!(prepared["input"].as_array().unwrap().len(), 2);
    assert!(prepared.get("previous_response_id").is_none());
    assert_eq!(prepared["input"][0]["role"], "developer");
    assert_eq!(prepared["input"][1]["role"], "user");
}

#[test]
fn removes_encrypted_compaction_on_the_first_proxied_request_after_a_model_switch() {
    let token = register(
        "first-proxied-request-after-switch",
        LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-chat-completions".to_owned(),
            convert_custom_tools: true,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("kimi-k3".to_owned()),
            routing_model_id: Some("wework-kimi-k3".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    mark_model_switch(&token);
    let body = serde_json::to_vec(&json!({
        "model": "gpt-5.6-sol",
        "previous_response_id": "resp_compacted",
        "input": [
            {
                "type": "context_compaction",
                "encrypted_content": "provider-bound-summary"
            },
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "continue"}]
            }
        ]
    }))
    .expect("request body");

    let routing = {
        let entries = registry().lock().expect("registry lock");
        begin_model_request(entries.routes.get(&token).expect("registered route"), &body)
    };
    assert!(routing.model_switched);
    assert!(routing.clear_pending_model_switch);

    let prepared = prepare_model_switch_request(
        &LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-chat-completions".to_owned(),
            convert_custom_tools: true,
            native_tool_search: false,
            native_namespace_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("kimi-k3".to_owned()),
            routing_model_id: Some("wework-kimi-k3".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
        body,
        routing.model_switched,
    )
    .expect("model switch should prepare");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared request");

    assert!(prepared.get("previous_response_id").is_none());
    assert_eq!(prepared["input"].as_array().unwrap().len(), 1);
    assert_eq!(prepared["input"][0]["role"], "user");

    let (converted, conversion, _) = prepare_request(
        "openai-chat-completions",
        true,
        None,
        &prepared.to_string().into_bytes(),
    )
    .expect("cleaned request should convert to chat completions");
    assert!(matches!(conversion, Some(Conversion::Chat(_))));
    let converted: Value = serde_json::from_slice(&converted).expect("converted chat request");
    assert!(converted
        .get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| messages.iter().all(|message| {
            !message.to_string().contains("provider-bound-summary")
                && !message.to_string().contains("encrypted_content")
        })));

    commit_model_request(&token, &routing);
    {
        let entries = registry().lock().expect("registry lock");
        assert!(
            !entries
                .routes
                .get(&token)
                .expect("registered route")
                .pending_model_switch_cleanup
        );
    }
    unregister(&token);
}

#[test]
fn consumes_pending_model_switch_cleanup_on_the_first_plain_request() {
    let token = register(
        "first-plain-request-after-switch",
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
            model_id: Some("kimi-k3".to_owned()),
            routing_model_id: Some("wework-kimi-k3".to_owned()),
            codex_request_mode: Default::default(),
            max_output_tokens: None,
            model_context_window: None,
        },
    );
    mark_model_switch(&token);
    let body = br#"{
        "model":"stale-codex-model",
        "input":[{
            "type":"message",
            "role":"user",
            "content":[{"type":"input_text","text":"continue"}]
        }]
    }"#;

    let routing = {
        let entries = registry().lock().expect("registry lock");
        begin_model_request(entries.routes.get(&token).expect("registered route"), body)
    };
    assert!(routing.model_switched);
    assert!(routing.clear_pending_model_switch);

    commit_model_request(&token, &routing);
    {
        let entries = registry().lock().expect("registry lock");
        let route = entries.routes.get(&token).expect("registered route");
        assert!(!route.pending_model_switch_cleanup);
        assert!(!begin_model_request(route, body).model_switched);
    }
    unregister(&token);
}

#[test]
fn removes_previous_response_id_from_a_switched_request_without_encrypted_items() {
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
        model_id: Some("kimi-k3".to_owned()),
        routing_model_id: Some("wework-kimi-k3".to_owned()),
        codex_request_mode: Default::default(),
        max_output_tokens: None,
        model_context_window: None,
    };
    let body = serde_json::to_vec(&json!({
        "model": "stale-codex-model",
        "previous_response_id": "resp_old_provider",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "continue"}]
        }]
    }))
    .expect("request body");

    let prepared =
        prepare_model_switch_request(&upstream, body, true).expect("request preparation");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared request");

    assert!(prepared.get("previous_response_id").is_none());
    assert_eq!(prepared["input"].as_array().unwrap().len(), 1);
}

#[test]
fn preserves_encrypted_history_without_a_model_switch_marker() {
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
        routing_model_id: Some("wework-gpt-5.6-sol".to_owned()),
        codex_request_mode: Default::default(),
        max_output_tokens: None,
        model_context_window: None,
    };
    let body = serde_json::to_vec(&json!({
        "model": "wework-gpt-5.6-sol",
        "previous_response_id": "resp_previous",
        "input": [{
            "type": "reasoning",
            "summary": [],
            "encrypted_content": "encrypted-same-model-state"
        }]
    }))
    .expect("request body");

    let prepared = prepare_model_switch_request(&upstream, body.clone(), false)
        .expect("request should prepare");

    assert_eq!(prepared, body);
}

#[test]
fn preserves_new_encrypted_history_after_the_model_switch_is_recorded() {
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
        routing_model_id: Some("wework-gpt-5.6-sol".to_owned()),
        codex_request_mode: Default::default(),
        max_output_tokens: None,
        model_context_window: None,
    };
    let body = serde_json::to_vec(&json!({
        "model": "wework-gpt-5.6-sol",
        "previous_response_id": "resp_after_switch",
        "input": [
            {
                "type": "reasoning",
                "summary": [],
                "encrypted_content": "encrypted-new-model-state"
            },
            {
                "type": "message",
                "role": "developer",
                "content": [{
                    "type": "input_text",
                    "text": "<model_switch>Persistent historical marker.</model_switch>"
                }]
            }
        ]
    }))
    .expect("request body");

    let prepared = prepare_model_switch_request(&upstream, body.clone(), false)
        .expect("later request should preserve new model state");

    assert_eq!(prepared, body);
}

#[test]
fn rejects_invalid_chat_request() {
    let error = prepare_request("openai-chat-completions", false, None, b"not-json")
        .expect_err("invalid JSON should fail");
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
}

#[test]
fn normalizes_cross_protocol_history_ids_for_native_responses_models() {
    let body = cross_protocol_history_with_invalid_ids();

    let (prepared, conversion, _) =
        prepare_request("openai-responses", false, None, &body).expect("native request");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");
    let call = &prepared["input"][0];
    let output = &prepared["input"][1];
    let item_id = call["id"].as_str().expect("function call item id");
    let call_id = call["call_id"].as_str().expect("function call id");

    assert_valid_api_id(item_id);
    assert_valid_api_id(call_id);
    assert_ne!(item_id, "fc_functions.exec_command:0");
    assert_ne!(call_id, "functions.exec_command:0");
    assert_eq!(output["call_id"], call["call_id"]);
    assert!(conversion.is_none());
}

#[test]
fn normalizes_cross_protocol_history_ids_before_chat_conversion() {
    let body = cross_protocol_history_with_invalid_ids();

    let (prepared, conversion, _) =
        prepare_request("openai-chat-completions", false, None, &body).expect("chat request");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");
    let call = &prepared["messages"][0]["tool_calls"][0];
    let output = &prepared["messages"][1];
    let call_id = call["id"].as_str().expect("chat tool call id");

    assert_valid_api_id(call_id);
    assert_ne!(call_id, "functions.exec_command:0");
    assert_eq!(output["tool_call_id"], call["id"]);
    assert!(matches!(conversion, Some(Conversion::Chat(_))));
}

#[test]
fn normalizes_cross_protocol_history_ids_before_anthropic_conversion() {
    let body = cross_protocol_history_with_invalid_ids();

    let (prepared, conversion, _) =
        prepare_request("anthropic-messages", false, None, &body).expect("Anthropic request");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");
    let call = &prepared["messages"][0]["content"][0];
    let output = &prepared["messages"][1]["content"][0];
    let call_id = call["id"].as_str().expect("Anthropic tool use id");

    assert_valid_api_id(call_id);
    assert_ne!(call_id, "functions.exec_command:0");
    assert_eq!(output["tool_use_id"], call["id"]);
    assert!(matches!(conversion, Some(Conversion::Anthropic(_))));
}

#[test]
fn defaults_anthropic_max_output_tokens_to_96000() {
    let body = serde_json::to_vec(&json!({
        "model": "kimi-k3",
        "input": "finish the task"
    }))
    .expect("request body");

    let (prepared, _, _) =
        prepare_request("anthropic-messages", false, None, &body).expect("Anthropic request");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

    assert_eq!(prepared["max_tokens"], 96_000);
}

#[test]
fn native_responses_do_not_add_max_output_tokens_by_default() {
    let body = serde_json::to_vec(&json!({
        "model": "gpt-5.6-sol",
        "input": [{"role": "user", "content": "finish the task"}]
    }))
    .expect("request body");

    let (prepared, _, _) =
        prepare_request("openai-responses", false, None, &body).expect("Responses request");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

    assert!(prepared.get("max_output_tokens").is_none());
}

#[test]
fn native_responses_add_configured_max_output_tokens() {
    let body = serde_json::to_vec(&json!({
        "model": "gpt-5.6-sol",
        "input": [{"role": "user", "content": "finish the task"}]
    }))
    .expect("request body");

    let (prepared, _, _) =
        prepare_request("openai-responses", false, Some(12_345), &body).expect("Responses request");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

    assert_eq!(prepared["max_output_tokens"], 12_345);
}

#[test]
fn configured_max_output_tokens_override_the_default() {
    let body = serde_json::to_vec(&json!({
        "model": "kimi-k3",
        "input": "finish the task"
    }))
    .expect("request body");

    let (prepared, _, _) = prepare_request("anthropic-messages", false, Some(12_345), &body)
        .expect("Anthropic request");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

    assert_eq!(prepared["max_tokens"], 12_345);
}

#[test]
fn explicit_request_max_output_tokens_override_model_configuration() {
    let body = serde_json::to_vec(&json!({
        "model": "kimi-k3",
        "input": "finish the task",
        "max_output_tokens": 2_048
    }))
    .expect("request body");

    let (prepared, _, _) = prepare_request("anthropic-messages", false, Some(96_000), &body)
        .expect("Anthropic request");
    let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

    assert_eq!(prepared["max_tokens"], 2_048);
}

#[test]
fn proxy_client_rejects_invalid_url() {
    assert!(proxy_client(Some("not a proxy url")).is_err());
}

#[test]
fn rate_limit_retry_delay_uses_retry_after_and_caps_large_values() {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::RETRY_AFTER,
        reqwest::header::HeaderValue::from_static("2"),
    );
    assert_eq!(rate_limit_retry_delay(&headers, 0), Duration::from_secs(2));

    headers.insert(
        reqwest::header::RETRY_AFTER,
        reqwest::header::HeaderValue::from_static("120"),
    );
    assert_eq!(
        rate_limit_retry_delay(&headers, 0),
        MAX_RATE_LIMIT_RETRY_DELAY
    );
}

#[test]
fn rate_limit_retry_delay_falls_back_to_configured_backoff_sequence() {
    let headers = reqwest::header::HeaderMap::new();

    let delays = (0..MAX_RATE_LIMIT_RETRIES)
        .map(|retry_count| rate_limit_retry_delay(&headers, retry_count))
        .collect::<Vec<_>>();

    assert_eq!(delays, RATE_LIMIT_RETRY_DELAYS);
    assert_eq!(
        rate_limit_retry_delay(&headers, 20),
        Duration::from_secs(60)
    );
}
