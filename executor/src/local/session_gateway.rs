// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{
        ws::{Message as ClientMessage, WebSocket, WebSocketUpgrade},
        FromRequestParts, State,
    },
    http::{
        header::{self, HeaderName, HeaderValue},
        HeaderMap, Request, Response, StatusCode,
    },
    response::IntoResponse,
    routing::any,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use reqwest::redirect::Policy;
use tokio::{net::TcpListener, task::JoinHandle};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message as UpstreamMessage},
};

use crate::{
    local::session::{
        GatewayRequest, GatewaySessionSnapshot, LocalSession, LocalSessionHandler, SessionGateway,
        SessionType,
    },
    logging::{format_executor_log, write_executor_error_line, write_executor_log_line},
};

const DEFAULT_GATEWAY_HOST: &str = "0.0.0.0";
const DEFAULT_GATEWAY_PORT: u16 = 17888;
const PUBLIC_BASE_URL_ENV: &str = "DEVICE_PUBLIC_BASE_URL";
const MAX_PROXY_BODY_BYTES: usize = 64 * 1024 * 1024;
const SESSION_PROBE_QUERY_KEY: &str = "__wegent_probe";

#[derive(Clone)]
struct GatewayState {
    session_handler: Arc<Mutex<LocalSessionHandler>>,
    client: reqwest::Client,
    code_server_logins: Arc<tokio::sync::Mutex<HashMap<String, Option<String>>>>,
}

pub struct SessionGatewayHandle {
    pub local_addr: SocketAddr,
    task: JoinHandle<()>,
}

impl Drop for SessionGatewayHandle {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn start_session_gateway(
    session_handler: Arc<Mutex<LocalSessionHandler>>,
) -> Result<Option<SessionGatewayHandle>, String> {
    let (enabled, public_base_url) = {
        let handler = session_handler
            .lock()
            .map_err(|_| "Session handler lock is poisoned".to_owned())?;
        (handler.gateway_enabled, handler.public_base_url.clone())
    };
    if !enabled {
        return Ok(None);
    }

    let host = env::var("DEVICE_SESSION_GATEWAY_HOST")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_GATEWAY_HOST.to_owned());
    let port = env::var("DEVICE_SESSION_GATEWAY_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .or_else(|| {
            url::Url::parse(&public_base_url)
                .ok()
                .and_then(|url| url.port())
        })
        .unwrap_or(DEFAULT_GATEWAY_PORT);
    let uses_dynamic_public_url = port == 0 && !has_explicit_public_base_url();
    let listener = TcpListener::bind((host.as_str(), port))
        .await
        .map_err(|error| format!("Failed to bind session gateway on {host}:{port}: {error}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|error| format!("Failed to read session gateway address: {error}"))?;
    if uses_dynamic_public_url {
        update_dynamic_public_base_url(&session_handler, local_addr.port())?;
    }
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("Failed to create session gateway HTTP client: {error}"))?;
    let state = GatewayState {
        session_handler,
        client,
        code_server_logins: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .fallback(any(handle_gateway_request))
        .with_state(state);
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            write_executor_error_line(&format_executor_log(
                "session gateway stopped",
                &[("error", error.to_string())],
            ));
        }
    });
    write_executor_log_line(&format_executor_log(
        "session gateway listening",
        &[("address", local_addr.to_string())],
    ));
    Ok(Some(SessionGatewayHandle { local_addr, task }))
}

fn has_explicit_public_base_url() -> bool {
    env::var(PUBLIC_BASE_URL_ENV)
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
}

fn update_dynamic_public_base_url(
    session_handler: &Arc<Mutex<LocalSessionHandler>>,
    port: u16,
) -> Result<(), String> {
    let mut handler = session_handler
        .lock()
        .map_err(|_| "Session handler lock is poisoned".to_owned())?;
    let mut public_url = url::Url::parse(&handler.public_base_url)
        .map_err(|error| format!("Invalid session gateway public base URL: {error}"))?;
    public_url
        .set_port(Some(port))
        .map_err(|_| "Session gateway public base URL cannot contain a port".to_owned())?;
    handler.public_base_url = public_url.as_str().trim_end_matches('/').to_owned();
    Ok(())
}

async fn handle_gateway_request(
    State(state): State<GatewayState>,
    request: Request<Body>,
) -> Response<Body> {
    let gateway_request = build_gateway_request(request.uri(), request.headers());
    let session = match resolve_session(&state, &gateway_request) {
        Ok(session) => session,
        Err(response) => return *response,
    };
    if gateway_request
        .query
        .get(SESSION_PROBE_QUERY_KEY)
        .map(String::as_str)
        == Some("1")
    {
        return session_response(StatusCode::NO_CONTENT, Bytes::new());
    }

    if is_websocket_request(request.headers()) {
        let (mut parts, body) = request.into_parts();
        let websocket_upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await
        {
            Ok(websocket_upgrade) => websocket_upgrade,
            Err(response) => return response.into_response(),
        };
        let request = Request::from_parts(parts, body);
        if !is_websocket_request(request.headers()) {
            return session_error(StatusCode::BAD_REQUEST, "Invalid WebSocket upgrade request");
        };
        if let Err(error) = ensure_code_server_login(&state, &session).await {
            return session_error(StatusCode::BAD_GATEWAY, &error);
        }
        return upgrade_websocket(state, websocket_upgrade, gateway_request, session).await;
    }

    if should_redirect_authenticated_request(&gateway_request, &session) {
        return authenticated_redirect(&gateway_request, &session);
    }
    proxy_http(state, request, gateway_request, session).await
}

fn resolve_session(
    state: &GatewayState,
    request: &GatewayRequest,
) -> Result<GatewaySessionSnapshot, Box<Response<Body>>> {
    let session = state
        .session_handler
        .lock()
        .map_err(|_| {
            Box::new(session_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Session state is unavailable",
            ))
        })?
        .gateway_session(request)
        .ok_or_else(|| {
            Box::new(session_error(
                StatusCode::NOT_FOUND,
                "This terminal or IDE session is no longer available. Return to Wegent and open it again from the workspace tools.",
            ))
        })?;
    if !is_authorized(request, &session) {
        return Err(Box::new(session_error(
            StatusCode::UNAUTHORIZED,
            "This session link is missing valid authorization. Return to Wegent and open the tool again.",
        )));
    }
    if epoch_seconds() > session.expires_at {
        return Err(Box::new(session_error(
            StatusCode::GONE,
            "This terminal or IDE session has expired. Return to Wegent and open it again from the workspace tools.",
        )));
    }
    if session.session_type == SessionType::Terminal {
        return Err(Box::new(session_error(
            StatusCode::NOT_FOUND,
            "Terminal sessions are available through Wegent's authenticated terminal channel.",
        )));
    }
    Ok(session)
}

fn is_authorized(request: &GatewayRequest, session: &GatewaySessionSnapshot) -> bool {
    request.query.get("token").or_else(|| {
        request
            .cookies
            .get(&format!("wegent_session_{}", session.session_id))
    }) == Some(&session.access_token)
}

fn should_redirect_authenticated_request(
    request: &GatewayRequest,
    session: &GatewaySessionSnapshot,
) -> bool {
    session.session_type == SessionType::CodeServer
        && request.query.contains_key("token")
        && request.query.get("embed").map(String::as_str) != Some("1")
}

fn authenticated_redirect(
    request: &GatewayRequest,
    session: &GatewaySessionSnapshot,
) -> Response<Body> {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(
            request
                .query
                .iter()
                .filter(|(key, _)| key.as_str() != "token"),
        )
        .finish();
    let location = if query.is_empty() {
        request.path.clone()
    } else {
        format!("{}?{query}", request.path)
    };
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::FOUND;
    if let Ok(value) = HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    append_session_cookies(response.headers_mut(), request, session);
    response
}

async fn proxy_http(
    state: GatewayState,
    request: Request<Body>,
    gateway_request: GatewayRequest,
    session: GatewaySessionSnapshot,
) -> Response<Body> {
    if let Err(error) = ensure_code_server_login(&state, &session).await {
        return session_error(StatusCode::BAD_GATEWAY, &error);
    }
    let utility_session = utility_session(&session);
    let utility = SessionGateway::new(HashMap::new());
    let upstream_url = utility.build_upstream_url(&gateway_request, &utility_session, "http");
    let proxy_headers = utility.proxy_headers(&gateway_request, Some(&utility_session));
    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, MAX_PROXY_BODY_BYTES).await {
        Ok(body) => body,
        Err(error) => {
            return session_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                &format!("Failed to read proxy request body: {error}"),
            )
        }
    };
    let mut upstream_request = state.client.request(parts.method, upstream_url);
    for (key, value) in proxy_headers {
        if let (Ok(key), Ok(value)) = (
            HeaderName::from_bytes(key.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            upstream_request = upstream_request.header(key, value);
        }
    }
    if let Some(cookie) = code_server_cookie(&state, &session.session_id).await {
        upstream_request = upstream_request.header(header::COOKIE, cookie);
    }
    let upstream = match upstream_request.body(body).send().await {
        Ok(response) => response,
        Err(error) => {
            return session_error(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to reach code-server: {error}"),
            )
        }
    };
    let status = upstream.status();
    let response_headers = upstream.headers().clone();
    let body = match upstream.bytes().await {
        Ok(body) => body,
        Err(error) => {
            return session_error(
                StatusCode::BAD_GATEWAY,
                &format!("Failed to read code-server response: {error}"),
            )
        }
    };
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    copy_response_headers(&response_headers, response.headers_mut());
    append_session_cookies(response.headers_mut(), &gateway_request, &session);
    response
}

async fn upgrade_websocket(
    state: GatewayState,
    websocket_upgrade: WebSocketUpgrade,
    gateway_request: GatewayRequest,
    session: GatewaySessionSnapshot,
) -> Response<Body> {
    let utility_session = utility_session(&session);
    let utility = SessionGateway::new(HashMap::new());
    let protocols = utility.websocket_protocols(&gateway_request);
    let upstream_url = utility.build_upstream_url(&gateway_request, &utility_session, "ws");
    let proxy_headers = utility.proxy_headers(&gateway_request, Some(&utility_session));
    let cookie = code_server_cookie(&state, &session.session_id).await;
    websocket_upgrade
        .protocols(protocols.clone())
        .on_upgrade(move |socket| async move {
            if let Err(error) =
                proxy_websocket(socket, upstream_url, proxy_headers, protocols, cookie).await
            {
                write_executor_error_line(&format_executor_log(
                    "session gateway websocket failed",
                    &[("error", error)],
                ));
            }
        })
        .into_response()
}

async fn proxy_websocket(
    client_socket: WebSocket,
    upstream_url: String,
    headers: HashMap<String, String>,
    protocols: Vec<String>,
    cookie: Option<String>,
) -> Result<(), String> {
    let mut upstream_request = upstream_url
        .into_client_request()
        .map_err(|error| format!("Invalid code-server WebSocket URL: {error}"))?;
    for (key, value) in headers {
        let Ok(name) = HeaderName::from_bytes(key.as_bytes()) else {
            continue;
        };
        let Ok(value) = HeaderValue::from_str(&value) else {
            continue;
        };
        upstream_request.headers_mut().insert(name, value);
    }
    if !protocols.is_empty() {
        let value = HeaderValue::from_str(&protocols.join(", "))
            .map_err(|error| format!("Invalid WebSocket protocol header: {error}"))?;
        upstream_request
            .headers_mut()
            .insert(header::SEC_WEBSOCKET_PROTOCOL, value);
    }
    if let Some(cookie) = cookie {
        let value = HeaderValue::from_str(&cookie)
            .map_err(|error| format!("Invalid code-server cookie: {error}"))?;
        upstream_request.headers_mut().insert(header::COOKIE, value);
    }
    let (upstream_socket, _) = connect_async(upstream_request)
        .await
        .map_err(|error| format!("Failed to connect to code-server WebSocket: {error}"))?;
    let (mut client_sender, mut client_receiver) = client_socket.split();
    let (mut upstream_sender, mut upstream_receiver) = upstream_socket.split();

    loop {
        tokio::select! {
            client_message = client_receiver.next() => {
                let Some(client_message) = client_message else {
                    let _ = upstream_sender.send(UpstreamMessage::Close(None)).await;
                    return Ok(());
                };
                let message = client_message
                    .map_err(|error| format!("Client WebSocket failed: {error}"))?;
                upstream_sender
                    .send(client_to_upstream_message(message))
                    .await
                    .map_err(|error| format!("Failed to forward client WebSocket message: {error}"))?;
            }
            upstream_message = upstream_receiver.next() => {
                let Some(upstream_message) = upstream_message else {
                    let _ = client_sender.send(ClientMessage::Close(None)).await;
                    return Ok(());
                };
                let message = upstream_message
                    .map_err(|error| format!("Code-server WebSocket failed: {error}"))?;
                if let Some(message) = upstream_to_client_message(message) {
                    client_sender
                        .send(message)
                        .await
                        .map_err(|error| format!("Failed to forward code-server WebSocket message: {error}"))?;
                }
            }
        }
    }
}

fn client_to_upstream_message(message: ClientMessage) -> UpstreamMessage {
    match message {
        ClientMessage::Text(text) => UpstreamMessage::Text(text.to_string()),
        ClientMessage::Binary(data) => UpstreamMessage::Binary(data.to_vec()),
        ClientMessage::Ping(data) => UpstreamMessage::Ping(data.to_vec()),
        ClientMessage::Pong(data) => UpstreamMessage::Pong(data.to_vec()),
        ClientMessage::Close(_) => UpstreamMessage::Close(None),
    }
}

fn upstream_to_client_message(message: UpstreamMessage) -> Option<ClientMessage> {
    match message {
        UpstreamMessage::Text(text) => Some(ClientMessage::Text(text.into())),
        UpstreamMessage::Binary(data) => Some(ClientMessage::Binary(data.into())),
        UpstreamMessage::Ping(data) => Some(ClientMessage::Ping(data.into())),
        UpstreamMessage::Pong(data) => Some(ClientMessage::Pong(data.into())),
        UpstreamMessage::Close(_) => Some(ClientMessage::Close(None)),
        UpstreamMessage::Frame(_) => None,
    }
}

async fn ensure_code_server_login(
    state: &GatewayState,
    session: &GatewaySessionSnapshot,
) -> Result<(), String> {
    if state
        .code_server_logins
        .lock()
        .await
        .contains_key(&session.session_id)
    {
        return Ok(());
    }
    let password = env::var("CODE_SERVER_PASSWORD")
        .or_else(|_| env::var("PASSWORD"))
        .unwrap_or_else(|_| "wegent".to_owned());
    let response = state
        .client
        .post(format!("http://127.0.0.1:{}/login", session.port))
        .form(&[("password", password)])
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|error| format!("Failed to authenticate code-server: {error}"))?;
    if !matches!(response.status(), StatusCode::FOUND | StatusCode::SEE_OTHER) {
        return Err(format!(
            "Failed to authenticate code-server: HTTP {}",
            response.status()
        ));
    }
    let cookie = response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    state.code_server_logins.lock().await.insert(
        session.session_id.clone(),
        (!cookie.is_empty()).then_some(cookie),
    );
    Ok(())
}

async fn code_server_cookie(state: &GatewayState, session_id: &str) -> Option<String> {
    state
        .code_server_logins
        .lock()
        .await
        .get(session_id)
        .cloned()
        .flatten()
}

fn utility_session(session: &GatewaySessionSnapshot) -> LocalSession {
    LocalSession::code_server(
        &session.session_id,
        &session.access_token,
        0,
        std::path::PathBuf::new(),
        session.port,
        session.expires_at,
    )
}

fn build_gateway_request(uri: &axum::http::Uri, headers: &HeaderMap) -> GatewayRequest {
    let mut request =
        GatewayRequest::new(uri.path()).with_query_string(uri.query().unwrap_or_default());
    for (name, value) in headers {
        if let Ok(value) = value.to_str() {
            request.headers.insert(name.to_string(), value.to_owned());
        }
    }
    for cookie_header in headers.get_all(header::COOKIE) {
        let Ok(cookie_header) = cookie_header.to_str() else {
            continue;
        };
        for cookie in cookie_header.split(';') {
            let Some((name, value)) = cookie.trim().split_once('=') else {
                continue;
            };
            request
                .cookies
                .insert(name.trim().to_owned(), value.trim().to_owned());
        }
    }
    request
}

fn is_websocket_request(headers: &HeaderMap) -> bool {
    headers
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
}

fn copy_response_headers(source: &HeaderMap, target: &mut HeaderMap) {
    const EXCLUDED: &[&str] = &[
        "connection",
        "content-encoding",
        "content-length",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "set-cookie",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
    ];
    for (name, value) in source {
        if EXCLUDED
            .iter()
            .any(|excluded| name.as_str().eq_ignore_ascii_case(excluded))
        {
            continue;
        }
        target.append(name, value.clone());
    }
}

fn append_session_cookies(
    headers: &mut HeaderMap,
    request: &GatewayRequest,
    session: &GatewaySessionSnapshot,
) {
    if request.query.get("token") != Some(&session.access_token) {
        return;
    }
    let max_age = session.expires_at.saturating_sub(epoch_seconds()).max(1);
    append_cookie(
        headers,
        &format!(
            "wegent_session_{}={}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Lax",
            session.session_id, session.access_token
        ),
    );
    append_cookie(
        headers,
        &format!(
            "wegent_active_session={}; Max-Age={max_age}; Path=/; HttpOnly; SameSite=Lax",
            session.session_id
        ),
    );
}

fn append_cookie(headers: &mut HeaderMap, cookie: &str) {
    if let Ok(value) = HeaderValue::from_str(cookie) {
        headers.append(header::SET_COOKIE, value);
    }
}

fn session_error(status: StatusCode, message: &str) -> Response<Body> {
    session_response(status, Bytes::copy_from_slice(message.as_bytes()))
}

fn session_response(status: StatusCode, body: Bytes) -> Response<Body> {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    response
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
