use super::*;

const SKIPPED_UPSTREAM_RESPONSE_HEADERS: [&str; 10] = [
    "connection",
    "content-encoding",
    "content-length",
    "content-type",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "transfer-encoding",
    "trailer",
    "upgrade",
];

pub(super) fn forward_official_response_headers(
    upstream: &LocalModelProxyUpstream,
    upstream_headers: &reqwest::header::HeaderMap,
    response_headers: &mut HeaderMap,
) {
    if !upstream.is_official_chatgpt_codex() {
        return;
    }
    for (name, value) in upstream_headers {
        if SKIPPED_UPSTREAM_RESPONSE_HEADERS.contains(&name.as_str())
            || name.as_str().starts_with("proxy-")
            || name.as_str().starts_with("sec-websocket-")
            || name == header::SET_COOKIE
        {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            header::HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            response_headers.append(name, value);
        }
    }
}

pub(crate) async fn handle_token_route(
    Path(token): Path<String>,
    mut headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    let body = request_body::decode(&mut headers, body)?;
    let token = token_route_token(token, &body)?;
    handle_for_token(token, headers, body).await
}

pub(super) async fn handle_harness_messages(
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    let request_started_at = Instant::now();
    let upstream = {
        let mut registry = registry()
            .lock()
            .expect("local model proxy registry should not be poisoned");
        prune_registry(&mut registry);
        let registered = registry.routes.get_mut(&token).ok_or_else(|| HttpError {
            status: StatusCode::NOT_FOUND,
            detail: "unknown or expired harness model route".to_owned(),
        })?;
        registered.last_used = Instant::now();
        registered.upstream.clone()
    };
    let request_url = upstream.resolved_request_url();
    let request_body = harness_protocol::adapt_messages_request(
        &body,
        &upstream.api_format,
        upstream.model_id.as_deref(),
    )?;
    log_executor_event(
        "harness model proxy request started",
        &[
            ("api_format", upstream.api_format.clone()),
            ("upstream", safe_url(&request_url)),
            ("body_bytes", request_body.len().to_string()),
        ],
    );
    let client = proxy_client(upstream.proxy_url.as_deref())?;
    let upstream_response = send_upstream_request_with_rate_limit_retry(
        &client,
        &upstream,
        None,
        &request_url,
        &request_body,
        &headers,
        None,
    )
    .await?;
    let status = upstream_response.status();
    let upstream_headers = upstream_response.headers().clone();
    let content_type = upstream_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    log_executor_event(
        "harness model proxy upstream headers received",
        &[
            ("api_format", upstream.api_format.clone()),
            ("status", status.as_u16().to_string()),
            (
                "elapsed_ms",
                request_started_at.elapsed().as_millis().to_string(),
            ),
        ],
    );
    if !status.is_success() {
        let response_body = upstream_response.bytes().await.map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Failed to read harness model error response: {error}"),
        })?;
        crate::detailed_telemetry::capture_model_http_error(
            status,
            &response_body,
            upstream.model_id.as_deref(),
        );
        if let Some(normalized) = long_context::normalize_context_overflow(
            status.as_u16(),
            &response_body,
            request_body.len(),
            upstream.model_context_window,
        ) {
            log_executor_event(
                "harness model proxy context overflow normalized",
                &[
                    ("api_format", upstream.api_format.clone()),
                    ("upstream_status", status.as_u16().to_string()),
                    (
                        "upstream_body",
                        wegent_runtime_logging::truncate_log_value(
                            &String::from_utf8_lossy(&response_body),
                            2048,
                        ),
                    ),
                    (
                        "message",
                        normalized["error"]["message"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                    ),
                ],
            );
            let mut response = Response::new(Body::from(normalized.to_string()));
            *response.status_mut() = StatusCode::BAD_REQUEST;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            return Ok(response);
        }
        let mut response = Response::new(Body::from(response_body));
        *response.status_mut() = status;
        if let Some(value) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
            response.headers_mut().insert(header::CONTENT_TYPE, value);
        }
        forward_official_response_headers(&upstream, &upstream_headers, response.headers_mut());
        return Ok(response);
    }
    if upstream.api_format == "anthropic-messages" {
        let mut response = Response::new(Body::from_stream(upstream_response.bytes_stream()));
        *response.status_mut() = status;
        if let Some(value) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
            response.headers_mut().insert(header::CONTENT_TYPE, value);
        }
        return Ok(response);
    }
    if !content_type
        .as_deref()
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"))
    {
        let response_body = upstream_response.bytes().await.map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Failed to read harness model response: {error}"),
        })?;
        let value = serde_json::from_slice::<Value>(&response_body).map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Harness upstream returned invalid JSON: {error}"),
        })?;
        let converted =
            harness_protocol::adapt_upstream_json_response(&upstream.api_format, &value)?;
        let mut response = Response::new(Body::from(converted.to_string()));
        *response.status_mut() = status;
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        forward_official_response_headers(&upstream, &upstream_headers, response.headers_mut());
        return Ok(response);
    }
    let stream = diagnostic_upstream_stream(
        upstream_response.bytes_stream(),
        upstream.api_format.clone(),
        request_started_at,
    );
    let mut response = Response::new(Body::from_stream(harness_protocol::adapt_upstream_sse(
        upstream.api_format.clone(),
        stream,
    )));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    forward_official_response_headers(&upstream, &upstream_headers, response.headers_mut());
    Ok(response)
}

pub(super) async fn handle_bound_thread(
    mut headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    if bearer_token(&headers).as_deref() != Some(API_KEY) {
        return Err(HttpError {
            status: StatusCode::UNAUTHORIZED,
            detail: "invalid local model proxy authorization".to_owned(),
        });
    }
    let body = request_body::decode(&mut headers, body)?;
    let token = bound_thread_token(&body)?;
    handle_for_token(token, headers, body).await
}

pub(super) fn bound_thread_token(body: &[u8]) -> Result<String, HttpError> {
    let identity = request_thread_identity(body).ok_or_else(|| HttpError {
        status: StatusCode::CONFLICT,
        detail: "Codex Responses request is missing task thread metadata".to_owned(),
    })?;
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    prune_registry(&mut registry);
    bound_thread_token_in_registry(&registry, &identity)
}

/// Reports whether a Codex thread resolves to a local model route.
#[cfg(any(test, feature = "test-support"))]
pub fn thread_has_bound_route(thread_id: &str) -> bool {
    let body = serde_json::json!({"client_metadata": {"thread_id": thread_id}}).to_string();
    bound_thread_token(body.as_bytes()).is_ok()
}

pub(super) fn bound_thread_token_in_registry(
    registry: &LocalModelProxyRegistry,
    identity: &RequestThreadIdentity,
) -> Result<String, HttpError> {
    let mut tokens = registry.routes.iter().filter_map(|(token, registered)| {
        let matches_thread = registered.thread_ids.contains(&identity.thread_id);
        let matches_parent = identity
            .parent_thread_id
            .as_ref()
            .is_some_and(|parent| registered.thread_ids.contains(parent));
        (matches_thread || matches_parent).then(|| token.clone())
    });
    let token = tokens.next().ok_or_else(|| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: "no local model proxy route is bound to the Codex thread".to_owned(),
    })?;
    if tokens.next().is_some() {
        return Err(HttpError {
            status: StatusCode::CONFLICT,
            detail: "multiple local model proxy routes are bound to the Codex thread".to_owned(),
        });
    }
    Ok(token)
}

pub(super) fn token_route_token(token: String, body: &[u8]) -> Result<String, HttpError> {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    prune_registry(&mut registry);
    if registry.routes.contains_key(&token) {
        return Ok(token);
    }
    let identity = request_thread_identity(body).ok_or_else(|| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: "unknown or expired local model proxy token".to_owned(),
    })?;
    let recovered = bound_thread_token_in_registry(&registry, &identity)?;
    log_executor_event(
        "local model proxy stale token recovered",
        &[
            ("thread_id", identity.thread_id),
            ("active_registrations", registry.routes.len().to_string()),
        ],
    );
    Ok(recovered)
}

pub(super) struct AuthorizedRequest {
    pub upstream: LocalModelProxyUpstream,
    gateway_credentials: Option<GatewayCredentials>,
    pub history: std::sync::Arc<history::CodexToolHistory>,
    pub model_routing: ModelRequestRouting,
    vision_sidecar: Option<VisionSidecarUpstream>,
    foreign_history_keys: HashSet<String>,
    text_only: bool,
}

pub(super) fn authorize_request(token: &str, body: &[u8]) -> Result<AuthorizedRequest, HttpError> {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    prune_registry(&mut registry);
    let route = registry.routes.get_mut(token).ok_or_else(|| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: "unknown or expired local model proxy token".to_owned(),
    })?;
    if route.active_references == 0 && route.gateway_credentials.is_some() {
        return Err(HttpError {
            status: StatusCode::NOT_FOUND,
            detail: "inactive model gateway route".to_owned(),
        });
    }
    authorize_task_thread(route, body)?;
    route.last_used = Instant::now();
    Ok(AuthorizedRequest {
        upstream: route.upstream.clone(),
        gateway_credentials: route.gateway_credentials.clone(),
        vision_sidecar: route.vision_sidecar.clone(),
        history: route.history.clone(),
        foreign_history_keys: route.foreign_history_keys.clone(),
        model_routing: begin_model_request(route, body),
        text_only: route.text_only,
    })
}

impl AuthorizedRequest {
    pub(super) async fn prepare(
        &self,
        body: &[u8],
        forked: bool,
    ) -> Result<request_policy::PreparedRequest, HttpError> {
        log_stale_requested_model(&self.upstream, body);
        let body = if self.upstream.codex_request_mode == CodexRequestMode::Passthrough {
            std::borrow::Cow::Borrowed(body)
        } else {
            let body = if self.text_only {
                text_only_request(body)?
            } else {
                body.to_vec()
            };
            std::borrow::Cow::Owned(progressive_tools::prepare(&body).map_err(|error| {
                HttpError {
                    status: StatusCode::BAD_REQUEST,
                    detail: format!("Invalid native Code Mode request: {error}"),
                }
            })?)
        };
        request_policy::prepare(
            &self.upstream,
            &body,
            self.vision_sidecar.as_ref(),
            self.history.as_ref(),
            self.model_routing.model_switched,
            forked,
            &self.foreign_history_keys,
        )
        .await
    }
}

pub(super) async fn handle_for_token(
    token: String,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    let request_started_at = Instant::now();
    let forked_from_thread_id = codex_forked_from_thread_id(&headers);
    let request = authorize_request(&token, &body)?;
    let request_policy::PreparedRequest {
        body: request_body,
        conversion,
        expanded_browser_tools,
        stripped_encrypted_content,
        normalized_reasoning_items,
        foreign_history_keys,
    } = request
        .prepare(&body, forked_from_thread_id.is_some())
        .await?;
    let AuthorizedRequest {
        upstream,
        gateway_credentials,
        history,
        model_routing,
        foreign_history_keys: known_foreign_history_keys,
        ..
    } = request;
    let request_url = upstream.resolved_request_url();
    let normalized_inter_agent_content = 0;
    let tool_capabilities = upstream.responses_tool_capabilities();
    let mut request_log_fields = vec![
        ("api_format", upstream.api_format.clone()),
        (
            "codex_request_mode",
            upstream.codex_request_mode.label().to_owned(),
        ),
        ("upstream", safe_url(&request_url)),
        (
            "credential_source",
            if gateway_credentials.is_some() {
                "device_connection"
            } else {
                "model_configuration"
            }
            .to_owned(),
        ),
        (
            "auth_present",
            (gateway_credentials.is_some() || !upstream.api_key.is_empty()).to_string(),
        ),
        (
            "default_headers",
            upstream.default_headers.len().to_string(),
        ),
        ("body_bytes", request_body.len().to_string()),
        (
            "convert_custom_tools",
            tool_capabilities.custom_tools.enabled().to_string(),
        ),
        (
            "native_tool_search",
            tool_capabilities.native_tool_search.to_string(),
        ),
        (
            "native_namespace_tools",
            tool_capabilities.native_namespace_tools.to_string(),
        ),
        (
            "expanded_browser_tools",
            expanded_browser_tools.len().to_string(),
        ),
        (
            "normalized_inter_agent_content",
            normalized_inter_agent_content.to_string(),
        ),
        (
            "normalized_reasoning_items",
            normalized_reasoning_items.to_string(),
        ),
        (
            "known_foreign_history_items",
            known_foreign_history_keys.len().to_string(),
        ),
        (
            "foreign_history_items",
            foreign_history_keys.len().to_string(),
        ),
    ];
    request_log_fields.extend(request_tool_diagnostic_fields(&request_body));
    if let Some(parent_thread_id) = forked_from_thread_id {
        request_log_fields.extend([
            ("forked_from_thread_id", parent_thread_id),
            (
                "stripped_encrypted_content",
                stripped_encrypted_content.to_string(),
            ),
        ]);
    }
    log_executor_event("local model proxy request started", &request_log_fields);

    let client = if gateway_credentials.is_some() {
        // The device credential is scoped to the backend, outside model proxy configuration.
        proxy_client_without_redirects(None)?
    } else {
        proxy_client(upstream.proxy_url.as_deref())?
    };
    let upstream_response = send_upstream_request_with_rate_limit_retry(
        &client,
        &upstream,
        gateway_credentials.as_ref(),
        &request_url,
        &request_body,
        &headers,
        retry_notifications::RetryWait::for_request(&body),
    )
    .await?;
    let status = upstream_response.status();
    let upstream_headers = upstream_response.headers().clone();
    if status.is_success() {
        commit_model_request(&token, &model_routing, &foreign_history_keys);
    }
    log_executor_event(
        "local model proxy upstream headers received",
        &[
            ("api_format", upstream.api_format.clone()),
            ("status", status.as_u16().to_string()),
            (
                "elapsed_ms",
                request_started_at.elapsed().as_millis().to_string(),
            ),
        ],
    );
    let content_type = upstream_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if !status.is_success() {
        let response_body = upstream_response.bytes().await.map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Failed to read local model error response: {error}"),
        })?;
        crate::detailed_telemetry::capture_model_http_error(
            status,
            &response_body,
            upstream.model_id.as_deref(),
        );
        log_executor_event(
            "local model proxy upstream rejected request",
            &[
                ("api_format", upstream.api_format.clone()),
                ("status", status.as_u16().to_string()),
                ("body_bytes", response_body.len().to_string()),
                (
                    "upstream_error_code",
                    detect_upstream_error_code(&response_body).unwrap_or_default(),
                ),
            ],
        );
        let mut response = Response::new(Body::from(response_body));
        *response.status_mut() = status;
        if let Some(value) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
            response.headers_mut().insert(header::CONTENT_TYPE, value);
        }
        forward_official_response_headers(&upstream, &upstream_headers, response.headers_mut());
        return Ok(response);
    }
    if upstream.api_format != "openai-responses"
        && !is_event_stream_content_type(content_type.as_deref())
    {
        let response_body = upstream_response.bytes().await.map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Failed to read non-streaming local model response: {error}"),
        })?;
        let value = serde_json::from_slice::<Value>(&response_body).map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Upstream returned invalid non-SSE JSON: {error}"),
        })?;
        log_executor_event(
            "local model proxy converting non-sse response",
            &[
                ("api_format", upstream.api_format.clone()),
                ("content_type", content_type.unwrap_or_default()),
                ("body_bytes", response_body.len().to_string()),
            ],
        );
        if let Some(conversion) = conversion {
            match conversion {
                Conversion::Chat(context) => {
                    let source = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
                        Bytes::from(format!("data: {}\n\ndata: [DONE]\n\n", value)),
                    )]);
                    let responses_stream = chat::chat_sse_to_responses(source, context);
                    let mut response = Response::new(Body::from_stream(
                        history::record_responses_stream(responses_stream, history),
                    ));
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/event-stream"),
                    );
                    forward_official_response_headers(
                        &upstream,
                        &upstream_headers,
                        response.headers_mut(),
                    );
                    return Ok(response);
                }
                Conversion::Anthropic(context) => {
                    let chat_value = anthropic::anthropic_response_to_chat(&value);
                    let source = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
                        Bytes::from(format!("data: {}\n\ndata: [DONE]\n\n", chat_value)),
                    )]);
                    let responses_stream = chat::chat_sse_to_responses(source, context);
                    let mut response = Response::new(Body::from_stream(
                        history::record_responses_stream(responses_stream, history),
                    ));
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/event-stream"),
                    );
                    forward_official_response_headers(
                        &upstream,
                        &upstream_headers,
                        response.headers_mut(),
                    );
                    return Ok(response);
                }
                Conversion::Responses(context) => {
                    let event = normalize_responses_event(&format!(
                        "event: response.completed\ndata: {}",
                        json!({"type": "response.completed", "response": value})
                    ));
                    let source = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
                        Bytes::from(format!("{}\n\n", event)),
                    )]);
                    let responses_stream = chat::responses_sse_to_responses(source, context);
                    let mut response = Response::new(Body::from_stream(
                        history::record_responses_stream(responses_stream, history),
                    ));
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/event-stream"),
                    );
                    forward_official_response_headers(
                        &upstream,
                        &upstream_headers,
                        response.headers_mut(),
                    );
                    return Ok(response);
                }
            }
        }
        let event = normalize_responses_event(&format!(
            "event: response.completed\ndata: {}",
            json!({"type": "response.completed", "response": value})
        ));
        let mut response = Response::new(Body::from(format!("{event}\n\n")));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream"),
        );
        forward_official_response_headers(&upstream, &upstream_headers, response.headers_mut());
        return Ok(response);
    }
    let is_converted = conversion.is_some();
    let response_stream = diagnostic_upstream_stream(
        upstream_response.bytes_stream(),
        upstream.api_format.clone(),
        request_started_at,
    );
    let mut response = match conversion {
        Some(Conversion::Chat(context)) => {
            let responses_stream = chat::chat_sse_to_responses(response_stream, context);
            Response::new(Body::from_stream(history::record_responses_stream(
                responses_stream,
                history,
            )))
        }
        Some(Conversion::Anthropic(context)) => {
            let responses_stream = anthropic::anthropic_sse_to_responses(response_stream, context);
            Response::new(Body::from_stream(history::record_responses_stream(
                responses_stream,
                history,
            )))
        }
        Some(Conversion::Responses(context)) => {
            let responses_stream = chat::responses_sse_to_responses(response_stream, context);
            Response::new(Body::from_stream(history::record_responses_stream(
                responses_stream,
                history,
            )))
        }
        None if upstream.uses_native_chatgpt_auth()
            && matches!(
                upstream.codex_request_mode,
                CodexRequestMode::Passthrough | CodexRequestMode::OfficialSubscription
            ) =>
        {
            Response::new(Body::from_stream(response_stream))
        }
        None if upstream.codex_request_mode == CodexRequestMode::Passthrough => {
            Response::new(Body::from_stream(history::record_responses_stream(
                passthrough_stream::guard(response_stream),
                history,
            )))
        }
        None => Response::new(Body::from_stream(history::record_responses_stream(
            normalize_responses_stream(response_stream, expanded_browser_tools),
            history,
        ))),
    };
    *response.status_mut() = status;
    if is_converted {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream"),
        );
    } else if let Some(value) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    forward_official_response_headers(&upstream, &upstream_headers, response.headers_mut());
    Ok(response)
}
