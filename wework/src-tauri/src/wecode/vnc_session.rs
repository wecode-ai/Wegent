use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;

const DEFAULT_SESSION_TTL: Duration = Duration::from_secs(120);
const EXTERNAL_BRIDGE_ADDR: &str = "127.0.0.1:0";
const EXTERNAL_BRIDGE_ADDR_ENV: &str = "WEWORK_VNC_EXTERNAL_BRIDGE_ADDR";
const EXTERNAL_BRIDGE_MAX_CONNECTIONS: usize = 32;
const EXTERNAL_BRIDGE_MAX_REQUEST_BYTES: usize = 16 * 1024;
const EXTERNAL_BRIDGE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const INVALID_SESSION_ID: &str = "Invalid VNC session id";
const INVALID_WEBSOCKET_URL: &str = "Invalid VNC WebSocket URL";
const INVALID_BEARER_TOKEN: &str = "Invalid VNC bearer token";
const ACTIVE_SESSION_ID: &str = "VNC session id is already active";
const MISSING_SESSION: &str = "VNC session is missing or expired";
const UNAVAILABLE_STATE: &str = "VNC session state is unavailable";
const EXTERNAL_BRIDGE_UNAVAILABLE: &str = "VNC external bridge is unavailable";
const VNC_HTML_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../wecode/features/vnc/assets/vnc.html"
));
const VNC_RFB_BYTES: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../wecode/features/vnc/assets/novnc/rfb.min.js"
));

pub struct VncSessionState {
    registry: Mutex<VncSessionRegistry>,
}

impl Default for VncSessionState {
    fn default() -> Self {
        Self {
            registry: Mutex::new(VncSessionRegistry::with_ttl(DEFAULT_SESSION_TTL)),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncSessionConfig {
    ws_url: String,
    token: String,
}

struct StoredVncSession {
    config: VncSessionConfig,
    expires_at: Instant,
}

struct VncSessionRegistry {
    sessions: HashMap<String, StoredVncSession>,
    ttl: Duration,
}

struct ExternalVncResponse {
    status: &'static str,
    content_type: &'static str,
    body: Vec<u8>,
}

struct ExternalVncConnectionLimiter {
    active: Arc<AtomicUsize>,
    limit: usize,
}

struct ExternalVncConnectionPermit {
    active: Arc<AtomicUsize>,
}

impl ExternalVncConnectionLimiter {
    fn new(limit: usize) -> Self {
        Self {
            active: Arc::new(AtomicUsize::new(0)),
            limit,
        }
    }

    fn try_acquire(&self) -> Option<ExternalVncConnectionPermit> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < self.limit).then_some(active + 1)
            })
            .ok()?;
        Some(ExternalVncConnectionPermit {
            active: self.active.clone(),
        })
    }
}

impl Drop for ExternalVncConnectionPermit {
    fn drop(&mut self) {
        let previous = self.active.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0);
    }
}

impl VncSessionRegistry {
    fn with_ttl(ttl: Duration) -> Self {
        Self {
            sessions: HashMap::new(),
            ttl,
        }
    }

    fn prepare(
        &mut self,
        session_id: &str,
        ws_url: &str,
        token: &str,
        now: Instant,
    ) -> Result<(), String> {
        validate_session_id(session_id)?;
        validate_bearer_token(token)?;
        validate_websocket_url(ws_url, token)?;
        self.remove_expired(now);
        let config = VncSessionConfig {
            ws_url: ws_url.to_string(),
            token: token.to_string(),
        };
        if let Some(session) = self.sessions.get(session_id) {
            return (session.config == config)
                .then_some(())
                .ok_or_else(|| ACTIVE_SESSION_ID.to_string());
        }
        self.sessions.insert(
            session_id.to_string(),
            StoredVncSession {
                config,
                expires_at: now + self.ttl,
            },
        );
        Ok(())
    }

    fn get(&mut self, session_id: &str, now: Instant) -> Result<VncSessionConfig, String> {
        validate_session_id(session_id)?;
        self.remove_expired(now);
        self.sessions
            .get(session_id)
            .map(|session| session.config.clone())
            .ok_or_else(|| MISSING_SESSION.to_string())
    }

    fn remove_expired(&mut self, now: Instant) {
        self.sessions.retain(|_, session| session.expires_at > now);
    }
}

fn external_vnc_response(
    status: &'static str,
    content_type: &'static str,
    body: impl Into<Vec<u8>>,
) -> ExternalVncResponse {
    ExternalVncResponse {
        status,
        content_type,
        body: body.into(),
    }
}

fn external_vnc_error(status: &'static str, message: &str) -> ExternalVncResponse {
    let body = serde_json::to_vec(&serde_json::json!({ "error": message }))
        .unwrap_or_else(|_| b"{\"error\":\"VNC external bridge error\"}".to_vec());
    external_vnc_response(status, "application/json", body)
}

fn route_external_vnc_request(
    method: &str,
    request_target: &str,
    registry: &mut VncSessionRegistry,
    now: Instant,
) -> ExternalVncResponse {
    if method != "GET" {
        return external_vnc_error("405 Method Not Allowed", "Method not allowed");
    }

    let path = request_target.split('?').next().unwrap_or("/");
    match path {
        "/" | "/vnc.html" => external_vnc_response(
            "200 OK",
            "text/html; charset=utf-8",
            VNC_HTML_BYTES.to_vec(),
        ),
        "/novnc/rfb.min.js" => external_vnc_response(
            "200 OK",
            "application/javascript; charset=utf-8",
            VNC_RFB_BYTES.to_vec(),
        ),
        _ => {
            let Some(session_id) = path.strip_prefix("/session/") else {
                return external_vnc_error("404 Not Found", "Not found");
            };
            if session_id.is_empty() || session_id.contains('/') {
                return external_vnc_error("404 Not Found", MISSING_SESSION);
            }
            match registry.get(session_id, now) {
                Ok(config) => match serde_json::to_vec(&config) {
                    Ok(body) => external_vnc_response("200 OK", "application/json", body),
                    Err(_) => {
                        external_vnc_error("500 Internal Server Error", EXTERNAL_BRIDGE_UNAVAILABLE)
                    }
                },
                Err(_) => external_vnc_error("404 Not Found", MISSING_SESSION),
            }
        }
    }
}

fn write_external_vnc_response<W: Write>(
    writer: &mut W,
    response: &ExternalVncResponse,
) -> Result<(), String> {
    write!(
        writer,
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nCross-Origin-Resource-Policy: same-origin\r\nContent-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'\r\n\r\n",
        response.status,
        response.content_type,
        response.body.len()
    )
    .map_err(|error| format!("Failed to write VNC bridge headers: {error}"))?;
    writer
        .write_all(&response.body)
        .map_err(|error| format!("Failed to write VNC bridge body: {error}"))
}

fn read_external_vnc_request_with_timeout(
    stream: &mut TcpStream,
    timeout: Duration,
) -> Result<(String, String, String), String> {
    stream
        .set_write_timeout(Some(EXTERNAL_BRIDGE_TIMEOUT))
        .map_err(|error| format!("Failed to configure VNC bridge write timeout: {error}"))?;

    let started_at = Instant::now();
    let mut request = Vec::new();
    let mut chunk = [0_u8; 2048];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let remaining = timeout
            .checked_sub(started_at.elapsed())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| "VNC bridge request timed out".to_string())?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|error| format!("Failed to configure VNC bridge read timeout: {error}"))?;
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("Failed to read VNC bridge request: {error}"))?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.len() > EXTERNAL_BRIDGE_MAX_REQUEST_BYTES {
            return Err("VNC bridge request is too large".to_string());
        }
    }
    if !request.windows(4).any(|window| window == b"\r\n\r\n") {
        return Err("VNC bridge request headers are incomplete".to_string());
    }

    let request = std::str::from_utf8(&request)
        .map_err(|_| "VNC bridge request is not valid UTF-8".to_string())?;
    let mut lines = request.lines();
    let mut request_line = lines
        .next()
        .ok_or_else(|| "VNC bridge request line is missing".to_string())?
        .split_whitespace();
    let method = request_line
        .next()
        .ok_or_else(|| "VNC bridge method is missing".to_string())?;
    let target = request_line
        .next()
        .ok_or_else(|| "VNC bridge target is missing".to_string())?;
    let host = lines
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("host")
                .then(|| value.trim().to_string())
        })
        .ok_or_else(|| "VNC bridge host is missing".to_string())?;
    Ok((method.to_string(), target.to_string(), host))
}

fn read_external_vnc_request(stream: &mut TcpStream) -> Result<(String, String, String), String> {
    read_external_vnc_request_with_timeout(stream, EXTERNAL_BRIDGE_TIMEOUT)
}

fn is_valid_external_vnc_request(
    listening_addr: SocketAddr,
    request_target: &str,
    host: &str,
) -> bool {
    host == listening_addr.to_string() && request_target.starts_with('/')
}

fn handle_external_vnc_connection(
    app: &tauri::AppHandle,
    listening_addr: SocketAddr,
    mut stream: TcpStream,
) -> Result<(), String> {
    let (method, target, host) = read_external_vnc_request(&mut stream)?;
    let response = if !is_valid_external_vnc_request(listening_addr, &target, &host) {
        external_vnc_error("400 Bad Request", "Invalid VNC bridge request")
    } else {
        let state = app.state::<VncSessionState>();
        let mut registry = state
            .registry
            .lock()
            .map_err(|_| UNAVAILABLE_STATE.to_string())?;
        route_external_vnc_request(&method, &target, &mut registry, Instant::now())
    };
    write_external_vnc_response(&mut stream, &response)
}

pub fn start_vnc_external_bridge(app: tauri::AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(EXTERNAL_BRIDGE_ADDR)
        .map_err(|error| format!("Failed to bind VNC external bridge: {error}"))?;
    let listening_addr = listener
        .local_addr()
        .map_err(|error| format!("Failed to read VNC external bridge address: {error}"))?;
    env::set_var(EXTERNAL_BRIDGE_ADDR_ENV, listening_addr.to_string());
    let connection_limiter = ExternalVncConnectionLimiter::new(EXTERNAL_BRIDGE_MAX_CONNECTIONS);
    thread::Builder::new()
        .name("vnc-external-bridge".to_string())
        .spawn(move || {
            log::info!("VNC external bridge listening on {listening_addr}");
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else {
                    log::warn!("VNC external bridge failed to accept a connection");
                    continue;
                };
                let Some(connection_permit) = connection_limiter.try_acquire() else {
                    let _ = stream.set_write_timeout(Some(EXTERNAL_BRIDGE_TIMEOUT));
                    if let Err(error) = write_external_vnc_response(
                        &mut stream,
                        &external_vnc_error("503 Service Unavailable", "Bridge is busy"),
                    ) {
                        log::warn!("Failed to reject a busy VNC bridge connection: {error}");
                    }
                    continue;
                };
                let connection_app = app.clone();
                if let Err(error) = thread::Builder::new()
                    .name("vnc-external-connection".to_string())
                    .spawn(move || {
                        let _connection_permit = connection_permit;
                        if let Err(error) =
                            handle_external_vnc_connection(&connection_app, listening_addr, stream)
                        {
                            log::warn!("VNC external bridge request failed: {error}");
                        }
                    })
                {
                    log::warn!("Failed to start a VNC bridge connection handler: {error}");
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Failed to start VNC external bridge: {error}"))
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    let bytes = session_id.as_bytes();
    let is_uuid_v4 = bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
        && bytes[14] == b'4'
        && matches!(bytes[19].to_ascii_lowercase(), b'8' | b'9' | b'a' | b'b');
    is_uuid_v4
        .then_some(())
        .ok_or_else(|| INVALID_SESSION_ID.to_string())
}

fn validate_websocket_url(ws_url: &str, token: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(ws_url).map_err(|_| INVALID_WEBSOCKET_URL.to_string())?;
    let has_explicit_authority = ws_url
        .split_once("://")
        .is_some_and(|(_, authority)| !authority.is_empty() && !authority.starts_with('/'));
    let has_forbidden_query = parsed.query_pairs().any(|(key, value)| {
        let key = key.to_ascii_lowercase();
        key.contains("token") || key == "authorization" || value == token
    });
    let is_valid = has_explicit_authority
        && matches!(parsed.scheme(), "ws" | "wss")
        && parsed.host_str().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.fragment().is_none()
        && !has_forbidden_query;
    is_valid
        .then_some(())
        .ok_or_else(|| INVALID_WEBSOCKET_URL.to_string())
}

fn validate_bearer_token(token: &str) -> Result<(), String> {
    let is_valid = !token.is_empty()
        && token.len() <= MAX_TOKEN_BYTES
        && token.bytes().all(|byte| byte.is_ascii_graphic());
    is_valid
        .then_some(())
        .ok_or_else(|| INVALID_BEARER_TOKEN.to_string())
}

#[tauri::command]
pub fn prepare_vnc_session(
    state: tauri::State<'_, VncSessionState>,
    session_id: String,
    ws_url: String,
    token: String,
) -> Result<(), String> {
    state
        .registry
        .lock()
        .map_err(|_| UNAVAILABLE_STATE.to_string())?
        .prepare(&session_id, &ws_url, &token, Instant::now())
}

#[tauri::command]
pub fn get_vnc_session_config(
    state: tauri::State<'_, VncSessionState>,
    session_id: String,
) -> Result<VncSessionConfig, String> {
    state
        .registry
        .lock()
        .map_err(|_| UNAVAILABLE_STATE.to_string())?
        .get(&session_id, Instant::now())
}

#[tauri::command]
pub fn get_vnc_external_bridge_url() -> Result<String, String> {
    let value =
        env::var(EXTERNAL_BRIDGE_ADDR_ENV).map_err(|_| EXTERNAL_BRIDGE_UNAVAILABLE.to_string())?;
    let address = value
        .parse::<SocketAddr>()
        .map_err(|_| EXTERNAL_BRIDGE_UNAVAILABLE.to_string())?;
    if !address.ip().is_loopback() {
        return Err(EXTERNAL_BRIDGE_UNAVAILABLE.to_string());
    }
    Ok(format!("http://{address}"))
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    const SESSION_ID: &str = "123e4567-e89b-42d3-a456-426614174000";
    const WS_URL: &str = "wss://cloud.example.com/vnc-proxy/device-1?quality=high";
    const TOKEN: &str = "bearer-token_123";
    const VNC_HTML: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../wecode/features/vnc/assets/vnc.html"
    ));

    #[test]
    fn stores_and_returns_a_valid_session_without_changing_its_expiry() {
        let started_at = Instant::now();
        let mut registry = VncSessionRegistry::with_ttl(Duration::from_secs(60));

        registry
            .prepare(SESSION_ID, WS_URL, TOKEN, started_at)
            .expect("valid VNC session");

        let first = registry
            .get(SESSION_ID, started_at + Duration::from_secs(10))
            .expect("stored VNC session");
        let second = registry
            .get(SESSION_ID, started_at + Duration::from_secs(59))
            .expect("session expiry must not extend on read");

        assert_eq!(first.ws_url, WS_URL);
        assert_eq!(first.token, TOKEN);
        assert_eq!(second, first);
    }

    #[test]
    fn removes_expired_sessions() {
        let started_at = Instant::now();
        let mut registry = VncSessionRegistry::with_ttl(Duration::from_secs(60));
        registry
            .prepare(SESSION_ID, WS_URL, TOKEN, started_at)
            .expect("valid VNC session");

        let error = registry
            .get(SESSION_ID, started_at + Duration::from_secs(60))
            .expect_err("expired VNC session must not be returned");

        assert_eq!(error, "VNC session is missing or expired");
        assert!(registry.sessions.is_empty());
    }

    #[test]
    fn rejects_invalid_session_ids() {
        let mut registry = VncSessionRegistry::with_ttl(Duration::from_secs(60));

        for session_id in [
            "",
            "not-a-uuid",
            "123e4567-e89b-12d3-a456-426614174000",
            "123e4567-e89b-42d3-c456-426614174000",
        ] {
            let error = registry
                .prepare(session_id, WS_URL, TOKEN, Instant::now())
                .expect_err("invalid session id must be rejected");
            assert_eq!(error, "Invalid VNC session id");
        }
    }

    #[test]
    fn rejects_websocket_urls_that_can_expose_credentials() {
        let mut registry = VncSessionRegistry::with_ttl(Duration::from_secs(60));

        for ws_url in [
            "https://cloud.example.com/vnc-proxy/device-1",
            "wss:///missing-host",
            "wss://user:password@cloud.example.com/vnc-proxy/device-1",
            "wss://cloud.example.com/vnc-proxy/device-1#token",
            "wss://cloud.example.com/vnc-proxy/device-1?token=secret",
            "wss://cloud.example.com/vnc-proxy/device-1?access_token=secret",
            "wss://cloud.example.com/vnc-proxy/device-1?authToken=secret",
            "wss://cloud.example.com/vnc-proxy/device-1?Authorization=secret",
            "wss://cloud.example.com/vnc-proxy/device-1?auth=bearer-token_123",
        ] {
            assert_eq!(
                registry.prepare(SESSION_ID, ws_url, TOKEN, Instant::now()),
                Err("Invalid VNC WebSocket URL".to_string()),
                "unsafe WebSocket URL must be rejected: {ws_url}"
            );
        }
    }

    #[test]
    fn rejects_empty_or_non_bearer_tokens() {
        let mut registry = VncSessionRegistry::with_ttl(Duration::from_secs(60));

        for token in ["", " leading", "trailing ", "line\nbreak", "令牌"] {
            let error = registry
                .prepare(SESSION_ID, WS_URL, token, Instant::now())
                .expect_err("invalid bearer token must be rejected");
            assert_eq!(error, "Invalid VNC bearer token");
        }
    }

    #[test]
    fn rejects_duplicate_live_session_ids() {
        let started_at = Instant::now();
        let mut registry = VncSessionRegistry::with_ttl(Duration::from_secs(60));
        registry
            .prepare(SESSION_ID, WS_URL, TOKEN, started_at)
            .expect("valid VNC session");

        let error = registry
            .prepare(
                SESSION_ID,
                "wss://cloud.example.com/vnc-proxy/device-2",
                "different-token",
                started_at + Duration::from_secs(1),
            )
            .expect_err("live session ids must not be replaced");

        assert_eq!(error, "VNC session id is already active");
        assert_eq!(
            registry
                .get(SESSION_ID, started_at + Duration::from_secs(2))
                .expect("original session")
                .token,
            TOKEN
        );
    }

    #[test]
    fn accepts_an_idempotent_prepare_retry() {
        let started_at = Instant::now();
        let mut registry = VncSessionRegistry::with_ttl(Duration::from_secs(60));
        registry
            .prepare(SESSION_ID, WS_URL, TOKEN, started_at)
            .expect("valid VNC session");

        registry
            .prepare(
                SESSION_ID,
                WS_URL,
                TOKEN,
                started_at + Duration::from_secs(1),
            )
            .expect("same prepare request must be idempotent");

        assert!(registry
            .get(SESSION_ID, started_at + Duration::from_secs(59))
            .is_ok());
        assert_eq!(
            registry.get(SESSION_ID, started_at + Duration::from_secs(60)),
            Err("VNC session is missing or expired".to_string())
        );
    }

    #[test]
    fn serializes_the_ipc_response_with_camel_case_fields() {
        let config = VncSessionConfig {
            ws_url: WS_URL.to_string(),
            token: TOKEN.to_string(),
        };

        assert_eq!(
            serde_json::to_value(config).expect("serialized config"),
            serde_json::json!({ "wsUrl": WS_URL, "token": TOKEN })
        );
    }

    #[test]
    fn external_bridge_serves_the_viewer_and_live_session_without_cors() {
        let started_at = Instant::now();
        let mut registry = VncSessionRegistry::with_ttl(Duration::from_secs(60));
        registry
            .prepare(SESSION_ID, WS_URL, TOKEN, started_at)
            .expect("valid VNC session");

        let page = route_external_vnc_request(
            "GET",
            &format!("/vnc.html?sessionId={SESSION_ID}&sandboxId=sandbox-1"),
            &mut registry,
            started_at,
        );
        assert_eq!(page.status, "200 OK");
        assert_eq!(page.content_type, "text/html; charset=utf-8");
        assert!(String::from_utf8_lossy(&page.body).contains("vnc-container"));

        let session = route_external_vnc_request(
            "GET",
            &format!("/session/{SESSION_ID}"),
            &mut registry,
            started_at,
        );
        assert_eq!(session.status, "200 OK");
        assert_eq!(session.content_type, "application/json");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&session.body)
                .expect("serialized VNC session"),
            serde_json::json!({ "wsUrl": WS_URL, "token": TOKEN })
        );

        let mut response_bytes = Vec::new();
        write_external_vnc_response(&mut response_bytes, &session)
            .expect("HTTP response is writable");
        let response = String::from_utf8(response_bytes).expect("UTF-8 HTTP response");
        assert!(response.contains("Cache-Control: no-store"));
        assert!(response.contains("Referrer-Policy: no-referrer"));
        assert!(response.contains("X-Frame-Options: DENY"));
        assert!(response.contains("frame-ancestors 'none'"));
        assert!(!response.contains("Access-Control-Allow-Origin"));
    }

    #[test]
    fn external_bridge_rejects_unknown_or_expired_session_requests() {
        let started_at = Instant::now();
        let mut registry = VncSessionRegistry::with_ttl(Duration::from_secs(60));
        registry
            .prepare(SESSION_ID, WS_URL, TOKEN, started_at)
            .expect("valid VNC session");
        let expired_target = format!("/session/{SESSION_ID}");

        for (method, target, now) in [
            ("POST", "/vnc.html", started_at),
            (
                "GET",
                "/session/123e4567-e89b-42d3-a456-426614174001",
                started_at,
            ),
            (
                "GET",
                expired_target.as_str(),
                started_at + Duration::from_secs(60),
            ),
        ] {
            let response = route_external_vnc_request(method, target, &mut registry, now);
            assert_ne!(response.status, "200 OK");
            assert!(!String::from_utf8_lossy(&response.body).contains(TOKEN));
        }
    }

    #[test]
    fn external_bridge_requires_the_exact_loopback_host() {
        let listening_addr = "127.0.0.1:43123"
            .parse::<SocketAddr>()
            .expect("valid loopback address");

        assert!(is_valid_external_vnc_request(
            listening_addr,
            "/vnc.html",
            "127.0.0.1:43123"
        ));
        for host in [
            "localhost:43123",
            "127.0.0.1:43124",
            "127.0.0.1:43123.example.com",
        ] {
            assert!(!is_valid_external_vnc_request(
                listening_addr,
                "/vnc.html",
                host
            ));
        }
        assert!(!is_valid_external_vnc_request(
            listening_addr,
            "http://127.0.0.1:43123/vnc.html",
            "127.0.0.1:43123"
        ));
    }

    #[test]
    fn external_bridge_limits_concurrent_connection_handlers() {
        let limiter = ExternalVncConnectionLimiter::new(2);
        let first = limiter.try_acquire().expect("first permit");
        let second = limiter.try_acquire().expect("second permit");

        assert!(limiter.try_acquire().is_none());
        drop(first);
        assert!(limiter.try_acquire().is_some());
        drop(second);
    }

    #[test]
    fn external_bridge_request_read_uses_an_absolute_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let listening_addr = listener.local_addr().expect("listener address");
        let mut client = TcpStream::connect(listening_addr).expect("loopback client");
        let writer = thread::spawn(move || {
            for byte in b"GET /vnc.html HTTP/1.1\r\nHost: 127.0.0.1:43123\r\n\r\n" {
                if client.write_all(&[*byte]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        let (mut server, _) = listener.accept().expect("accepted connection");
        let started_at = Instant::now();

        let result = read_external_vnc_request_with_timeout(&mut server, Duration::from_millis(80));

        assert!(result.is_err());
        assert!(started_at.elapsed() < Duration::from_millis(250));
        drop(server);
        writer.join().expect("writer exits");
    }

    #[test]
    fn vnc_page_fetches_credentials_over_ipc_instead_of_the_page_url() {
        let html = VNC_HTML;

        assert!(html.contains("params.get('sessionId')"));
        assert!(html.contains("get_vnc_session_config"));
        assert!(html.contains("url.searchParams.set('token', config.token)"));
        assert!(html.contains("key.toLowerCase().includes('token')"));
        assert!(html.contains("value === config.token"));
        assert!(!html.contains("params.get('wsUrl')"));
        assert!(!html.contains("params.get('token')"));
    }

    #[test]
    fn vnc_page_does_not_render_errors_with_html_injection_sinks() {
        let html = VNC_HTML;

        assert!(html.contains("errorText.textContent = msg"));
        assert!(!html.contains(".innerHTML"));
        assert!(!html.contains("onclick="));
    }
}
