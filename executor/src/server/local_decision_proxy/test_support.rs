// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared fixtures for the decision proxy HTTP tests.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::config::device::ConnectionConfig;
/// Credential the fake backend hands out, and what the fake upstream must see.
pub(super) const EXCHANGED_KEY: &str = "sk-wecode-test-key";
/// Login token the routes carry in their connection snapshot.
pub(super) const LOGIN_TOKEN: &str = "weework-login-token";
pub(super) const EXCHANGE_PATH: &str = "/api/internal/apikey/wegent-model-key";
pub(super) const MAX_TEST_BODY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Default)]
pub(super) struct RecordedRequest {
    pub(super) headers: Vec<(String, String)>,
    pub(super) body: Value,
}

#[derive(Clone)]
pub(super) struct ScriptedResponse {
    pub(super) status: u16,
    pub(super) body: String,
    pub(super) delay: Duration,
}

impl ScriptedResponse {
    pub(super) fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body: body.to_string(),
            delay: Duration::ZERO,
        }
    }

    pub(super) fn raw(status: u16, body: &str) -> Self {
        Self {
            status,
            body: body.to_owned(),
            delay: Duration::ZERO,
        }
    }
}

/// Response script: the last entry repeats, so one entry means "always".
#[derive(Clone)]
pub(super) struct Script {
    pub(super) responses: Vec<ScriptedResponse>,
}

impl From<ScriptedResponse> for Script {
    fn from(response: ScriptedResponse) -> Self {
        Self {
            responses: vec![response],
        }
    }
}

impl Script {
    pub(super) fn sequence(responses: Vec<ScriptedResponse>) -> Self {
        assert!(
            !responses.is_empty(),
            "a script needs at least one response"
        );
        Self { responses }
    }

    pub(super) fn at(&self, served: usize) -> ScriptedResponse {
        self.responses[served.min(self.responses.len() - 1)].clone()
    }
}

pub(super) fn exchange_response(api_key: &str) -> ScriptedResponse {
    ScriptedResponse::json(200, json!({"api_key": api_key}))
}

pub(super) struct UpstreamShared {
    pub(super) requests: Mutex<Vec<RecordedRequest>>,
    pub(super) script: Mutex<Script>,
    pub(super) key_requests: Mutex<Vec<RecordedRequest>>,
    pub(super) key_script: Mutex<Script>,
}

pub(super) struct FakeUpstream {
    pub(super) url: Url,
    /// Backend origin the route snapshot points at.
    pub(super) backend_url: String,
    pub(super) shared: Arc<UpstreamShared>,
}

impl FakeUpstream {
    pub(super) fn requests(&self) -> Vec<RecordedRequest> {
        self.shared.requests.lock().expect("requests lock").clone()
    }

    pub(super) fn only_request(&self) -> RecordedRequest {
        let requests = self.requests();
        assert_eq!(requests.len(), 1, "expected exactly one upstream call");
        requests.into_iter().next().expect("recorded request")
    }

    pub(super) fn last_request(&self) -> RecordedRequest {
        self.requests()
            .into_iter()
            .next_back()
            .expect("recorded request")
    }

    pub(super) fn header(&self, name: &str) -> Option<String> {
        self.last_request()
            .headers
            .into_iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value)
    }

    pub(super) fn key_requests(&self) -> Vec<RecordedRequest> {
        self.shared
            .key_requests
            .lock()
            .expect("key requests lock")
            .clone()
    }

    pub(super) fn last_key_authorization(&self) -> Option<String> {
        self.key_requests()
            .into_iter()
            .next_back()
            .and_then(|request| {
                request
                    .headers
                    .into_iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                    .map(|(_, value)| value)
            })
    }
}

pub(super) async fn start_upstream(script: impl Into<Script>) -> FakeUpstream {
    start_backend(
        script.into(),
        Script::from(exchange_response(EXCHANGED_KEY)),
    )
    .await
}

pub(super) async fn start_backend(script: Script, key_script: Script) -> FakeUpstream {
    let shared = Arc::new(UpstreamShared {
        requests: Mutex::new(Vec::new()),
        script: Mutex::new(script),
        key_requests: Mutex::new(Vec::new()),
        key_script: Mutex::new(key_script),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("upstream listener");
    let address = listener.local_addr().expect("upstream address");
    let router = Router::new()
        .route("/v1/decisions", post(fake_upstream))
        .route(EXCHANGE_PATH, post(fake_model_key))
        .with_state(Arc::clone(&shared));
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    FakeUpstream {
        url: Url::parse(&format!("http://{address}/v1/decisions")).expect("upstream url"),
        backend_url: format!("http://{address}"),
        shared,
    }
}

pub(super) async fn fake_upstream(
    State(shared): State<Arc<UpstreamShared>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let served = record(&shared.requests, headers, || {
        serde_json::from_slice(&body).unwrap_or(Value::Null)
    });
    scripted_response(&shared.script, served).await
}

pub(super) async fn fake_model_key(
    State(shared): State<Arc<UpstreamShared>>,
    headers: HeaderMap,
) -> Response {
    let served = record(&shared.key_requests, headers, Value::default);
    scripted_response(&shared.key_script, served).await
}

pub(super) fn record(
    log: &Mutex<Vec<RecordedRequest>>,
    headers: HeaderMap,
    body: impl FnOnce() -> Value,
) -> usize {
    let mut entries = log.lock().expect("requests lock");
    entries.push(RecordedRequest {
        headers: headers
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_owned(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect(),
        body: body(),
    });
    entries.len() - 1
}

pub(super) async fn scripted_response(script: &Mutex<Script>, served: usize) -> Response {
    let scripted = script.lock().expect("script lock").at(served);
    if !scripted.delay.is_zero() {
        tokio::time::sleep(scripted.delay).await;
    }
    (
        StatusCode::from_u16(scripted.status).expect("status"),
        [(header::CONTENT_TYPE, "application/json")],
        scripted.body,
    )
        .into_response()
}

pub(super) fn settings(upstream: &Url) -> DecisionProxySettings {
    DecisionProxySettings {
        upstream_url: upstream.clone(),
        default_model: "model-a".to_owned(),
        models: vec![
            DecisionModel {
                id: "model-a".to_owned(),
                display_name: "Model A".to_owned(),
            },
            DecisionModel {
                id: "model-b".to_owned(),
                display_name: "model-b".to_owned(),
            },
        ],
    }
}

pub(super) fn app(config: DecisionProxyConfig, timeout: Duration) -> Router {
    let mut state =
        DecisionProxyState::new(Arc::new(config), Arc::new(DecisionProxyRuntime::new()));
    state.timeout = timeout;
    routes::<DecisionProxyState>().with_state(state)
}

pub(super) fn connection_snapshot(
    backend_url: &str,
    login_token: &str,
) -> Arc<Mutex<Option<ConnectionConfig>>> {
    Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: backend_url.to_owned(),
        socket_url: String::new(),
        auth_token: login_token.to_owned(),
        runtime_auth_token: String::new(),
    })))
}

/// Registers a route bound to `upstream`'s fake backend and login token.
pub(super) fn register_route(upstream: &FakeUpstream, scope: &str) -> String {
    register(
        scope,
        connection_snapshot(&upstream.backend_url, LOGIN_TOKEN),
    )
}

pub(super) fn enabled_app(upstream: &FakeUpstream) -> Router {
    app(
        DecisionProxyConfig::Enabled(settings(&upstream.url)),
        UPSTREAM_TIMEOUT,
    )
}

pub(super) async fn send(app: Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.oneshot(request).await.expect("router response");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), MAX_TEST_BODY_BYTES)
        .await
        .expect("response body");
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

pub(super) fn status_request(token: &str, authorization: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method("GET")
        .uri(format!("/v1/decision-router/{token}/status"));
    if let Some(value) = authorization {
        builder = builder.header(header::AUTHORIZATION, value);
    }
    builder.body(Body::empty()).expect("status request")
}

pub(super) fn decision_request(
    token: &str,
    authorization: Option<&str>,
    content_type: Option<&str>,
    body: Body,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri(format!("/v1/decision-router/{token}/v1/decisions"))
        .header("x-request-id", "client-supplied");
    if let Some(value) = authorization {
        builder = builder.header(header::AUTHORIZATION, value);
    }
    if let Some(value) = content_type {
        builder = builder.header(header::CONTENT_TYPE, value);
    }
    builder.body(body).expect("decision request")
}

pub(super) fn json_body(value: Value) -> Body {
    Body::from(value.to_string())
}

pub(super) fn valid_body() -> Value {
    json!({
        "model": "model-a",
        "state": {"field": "comment", "value": "great"},
        "questions": {"sentiment": {"type": "choice"}},
    })
}

pub(super) fn local_marker() -> String {
    format!("Bearer {LOCAL_AUTHORIZATION_VALUE}")
}

pub(super) fn error_code(value: &Value) -> String {
    value["error"]["code"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}
