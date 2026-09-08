// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};

use axum::{
    extract::ws::{Message as AxumMessage, WebSocketUpgrade},
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message as TungsteniteMessage};
use wegent_executor::local::session::{
    CodeServerLoginClient, GatewayRequest, LocalSession, LocalSessionHandler, PtySpawnRequest,
    SessionGateway, SessionPtyManager, SessionStartRequest, SessionType, TerminalEvent,
    TerminalPty,
};
use wegent_executor::local::session_gateway::start_session_gateway;

const TERMINAL_CONSUMER_ID: &str = "consumer-1";

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn session_gateway_forwards_websocket_protocols_without_duplicate_header() {
    let request = GatewayRequest::new("/")
        .with_header("Accept-Encoding", "gzip, deflate, br")
        .with_header("Sec-WebSocket-Protocol", "tty, other")
        .with_header("User-Agent", "contract");
    let gateway = SessionGateway::new(HashMap::new());

    assert_eq!(gateway.websocket_protocols(&request), vec!["tty", "other"]);
    assert_eq!(
        gateway.proxy_headers(&request, None),
        HashMap::from([
            ("Accept-Encoding".to_owned(), "identity".to_owned()),
            ("User-Agent".to_owned(), "contract".to_owned()),
        ])
    );
}

#[test]
fn session_gateway_rewrites_code_server_origin_for_upstream() {
    let request = GatewayRequest::new("/")
        .with_header("Accept-Encoding", "gzip, deflate, br")
        .with_header("Origin", "http://localhost:17888")
        .with_header("User-Agent", "contract");
    let gateway = SessionGateway::new(HashMap::new());
    let session = code_session("code-1");

    assert_eq!(
        gateway.proxy_headers(&request, Some(&session)),
        HashMap::from([
            ("Accept-Encoding".to_owned(), "identity".to_owned()),
            ("Origin".to_owned(), "http://127.0.0.1:45678".to_owned()),
            ("User-Agent".to_owned(), "contract".to_owned()),
        ])
    );
}

#[test]
fn session_gateway_strips_code_server_prefix_and_filters_auth_query() {
    let gateway = SessionGateway::new(HashMap::new());
    let request = GatewayRequest::new("/s/code-1/stable/static/out/workbench.js")
        .with_query_string("token=secret&folder=/workspace&__wegent_probe=1");
    let session = code_session("code-1");

    assert_eq!(
        gateway.build_upstream_url(&request, &session, "http"),
        "http://127.0.0.1:45678/stable/static/out/workbench.js?folder=%2Fworkspace"
    );
}

#[test]
fn session_gateway_does_not_redirect_embedded_code_server_requests() {
    let gateway = SessionGateway::new(HashMap::new());
    let session = code_session("code-1");
    let request = GatewayRequest::new("/s/code-1/").with_query("token", "secret");
    let embedded = GatewayRequest::new("/s/code-1/")
        .with_query("token", "secret")
        .with_query("embed", "1");

    assert!(!gateway.should_redirect_authenticated_request(&embedded, &session));
    assert!(gateway.should_redirect_authenticated_request(&request, &session));
}

#[test]
fn session_gateway_rejects_code_server_session_path_without_cookies() {
    let gateway = SessionGateway::new(HashMap::new());
    let session = code_session("code-1");
    let request = GatewayRequest::new("/s/code-1/");

    assert!(!gateway.is_authorized(&request, &session));
}

#[test]
fn session_gateway_returns_actionable_message_for_missing_session() {
    let mut gateway = SessionGateway::new(HashMap::new());
    let response = gateway.handle_request(&GatewayRequest::new("/s/missing-session/"));

    assert_eq!(response.status, 404);
    let body = String::from_utf8(response.body).unwrap();
    assert!(body.contains("session is no longer available"));
    assert!(body.contains("Return to Wegent"));
    assert!(body.contains("open it again from the workspace tools"));
}

#[test]
fn session_gateway_probe_returns_no_content_for_valid_session() {
    let session = code_session("code-1");
    let mut gateway = SessionGateway::new(HashMap::from([(session.session_id.clone(), session)]));
    let request = GatewayRequest::new("/s/code-1/")
        .with_query("token", "secret")
        .with_query("__wegent_probe", "1");

    let response = gateway.handle_request(&request);

    assert_eq!(response.status, 204);
    assert_eq!(
        response.headers.get("Access-Control-Allow-Origin"),
        Some(&"*".to_owned())
    );
}

#[test]
fn session_gateway_logs_in_to_code_server_with_configured_password_once() {
    let _lock = env_lock();
    let _password = EnvGuard::set("CODE_SERVER_PASSWORD", "configured-secret");
    let mut gateway = SessionGateway::new(HashMap::new());
    let mut session = code_session("code-1");
    let mut client = RecordingLoginClient::default();

    gateway
        .ensure_code_server_login(&mut session, &mut client)
        .unwrap();
    gateway
        .ensure_code_server_login(&mut session, &mut client)
        .unwrap();

    assert!(session.code_server_authenticated);
    assert_eq!(
        client.posts,
        vec![(
            "http://127.0.0.1:45678/login".to_owned(),
            "configured-secret".to_owned()
        )]
    );
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Serializes process-wide gateway environment overrides.
async fn running_session_gateway_proxies_http_and_websocket_to_code_server() {
    let _lock = env_lock();
    let _gateway_host = EnvGuard::set("DEVICE_SESSION_GATEWAY_HOST", "127.0.0.1");
    let _gateway_port = EnvGuard::set("DEVICE_SESSION_GATEWAY_PORT", "0");
    let _public_base_url = EnvGuard::set("DEVICE_PUBLIC_BASE_URL", "");
    let _password = EnvGuard::set("CODE_SERVER_PASSWORD", "configured-secret");
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    let upstream = Router::new()
        .route("/login", post(fake_code_server_login))
        .route("/health", get(fake_code_server_health))
        .route("/ws", get(fake_code_server_websocket));
    let upstream_task = tokio::spawn(async move {
        axum::serve(upstream_listener, upstream).await.unwrap();
    });

    let root = temp_root("running-gateway");
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler = LocalSessionHandler::new(
        "http://127.0.0.1:0",
        true,
        upstream_addr.port(),
        root.clone(),
        pty_manager,
    );
    handler.sessions.insert(
        "code-http".to_owned(),
        LocalSession::code_server(
            "code-http",
            "secret",
            123,
            root,
            upstream_addr.port(),
            9999999999,
        ),
    );
    let handler = Arc::new(Mutex::new(handler));
    let gateway = start_session_gateway(Arc::clone(&handler))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        handler.lock().unwrap().public_base_url,
        format!("http://127.0.0.1:{}", gateway.local_addr.port())
    );
    let http_base = format!("http://{}", gateway.local_addr);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();

    let unauthorized = client
        .get(format!("{http_base}/s/code-http/health?token=invalid"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let redirect = client
        .get(format!(
            "{http_base}/s/code-http/health?token=secret&folder=%2Fworkspace"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(redirect.status(), StatusCode::FOUND);
    assert_eq!(
        redirect.headers().get(header::LOCATION).unwrap(),
        "/s/code-http/health?folder=%2Fworkspace"
    );
    let browser_cookie = redirect
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|value| value.to_str().unwrap().split(';').next().unwrap())
        .collect::<Vec<_>>()
        .join("; ");
    assert!(browser_cookie.contains("wegent_session_code-http=secret"));
    assert!(browser_cookie.contains("wegent_active_session=code-http"));

    let health = client
        .get(format!("{http_base}/health?folder=%2Fworkspace"))
        .header(header::COOKIE, &browser_cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    let health_body = health.text().await.unwrap();
    assert!(health_body.contains("cookie=code-server-session=fake"));
    assert!(health_body.contains("uri=/health?folder=%2Fworkspace"));

    let mut websocket_request = format!("ws://{}/ws", gateway.local_addr)
        .into_client_request()
        .unwrap();
    websocket_request.headers_mut().insert(
        header::COOKIE,
        browser_cookie.parse::<axum::http::HeaderValue>().unwrap(),
    );
    websocket_request.headers_mut().insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        "vscode".parse::<axum::http::HeaderValue>().unwrap(),
    );
    let (mut websocket, response) = tokio_tungstenite::connect_async(websocket_request)
        .await
        .unwrap();
    assert_eq!(
        response
            .headers()
            .get(header::SEC_WEBSOCKET_PROTOCOL)
            .unwrap(),
        "vscode"
    );
    assert_eq!(
        websocket.next().await.unwrap().unwrap(),
        TungsteniteMessage::Text("cookie=code-server-session=fake".to_owned())
    );
    websocket
        .send(TungsteniteMessage::Text("ping".to_owned()))
        .await
        .unwrap();
    assert_eq!(
        websocket.next().await.unwrap().unwrap(),
        TungsteniteMessage::Text("echo:ping".to_owned())
    );
    websocket.close(None).await.unwrap();

    drop(gateway);
    upstream_task.abort();
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Serializes process-wide gateway environment overrides.
async fn running_session_gateway_supports_code_server_without_auth_cookie() {
    let _lock = env_lock();
    let _gateway_host = EnvGuard::set("DEVICE_SESSION_GATEWAY_HOST", "127.0.0.1");
    let _gateway_port = EnvGuard::set("DEVICE_SESSION_GATEWAY_PORT", "0");
    let _public_base_url = EnvGuard::set("DEVICE_PUBLIC_BASE_URL", "");
    let upstream_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream_listener.local_addr().unwrap();
    let upstream = Router::new()
        .route("/login", post(fake_code_server_login_without_cookie))
        .route("/health", get(fake_code_server_health));
    let upstream_task = tokio::spawn(async move {
        axum::serve(upstream_listener, upstream).await.unwrap();
    });

    let root = temp_root("gateway-auth-none");
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler = LocalSessionHandler::new(
        "http://127.0.0.1:0",
        true,
        upstream_addr.port(),
        root.clone(),
        pty_manager,
    );
    handler.sessions.insert(
        "code-none".to_owned(),
        LocalSession::code_server(
            "code-none",
            "secret",
            123,
            root,
            upstream_addr.port(),
            9999999999,
        ),
    );
    let gateway = start_session_gateway(Arc::new(Mutex::new(handler)))
        .await
        .unwrap()
        .unwrap();

    let response = reqwest::get(format!(
        "http://{}/s/code-none/health?token=secret&embed=1",
        gateway.local_addr
    ))
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    drop(gateway);
    upstream_task.abort();
}

#[tokio::test]
#[allow(clippy::await_holding_lock)] // Serializes process-wide gateway environment overrides.
async fn dynamic_session_gateway_preserves_explicit_public_base_url() {
    let _lock = env_lock();
    let _gateway_host = EnvGuard::set("DEVICE_SESSION_GATEWAY_HOST", "127.0.0.1");
    let _gateway_port = EnvGuard::set("DEVICE_SESSION_GATEWAY_PORT", "0");
    let _public_base_url = EnvGuard::set(
        "DEVICE_PUBLIC_BASE_URL",
        "https://gateway.example.com/sessions",
    );
    let handler = Arc::new(Mutex::new(LocalSessionHandler::new(
        "https://gateway.example.com/sessions",
        true,
        18080,
        temp_root("gateway-explicit-public-url"),
        Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
            RecordingTerminal::default(),
        )))),
    )));

    let gateway = start_session_gateway(Arc::clone(&handler))
        .await
        .unwrap()
        .unwrap();

    assert_eq!(
        handler.lock().unwrap().public_base_url,
        "https://gateway.example.com/sessions"
    );
    drop(gateway);
}

#[test]
fn start_terminal_session_uses_embedded_pty_and_lifecycle_methods() {
    let _lock = env_lock();
    let root = temp_root("terminal-session");
    let _shell = EnvGuard::set("SHELL", "/bin/bash");
    let terminal = Arc::new(Mutex::new(RecordingTerminal::default()));
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::clone(&terminal)));
    let mut handler = LocalSessionHandler::new(
        "http://localhost:17888",
        true,
        18080,
        root.clone(),
        pty_manager.clone(),
    );

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::Terminal,
        session_id: "terminal-1".to_owned(),
        project_id: 123,
        path: root.display().to_string(),
        access_token: "secret".to_owned(),
        rows: Some(40),
        cols: Some(120),
        create_if_missing: false,
        ttl_seconds: None,
    });

    assert!(result.success);
    assert_eq!(result.url, "");
    assert_eq!(result.transport.as_deref(), Some("socketio"));
    let spawned = pty_manager.spawned.lock().unwrap();
    assert_eq!(spawned.len(), 1);
    assert_eq!(spawned[0].cmd, vec!["/bin/bash"]);
    assert_eq!(spawned[0].cwd, root);
    assert_eq!(spawned[0].rows, 40);
    assert_eq!(spawned[0].cols, 120);
    assert!(!spawned[0].env.is_empty());
    drop(spawned);

    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );
    assert!(
        handler
            .handle_terminal_input("terminal-1", TERMINAL_CONSUMER_ID, "pwd\r")
            .success
    );
    assert!(
        handler
            .handle_terminal_resize("terminal-1", TERMINAL_CONSUMER_ID, 30, 100)
            .success
    );
    assert!(
        handler
            .handle_terminal_close("terminal-1", TERMINAL_CONSUMER_ID)
            .success
    );
    assert!(!handler.sessions.contains_key("terminal-1"));

    let terminal = terminal.lock().unwrap();
    assert_eq!(terminal.writes, vec![b"pwd\r".to_vec()]);
    assert_eq!(terminal.resizes, vec![(30, 100)]);
    assert!(terminal.terminated);
    assert!(terminal.closed);
}

#[test]
fn terminal_input_and_resize_return_errors_when_pty_is_gone() {
    let root = temp_root("failing-terminal");
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        fail_write: true,
        fail_resize: true,
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(root, &terminal);

    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );
    let input = handler.handle_terminal_input("terminal-1", TERMINAL_CONSUMER_ID, "pwd\r");
    let resize = handler.handle_terminal_resize("terminal-1", TERMINAL_CONSUMER_ID, 30, 100);

    assert!(!input.success);
    assert_eq!(
        input.error.as_deref(),
        Some("Terminal session is not writable")
    );
    assert!(!resize.success);
    assert_eq!(
        resize.error.as_deref(),
        Some("Terminal session is not resizable")
    );
}

#[test]
fn terminal_events_drain_output_before_exit_and_remove_finished_session() {
    let root = temp_root("terminal-output");
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"hello ".to_vec(), vec![b'w', b'o', b'r', b'l', b'd', 0xff]]),
        exit_code: Some(0),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(root, &terminal);

    assert!(handler.drain_terminal_events().is_empty());
    assert_eq!(terminal.lock().unwrap().output.len(), 2);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );
    let events = handler.drain_terminal_events();

    assert_eq!(
        events,
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 1,
            data: "hello world�".to_owned(),
        }]
    );
    mark_output_events_delivered(&mut handler, &events);
    assert!(
        handler
            .handle_terminal_ack("terminal-1", TERMINAL_CONSUMER_ID, 1)
            .success
    );
    let exit_events = vec![TerminalEvent::Exit {
        session_id: "terminal-1".to_owned(),
        consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
        exit_code: Some(0),
        error: None,
    }];
    assert_eq!(handler.drain_terminal_events(), exit_events);
    assert_eq!(
        handler.drain_terminal_events(),
        vec![TerminalEvent::Exit {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            exit_code: Some(0),
            error: None,
        }]
    );
    handler
        .complete_terminal_exit("terminal-1", TERMINAL_CONSUMER_ID)
        .unwrap();
    assert!(!handler.sessions.contains_key("terminal-1"));
    assert!(terminal.lock().unwrap().closed);
}

#[test]
fn terminal_output_preserves_chinese_characters_split_across_pty_chunks() {
    let chinese = "中文".as_bytes();
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([
            chinese[..2].to_vec(),
            chinese[2..4].to_vec(),
            chinese[4..].to_vec(),
        ]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-utf8-pty-chunks"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );

    assert_eq!(
        handler.drain_terminal_events(),
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 1,
            data: "中文".to_owned(),
        }]
    );
}

#[test]
fn terminal_output_preserves_chinese_character_split_across_drains() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([vec![0xe4]]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-utf8-drains"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );

    assert!(handler.drain_terminal_events().is_empty());
    push_terminal_output(&terminal, vec![0xb8, 0xad]);

    assert_eq!(
        handler.drain_terminal_events(),
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 1,
            data: "中".to_owned(),
        }]
    );
}

#[test]
fn terminal_output_replaces_invalid_utf8_without_losing_valid_bytes() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([
            b"valid".to_vec(),
            vec![0xf0, 0x28, 0x8c, 0x28],
            b"tail".to_vec(),
        ]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-invalid-utf8"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );

    assert_eq!(
        handler.drain_terminal_events(),
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 1,
            data: "valid�(�(tail".to_owned(),
        }]
    );
}

#[test]
fn terminal_output_flushes_incomplete_utf8_at_eof_before_exit() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([vec![b't', b'a', b'i', b'l', 0xe4, 0xb8]]),
        exit_code: Some(0),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-incomplete-utf8-eof"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );

    let output = handler.drain_terminal_events();
    assert_eq!(
        output,
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 1,
            data: "tail�".to_owned(),
        }]
    );
    mark_output_events_delivered(&mut handler, &output);
    assert!(
        handler
            .handle_terminal_ack("terminal-1", TERMINAL_CONSUMER_ID, 1)
            .success
    );
    assert_eq!(
        handler.drain_terminal_events(),
        vec![TerminalEvent::Exit {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            exit_code: Some(0),
            error: None,
        }]
    );
}

#[test]
fn terminal_exit_waits_until_pending_output_is_closed() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"last output".to_vec()]),
        exit_code: Some(0),
        output_open: true,
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-exit-order"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );

    let output_events = handler.drain_terminal_events();
    assert_eq!(
        output_events,
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 1,
            data: "last output".to_owned(),
        }]
    );
    mark_output_events_delivered(&mut handler, &output_events);
    assert!(handler.sessions.contains_key("terminal-1"));

    terminal.lock().unwrap().output_open = false;
    assert_eq!(handler.drain_terminal_events(), Vec::<TerminalEvent>::new());
    assert!(handler.sessions.contains_key("terminal-1"));
    assert!(terminal.lock().unwrap().closed);
    assert!(
        handler
            .handle_terminal_ack("terminal-1", TERMINAL_CONSUMER_ID, 1)
            .success
    );
    assert_eq!(
        handler.drain_terminal_events(),
        vec![TerminalEvent::Exit {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            exit_code: Some(0),
            error: None,
        }]
    );
    handler
        .complete_terminal_exit("terminal-1", TERMINAL_CONSUMER_ID)
        .unwrap();
    assert!(!handler.sessions.contains_key("terminal-1"));
}

#[test]
fn terminal_output_is_retried_until_transport_delivery_succeeds() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"retry".to_vec()]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-delivery-retry"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );

    let first_attempt = handler.drain_terminal_events();
    assert_eq!(
        first_attempt,
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 1,
            data: "retry".to_owned(),
        }]
    );
    mark_output_events_delivered(&mut handler, &first_attempt);
    assert!(handler.drain_terminal_events().is_empty());
    assert!(handler.retry_terminal_output_delivery("terminal-1", 1));
    assert_eq!(handler.drain_terminal_events(), first_attempt);
}

#[test]
fn terminal_ack_can_arrive_while_backend_delivery_call_is_in_flight() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"race".to_vec()]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-ack-race"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );

    let events = handler.drain_terminal_events();
    mark_output_events_delivered(&mut handler, &events);

    assert!(
        handler
            .handle_terminal_ack("terminal-1", TERMINAL_CONSUMER_ID, 1)
            .success
    );
    assert!(handler.drain_terminal_events().is_empty());
}

#[test]
fn terminal_backend_reconnect_replays_every_unacknowledged_delivery() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"reconnect".to_vec()]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-backend-reconnect"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );

    let events = handler.drain_terminal_events();
    mark_output_events_delivered(&mut handler, &events);
    assert!(handler.drain_terminal_events().is_empty());

    handler.prepare_terminal_reconnect();

    assert_eq!(handler.drain_terminal_events(), events);
}

#[test]
fn terminal_reconnect_accepts_output_consumed_before_ack_reached_executor() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"consumed".to_vec()]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-reconnect-lost-ack"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );
    let events = handler.drain_terminal_events();
    mark_output_events_delivered(&mut handler, &events);

    handler.prepare_terminal_reconnect();

    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 1)
            .success
    );
    assert!(handler.drain_terminal_events().is_empty());
}

#[test]
fn terminal_consumer_takeover_rejects_stale_ack_and_relabels_replay() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"takeover".to_vec()]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-consumer-takeover"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", "consumer-old", 0)
            .success
    );
    let first = handler.drain_terminal_events();
    mark_output_events_delivered(&mut handler, &first);

    assert!(
        handler
            .handle_terminal_attach("terminal-1", "consumer-new", 0)
            .success
    );
    let stale_ack = handler.handle_terminal_ack("terminal-1", "consumer-old", 1);
    assert!(!stale_ack.success);
    assert_eq!(
        stale_ack.error.as_deref(),
        Some("Terminal consumer is no longer active")
    );
    assert_eq!(
        handler.drain_terminal_events(),
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some("consumer-new".to_owned()),
            sequence: 1,
            data: "takeover".to_owned(),
        }]
    );
}

#[test]
fn expired_terminal_sessions_are_reaped_and_close_the_pty() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal::default()));
    let mut handler = LocalSessionHandler::new(
        "http://localhost:17888",
        true,
        18080,
        temp_root("terminal-expiry"),
        Arc::new(RecordingPtyManager::new(Arc::clone(&terminal))),
    );
    handler.sessions.insert(
        "terminal-1".to_owned(),
        LocalSession::terminal(
            "terminal-1",
            "secret",
            123,
            PathBuf::from("/workspace"),
            Box::new(SharedTerminal(Arc::clone(&terminal))),
            1,
        ),
    );

    assert_eq!(handler.reap_expired_sessions(), 1);
    assert!(!handler.sessions.contains_key("terminal-1"));
    assert!(terminal.lock().unwrap().terminated);
    assert!(terminal.lock().unwrap().closed);
}

#[tokio::test]
async fn terminal_output_notification_wakes_without_periodic_polling() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal::default()));
    let mut handler = terminal_handler(temp_root("terminal-notification"), &terminal);
    let event_notifier = handler.terminal_event_notifier();

    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );
    tokio::time::timeout(Duration::from_millis(50), event_notifier.notified())
        .await
        .expect("attaching should wake the terminal event loop");
    assert!(handler.drain_terminal_events().is_empty());

    push_terminal_output(&terminal, b"prompt$ ".to_vec());
    tokio::time::timeout(Duration::from_millis(50), event_notifier.notified())
        .await
        .expect("PTY output should wake the terminal event loop");

    assert_eq!(
        handler.drain_terminal_events(),
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 1,
            data: "prompt$ ".to_owned(),
        }]
    );
}

#[tokio::test]
async fn terminal_event_drain_keeps_busy_and_quiet_sessions_fair() {
    let busy = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from(vec![b"a".to_vec(); 20]),
        ..RecordingTerminal::default()
    }));
    let quiet = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"b".to_vec()]),
        ..RecordingTerminal::default()
    }));
    let mut handler = LocalSessionHandler::new(
        "http://localhost:17888",
        true,
        18080,
        temp_root("terminal-fairness"),
        Arc::new(RecordingPtyManager::new(Arc::clone(&busy))),
    );
    handler.sessions.insert(
        "busy".to_owned(),
        LocalSession::terminal(
            "busy",
            "secret",
            123,
            PathBuf::from("/workspace"),
            Box::new(SharedTerminal(busy)),
            9999999999,
        ),
    );
    handler.sessions.insert(
        "quiet".to_owned(),
        LocalSession::terminal(
            "quiet",
            "secret",
            123,
            PathBuf::from("/workspace"),
            Box::new(SharedTerminal(quiet)),
            9999999999,
        ),
    );
    assert!(
        handler
            .handle_terminal_attach("busy", TERMINAL_CONSUMER_ID, 0)
            .success
    );
    assert!(
        handler
            .handle_terminal_attach("quiet", TERMINAL_CONSUMER_ID, 0)
            .success
    );

    let events = handler.drain_terminal_events();
    assert!(events.iter().any(|event| {
        matches!(
            event,
            TerminalEvent::Output {
                session_id,
                consumer_id: _,
                sequence: 1,
                data,
            }
                if session_id == "busy" && data.len() == 16
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            TerminalEvent::Output {
                session_id,
                consumer_id: _,
                sequence: 1,
                data,
            }
                if session_id == "quiet" && data == "b"
        )
    }));
    mark_output_events_delivered(&mut handler, &events);

    let notifier = handler.terminal_event_notifier();
    tokio::time::timeout(Duration::from_millis(50), notifier.notified())
        .await
        .expect("bounded draining should schedule the remaining busy output");
    assert!(handler.drain_terminal_events().iter().any(|event| {
        matches!(
            event,
            TerminalEvent::Output {
                session_id,
                consumer_id: _,
                sequence: 2,
                data,
            }
                if session_id == "busy" && data == "aaaa"
        )
    }));
}

#[tokio::test]
async fn terminal_event_drain_preserves_continuous_large_output() {
    let chunk = vec![b'x'; 4096];
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from(vec![chunk; 64]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-large-output"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );
    let notifier = handler.terminal_event_notifier();
    tokio::time::timeout(Duration::from_millis(50), notifier.notified())
        .await
        .expect("attaching should wake the terminal event loop");

    let mut output_len = 0;
    for cycle in 0..4 {
        if cycle > 0 {
            tokio::time::timeout(Duration::from_millis(50), notifier.notified())
                .await
                .expect("bounded draining should continue until all output is consumed");
        }
        let events = handler.drain_terminal_events();
        for event in &events {
            if let TerminalEvent::Output { data, .. } = event {
                output_len += data.len();
            }
        }
        mark_output_events_delivered(&mut handler, &events);
    }

    assert_eq!(output_len, 64 * 4096);
}

#[test]
fn terminal_reconnect_replays_only_output_after_last_acknowledged_sequence() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"one".to_vec()]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-replay"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );

    let initial = handler.drain_terminal_events();
    assert_eq!(
        initial,
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 1,
            data: "one".to_owned(),
        }]
    );
    mark_output_events_delivered(&mut handler, &initial);
    push_terminal_output(&terminal, b"two".to_vec());
    let second = handler.drain_terminal_events();
    assert_eq!(
        second,
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 2,
            data: "two".to_owned(),
        }]
    );
    mark_output_events_delivered(&mut handler, &second);
    assert!(
        handler
            .handle_terminal_ack("terminal-1", TERMINAL_CONSUMER_ID, 1)
            .success
    );

    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 1)
            .success
    );
    assert_eq!(
        handler.drain_terminal_events(),
        vec![TerminalEvent::Output {
            session_id: "terminal-1".to_owned(),
            consumer_id: Some(TERMINAL_CONSUMER_ID.to_owned()),
            sequence: 2,
            data: "two".to_owned(),
        }]
    );
}

#[test]
fn terminal_rejects_unavailable_replay_and_unsent_acknowledgement() {
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from([b"one".to_vec()]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-invalid-sequence"), &terminal);
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );
    let events = handler.drain_terminal_events();
    mark_output_events_delivered(&mut handler, &events);
    assert!(
        handler
            .handle_terminal_ack("terminal-1", TERMINAL_CONSUMER_ID, 1)
            .success
    );

    let stale_attach = handler.handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0);
    assert!(!stale_attach.success);
    assert_eq!(
        stale_attach.error.as_deref(),
        Some("Terminal replay history is no longer available")
    );
    let future_ack = handler.handle_terminal_ack("terminal-1", TERMINAL_CONSUMER_ID, 2);
    assert!(!future_ack.success);
    assert_eq!(
        future_ack.error.as_deref(),
        Some("Terminal output sequence has not been sent")
    );
}

#[tokio::test]
async fn terminal_acknowledgement_resumes_pty_drain_below_low_watermark() {
    let chunk = vec![b'x'; 8 * 1024];
    let terminal = Arc::new(Mutex::new(RecordingTerminal {
        output: VecDeque::from(vec![chunk; 50]),
        ..RecordingTerminal::default()
    }));
    let mut handler = terminal_handler(temp_root("terminal-backpressure"), &terminal);
    let notifier = handler.terminal_event_notifier();
    assert!(
        handler
            .handle_terminal_attach("terminal-1", TERMINAL_CONSUMER_ID, 0)
            .success
    );
    tokio::time::timeout(Duration::from_millis(50), notifier.notified())
        .await
        .unwrap();

    for cycle in 0..3 {
        let events = handler.drain_terminal_events();
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events.first(),
            Some(TerminalEvent::Output { sequence, data, .. })
                if *sequence == cycle + 1 && data.len() == 128 * 1024
        ));
        mark_output_events_delivered(&mut handler, &events);
        if cycle < 2 {
            tokio::time::timeout(Duration::from_millis(50), notifier.notified())
                .await
                .unwrap();
        }
    }

    assert_eq!(terminal.lock().unwrap().output.len(), 2);
    assert!(handler.drain_terminal_events().is_empty());

    assert!(
        handler
            .handle_terminal_ack("terminal-1", TERMINAL_CONSUMER_ID, 2)
            .success
    );
    tokio::time::timeout(Duration::from_millis(50), notifier.notified())
        .await
        .expect("ACK below the low watermark should resume PTY draining");

    let resumed = handler.drain_terminal_events();
    assert_eq!(resumed.len(), 1);
    assert!(matches!(
        resumed.first(),
        Some(TerminalEvent::Output { sequence: 4, data, .. }) if data.len() == 16 * 1024
    ));
    assert!(terminal.lock().unwrap().output.is_empty());
}

#[test]
fn start_code_server_session_returns_gateway_url() {
    let root = temp_root("code-server");
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler = LocalSessionHandler::new(
        "http://localhost:17888",
        true,
        18080,
        root.clone(),
        pty_manager,
    );

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::CodeServer,
        session_id: "code-1".to_owned(),
        project_id: 123,
        path: root.display().to_string(),
        access_token: "secret".to_owned(),
        rows: None,
        cols: None,
        create_if_missing: false,
        ttl_seconds: None,
    });

    assert!(result.success);
    assert!(result.url.starts_with("http://localhost:17888/s/code-1/?"));
    assert!(result.url.contains("token=secret"));
    assert!(result.url.contains(&format!(
        "folder={}",
        wegent_executor::local::session::form_urlencode(root.to_str().unwrap())
    )));
    let session = handler.sessions.get("code-1").unwrap();
    assert_eq!(session.session_type, SessionType::CodeServer);
    assert!(session.terminal.is_none());
    assert_eq!(session.port, 18080);
}

#[test]
fn empty_session_path_uses_and_creates_configured_workspace_root() {
    let root = temp_root("default-session-workspace").join("workspace");
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler = LocalSessionHandler::new(
        "http://localhost:17888",
        true,
        18080,
        root.clone(),
        pty_manager,
    );

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::CodeServer,
        session_id: "code-default-root".to_owned(),
        project_id: 0,
        path: String::new(),
        access_token: "secret".to_owned(),
        rows: None,
        cols: None,
        create_if_missing: true,
        ttl_seconds: None,
    });

    assert!(result.success);
    assert!(root.is_dir());
    assert_eq!(result.path.as_deref(), Some(root.as_path()));
}

#[test]
fn disabled_session_gateway_rejects_code_server_session() {
    let root = temp_root("disabled-code-server");
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler = LocalSessionHandler::new(
        "http://localhost:17888",
        false,
        18080,
        root.clone(),
        pty_manager,
    );

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::CodeServer,
        session_id: "code-1".to_owned(),
        project_id: 123,
        path: root.display().to_string(),
        access_token: "secret".to_owned(),
        rows: None,
        cols: None,
        create_if_missing: false,
        ttl_seconds: None,
    });

    assert!(!result.success);
    assert!(result
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("Session gateway is disabled"));
    assert!(!handler.sessions.contains_key("code-1"));
}

#[test]
fn disabled_code_server_capability_rejects_session_before_creating_path() {
    let root = temp_root("code-server-capability-disabled");
    let missing = root.join("missing");
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler =
        LocalSessionHandler::new("http://localhost:17888", true, 18080, root, pty_manager)
            .with_interactive_sessions(false, true);

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::CodeServer,
        session_id: "code-disabled".to_owned(),
        project_id: 123,
        path: missing.display().to_string(),
        access_token: "secret".to_owned(),
        rows: None,
        cols: None,
        create_if_missing: true,
        ttl_seconds: None,
    });

    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Code-server sessions are disabled on this device")
    );
    assert!(!missing.exists());
    assert!(!handler.sessions.contains_key("code-disabled"));
}

#[test]
fn disabled_terminal_capability_rejects_session_before_spawning_pty() {
    let root = temp_root("terminal-capability-disabled");
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler = LocalSessionHandler::new(
        "http://localhost:17888",
        true,
        18080,
        root.clone(),
        pty_manager.clone(),
    )
    .with_interactive_sessions(true, false);

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::Terminal,
        session_id: "terminal-disabled".to_owned(),
        project_id: 123,
        path: root.display().to_string(),
        access_token: "secret".to_owned(),
        rows: None,
        cols: None,
        create_if_missing: false,
        ttl_seconds: None,
    });

    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Terminal sessions are disabled on this device")
    );
    assert!(pty_manager.spawned.lock().unwrap().is_empty());
    assert!(!handler.sessions.contains_key("terminal-disabled"));
}

#[test]
fn start_session_rejects_missing_project_path() {
    let root = temp_root("missing-project-root");
    let missing = root.join("missing");
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler =
        LocalSessionHandler::new("http://localhost:17888", true, 18080, root, pty_manager);

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::Terminal,
        session_id: "terminal-1".to_owned(),
        project_id: 123,
        path: missing.display().to_string(),
        access_token: "secret".to_owned(),
        rows: None,
        cols: None,
        create_if_missing: false,
        ttl_seconds: None,
    });

    assert!(!result.success);
    assert!(result
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("does not exist"));
}

#[test]
fn start_session_rejects_project_path_outside_allowed_workspace_roots() {
    let root = temp_root("allowed-project-root");
    let outside = temp_root("outside-project-root");
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler =
        LocalSessionHandler::new("http://localhost:17888", true, 18080, root, pty_manager);

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::CodeServer,
        session_id: "code-outside".to_owned(),
        project_id: 123,
        path: outside.display().to_string(),
        access_token: "secret".to_owned(),
        rows: None,
        cols: None,
        create_if_missing: false,
        ttl_seconds: None,
    });

    assert!(!result.success);
    assert_eq!(
        result.error.as_deref(),
        Some("Project path is outside allowed workspace roots")
    );
}

#[test]
fn start_session_allows_explicit_workspace_environment_root() {
    let _lock = env_lock();
    let root = temp_root("default-project-root");
    let allowed_root = temp_root("explicit-project-root");
    let project = allowed_root.join("wegent");
    fs::create_dir_all(&project).unwrap();
    let _workspace_roots = EnvGuard::set(
        "WEGENT_WORKSPACE_ROOTS",
        allowed_root.to_str().expect("workspace root must be UTF-8"),
    );
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler =
        LocalSessionHandler::new("http://localhost:17888", true, 18080, root, pty_manager);

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::CodeServer,
        session_id: "code-explicit-root".to_owned(),
        project_id: 123,
        path: project.display().to_string(),
        access_token: "secret".to_owned(),
        rows: None,
        cols: None,
        create_if_missing: false,
        ttl_seconds: None,
    });

    assert!(result.success, "{:?}", result.error);
    assert_eq!(result.path.as_deref(), Some(project.as_path()));
}

#[test]
fn start_session_allows_saved_codex_project_roots() {
    let _lock = env_lock();
    let root = temp_root("configured-project-root");
    let saved_project = temp_root("saved-codex-project");
    let codex_home = temp_root("saved-codex-home");
    fs::write(
        codex_home.join(".codex-global-state.json"),
        serde_json::json!({
            "electron-saved-workspace-roots": [saved_project.display().to_string()],
            "project-order": [saved_project.display().to_string()],
        })
        .to_string(),
    )
    .unwrap();
    let _codex_home = EnvGuard::set("CODEX_HOME", codex_home.to_str().unwrap());
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler =
        LocalSessionHandler::new("http://localhost:17888", true, 18080, root, pty_manager);

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::CodeServer,
        session_id: "code-saved-project".to_owned(),
        project_id: 123,
        path: saved_project.display().to_string(),
        access_token: "secret".to_owned(),
        rows: None,
        cols: None,
        create_if_missing: false,
        ttl_seconds: None,
    });

    assert!(result.success, "{:?}", result.error);
    assert_eq!(result.path.as_deref(), Some(saved_project.as_path()));
}

#[test]
fn start_session_resolves_relative_default_path() {
    let _lock = env_lock();
    let root = temp_root("relative-project");
    let _shell = EnvGuard::set("SHELL", "/bin/bash");
    let pty_manager = Arc::new(RecordingPtyManager::new(Arc::new(Mutex::new(
        RecordingTerminal::default(),
    ))));
    let mut handler = LocalSessionHandler::new(
        "http://localhost:17888",
        true,
        18080,
        root.clone(),
        pty_manager.clone(),
    );

    let result = handler.handle_start_session(SessionStartRequest {
        session_type: SessionType::Terminal,
        session_id: "terminal-17".to_owned(),
        project_id: 17,
        path: "project17".to_owned(),
        access_token: "secret".to_owned(),
        rows: None,
        cols: None,
        create_if_missing: true,
        ttl_seconds: None,
    });

    let expected_path = root.join("project17");
    assert!(result.success);
    assert!(expected_path.is_dir());
    assert_eq!(pty_manager.spawned.lock().unwrap()[0].cwd, expected_path);
}

fn terminal_handler(
    root: PathBuf,
    terminal: &Arc<Mutex<RecordingTerminal>>,
) -> LocalSessionHandler {
    let mut handler = LocalSessionHandler::new(
        "http://localhost:17888",
        true,
        18080,
        root,
        Arc::new(RecordingPtyManager::new(Arc::clone(terminal))),
    );
    handler.sessions.insert(
        "terminal-1".to_owned(),
        LocalSession::terminal(
            "terminal-1",
            "secret",
            123,
            PathBuf::from("/workspace"),
            Box::new(SharedTerminal(Arc::clone(terminal))),
            9999999999,
        ),
    );
    handler
}

fn code_session(session_id: &str) -> LocalSession {
    LocalSession::code_server(
        session_id,
        "secret",
        123,
        PathBuf::from("/workspace"),
        45678,
        9999999999,
    )
}

#[derive(Default)]
struct RecordingLoginClient {
    posts: Vec<(String, String)>,
}

impl CodeServerLoginClient for RecordingLoginClient {
    fn post_login(&mut self, url: &str, password: &str) -> Result<u16, String> {
        self.posts.push((url.to_owned(), password.to_owned()));
        Ok(302)
    }
}

struct RecordingPtyManager {
    spawned: Mutex<Vec<PtySpawnRequest>>,
    terminal: Arc<Mutex<RecordingTerminal>>,
}

impl RecordingPtyManager {
    fn new(terminal: Arc<Mutex<RecordingTerminal>>) -> Self {
        Self {
            spawned: Mutex::new(Vec::new()),
            terminal,
        }
    }
}

impl SessionPtyManager for RecordingPtyManager {
    fn is_available(&self) -> bool {
        true
    }

    fn spawn(&self, request: PtySpawnRequest) -> Result<Box<dyn TerminalPty>, String> {
        self.spawned.lock().unwrap().push(request);
        Ok(Box::new(SharedTerminal(Arc::clone(&self.terminal))))
    }
}

#[derive(Default)]
struct RecordingTerminal {
    output: VecDeque<Vec<u8>>,
    exit_code: Option<u32>,
    output_open: bool,
    event_notifier: Option<Arc<Notify>>,
    writes: Vec<Vec<u8>>,
    resizes: Vec<(u16, u16)>,
    terminated: bool,
    closed: bool,
    fail_write: bool,
    fail_resize: bool,
}

struct SharedTerminal(Arc<Mutex<RecordingTerminal>>);

impl TerminalPty for SharedTerminal {
    fn pid(&self) -> u32 {
        1234
    }

    fn fd(&self) -> Option<i32> {
        Some(56)
    }

    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let mut terminal = self.0.lock().unwrap();
        if terminal.fail_write {
            return Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "closed",
            ));
        }
        terminal.writes.push(data.to_vec());
        Ok(data.len())
    }

    fn read_available(&mut self, _timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
        Ok(self.0.lock().unwrap().output.pop_front())
    }

    fn set_event_notifier(&mut self, notifier: Arc<Notify>) {
        self.0.lock().unwrap().event_notifier = Some(notifier);
    }

    fn output_closed(&self) -> bool {
        !self.0.lock().unwrap().output_open
    }

    fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        let mut terminal = self.0.lock().unwrap();
        if terminal.fail_resize {
            return Err("closed".to_owned());
        }
        terminal.resizes.push((rows, cols));
        Ok(())
    }

    fn poll(&mut self) -> std::io::Result<Option<u32>> {
        Ok(self.0.lock().unwrap().exit_code)
    }

    fn terminate(&mut self, _force: bool) {
        self.0.lock().unwrap().terminated = true;
    }

    fn close(&mut self) {
        self.0.lock().unwrap().closed = true;
    }
}

fn push_terminal_output(terminal: &Arc<Mutex<RecordingTerminal>>, output: Vec<u8>) {
    let notifier = {
        let mut terminal = terminal.lock().unwrap();
        terminal.output.push_back(output);
        terminal.event_notifier.clone()
    };
    notifier
        .expect("terminal event notifier must be configured before output")
        .notify_one();
}

fn mark_output_events_delivered(handler: &mut LocalSessionHandler, events: &[TerminalEvent]) {
    for event in events {
        if let TerminalEvent::Output {
            session_id,
            consumer_id,
            sequence,
            ..
        } = event
        {
            assert!(handler
                .begin_terminal_output_delivery(session_id, consumer_id.as_deref(), *sequence)
                .unwrap());
        }
    }
}

fn temp_root(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "wegent-local-session-{label}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

async fn fake_code_server_login() -> impl IntoResponse {
    (
        StatusCode::FOUND,
        [
            (header::LOCATION, "/"),
            (
                header::SET_COOKIE,
                "code-server-session=fake; Path=/; HttpOnly",
            ),
        ],
        "",
    )
}

async fn fake_code_server_login_without_cookie() -> impl IntoResponse {
    (StatusCode::FOUND, [(header::LOCATION, "/")], "")
}

async fn fake_code_server_health(headers: HeaderMap, uri: Uri) -> String {
    format!(
        "cookie={};uri={uri}",
        headers
            .get(header::COOKIE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
    )
}

async fn fake_code_server_websocket(
    headers: HeaderMap,
    websocket_upgrade: WebSocketUpgrade,
) -> Response {
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    websocket_upgrade
        .protocols(["vscode"])
        .on_upgrade(move |mut socket| async move {
            let _ = socket
                .send(AxumMessage::Text(format!("cookie={cookie}").into()))
                .await;
            if let Some(Ok(AxumMessage::Text(message))) = socket.recv().await {
                let _ = socket
                    .send(AxumMessage::Text(format!("echo:{message}").into()))
                    .await;
            }
        })
        .into_response()
}
