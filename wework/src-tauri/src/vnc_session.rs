use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

const DEFAULT_SESSION_TTL: Duration = Duration::from_secs(120);
const MAX_TOKEN_BYTES: usize = 16 * 1024;
const INVALID_SESSION_ID: &str = "Invalid VNC session id";
const INVALID_WEBSOCKET_URL: &str = "Invalid VNC WebSocket URL";
const INVALID_BEARER_TOKEN: &str = "Invalid VNC bearer token";
const ACTIVE_SESSION_ID: &str = "VNC session id is already active";
const MISSING_SESSION: &str = "VNC session is missing or expired";
const UNAVAILABLE_STATE: &str = "VNC session state is unavailable";

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
