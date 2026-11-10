//! Native-only HTTP sessions are bound to the exact active account profile.
use super::transport::{PluginAuthFuture, PluginAuthTransport};
use crate::{
    agents::backend_url::backend_http_client,
    config::device::ConnectionConfig,
    local::{app_ipc::AppIpcError, backend::SocketIoTransport},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

pub(crate) fn account_scope(connection: &ConnectionConfig) -> String {
    // This is only a local cancellation key, never an authorization decision.
    let identity = connection
        .auth_token
        .split('.')
        .nth(1)
        .and_then(|p| URL_SAFE_NO_PAD.decode(p).ok())
        .and_then(|p| serde_json::from_slice::<Value>(&p).ok())
        .map(|v| json!([v["user_id"], v["sub"]]).to_string())
        .unwrap_or_else(|| format!("{:x}", Sha256::digest(connection.auth_token.as_bytes())));
    format!("{}:{identity}", connection.backend_url)
}

#[derive(Deserialize, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
struct Session {
    backend_url: String,
    account_token: String,
    native_token: String,
    expires_at: i64,
}
#[derive(Default)]
struct State {
    session: Option<Session>,
    socket: Option<SocketIoTransport>,
    remote: bool,
    generation: u64,
    configuration_revision: u64,
}

#[derive(Clone)]
pub(crate) struct LocalAuthContext {
    state: Arc<Mutex<State>>,
    connection: Arc<Mutex<Option<ConnectionConfig>>>,
}
impl LocalAuthContext {
    pub(crate) fn new(connection: Arc<Mutex<Option<ConnectionConfig>>>) -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            connection,
        }
    }
    pub(crate) fn configure(&self, params: Value) -> Result<Value, AppIpcError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Configuration {
            configuration_revision: u64,
            session: Option<Session>,
        }
        let input: Configuration = serde_json::from_value(params).map_err(|_| unavailable())?;
        let mut state = self.state.lock().map_err(|_| unavailable())?;
        if input.configuration_revision <= state.configuration_revision {
            return Err(unavailable());
        }
        let session = if input.session.is_none() {
            None
        } else {
            let mut session = input.session.expect("present session");
            let url = reqwest::Url::parse(&session.backend_url).map_err(|_| unavailable())?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || session.account_token.is_empty()
                || session.native_token.is_empty()
                || session.expires_at <= chrono::Utc::now().timestamp()
            {
                return Err(unavailable());
            }
            session.backend_url = session.backend_url.trim_end_matches('/').into();
            Some(session)
        };
        state.generation += 1;
        state.configuration_revision = input.configuration_revision;
        state.session = session;
        Ok(json!({"enabled":state.session.is_some()}))
    }
    pub(crate) fn socket(&self, socket: Option<SocketIoTransport>, remote: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.socket = socket;
            state.remote = remote;
        }
    }
    pub(crate) fn clear(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.session = None;
            state.socket = None;
            state.generation += 1;
        }
    }
    fn bound(&self, session: &Session) -> bool {
        self.connection
            .lock()
            .ok()
            .and_then(|p| {
                p.as_ref().map(|p| {
                    p.backend_url == session.backend_url && p.auth_token == session.account_token
                })
            })
            .unwrap_or(false)
            && session.expires_at > chrono::Utc::now().timestamp()
    }
}
fn unavailable() -> AppIpcError {
    AppIpcError::new(
        "plugin_auth_backend_unavailable",
        "Plugin account transport is unavailable",
    )
}
impl PluginAuthTransport for LocalAuthContext {
    fn available(&self, registered: bool) -> bool {
        let Ok(state) = self.state.lock() else {
            return false;
        };
        match state.session.as_ref().filter(|_| !state.remote) {
            Some(session) => self.bound(session),
            None => registered && state.socket.is_some(),
        }
    }
    fn exchange<'a>(
        &'a self,
        operation: &'a str,
        payload: Value,
        timeout: Duration,
    ) -> PluginAuthFuture<'a> {
        Box::pin(async move {
            let (session, socket, generation) = {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| "plugin_auth_backend_unavailable".to_string())?;
                (
                    state.session.clone().filter(|_| !state.remote),
                    state.socket.clone(),
                    state.generation,
                )
            };
            let Some(session) = session else {
                let socket = socket.ok_or("plugin_auth_backend_unavailable")?;
                return PluginAuthTransport::exchange(&socket, operation, payload, timeout).await;
            };
            if !self.bound(&session) {
                return Err("plugin_auth_backend_unavailable".into());
            }
            let client = backend_http_client().map_err(|_| "plugin_auth_backend_unavailable")?;
            let mut response=client.post(format!("{}/api/plugins/native-auth/exchange",session.backend_url))
                .json(&json!({"operation":operation,"native_token":session.native_token,"data":payload}))
                .timeout(timeout).send().await.map_err(|_|"plugin_auth_backend_unavailable")?;
            if response
                .content_length()
                .is_some_and(|n| n > 2 * 1024 * 1024)
            {
                return Err("plugin_auth_backend_unavailable".into());
            }
            let status = response.status();
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "plugin_auth_backend_unavailable")?
            {
                if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                    return Err("plugin_auth_backend_unavailable".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| "plugin_auth_backend_unavailable")?;
            if !self.bound(&session)
                || self
                    .state
                    .lock()
                    .map_err(|_| "plugin_auth_backend_unavailable")?
                    .generation
                    != generation
            {
                return Err("plugin_auth_backend_unavailable".into());
            }
            if status.is_success() {
                Ok(value)
            } else {
                Ok(
                    json!({"success":false,"error":value["detail"].as_str().unwrap_or("plugin_auth_exchange_rejected")}),
                )
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};
    use tokio::sync::oneshot;

    fn context(base: &str) -> LocalAuthContext {
        LocalAuthContext::new(Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: base.into(),
            auth_token: "account-a".into(),
            ..Default::default()
        }))))
    }
    fn configure(context: &LocalAuthContext, revision: u64, base: &str) {
        context.configure(json!({"configuration_revision":revision,"session":{
            "backend_url":base,"account_token":"account-a","native_token":"private-native-token",
            "expires_at":chrono::Utc::now().timestamp()+600
        }})).unwrap();
    }
    #[test]
    fn native_availability_does_not_change_device_registration_or_cloud_mode() {
        let context = context("http://127.0.0.1:1");
        assert!(!context.available(false));
        configure(&context, 1, "http://127.0.0.1:1");
        assert!(context.available(false));
        context.socket(None, true);
        assert!(
            !context.available(false),
            "cloud profiles still require their Socket"
        );
        context.socket(None, false);
        assert!(context.available(false));
        context
            .connection
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .auth_token = "other-account".into();
        assert!(
            !context.available(true),
            "a native session cannot cross profiles"
        );
    }
    #[test]
    fn clear_fences_late_configuration_and_expired_sessions() {
        let context = context("http://127.0.0.1:1");
        configure(&context, 1, "http://127.0.0.1:1");
        context
            .configure(json!({"configuration_revision":3,"session":null}))
            .unwrap();
        assert!(context
            .configure(json!({"configuration_revision":2,"session":null}))
            .is_err());
        assert!(!context.available(false));
        assert!(context.configure(json!({"configuration_revision":4,"session":{
            "backend_url":"http://127.0.0.1:1","account_token":"account-a","native_token":"secret","expires_at":1
        }})).is_err());
    }
    #[tokio::test]
    async fn http_works_without_socket_and_discards_response_after_account_change() {
        for change_profile in [false, true] {
            let (started, start) = oneshot::channel();
            let (release, released) = oneshot::channel();
            let request = Arc::new(Mutex::new(Some((started, released))));
            let app = Router::new().route(
                "/api/plugins/native-auth/exchange",
                post(move |Json(body): Json<Value>| {
                    let (started, released) = request.lock().unwrap().take().unwrap();
                    async move {
                        assert_eq!(body["native_token"], "private-native-token");
                        assert_eq!(body["operation"], "plugin.auth.execute");
                        started.send(()).unwrap();
                        released.await.unwrap();
                        Json(json!({"success":true,"credential":"must-stay-native"}))
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let context = context(&base);
            configure(&context, 1, &base);
            assert!(context.available(false));
            let active = context.clone();
            let call = tokio::spawn(async move {
                active
                    .exchange("plugin.auth.execute", json!({}), Duration::from_secs(5))
                    .await
            });
            start.await.unwrap();
            if change_profile {
                context
                    .connection
                    .lock()
                    .unwrap()
                    .as_mut()
                    .unwrap()
                    .auth_token = "account-b".into();
            }
            release.send(()).unwrap();
            let result = call.await.unwrap();
            if change_profile {
                assert_eq!(result.unwrap_err(), "plugin_auth_backend_unavailable");
            } else {
                assert_eq!(result.unwrap()["credential"], "must-stay-native");
            }
            server.abort();
        }
    }

    #[test]
    fn broker_owner_survives_token_rotation_but_not_account_switch() {
        let token = |sub: &str, exp: i32| {
            format!(
                "header.{}.signature",
                URL_SAFE_NO_PAD.encode(json!({"sub":sub,"exp":exp}).to_string())
            )
        };
        let mut profile = ConnectionConfig {
            backend_url: "http://backend".into(),
            auth_token: token("a", 1),
            ..Default::default()
        };
        let old = account_scope(&profile);
        profile.auth_token = token("a", 2);
        assert_eq!(old, account_scope(&profile));
        profile.auth_token = token("b", 2);
        assert_ne!(old, account_scope(&profile));
    }
}
