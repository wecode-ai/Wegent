// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use axum::extract::ws::{Message as ClientMessage, WebSocket, WebSocketUpgrade};
use futures_util::SinkExt;
use tokio_tungstenite::{
    tungstenite::{
        handshake::{client::generate_key, derive_accept_key},
        protocol::Role,
        Message as UpstreamMessage,
    },
    WebSocketStream,
};

use super::{
    handlers::{authorize_request, forward_official_response_headers},
    upstream_transport::{proxy_client_builder, with_upstream_headers},
    *,
};

const TIMING_HEADER: &str = "x-responsesapi-include-timing-metrics";
const UPSTREAM_TIMING_EVENT: &str = "responsesapi.websocket_timing";

fn supports_websocket(upstream: &LocalModelProxyUpstream) -> bool {
    upstream.uses_native_chatgpt_auth()
        && matches!(
            upstream.codex_request_mode,
            CodexRequestMode::Passthrough | CodexRequestMode::OfficialSubscription
        )
}

pub(super) async fn handle_upgrade(
    Path(token): Path<String>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, HttpError> {
    let upstream = {
        let mut registry = registry()
            .lock()
            .expect("local model proxy registry should not be poisoned");
        prune_registry(&mut registry);
        registry
            .routes
            .get(&token)
            .filter(|route| supports_websocket(&route.upstream))
            .map(|route| route.upstream.clone())
    }
    // Codex handles 426 by switching to POST. POST can recover a persisted
    // route token using the thread identity in its body.
    .ok_or_else(|| upgrade_required("This model route requires HTTP POST"))?;
    let started_at = Instant::now();
    let client = proxy_client_builder(upstream.proxy_url.as_deref())?
        .redirect(reqwest::redirect::Policy::none())
        .http1_only()
        .timeout(Duration::from_secs(
            LOCAL_MODEL_PROXY_REQUEST_TIMEOUT_SECONDS,
        ))
        .build()
        .map_err(|_| bad_gateway("Failed to configure Responses WebSocket client"))?;
    let key = generate_key();
    let request = client
        .get(upstream.resolved_request_url())
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, &key);
    let trace_enabled = std::env::var("WEWORK_PROCESS_TRACE").as_deref() == Ok("1");
    let request = if trace_enabled && !headers.contains_key(TIMING_HEADER) {
        request.header(TIMING_HEADER, "true")
    } else {
        request
    };
    let response = with_upstream_headers(request, &upstream, &headers)
        .send()
        .await
        .map_err(|_| bad_gateway("Responses WebSocket upstream handshake failed"))?;
    let status = response.status();
    let upstream_headers = response.headers().clone();
    log_executor_event(
        "local model proxy websocket handshake",
        &[
            ("status", status.as_u16().to_string()),
            ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
        ],
    );

    if status != StatusCode::SWITCHING_PROTOCOLS {
        if status.is_success()
            || matches!(
                status,
                StatusCode::NOT_FOUND
                    | StatusCode::METHOD_NOT_ALLOWED
                    | StatusCode::UPGRADE_REQUIRED
            )
        {
            return Err(upgrade_required("Upstream Responses requires HTTP POST"));
        }
        let content_type = upstream_headers.get(header::CONTENT_TYPE).cloned();
        // WebSocket clients read the handshake rejection body directly.
        // Return a sized body so HTTP chunk framing does not become part of it.
        let body = response
            .bytes()
            .await
            .map_err(|_| bad_gateway("Failed to read Responses WebSocket handshake rejection"))?;
        let mut downstream = Response::new(Body::from(body));
        *downstream.status_mut() = status;
        if let Some(value) = content_type {
            downstream.headers_mut().insert(header::CONTENT_TYPE, value);
        }
        forward_official_response_headers(&upstream, &upstream_headers, downstream.headers_mut());
        return Ok(downstream);
    }

    let accept = derive_accept_key(key.as_bytes());
    if !has_header_token(&upstream_headers, header::CONNECTION, "upgrade")
        || !has_header_token(&upstream_headers, header::UPGRADE, "websocket")
        || upstream_headers
            .get(header::SEC_WEBSOCKET_ACCEPT)
            .map(HeaderValue::as_bytes)
            != Some(accept.as_bytes())
        || upstream_headers.contains_key(header::SEC_WEBSOCKET_PROTOCOL)
        || upstream_headers.contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
    {
        return Err(bad_gateway(
            "Invalid Responses WebSocket upstream handshake",
        ));
    }
    let stream = response
        .upgrade()
        .await
        .map_err(|_| bad_gateway("Failed to open Responses WebSocket upstream"))?;
    let remote = WebSocketStream::from_raw_socket(stream, Role::Client, None).await;
    let mut response = ws
        .max_message_size(MAX_REQUEST_BODY_BYTES)
        .max_frame_size(MAX_REQUEST_BODY_BYTES)
        .on_upgrade({
            let upstream = upstream.clone();
            move |socket| relay(socket, remote, token, headers, upstream, trace_enabled)
        });
    forward_official_response_headers(&upstream, &upstream_headers, response.headers_mut());
    Ok(response)
}

fn has_header_token(headers: &HeaderMap, name: header::HeaderName, token: &str) -> bool {
    headers
        .get_all(name)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim().eq_ignore_ascii_case(token))
}

fn upgrade_required(detail: &str) -> HttpError {
    HttpError {
        status: StatusCode::UPGRADE_REQUIRED,
        detail: detail.to_owned(),
    }
}

fn bad_gateway(detail: &str) -> HttpError {
    HttpError {
        status: StatusCode::BAD_GATEWAY,
        detail: detail.to_owned(),
    }
}

struct PendingRequest {
    history: std::sync::Arc<history::CodexToolHistory>,
    commit: Option<(ModelRequestRouting, HashSet<String>)>,
    started_at: Instant,
    first_event_seen: bool,
}

struct StreamTiming {
    sent_at: Instant,
    first_event: Option<Instant>,
    first_item: Option<Instant>,
    first_delta: Option<Instant>,
    first_item_done: Option<Instant>,
    handling: Duration,
    forwarding: Duration,
    frames: usize,
}

impl StreamTiming {
    fn new(sent_at: Instant) -> Self {
        Self {
            sent_at,
            first_event: None,
            first_item: None,
            first_delta: None,
            first_item_done: None,
            handling: Duration::ZERO,
            forwarding: Duration::ZERO,
            frames: 0,
        }
    }

    fn observe(&mut self, kind: &str, received_at: Instant) {
        if kind.starts_with("response.") || kind == "error" {
            self.first_event.get_or_insert(received_at);
        }
        match kind {
            "response.output_item.added" => self.first_item.get_or_insert(received_at),
            "response.output_item.done" => self.first_item_done.get_or_insert(received_at),
            "response.output_text.delta"
            | "response.function_call_arguments.delta"
            | "response.custom_tool_call_input.delta"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_text.delta" => self.first_delta.get_or_insert(received_at),
            _ => return,
        };
    }

    fn log(
        &self,
        connection_id: &str,
        request_number: u64,
        started_at: Instant,
        terminal_at: Instant,
    ) {
        let mut fields = vec![
            ("connection_id", connection_id.to_owned()),
            ("request_number", request_number.to_string()),
            (
                "prepare_and_send_us",
                self.sent_at
                    .duration_since(started_at)
                    .as_micros()
                    .to_string(),
            ),
            (
                "terminal_us",
                terminal_at
                    .duration_since(self.sent_at)
                    .as_micros()
                    .to_string(),
            ),
            ("handling_us", self.handling.as_micros().to_string()),
            ("forwarding_us", self.forwarding.as_micros().to_string()),
            ("frames", self.frames.to_string()),
        ];
        for (field, instant) in [
            ("first_event_us", self.first_event),
            ("first_item_us", self.first_item),
            ("first_delta_us", self.first_delta),
            ("first_item_done_us", self.first_item_done),
        ] {
            if let Some(instant) = instant {
                fields.push((
                    field,
                    instant.duration_since(self.sent_at).as_micros().to_string(),
                ));
            }
        }
        log_executor_event("local model proxy websocket stream timing", &fields);
    }
}

fn log_upstream_timing(connection_id: &str, event: &Value) {
    let mut fields = vec![("connection_id", connection_id.to_owned())];
    for name in [
        "responses_duration_excl_engine_and_client_tool_time_ms",
        "engine_service_total_ms",
        "engine_iapi_ttft_total_ms",
        "engine_service_ttft_total_ms",
        "engine_iapi_tbt_across_engine_calls_ms",
        "engine_service_tbt_across_engine_calls_ms",
    ] {
        if let Some(number) = event
            .get("timing_metrics")
            .and_then(|metrics| metrics.get(name))
            .and_then(Value::as_f64)
        {
            fields.push((name, number.to_string()));
        }
    }
    if fields.len() > 1 {
        log_executor_event("local model proxy websocket upstream timing", &fields);
    }
}

impl PendingRequest {
    async fn observe(&mut self, token: &str, event: &Value) -> bool {
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !self.first_event_seen && (kind.starts_with("response.") || kind == "error") {
            self.first_event_seen = true;
            log_executor_event(
                "local model proxy websocket first response event",
                &[(
                    "elapsed_ms",
                    self.started_at.elapsed().as_millis().to_string(),
                )],
            );
        }
        if matches!(kind, "response.created" | "response.completed") {
            if let Some((routing, foreign_history_keys)) = self.commit.take() {
                commit_model_request(token, &routing, &foreign_history_keys);
            }
        }
        if kind == "response.completed" {
            if let Some(response) = event.get("response") {
                self.history.record_response(response).await;
            }
        }
        let terminal = matches!(
            kind,
            "response.completed" | "response.failed" | "response.incomplete" | "error"
        );
        if terminal {
            log_executor_event(
                "local model proxy websocket response finished",
                &[
                    ("event", kind.to_owned()),
                    (
                        "elapsed_ms",
                        self.started_at.elapsed().as_millis().to_string(),
                    ),
                ],
            );
        }
        terminal
    }
}

struct RequestError {
    error: HttpError,
    code: &'static str,
}

impl From<HttpError> for RequestError {
    fn from(error: HttpError) -> Self {
        Self {
            error,
            code: "local_model_proxy_error",
        }
    }
}

impl RequestError {
    fn message(self) -> ClientMessage {
        ClientMessage::Text(
            json!({
                "type": "error",
                "status": self.error.status.as_u16(),
                "error": { "code": self.code, "message": self.error.detail },
            })
            .to_string()
            .into(),
        )
    }
}

async fn prepare_create(
    token: &str,
    connected_upstream: &LocalModelProxyUpstream,
    headers: &HeaderMap,
    connection_thread: &mut Option<String>,
    text: &str,
) -> Result<(UpstreamMessage, PendingRequest), RequestError> {
    let started_at = Instant::now();
    let request: Value = serde_json::from_str(text).map_err(|_| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "Invalid Responses WebSocket request".to_owned(),
    })?;
    if request.get("type").and_then(Value::as_str) != Some("response.create") {
        return Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: "Expected a Responses WebSocket response.create event".to_owned(),
        }
        .into());
    }

    let thread_id = request
        .pointer("/client_metadata/thread_id")
        .and_then(Value::as_str);
    if connection_thread
        .as_deref()
        .is_some_and(|expected| thread_id != Some(expected))
    {
        return Err(HttpError {
            status: StatusCode::CONFLICT,
            detail: "Codex request thread changed on the Responses WebSocket".to_owned(),
        }
        .into());
    }
    let authorized = authorize_request(token, text.as_bytes())?;
    if !supports_websocket(&authorized.upstream)
        || authorized.upstream.resolved_request_url() != connected_upstream.resolved_request_url()
        || authorized.upstream.proxy_url != connected_upstream.proxy_url
        || authorized.upstream.default_headers != connected_upstream.default_headers
    {
        return Err(RequestError {
            error: HttpError {
                status: StatusCode::CONFLICT,
                detail: "The model route changed. Reconnect the Responses WebSocket".to_owned(),
            },
            code: "websocket_connection_limit_reached",
        });
    }
    if connection_thread.is_none() {
        *connection_thread = thread_id.map(str::to_owned);
    }

    let prepared = authorized
        .prepare(
            text.as_bytes(),
            codex_forked_from_thread_id(headers).is_some(),
        )
        .await?;
    let body = String::from_utf8(prepared.body)
        .map_err(|_| bad_gateway("Invalid Responses WebSocket payload"))?;
    let previous_response_id = request.get("previous_response_id").and_then(Value::as_str);
    if previous_response_id.is_some() && authorized.model_routing.model_switched {
        // Codex must replay full history when a delta belongs to a different model.
        return Err(RequestError {
            error: HttpError {
                status: StatusCode::BAD_REQUEST,
                detail: "Previous response cannot be reused after a model change".to_owned(),
            },
            code: "previous_response_not_found",
        });
    }
    log_executor_event(
        "local model proxy websocket response.create",
        &[
            ("incremental", previous_response_id.is_some().to_string()),
            (
                "warmup",
                (request.get("generate") == Some(&Value::Bool(false))).to_string(),
            ),
            ("body_bytes", body.len().to_string()),
        ],
    );
    Ok((
        UpstreamMessage::Text(body.into()),
        PendingRequest {
            history: authorized.history,
            commit: Some((authorized.model_routing, prepared.foreign_history_keys)),
            started_at,
            first_event_seen: false,
        },
    ))
}

async fn relay(
    mut socket: WebSocket,
    mut remote: WebSocketStream<reqwest::Upgraded>,
    token: String,
    headers: HeaderMap,
    upstream: LocalModelProxyUpstream,
    trace_enabled: bool,
) {
    let mut pending: Option<PendingRequest> = None;
    let connection_id = trace_enabled.then(|| uuid::Uuid::new_v4().to_string());
    let mut request_number = 0;
    let mut timing: Option<StreamTiming> = None;
    let mut connection_thread = headers
        .get("thread-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    loop {
        tokio::select! {
            client_message = socket.recv() => match client_message {
                Some(Ok(ClientMessage::Text(text))) if pending.is_none() => {
                    match prepare_create(&token, &upstream, &headers, &mut connection_thread, text.as_str()).await {
                        Ok((message, request)) => {
                            if remote.send(message).await.is_err() {
                                break;
                            }
                            if trace_enabled {
                                request_number += 1;
                                timing = Some(StreamTiming::new(Instant::now()));
                            }
                            pending = Some(request);
                        }
                        Err(error) => {
                            if socket.send(error.message()).await.is_err() {
                                break;
                            }
                        }
                    }
                }
                Some(Ok(ClientMessage::Ping(_) | ClientMessage::Pong(_))) => {}
                Some(Ok(ClientMessage::Close(_))) => {
                    let _ = remote.close(None).await;
                    break;
                }
                _ => break,
            },
            remote_message = remote.next() => match remote_message {
                Some(Ok(UpstreamMessage::Text(text))) => {
                    let received_at = Instant::now();
                    let mut terminal = false;
                    if let Ok(event) = serde_json::from_str::<Value>(text.as_str()) {
                        let kind = event.get("type").and_then(Value::as_str);
                        if let (Some(trace), Some(kind)) = (timing.as_mut(), kind) {
                            trace.observe(kind, received_at);
                        }
                        if let (Some(id), Some(UPSTREAM_TIMING_EVENT)) = (connection_id.as_deref(), kind) {
                            log_upstream_timing(id, &event);
                        }
                        if let Some(request) = pending.as_mut() {
                            terminal = request.observe(&token, &event).await;
                        }
                    }
                    let forwarding_at = Instant::now();
                    if socket.send(ClientMessage::Text(text.as_str().into())).await.is_err() {
                        break;
                    }
                    if let Some(trace) = timing.as_mut() {
                        trace.frames += 1;
                        trace.handling += forwarding_at.duration_since(received_at);
                        trace.forwarding += forwarding_at.elapsed();
                    }
                    if terminal {
                        if let (Some(trace), Some(id), Some(request)) =
                            (timing.take(), connection_id.as_deref(), pending.take())
                        {
                            trace.log(id, request_number, request.started_at, received_at);
                        }
                    }
                }
                Some(Ok(UpstreamMessage::Ping(_) | UpstreamMessage::Pong(_))) => {}
                Some(Ok(UpstreamMessage::Close(frame))) => {
                    let frame = frame.map(|frame| axum::extract::ws::CloseFrame {
                        code: frame.code.into(),
                        reason: frame.reason.as_str().into(),
                    });
                    let _ = socket.send(ClientMessage::Close(frame)).await;
                    break;
                }
                _ => break,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::{response::IntoResponse, routing::get, Router};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{client_async, tungstenite::client::IntoClientRequest};

    use super::*;

    async fn serve(app: Router) -> std::net::SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        address
    }

    async fn start_proxy(remote: Router, scope: &str) -> (std::net::SocketAddr, String) {
        let upstream_address = serve(remote).await;
        let upstream = upstream_from_model_config(&json!({
            "base_url": format!("http://{upstream_address}/backend-api/codex"),
            "codex_request_mode": "passthrough",
        }))
        .unwrap()
        .unwrap();
        let token = register(scope, upstream);
        let address = serve(Router::new().route(TOKEN_ROUTE, token_route())).await;
        (address, token)
    }

    async fn receive_json(client: &mut WebSocketStream<TcpStream>) -> Value {
        let message = tokio::time::timeout(Duration::from_secs(5), client.next())
            .await
            .expect("Timed out waiting for a Responses event")
            .unwrap()
            .unwrap();
        serde_json::from_str(message.to_text().unwrap()).unwrap()
    }

    async fn send_json(client: &mut WebSocketStream<TcpStream>, value: &Value) {
        client
            .send(UpstreamMessage::Text(value.to_string().into()))
            .await
            .unwrap();
    }

    fn create(thread: &str, input: Value) -> Value {
        json!({
            "type": "response.create",
            "model": "gpt-5.5",
            "client_metadata": {"thread_id": thread},
            "input": input,
        })
    }

    #[tokio::test]
    async fn reuses_the_upstream_socket_for_tool_output_and_enforces_thread_binding() {
        async fn provider(headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
            assert_eq!(headers[header::AUTHORIZATION], "Bearer test-oauth");
            assert_eq!(headers["chatgpt-account-id"], "test-account");
            assert_eq!(headers["thread-id"], "ws-tool-thread");
            let mut response = ws.on_upgrade(|mut ws| async move {
                for id in 1..=2 {
                    let text = ws.recv().await.unwrap().unwrap().into_text().unwrap();
                    let request: Value = serde_json::from_str(text.as_str()).unwrap();
                    assert_eq!(request["client_metadata"]["thread_id"], "ws-tool-thread");
                    match id {
                        1 => {
                            assert_eq!(request["input"][0]["role"], "user");
                            assert!(request.get("previous_response_id").is_none());
                        }
                        _ => {
                            assert_eq!(request["previous_response_id"], "resp_1");
                            assert_eq!(request["input"][0]["type"], "function_call_output");
                            assert_eq!(request["input"][0]["call_id"], "call_1");
                        }
                    }
                    let response = json!({
                        "type": "response.completed",
                        "response": {
                            "id": format!("resp_{id}"),
                            "output": if id == 1 {
                                json!([{"type":"function_call","call_id":"call_1","name":"desktop","arguments":"{}"}])
                            } else { json!([]) },
                        },
                    });
                    ws.send(ClientMessage::Text(response.to_string().into())).await.unwrap();
                }
            });
            response
                .headers_mut()
                .insert("x-codex-turn-state", HeaderValue::from_static("turn-state"));
            response
        }

        let (address, token) = start_proxy(
            Router::new().route("/backend-api/codex/responses", get(provider)),
            "websocket-tool-continuation",
        )
        .await;
        bind_thread(&token, "ws-tool-thread").unwrap();
        let mut request = format!("ws://{address}/v1/codex-router/{token}/responses")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer test-oauth"),
        );
        request.headers_mut().insert(
            "chatgpt-account-id",
            HeaderValue::from_static("test-account"),
        );
        request
            .headers_mut()
            .insert("thread-id", HeaderValue::from_static("ws-tool-thread"));
        let (mut client, response) =
            client_async(request, TcpStream::connect(address).await.unwrap())
                .await
                .unwrap();
        assert_eq!(response.headers()["x-codex-turn-state"], "turn-state");

        send_json(
            &mut client,
            &create(
                "ws-tool-thread",
                json!([{"type":"message","role":"user","content":"open"}]),
            ),
        )
        .await;
        assert_eq!(receive_json(&mut client).await["response"]["id"], "resp_1");

        send_json(&mut client, &create("unbound-thread", json!([]))).await;
        assert_eq!(receive_json(&mut client).await["status"], 409);

        let mut request = create(
            "ws-tool-thread",
            json!([{"type":"function_call_output","call_id":"call_1","output":"done"}]),
        );
        request["previous_response_id"] = json!("resp_1");
        send_json(&mut client, &request).await;
        assert_eq!(receive_json(&mut client).await["response"]["id"], "resp_2");
    }

    #[tokio::test]
    async fn preserves_native_auth_errors_and_downgrades_an_http_only_upstream() {
        async fn http_only() -> StatusCode {
            StatusCode::METHOD_NOT_ALLOWED
        }

        async fn post_responses() -> Response {
            (
                [(header::CONTENT_TYPE, "text/event-stream")],
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_http\",\"output\":[]}}\n\n",
            )
                .into_response()
        }

        async fn expired_token() -> Response {
            (
                StatusCode::UNAUTHORIZED,
                [(header::WWW_AUTHENTICATE, "Bearer error=\"invalid_token\"")],
                "oauth token expired",
            )
                .into_response()
        }

        for (scope, remote, expected) in [
            (
                "websocket-http-only",
                get(http_only).post(post_responses),
                StatusCode::UPGRADE_REQUIRED,
            ),
            (
                "websocket-expired-oauth",
                get(expired_token),
                StatusCode::UNAUTHORIZED,
            ),
        ] {
            let (address, token) = start_proxy(
                Router::new().route("/backend-api/codex/responses", remote),
                scope,
            )
            .await;
            let uri = format!("ws://{address}/v1/codex-router/{token}/responses");
            let result = client_async(uri, TcpStream::connect(address).await.unwrap()).await;
            let Err(tokio_tungstenite::tungstenite::Error::Http(response)) = result else {
                panic!("Expected a native HTTP handshake error, got {result:?}")
            };
            assert_eq!(response.status(), expected);
            if expected == StatusCode::UPGRADE_REQUIRED {
                let post = reqwest::Client::builder()
                    .no_proxy()
                    .build()
                    .unwrap()
                    .post(format!(
                        "http://{address}/v1/codex-router/{token}/responses"
                    ))
                    .json(&json!({"model":"gpt-5.5","input":[],"stream":true}))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(post.status(), StatusCode::OK);
                assert!(post.text().await.unwrap().contains("resp_http"));
            } else {
                assert_eq!(
                    response.headers()[header::WWW_AUTHENTICATE],
                    "Bearer error=\"invalid_token\""
                );
                assert_eq!(
                    response.body().as_deref(),
                    Some(b"oauth token expired".as_slice())
                );
            }
        }
    }

    #[tokio::test]
    async fn requests_full_input_when_a_model_switch_invalidates_the_delta() {
        let upstream = upstream_from_model_config(&json!({
            "base_url": OFFICIAL_CHATGPT_CODEX_BASE_URL,
            "codex_request_mode": "passthrough",
            "model_id": "gpt-5.5",
        }))
        .unwrap()
        .unwrap();
        let token = register("websocket-switch-delta", upstream);
        let connected_upstream = registry().lock().unwrap().routes[&token].upstream.clone();
        bind_thread(&token, "ws-switch-thread").unwrap();
        mark_model_switch(&token);
        let mut thread = None;
        let mut request = create("ws-switch-thread", json!([]));
        request["previous_response_id"] = json!("resp_foreign");
        let Err(error) = prepare_create(
            &token,
            &connected_upstream,
            &HeaderMap::new(),
            &mut thread,
            &request.to_string(),
        )
        .await
        else {
            panic!("A delta must be replayed with full history");
        };
        assert_eq!(error.code, "previous_response_not_found");
        assert!(registry().lock().unwrap().routes[&token].pending_model_switch_cleanup);
    }
}
