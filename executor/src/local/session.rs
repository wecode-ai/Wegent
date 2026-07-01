// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use crate::local::{command::build_env, pty::UnixPtyProcess};

const DEFAULT_SESSION_TTL_SECONDS: u64 = 60 * 60;
const SESSION_PROBE_QUERY_KEY: &str = "__wegent_probe";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionType {
    Terminal,
    CodeServer,
}

pub trait TerminalPty: Send {
    fn pid(&self) -> u32;
    fn fd(&self) -> Option<i32>;
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize>;
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
    pub expires_at: u64,
    pub code_server_authenticated: bool,
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
            expires_at,
            code_server_authenticated: false,
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
        let query = parse_query_items(&request.query_string)
            .into_iter()
            .filter(|(key, _)| {
                key != "token" && key != "session_id" && key != SESSION_PROBE_QUERY_KEY
            })
            .map(|(key, value)| format!("{}={}", form_urlencode(&key), form_urlencode(&value)))
            .collect::<Vec<_>>()
            .join("&");
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
    pub public_base_url: String,
    pub code_server_port: u16,
    pub workspace_root: PathBuf,
    pub sessions: HashMap<String, LocalSession>,
    pty_manager: Arc<dyn SessionPtyManager>,
}

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
            public_base_url: public_base_url.trim_end_matches('/').to_owned(),
            code_server_port,
            workspace_root,
            sessions: HashMap::new(),
            pty_manager,
        }
    }

    pub fn handle_start_session(&mut self, request: SessionStartRequest) -> SessionResult {
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

    pub fn handle_terminal_input(&mut self, session_id: &str, data: &str) -> SessionResult {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::error("Terminal session not found");
        };
        let Some(terminal) = session.terminal.as_mut() else {
            return SessionResult::error("Terminal session not found");
        };
        if terminal.write(data.as_bytes()).is_err() {
            return SessionResult::error("Terminal session is not writable");
        }
        SessionResult::success()
    }

    pub fn handle_terminal_resize(
        &mut self,
        session_id: &str,
        rows: u16,
        cols: u16,
    ) -> SessionResult {
        let Some(session) = self.terminal_session_mut(session_id) else {
            return SessionResult::error("Terminal session not found");
        };
        let Some(terminal) = session.terminal.as_mut() else {
            return SessionResult::error("Terminal session not found");
        };
        if terminal.resize(rows.max(1), cols.max(1)).is_err() {
            return SessionResult::error("Terminal session is not resizable");
        }
        SessionResult::success()
    }

    pub fn handle_terminal_close(&mut self, session_id: &str) -> SessionResult {
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
        let terminal = match self.pty_manager.spawn(spawn_request) {
            Ok(terminal) => terminal,
            Err(error) => return SessionResult::error(error),
        };
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
        let project_path = PathBuf::from(path);
        let project_path = if project_path.is_absolute() {
            project_path
        } else {
            self.workspace_root.join(project_path)
        };
        if create_if_missing {
            fs::create_dir_all(&project_path).map_err(|error| error.to_string())?;
        }
        if !project_path.exists() {
            return Err(format!("Project path does not exist: {path}"));
        }
        if !project_path.is_dir() {
            return Err(format!("Project path is not a directory: {path}"));
        }
        Ok(project_path)
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
    query_string
        .split('&')
        .filter(|item| !item.is_empty())
        .map(|item| {
            item.split_once('=')
                .map(|(key, value)| (key.to_owned(), value.to_owned()))
                .unwrap_or_else(|| (item.to_owned(), String::new()))
        })
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
