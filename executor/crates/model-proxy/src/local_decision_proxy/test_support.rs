// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real HTTP fixtures for the local-to-backend decision boundary.

use std::sync::{Arc, Mutex};

use axum::{
    body::{to_bytes, Body},
    http::Request,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;
use crate::config::device::ConnectionConfig;

pub(super) const LOGIN_TOKEN: &str = "decision-test-login";

#[derive(Clone, Default)]
pub(super) struct RecordedRequest {
    pub method: Method,
    pub headers: HeaderMap,
    pub body: Value,
}

#[derive(Clone)]
pub(super) struct FakeBackend {
    pub url: String,
    pub requests: Arc<Mutex<Vec<RecordedRequest>>>,
    pub reply: Arc<Mutex<(StatusCode, Value)>>,
    pub delay: Duration,
}

impl FakeBackend {
    pub fn set_reply(&self, status: StatusCode, body: Value) {
        *self.reply.lock().unwrap() = (status, body);
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

pub(super) fn catalog() -> Value {
    json!({
        "protocolVersion": 1,
        "defaultModel": "model-a",
        "models": [
            {"id": "model-a", "displayName": "SystemOne model", "protocol": "systemone",
             "modelId": "jev-latest", "type": "public", "namespace": "default"},
            {"id": "model-b", "displayName": "OpenAI model", "protocol": "openai",
             "modelId": "decision-model", "type": "user", "namespace": "default"},
        ]
    })
}

pub(super) async fn start_backend(body: Value, delay: Duration) -> FakeBackend {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let backend = FakeBackend {
        url: format!("http://{address}"),
        requests: Arc::new(Mutex::new(Vec::new())),
        reply: Arc::new(Mutex::new((StatusCode::OK, body))),
        delay,
    };
    let router = Router::new()
        .route(
            "/api/models/decisions",
            get(fake_backend).post(fake_backend),
        )
        .with_state(backend.clone());
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    backend
}

async fn fake_backend(
    State(backend): State<FakeBackend>,
    method: Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    backend.requests.lock().unwrap().push(RecordedRequest {
        method,
        headers,
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    });
    if !backend.delay.is_zero() {
        tokio::time::sleep(backend.delay).await;
    }
    let (status, body) = backend.reply.lock().unwrap().clone();
    (status, Json(body)).into_response()
}

pub(super) fn app(timeout: Duration) -> Router {
    let mut state = DecisionProxyState::new(Arc::new(DecisionProxyRuntime::new()));
    state.timeout = timeout;
    routes::<DecisionProxyState>().with_state(state)
}

pub(super) fn connection(backend: &FakeBackend) -> Arc<Mutex<Option<ConnectionConfig>>> {
    Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: backend.url.clone(),
        socket_url: String::new(),
        auth_token: LOGIN_TOKEN.to_owned(),
        runtime_auth_token: String::new(),
    })))
}

pub(super) fn register_route(backend: &FakeBackend, scope: &str) -> String {
    register(scope, connection(backend))
}

pub(super) fn request(token: &str, method: Method, body: Value) -> Request<Body> {
    let path = if method == Method::GET {
        "status"
    } else {
        "v1/decisions"
    };
    Request::builder()
        .method(method)
        .uri(format!("/v1/decision-router/{token}/{path}"))
        .header(
            header::AUTHORIZATION,
            format!("Bearer {LOCAL_AUTHORIZATION_VALUE}"),
        )
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, "must-not-forward")
        .header("x-api-key", "must-not-forward")
        .body(Body::from(body.to_string()))
        .unwrap()
}

pub(super) fn valid_body() -> Value {
    json!({"model": "model-a", "state": "a comment",
        "questions": {"urgent": {"type": "noul", "instructions": "Is it urgent?"}}})
}

pub(super) async fn send(app: Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), 2 * MAX_REQUEST_BYTES)
        .await
        .unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}
