// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tokio::sync::Notify;

use crate::local::{command::build_env, pty::UnixPtyProcess};

const DEFAULT_SESSION_TTL_SECONDS: u64 = 60 * 60;
const SESSION_PROBE_QUERY_KEY: &str = "__wegent_probe";
const TERMINAL_REPLAY_MAX_BYTES: usize = 512 * 1024;
const TERMINAL_REPLAY_HIGH_WATERMARK_BYTES: usize = 384 * 1024;
const TERMINAL_REPLAY_LOW_WATERMARK_BYTES: usize = 128 * 1024;
const MAX_UTF8_PENDING_BYTES: usize = 3;

static TERMINAL_OUTPUT_BATCHES_TOTAL: AtomicU64 = AtomicU64::new(0);
static TERMINAL_OUTPUT_BYTES_TOTAL: AtomicU64 = AtomicU64::new(0);
static TERMINAL_REPLAYED_BATCHES_TOTAL: AtomicU64 = AtomicU64::new(0);
static TERMINAL_REPLAY_BYTES: AtomicU64 = AtomicU64::new(0);
static TERMINAL_ACK_LAG_BYTES: AtomicU64 = AtomicU64::new(0);
static TERMINAL_BACKPRESSURED_SESSIONS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TerminalMetricsSnapshot {
    pub output_batches_total: u64,
    pub output_bytes_total: u64,
    pub replayed_batches_total: u64,
    pub replay_bytes: u64,
    pub ack_lag_bytes: u64,
    pub backpressured_sessions: u64,
}

pub(crate) fn terminal_metrics_snapshot() -> TerminalMetricsSnapshot {
    TerminalMetricsSnapshot {
        output_batches_total: TERMINAL_OUTPUT_BATCHES_TOTAL.load(Ordering::Relaxed),
        output_bytes_total: TERMINAL_OUTPUT_BYTES_TOTAL.load(Ordering::Relaxed),
        replayed_batches_total: TERMINAL_REPLAYED_BATCHES_TOTAL.load(Ordering::Relaxed),
        replay_bytes: TERMINAL_REPLAY_BYTES.load(Ordering::Relaxed),
        ack_lag_bytes: TERMINAL_ACK_LAG_BYTES.load(Ordering::Relaxed),
        backpressured_sessions: TERMINAL_BACKPRESSURED_SESSIONS.load(Ordering::Relaxed),
    }
}

fn subtract_metric(metric: &AtomicU64, value: usize) {
    let value = value as u64;
    let _ = metric.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
        Some(current.saturating_sub(value))
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionType {
    Terminal,
    CodeServer,
}

pub trait TerminalPty: Send {
    fn pid(&self) -> u32;
    fn fd(&self) -> Option<i32>;
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize>;
    fn read_available(&mut self, timeout: Duration) -> std::io::Result<Option<Vec<u8>>>;
    fn set_event_notifier(&mut self, _notifier: Arc<Notify>) {}
    fn output_closed(&self) -> bool {
        true
    }
    fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String>;
    fn poll(&mut self) -> std::io::Result<Option<u32>>;
    fn terminate(&mut self, force: bool);
    fn close(&mut self);
}

impl TerminalPty for UnixPtyProcess {
    fn pid(&self) -> u32 {
        self.pid()
    }

    fn fd(&self) -> Option<i32> {
        #[cfg(unix)]
        {
            self.fd()
        }
        #[cfg(not(unix))]
        {
            None
        }
    }

    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.write(data)
    }

    fn read_available(&mut self, timeout: Duration) -> std::io::Result<Option<Vec<u8>>> {
        #[cfg(unix)]
        {
            self.read_available(timeout)
        }
        #[cfg(not(unix))]
        {
            let _ = timeout;
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "PTY output polling is not supported on this platform",
            ))
        }
    }

    fn set_event_notifier(&mut self, notifier: Arc<Notify>) {
        self.set_event_notifier(notifier);
    }

    fn output_closed(&self) -> bool {
        self.output_closed()
    }

    fn resize(&mut self, rows: u16, cols: u16) -> Result<(), String> {
        self.resize(rows, cols)
    }

    fn poll(&mut self) -> std::io::Result<Option<u32>> {
        self.poll()
    }

    fn terminate(&mut self, force: bool) {
        self.terminate(force);
    }

    fn close(&mut self) {
        self.close();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtySpawnRequest {
    pub cmd: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
    pub rows: u16,
    pub cols: u16,
}

pub trait SessionPtyManager: Send + Sync {
    fn is_available(&self) -> bool;
    fn spawn(&self, request: PtySpawnRequest) -> Result<Box<dyn TerminalPty>, String>;
}

#[derive(Debug, Default)]
pub struct UnixSessionPtyManager;

impl SessionPtyManager for UnixSessionPtyManager {
    fn is_available(&self) -> bool {
        crate::local::pty::UnixPtyManager::new().is_available()
    }

    fn spawn(&self, request: PtySpawnRequest) -> Result<Box<dyn TerminalPty>, String> {
        let argv = request.cmd.iter().map(String::as_str).collect::<Vec<_>>();
        let env = request
            .env
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect::<Vec<_>>();
        crate::local::pty::UnixPtyManager::new()
            .spawn(&argv, Some(&request.cwd), &env, request.rows, request.cols)
            .map(|process| Box::new(process) as Box<dyn TerminalPty>)
    }
}

pub struct LocalSession {
    pub session_id: String,
    pub session_type: SessionType,
    pub access_token: String,
    pub project_id: u64,
    pub path: PathBuf,
    pub port: u16,
    pub terminal: Option<Box<dyn TerminalPty>>,
    pub terminal_attached: bool,
    terminal_consumer_id: Option<String>,
    terminal_next_sequence: u64,
    terminal_acked_sequence: u64,
    terminal_last_sent_sequence: u64,
    terminal_highest_sent_sequence: u64,
    terminal_replay: VecDeque<TerminalOutputRecord>,
    terminal_replay_bytes: usize,
    terminal_ack_lag_bytes: usize,
    terminal_backpressured: bool,
    terminal_utf8_decoder: TerminalUtf8Decoder,
    terminal_exit: Option<TerminalExitRecord>,
    pub expires_at: u64,
    pub code_server_authenticated: bool,
}

#[derive(Debug, Default)]
struct TerminalUtf8Decoder {
    pending: [u8; MAX_UTF8_PENDING_BYTES],
    pending_len: usize,
}

impl TerminalUtf8Decoder {
    fn decode(&mut self, input: Vec<u8>) -> String {
        if input.is_empty() {
            return String::new();
        }
        let bytes = if self.pending_len == 0 {
            input
        } else {
            let mut combined = Vec::with_capacity(self.pending_len + input.len());
            combined.extend_from_slice(&self.pending[..self.pending_len]);
            combined.extend_from_slice(&input);
            self.pending_len = 0;
            combined
        };
        match String::from_utf8(bytes) {
            Ok(data) => data,
            Err(error) => self.decode_lossy_prefix(&error.into_bytes()),
        }
    }

    fn finish(&mut self) -> String {
        if self.pending_len == 0 {
            return String::new();
        }
        self.pending_len = 0;
        "\u{fffd}".to_owned()
    }

    fn decode_lossy_prefix(&mut self, bytes: &[u8]) -> String {
        let mut decoded = String::with_capacity(bytes.len());
        let mut remaining = bytes;
        while !remaining.is_empty() {
            match std::str::from_utf8(remaining) {
                Ok(valid) => {
                    decoded.push_str(valid);
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    decoded.push_str(
                        std::str::from_utf8(&remaining[..valid_up_to])
                            .expect("UTF-8 validator reported an invalid valid prefix"),
                    );
                    match error.error_len() {
                        Some(invalid_len) => {
                            decoded.push('\u{fffd}');
                            remaining = &remaining[valid_up_to + invalid_len..];
                        }
                        None => {
                            let incomplete = &remaining[valid_up_to..];
                            debug_assert!(incomplete.len() <= MAX_UTF8_PENDING_BYTES);
                            self.pending[..incomplete.len()].copy_from_slice(incomplete);
                            self.pending_len = incomplete.len();
                            break;
                        }
                    }
                }
            }
        }
        decoded
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalOutputRecord {
    sequence: u64,
    data: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalExitRecord {
    exit_code: Option<u32>,
    error: Option<String>,
}

impl LocalSession {
    pub fn code_server(
        session_id: &str,
        access_token: &str,
        project_id: u64,
        path: PathBuf,
        port: u16,
        expires_at: u64,
    ) -> Self {
        Self {
            session_id: session_id.to_owned(),
            session_type: SessionType::CodeServer,
            access_token: access_token.to_owned(),
            project_id,
            path,
            port,
            terminal: None,
            terminal_attached: false,
            terminal_consumer_id: None,
            terminal_next_sequence: 1,
            terminal_acked_sequence: 0,
            terminal_last_sent_sequence: 0,
            terminal_highest_sent_sequence: 0,
            terminal_replay: VecDeque::new(),
            terminal_replay_bytes: 0,
            terminal_ack_lag_bytes: 0,
            terminal_backpressured: false,
            terminal_utf8_decoder: TerminalUtf8Decoder::default(),
            terminal_exit: None,
            expires_at,
            code_server_authenticated: false,
        }
    }

    pub fn terminal(
        session_id: &str,
        access_token: &str,
        project_id: u64,
        path: PathBuf,
        terminal: Box<dyn TerminalPty>,
        expires_at: u64,
    ) -> Self {
        Self {
            session_id: session_id.to_owned(),
            session_type: SessionType::Terminal,
            access_token: access_token.to_owned(),
            project_id,
            path,
            port: 0,
            terminal: Some(terminal),
            terminal_attached: false,
            terminal_consumer_id: None,
            terminal_next_sequence: 1,
            terminal_acked_sequence: 0,
            terminal_last_sent_sequence: 0,
            terminal_highest_sent_sequence: 0,
            terminal_replay: VecDeque::new(),
            terminal_replay_bytes: 0,
            terminal_ack_lag_bytes: 0,
            terminal_backpressured: false,
            terminal_utf8_decoder: TerminalUtf8Decoder::default(),
            terminal_exit: None,
            expires_at,
            code_server_authenticated: false,
        }
    }

    fn attach_terminal(
        &mut self,
        consumer_id: &str,
        last_acked_sequence: u64,
    ) -> Result<(), String> {
        let was_attached = self.terminal_attached;
        let latest_sequence = self.terminal_next_sequence.saturating_sub(1);
        if last_acked_sequence < self.terminal_acked_sequence {
            return Err("Terminal replay history is no longer available".to_owned());
        }
        if last_acked_sequence > self.terminal_highest_sent_sequence
            || last_acked_sequence > latest_sequence
        {
            return Err("last_acked_sequence exceeds sent terminal output".to_owned());
        }
        self.acknowledge_terminal_output(last_acked_sequence)?;
        subtract_metric(&TERMINAL_ACK_LAG_BYTES, self.terminal_ack_lag_bytes);
        self.terminal_ack_lag_bytes = 0;
        self.terminal_last_sent_sequence = last_acked_sequence;
        self.terminal_attached = true;
        self.terminal_consumer_id = Some(consumer_id.to_owned());
        if was_attached {
            let replayed_batches = self
                .terminal_replay
                .iter()
                .filter(|record| record.sequence > last_acked_sequence)
                .count() as u64;
            TERMINAL_REPLAYED_BATCHES_TOTAL.fetch_add(replayed_batches, Ordering::Relaxed);
        }
        Ok(())
    }

    fn acknowledge_terminal_output(&mut self, sequence: u64) -> Result<bool, String> {
        if sequence <= self.terminal_acked_sequence {
            return Ok(false);
        }
        if sequence > self.terminal_highest_sent_sequence {
            return Err("Terminal output sequence has not been sent".to_owned());
        }
        let mut acknowledged_bytes = 0;
        while self
            .terminal_replay
            .front()
            .is_some_and(|record| record.sequence <= sequence)
        {
            if let Some(record) = self.terminal_replay.pop_front() {
                acknowledged_bytes += record.data.len();
                self.terminal_replay_bytes =
                    self.terminal_replay_bytes.saturating_sub(record.data.len());
            }
        }
        self.terminal_ack_lag_bytes = self
            .terminal_ack_lag_bytes
            .saturating_sub(acknowledged_bytes);
        subtract_metric(&TERMINAL_REPLAY_BYTES, acknowledged_bytes);
        subtract_metric(&TERMINAL_ACK_LAG_BYTES, acknowledged_bytes);
        self.terminal_acked_sequence = sequence;
        let resumed = self.terminal_backpressured
            && self.terminal_replay_bytes <= TERMINAL_REPLAY_LOW_WATERMARK_BYTES;
        if resumed {
            self.terminal_backpressured = false;
            subtract_metric(&TERMINAL_BACKPRESSURED_SESSIONS, 1);
        }
        Ok(resumed)
    }

    fn unsent_terminal_output(&self, limit: usize) -> Vec<TerminalEvent> {
        self.terminal_replay
            .iter()
            .filter(|record| record.sequence > self.terminal_last_sent_sequence)
            .take(limit)
            .map(|record| TerminalEvent::Output {
                session_id: self.session_id.clone(),
                consumer_id: self
                    .terminal_consumer_id
                    .clone()
                    .expect("attached terminal consumer"),
                sequence: record.sequence,
                data: record.data.clone(),
            })
            .collect()
    }

    fn record_terminal_output(&mut self, data: String) -> Result<TerminalEvent, String> {
        if self.terminal_replay_bytes.saturating_add(data.len()) > TERMINAL_REPLAY_MAX_BYTES {
            return Err("Terminal output exceeded the bounded replay capacity".to_owned());
        }
        let sequence = self.terminal_next_sequence;
        self.terminal_next_sequence = self
            .terminal_next_sequence
            .checked_add(1)
            .ok_or_else(|| "Terminal output sequence exhausted".to_owned())?;
        self.terminal_replay_bytes += data.len();
        TERMINAL_OUTPUT_BATCHES_TOTAL.fetch_add(1, Ordering::Relaxed);
        TERMINAL_OUTPUT_BYTES_TOTAL.fetch_add(data.len() as u64, Ordering::Relaxed);
        TERMINAL_REPLAY_BYTES.fetch_add(data.len() as u64, Ordering::Relaxed);
        self.terminal_replay.push_back(TerminalOutputRecord {
            sequence,
            data: data.clone(),
        });
        if !self.terminal_backpressured
            && self.terminal_replay_bytes >= TERMINAL_REPLAY_HIGH_WATERMARK_BYTES
        {
            self.terminal_backpressured = true;
            TERMINAL_BACKPRESSURED_SESSIONS.fetch_add(1, Ordering::Relaxed);
        }
        Ok(TerminalEvent::Output {
            session_id: self.session_id.clone(),
            consumer_id: self
                .terminal_consumer_id
                .clone()
                .expect("attached terminal consumer"),
            sequence,
            data,
        })
    }

    fn begin_terminal_output_delivery(&mut self, sequence: u64) -> Result<(), String> {
        let expected_sequence = self.terminal_last_sent_sequence.saturating_add(1);
        let Some(record) = self
            .terminal_replay
            .iter()
            .find(|record| record.sequence == sequence)
        else {
            return Err("Terminal output delivery sequence is out of order".to_owned());
        };
        if sequence != expected_sequence {
            return Err("Terminal output delivery sequence is out of order".to_owned());
        }
        self.terminal_ack_lag_bytes += record.data.len();
        TERMINAL_ACK_LAG_BYTES.fetch_add(record.data.len() as u64, Ordering::Relaxed);
        self.terminal_last_sent_sequence = sequence;
        self.terminal_highest_sent_sequence = self.terminal_highest_sent_sequence.max(sequence);
        Ok(())
    }

    fn require_terminal_consumer(&self, consumer_id: &str) -> Result<(), String> {
        if !self.terminal_attached || self.terminal_consumer_id.as_deref() != Some(consumer_id) {
            return Err("Terminal consumer is no longer active".to_owned());
        }
        Ok(())
    }
}

impl Drop for LocalSession {
    fn drop(&mut self) {
        subtract_metric(&TERMINAL_REPLAY_BYTES, self.terminal_replay_bytes);
        subtract_metric(&TERMINAL_ACK_LAG_BYTES, self.terminal_ack_lag_bytes);
        if self.terminal_backpressured {
            subtract_metric(&TERMINAL_BACKPRESSURED_SESSIONS, 1);
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct GatewayRequest {
    pub path: String,
    pub query_string: String,
    pub query: HashMap<String, String>,
    pub headers: HashMap<String, String>,
    pub cookies: HashMap<String, String>,
}

impl GatewayRequest {
    pub fn new(path: &str) -> Self {
        Self {
            path: path.to_owned(),
            ..Self::default()
        }
    }

    pub fn with_header(mut self, key: &str, value: &str) -> Self {
        self.headers.insert(key.to_owned(), value.to_owned());
        self
    }

    pub fn with_query(mut self, key: &str, value: &str) -> Self {
        if !self.query_string.is_empty() {
            self.query_string.push('&');
        }
        self.query_string.push_str(&form_urlencode(key));
        self.query_string.push('=');
        self.query_string.push_str(&form_urlencode(value));
        self.query.insert(key.to_owned(), value.to_owned());
        self
    }

    pub fn with_query_string(mut self, query_string: &str) -> Self {
        self.query_string = query_string.to_owned();
        self.query = parse_query_items(query_string).into_iter().collect();
        self
    }

    pub fn with_cookie(mut self, key: &str, value: &str) -> Self {
        self.cookies.insert(key.to_owned(), value.to_owned());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GatewayResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GatewaySessionSnapshot {
    pub session_id: String,
    pub session_type: SessionType,
    pub access_token: String,
    pub port: u16,
    pub expires_at: u64,
}

pub trait CodeServerLoginClient {
    fn post_login(&mut self, url: &str, password: &str) -> Result<u16, String>;
}

pub struct SessionGateway {
    pub sessions: HashMap<String, LocalSession>,
}

impl SessionGateway {
    pub fn new(sessions: HashMap<String, LocalSession>) -> Self {
        Self { sessions }
    }

    pub fn websocket_protocols(&self, request: &GatewayRequest) -> Vec<String> {
        header_value(&request.headers, "Sec-WebSocket-Protocol")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|protocol| !protocol.is_empty())
            .map(str::to_owned)
            .collect()
    }

    pub fn proxy_headers(
        &self,
        request: &GatewayRequest,
        session: Option<&LocalSession>,
    ) -> HashMap<String, String> {
        let excluded = [
            "connection",
            "cookie",
            "host",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "accept-encoding",
            "te",
            "trailers",
            "transfer-encoding",
            "upgrade",
            "sec-websocket-protocol",
            "sec-websocket-key",
            "sec-websocket-version",
            "sec-websocket-extensions",
        ];
        let mut headers = request
            .headers
            .iter()
            .filter(|(key, _)| {
                !excluded
                    .iter()
                    .any(|excluded| key.eq_ignore_ascii_case(excluded))
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<HashMap<_, _>>();
        headers.insert("Accept-Encoding".to_owned(), "identity".to_owned());
        if session.is_some_and(|session| session.session_type == SessionType::CodeServer) {
            if let Some(origin_key) = headers
                .keys()
                .find(|key| key.eq_ignore_ascii_case("Origin"))
                .cloned()
            {
                let port = session.expect("checked above").port;
                headers.insert(origin_key, format!("http://127.0.0.1:{port}"));
            }
        }
        headers
    }

    pub fn build_upstream_url(
        &self,
        request: &GatewayRequest,
        session: &LocalSession,
        scheme: &str,
    ) -> String {
        let path = self.upstream_path(request, session);
        let query_items = parse_query_items(&request.query_string)
            .into_iter()
            .filter(|(key, _)| {
                key != "token" && key != "session_id" && key != SESSION_PROBE_QUERY_KEY
            })
            .collect::<Vec<_>>();
        let query = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(query_items)
            .finish();
        let suffix = if query.is_empty() {
            path
        } else {
            format!("{path}?{query}")
        };
        format!("{scheme}://127.0.0.1:{}{suffix}", session.port)
    }

    pub fn should_redirect_authenticated_request(
        &self,
        request: &GatewayRequest,
        session: &LocalSession,
    ) -> bool {
        session.session_type == SessionType::CodeServer
            && request.query.contains_key("token")
            && request.query.get("embed").map(String::as_str) != Some("1")
            && header_value(&request.headers, "Upgrade")
                .map(|value| !value.eq_ignore_ascii_case("websocket"))
                .unwrap_or(true)
    }

    pub fn is_authorized(&self, request: &GatewayRequest, session: &LocalSession) -> bool {
        let terminal_prefix = format!("/s/{}", session.session_id);
        if session.session_type == SessionType::Terminal
            && (request.path == terminal_prefix
                || request.path.starts_with(&format!("{terminal_prefix}/")))
        {
            return true;
        }
        request.query.get("token").or_else(|| {
            request
                .cookies
                .get(&self.token_cookie_name(&session.session_id))
        }) == Some(&session.access_token)
    }

    pub fn handle_request(&mut self, request: &GatewayRequest) -> GatewayResponse {
        let Some(session) = self.resolve_session(request) else {
            return session_error_response(
                404,
                "This terminal or IDE session is no longer available. Return to Wegent and open it again from the workspace tools.",
            );
        };
        if !self.is_authorized(request, session) {
            return session_error_response(
                401,
                "This session link is missing valid authorization. Return to Wegent and open the tool again.",
            );
        }
        if epoch_seconds() > session.expires_at {
            return session_error_response(
                410,
                "This terminal or IDE session has expired. Return to Wegent and open it again from the workspace tools.",
            );
        }
        if session.session_type == SessionType::Terminal {
            return session_error_response(
                404,
                "Terminal sessions are available through Wegent's authenticated terminal channel.",
            );
        }
        if request
            .query
            .get(SESSION_PROBE_QUERY_KEY)
            .map(String::as_str)
            == Some("1")
        {
            return GatewayResponse {
                status: 204,
                headers: session_probe_headers(),
                body: Vec::new(),
            };
        }
        GatewayResponse {
            status: 502,
            headers: session_probe_headers(),
            body: b"Proxying is handled by the runtime gateway".to_vec(),
        }
    }

    pub fn ensure_code_server_login(
        &mut self,
        session: &mut LocalSession,
        client: &mut dyn CodeServerLoginClient,
    ) -> Result<(), String> {
        if session.code_server_authenticated {
            return Ok(());
        }
        let password = code_server_password();
        let url = format!("http://127.0.0.1:{}/login", session.port);
        let status = client.post_login(&url, &password)?;
        if status != 302 && status != 303 {
            return Err("Failed to authenticate code-server".to_owned());
        }
        session.code_server_authenticated = true;
        Ok(())
    }

    fn upstream_path(&self, request: &GatewayRequest, session: &LocalSession) -> String {
        if session.session_type != SessionType::CodeServer {
            return request.path.clone();
        }
        let prefix = format!("/s/{}", session.session_id);
        if request.path == prefix {
            return "/".to_owned();
        }
        if request.path.starts_with(&format!("{prefix}/")) {
            return request.path[prefix.len()..].to_owned();
        }
        request.path.clone()
    }

    fn resolve_session(&self, request: &GatewayRequest) -> Option<&LocalSession> {
        let path_parts = request
            .path
            .split('/')
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>();
        if path_parts.len() >= 2 && path_parts[0] == "s" {
            return self.sessions.get(path_parts[1]);
        }
        request
            .query
            .get("session_id")
            .or_else(|| request.cookies.get("wegent_active_session"))
            .and_then(|session_id| self.sessions.get(session_id))
    }

    fn token_cookie_name(&self, session_id: &str) -> String {
        format!("wegent_session_{session_id}")
    }
}

pub struct LocalSessionHandler {
    pub gateway_enabled: bool,
    pub code_server_enabled: bool,
    pub terminal_enabled: bool,
    pub public_base_url: String,
    pub code_server_port: u16,
    pub workspace_root: PathBuf,
    pub sessions: HashMap<String, LocalSession>,
    pty_manager: Arc<dyn SessionPtyManager>,
    terminal_event_notifier: Arc<Notify>,
    terminal_drain_offset: usize,
}

const MAX_TERMINAL_READS_PER_DRAIN: usize = 16;
const MAX_TERMINAL_SESSIONS_PER_DRAIN: usize = 32;

impl LocalSessionHandler {
    pub fn new(
        public_base_url: &str,
        gateway_enabled: bool,
        code_server_port: u16,
        workspace_root: PathBuf,
        pty_manager: Arc<dyn SessionPtyManager>,
    ) -> Self {
        Self {
            gateway_enabled,
            code_server_enabled: true,
            terminal_enabled: true,
            public_base_url: public_base_url.trim_end_matches('/').to_owned(),
            code_server_port,
            workspace_root,
            sessions: HashMap::new(),
            pty_manager,
            terminal_event_notifier: Arc::new(Notify::new()),
            terminal_drain_offset: 0,
        }
    }

    pub fn with_interactive_sessions(
        mut self,
        code_server_enabled: bool,
        terminal_enabled: bool,
    ) -> Self {
        self.code_server_enabled = code_server_enabled;
        self.terminal_enabled = terminal_enabled;
        self
    }

    pub fn terminal_event_notifier(&self) -> Arc<Notify> {
        Arc::clone(&self.terminal_event_notifier)
    }

    pub fn handle_start_session(&mut self, request: SessionStartRequest) -> SessionResult {
        match request.session_type {
            SessionType::CodeServer if !self.code_server_enabled => {
                return SessionResult::error("Code-server sessions are disabled on this device");
            }
            SessionType::Terminal if !self.terminal_enabled => {
                return SessionResult::error("Terminal sessions are disabled on this device");
            }
            _ => {}
        }
        let path = match self.project_path(&request.path, request.create_if_missing) {
            Ok(path) => path,
            Err(error) => return SessionResult::error(error),
        };
        if self.sessions.contains_key(&request.session_id) {
            if let Some(mut existing) = self.sessions.remove(&request.session_id) {
                if let Some(mut terminal) = existing.terminal.take() {
                    terminal.terminate(false);
                    terminal.close();
                }
            }
        }
        match request.session_type {
            SessionType::CodeServer => self.start_code_server_session(request, path),
            SessionType::Terminal => self.start_terminal_session(request, path),
        }
    }

    pub(crate) fn gateway_session(
        &self,
        request: &GatewayRequest,
    ) -> Option<GatewaySessionSnapshot> {
        let session_id = request_session_id(request)?;
        let session = self.sessions.get(&session_id)?;
        Some(GatewaySessionSnapshot {
            session_id: session.session_id.clone(),
            session_type: session.session_type,
            access_token: session.access_token.clone(),
            port: session.port,
            expires_at: session.expires_at,
        })
    }

    pub fn handle_terminal_input(
        &mut self,
        session_id: &str,
        consumer_id: &str,
        data: &str,
    ) -> SessionResult {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::error("Terminal session not found");
        };
        if let Err(error) = session.require_terminal_consumer(consumer_id) {
            return SessionResult::error(error);
        }
        let Some(terminal) = session.terminal.as_mut() else {
            return SessionResult::error("Terminal session not found");
        };
        if terminal.write(data.as_bytes()).is_err() {
            return SessionResult::error("Terminal session is not writable");
        }
        SessionResult::success()
    }

    pub fn handle_terminal_attach(
        &mut self,
        session_id: &str,
        consumer_id: &str,
        last_acked_sequence: u64,
    ) -> SessionResult {
        let notifier = Arc::clone(&self.terminal_event_notifier);
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::error("Terminal session not found");
        };
        if let Err(error) = session.attach_terminal(consumer_id, last_acked_sequence) {
            return SessionResult::error(error);
        }
        if let Some(terminal) = session.terminal.as_mut() {
            terminal.set_event_notifier(Arc::clone(&notifier));
        }
        notifier.notify_one();
        SessionResult::success()
    }

    pub fn handle_terminal_ack(
        &mut self,
        session_id: &str,
        consumer_id: &str,
        sequence: u64,
    ) -> SessionResult {
        let notifier = Arc::clone(&self.terminal_event_notifier);
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::error("Terminal session not found");
        };
        if let Err(error) = session.require_terminal_consumer(consumer_id) {
            return SessionResult::error(error);
        }
        let had_replay = !session.terminal_replay.is_empty();
        let resumed = match session.acknowledge_terminal_output(sequence) {
            Ok(resumed) => resumed,
            Err(error) => return SessionResult::error(error),
        };
        if resumed
            || (had_replay && session.terminal_replay.is_empty() && session.terminal_exit.is_some())
        {
            notifier.notify_one();
        }
        SessionResult::success()
    }

    pub fn begin_terminal_output_delivery(
        &mut self,
        session_id: &str,
        consumer_id: &str,
        sequence: u64,
    ) -> Result<bool, String> {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return Ok(false);
        };
        if session.require_terminal_consumer(consumer_id).is_err() {
            self.terminal_event_notifier.notify_one();
            return Ok(false);
        }
        session.begin_terminal_output_delivery(sequence)?;
        Ok(true)
    }

    pub fn retry_terminal_output_delivery(&mut self, session_id: &str, sequence: u64) -> bool {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return false;
        };
        if session.terminal_acked_sequence >= sequence {
            session.terminal_last_sent_sequence = session.terminal_acked_sequence;
            return true;
        }
        let Some(record) = session
            .terminal_replay
            .iter()
            .find(|record| record.sequence == sequence)
        else {
            return true;
        };
        session.terminal_last_sent_sequence = sequence.saturating_sub(1);
        session.terminal_ack_lag_bytes = session
            .terminal_ack_lag_bytes
            .saturating_sub(record.data.len());
        subtract_metric(&TERMINAL_ACK_LAG_BYTES, record.data.len());
        true
    }

    pub fn complete_terminal_exit(
        &mut self,
        session_id: &str,
        consumer_id: &str,
    ) -> Result<(), String> {
        let Some(session) = self.sessions.get(session_id) else {
            return Ok(());
        };
        session.require_terminal_consumer(consumer_id)?;
        if session.session_type != SessionType::Terminal
            || session.terminal_exit.is_none()
            || !session.terminal_replay.is_empty()
        {
            return Err("Terminal exit is not ready for completion".to_owned());
        }
        self.sessions.remove(session_id);
        Ok(())
    }

    pub fn prepare_terminal_reconnect(&mut self) {
        let mut should_notify = false;
        for session in self.sessions.values_mut().filter(|session| {
            session.session_type == SessionType::Terminal && session.terminal_attached
        }) {
            subtract_metric(&TERMINAL_ACK_LAG_BYTES, session.terminal_ack_lag_bytes);
            session.terminal_ack_lag_bytes = 0;
            session.terminal_last_sent_sequence = session.terminal_acked_sequence;
            should_notify |= !session.terminal_replay.is_empty() || session.terminal_exit.is_some();
        }
        if should_notify {
            self.terminal_event_notifier.notify_one();
        }
    }

    pub fn reap_expired_sessions(&mut self) -> usize {
        let now = epoch_seconds();
        let expired = self
            .sessions
            .values()
            .filter(|session| session.expires_at <= now)
            .map(|session| session.session_id.clone())
            .collect::<Vec<_>>();
        for session_id in &expired {
            let _ = self.close_terminal_session(session_id);
        }
        expired.len()
    }

    pub fn handle_terminal_resize(
        &mut self,
        session_id: &str,
        consumer_id: &str,
        rows: u16,
        cols: u16,
    ) -> SessionResult {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::error("Terminal session not found");
        };
        if let Err(error) = session.require_terminal_consumer(consumer_id) {
            return SessionResult::error(error);
        }
        let Some(terminal) = session.terminal.as_mut() else {
            return SessionResult::error("Terminal session not found");
        };
        if terminal.resize(rows.max(1), cols.max(1)).is_err() {
            return SessionResult::error("Terminal session is not resizable");
        }
        SessionResult::success()
    }

    pub fn handle_terminal_close(&mut self, session_id: &str, consumer_id: &str) -> SessionResult {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::success();
        };
        if let Err(error) = session.require_terminal_consumer(consumer_id) {
            return SessionResult::error(error);
        }
        self.close_terminal_session(session_id)
    }

    fn close_terminal_session(&mut self, session_id: &str) -> SessionResult {
        let Some(mut session) = self.sessions.remove(session_id) else {
            return SessionResult::success();
        };
        if let Some(mut terminal) = session.terminal.take() {
            let _ = terminal.poll();
            terminal.terminate(false);
            terminal.close();
        }
        SessionResult::success()
    }

    pub fn drain_terminal_events(&mut self) -> Vec<TerminalEvent> {
        let notifier = Arc::clone(&self.terminal_event_notifier);
        let mut session_ids = self
            .sessions
            .values()
            .filter(|session| {
                session.session_type == SessionType::Terminal && session.terminal_attached
            })
            .map(|session| session.session_id.clone())
            .collect::<Vec<_>>();
        session_ids.sort();
        if session_ids.len() > MAX_TERMINAL_SESSIONS_PER_DRAIN {
            let session_count = session_ids.len();
            let start = self.terminal_drain_offset % session_count;
            session_ids.rotate_left(start);
            session_ids.truncate(MAX_TERMINAL_SESSIONS_PER_DRAIN);
            self.terminal_drain_offset = (start + MAX_TERMINAL_SESSIONS_PER_DRAIN) % session_count;
            notifier.notify_one();
        } else {
            self.terminal_drain_offset = 0;
        }
        let mut events = Vec::new();

        for session_id in session_ids {
            let Some(session) = self.sessions.get_mut(&session_id) else {
                continue;
            };
            let mut session_events = session.unsent_terminal_output(MAX_TERMINAL_READS_PER_DRAIN);
            let mut remaining_capacity =
                MAX_TERMINAL_READS_PER_DRAIN.saturating_sub(session_events.len());
            let unsent_count = session
                .terminal_replay
                .iter()
                .filter(|record| record.sequence > session.terminal_last_sent_sequence)
                .count();
            if unsent_count > 0 {
                if unsent_count > session_events.len() {
                    notifier.notify_one();
                }
                events.extend(session_events);
                continue;
            }

            let mut data = String::new();
            let mut terminal_error = None;
            let mut read_limit_reached = false;

            while remaining_capacity > 0
                && !session.terminal_backpressured
                && session.terminal_replay_bytes.saturating_add(data.len())
                    < TERMINAL_REPLAY_HIGH_WATERMARK_BYTES
            {
                let read_result = match session.terminal.as_mut() {
                    Some(terminal) => terminal.read_available(Duration::ZERO),
                    None => break,
                };
                match read_result {
                    Ok(Some(chunk)) if chunk.is_empty() => {
                        break;
                    }
                    Ok(Some(chunk)) => {
                        data.push_str(&session.terminal_utf8_decoder.decode(chunk));
                        remaining_capacity -= 1;
                        read_limit_reached = remaining_capacity == 0;
                    }
                    Ok(None) => break,
                    Err(error) => {
                        terminal_error = Some(format!("Failed to read terminal output: {error}"));
                        break;
                    }
                }
            }

            if read_limit_reached && !session.terminal_backpressured {
                notifier.notify_one();
            }

            let mut exit_code = None;
            if session.terminal_exit.is_none() {
                let exit_result = session.terminal.as_mut().map(|terminal| {
                    let output_closed = terminal.output_closed();
                    (terminal.poll(), output_closed)
                });
                exit_code = match exit_result {
                    Some((Ok(Some(exit_code)), true)) => Some(exit_code),
                    Some((Ok(_), _)) | None => None,
                    Some((Err(error), _)) => {
                        terminal_error =
                            Some(format!("Failed to poll terminal process status: {error}"));
                        None
                    }
                };
            }

            let terminal_finished = exit_code.is_some() || terminal_error.is_some();
            if terminal_finished {
                data.push_str(&session.terminal_utf8_decoder.finish());
            }
            if !data.is_empty() {
                match session.record_terminal_output(data) {
                    Ok(event) => session_events.push(event),
                    Err(error) => terminal_error = Some(error),
                }
            }

            if session.terminal_exit.is_none() && (exit_code.is_some() || terminal_error.is_some())
            {
                if terminal_error.is_some() {
                    if let Some(terminal) = session.terminal.as_mut() {
                        terminal.terminate(false);
                    }
                }
                if let Some(mut terminal) = session.terminal.take() {
                    terminal.close();
                }
                session.terminal_exit = Some(TerminalExitRecord {
                    exit_code,
                    error: terminal_error,
                });
            }

            events.extend(session_events);
            if session.terminal_replay.is_empty() {
                if let Some(exit) = &session.terminal_exit {
                    events.push(TerminalEvent::Exit {
                        session_id: session_id.clone(),
                        consumer_id: session
                            .terminal_consumer_id
                            .clone()
                            .expect("attached terminal consumer"),
                        exit_code: exit.exit_code,
                        error: exit.error.clone(),
                    });
                }
            }
        }

        events
    }

    fn start_code_server_session(
        &mut self,
        request: SessionStartRequest,
        path: PathBuf,
    ) -> SessionResult {
        if !self.gateway_enabled {
            return SessionResult::error("Session gateway is disabled");
        }
        let expires_at =
            epoch_seconds() + request.ttl_seconds.unwrap_or(DEFAULT_SESSION_TTL_SECONDS);
        let session = LocalSession::code_server(
            &request.session_id,
            &request.access_token,
            request.project_id,
            path.clone(),
            self.code_server_port,
            expires_at,
        );
        self.sessions.insert(request.session_id.clone(), session);
        SessionResult {
            success: true,
            error: None,
            session_id: Some(request.session_id.clone()),
            project_id: Some(request.project_id),
            session_type: Some(SessionType::CodeServer),
            path: Some(path.clone()),
            url: self.build_session_url(
                SessionType::CodeServer,
                &request.session_id,
                &request.access_token,
                Some(&path),
            ),
            transport: None,
        }
    }

    fn start_terminal_session(
        &mut self,
        request: SessionStartRequest,
        path: PathBuf,
    ) -> SessionResult {
        if !self.pty_manager.is_available() {
            return SessionResult::error("PTY is not available on this device");
        }
        let spawn_request = PtySpawnRequest {
            cmd: self.terminal_command(),
            cwd: path.clone(),
            env: build_env(&HashMap::new()),
            rows: request.rows.unwrap_or(24).max(1),
            cols: request.cols.unwrap_or(80).max(1),
        };
        let mut terminal = match self.pty_manager.spawn(spawn_request) {
            Ok(terminal) => terminal,
            Err(error) => return SessionResult::error(error),
        };
        terminal.set_event_notifier(Arc::clone(&self.terminal_event_notifier));
        let expires_at =
            epoch_seconds() + request.ttl_seconds.unwrap_or(DEFAULT_SESSION_TTL_SECONDS);
        let session = LocalSession::terminal(
            &request.session_id,
            &request.access_token,
            request.project_id,
            path.clone(),
            terminal,
            expires_at,
        );
        self.sessions.insert(request.session_id.clone(), session);
        SessionResult {
            success: true,
            error: None,
            session_id: Some(request.session_id),
            project_id: Some(request.project_id),
            session_type: Some(SessionType::Terminal),
            path: Some(path),
            url: String::new(),
            transport: Some("socketio".to_owned()),
        }
    }

    fn project_path(&self, path: &str, create_if_missing: bool) -> Result<PathBuf, String> {
        let requested_path = PathBuf::from(path);
        let project_path = if path.trim().is_empty() {
            self.workspace_root.clone()
        } else if requested_path.is_absolute() {
            requested_path
        } else {
            self.workspace_root.join(requested_path)
        };
        let allowed_roots = self.allowed_workspace_roots(create_if_missing)?;
        let resolved_path = resolve_path_for_boundary_check(&project_path)?;
        require_allowed_workspace_path(&resolved_path, &allowed_roots)?;
        if create_if_missing {
            fs::create_dir_all(&project_path).map_err(|error| error.to_string())?;
        }
        if !project_path.exists() {
            return Err(format!("Project path does not exist: {path}"));
        }
        if !project_path.is_dir() {
            return Err(format!("Project path is not a directory: {path}"));
        }
        let canonical_path = fs::canonicalize(&project_path).map_err(|error| error.to_string())?;
        require_allowed_workspace_path(&canonical_path, &allowed_roots)?;
        Ok(project_path)
    }

    fn allowed_workspace_roots(&self, create_if_missing: bool) -> Result<Vec<PathBuf>, String> {
        if create_if_missing {
            fs::create_dir_all(&self.workspace_root).map_err(|error| error.to_string())?;
        }
        let mut roots = vec![fs::canonicalize(&self.workspace_root)
            .map_err(|error| format!("Invalid workspace root: {error}"))?];
        if let Ok(value) = env::var("WEGENT_WORKSPACE_ROOTS") {
            for raw_root in value.split(if cfg!(windows) { ';' } else { ':' }) {
                let raw_root = raw_root.trim();
                if raw_root.is_empty() {
                    continue;
                }
                let root = fs::canonicalize(raw_root)
                    .map_err(|error| format!("Invalid workspace root: {error}"))?;
                if !roots.contains(&root) {
                    roots.push(root);
                }
            }
        }
        for raw_root in crate::runtime_work::codex_workspace_roots() {
            let Ok(root) = fs::canonicalize(raw_root) else {
                continue;
            };
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
        Ok(roots)
    }

    fn terminal_command(&self) -> Vec<String> {
        #[cfg(windows)]
        {
            vec![std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned())]
        }
        #[cfg(not(windows))]
        {
            vec![std::env::var("SHELL").unwrap_or_else(|_| "bash".to_owned())]
        }
    }

    fn build_session_url(
        &self,
        session_type: SessionType,
        session_id: &str,
        access_token: &str,
        path: Option<&PathBuf>,
    ) -> String {
        let mut query = format!("token={}", form_urlencode(access_token));
        if session_type == SessionType::CodeServer {
            if let Some(path) = path.and_then(|path| path.to_str()) {
                query.push_str("&folder=");
                query.push_str(&form_urlencode(path));
            }
        }
        format!("{}/s/{session_id}/?{query}", self.public_base_url)
    }

    fn terminal_session_mut(&mut self, session_id: &str) -> Option<&mut LocalSession> {
        let session = self.sessions.get_mut(session_id)?;
        (session.session_type == SessionType::Terminal).then_some(session)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    Output {
        session_id: String,
        consumer_id: String,
        sequence: u64,
        data: String,
    },
    Exit {
        session_id: String,
        consumer_id: String,
        exit_code: Option<u32>,
        error: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionStartRequest {
    pub session_type: SessionType,
    pub session_id: String,
    pub project_id: u64,
    pub path: String,
    pub access_token: String,
    pub rows: Option<u16>,
    pub cols: Option<u16>,
    pub create_if_missing: bool,
    pub ttl_seconds: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionResult {
    pub success: bool,
    pub error: Option<String>,
    pub session_id: Option<String>,
    pub project_id: Option<u64>,
    pub session_type: Option<SessionType>,
    pub path: Option<PathBuf>,
    pub url: String,
    pub transport: Option<String>,
}

impl SessionResult {
    pub fn success() -> Self {
        Self {
            success: true,
            error: None,
            session_id: None,
            project_id: None,
            session_type: None,
            path: None,
            url: String::new(),
            transport: None,
        }
    }

    pub fn error(error: impl Into<String>) -> Self {
        Self {
            success: false,
            error: Some(error.into()),
            session_id: None,
            project_id: None,
            session_type: None,
            path: None,
            url: String::new(),
            transport: None,
        }
    }
}

pub fn form_urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            b' ' => "+".to_owned(),
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

fn parse_query_items(query_string: &str) -> Vec<(String, String)> {
    url::form_urlencoded::parse(query_string.as_bytes())
        .into_owned()
        .collect()
}

fn header_value(headers: &HashMap<String, String>, name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

fn session_error_response(status: u16, message: &str) -> GatewayResponse {
    GatewayResponse {
        status,
        headers: session_probe_headers(),
        body: message.as_bytes().to_vec(),
    }
}

fn session_probe_headers() -> HashMap<String, String> {
    HashMap::from([("Access-Control-Allow-Origin".to_owned(), "*".to_owned())])
}

fn code_server_password() -> String {
    std::env::var("CODE_SERVER_PASSWORD")
        .or_else(|_| std::env::var("PASSWORD"))
        .unwrap_or_else(|_| "wegent".to_owned())
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn request_session_id(request: &GatewayRequest) -> Option<String> {
    let path_parts = request
        .path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if path_parts.len() >= 2 && path_parts[0] == "s" {
        return Some(path_parts[1].to_owned());
    }
    request
        .query
        .get("session_id")
        .or_else(|| request.cookies.get("wegent_active_session"))
        .cloned()
}

fn resolve_path_for_boundary_check(path: &Path) -> Result<PathBuf, String> {
    let mut ancestor = path;
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        let name = ancestor
            .file_name()
            .ok_or_else(|| "Project path has no existing ancestor".to_owned())?;
        suffix.push(name.to_owned());
        ancestor = ancestor
            .parent()
            .ok_or_else(|| "Project path has no existing ancestor".to_owned())?;
    }
    let mut resolved = fs::canonicalize(ancestor).map_err(|error| error.to_string())?;
    for component in suffix.iter().rev() {
        resolved.push(component);
    }
    Ok(resolved)
}

fn require_allowed_workspace_path(path: &Path, allowed_roots: &[PathBuf]) -> Result<(), String> {
    if allowed_roots.iter().any(|root| path.starts_with(root)) {
        return Ok(());
    }
    Err("Project path is outside allowed workspace roots".to_owned())
}
