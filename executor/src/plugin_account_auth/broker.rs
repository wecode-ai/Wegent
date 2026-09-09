// SPDX-License-Identifier: Apache-2.0
//! Authenticated loopback business API shared by desktop and standalone runners.

use super::{execute, AuthError, ExecutionRequest};
use crate::local::backend::LocalBackendTransport;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tokio::{
    net::TcpListener,
    sync::{watch, Semaphore},
    task::JoinHandle,
};

#[derive(Clone)]
struct Endpoint {
    url: String,
    token: String,
    mode: String,
    home: PathBuf,
}

fn endpoint() -> &'static Mutex<Option<Endpoint>> {
    static ENDPOINT: OnceLock<Mutex<Option<Endpoint>>> = OnceLock::new();
    ENDPOINT.get_or_init(|| Mutex::new(None))
}

/// Only these local business capability values are added to agent processes.
pub fn environment() -> HashMap<String, String> {
    let guard = endpoint()
        .lock()
        .expect("plugin broker endpoint lock poisoned");
    let Some(endpoint) = guard.as_ref() else {
        return HashMap::new();
    };
    HashMap::from([
        ("WEGENT_PLUGIN_AUTH_BROKER".into(), endpoint.url.clone()),
        (
            "WEGENT_PLUGIN_AUTH_BROKER_TOKEN".into(),
            endpoint.token.clone(),
        ),
        ("WEGENT_PLUGIN_AUTH_MODE".into(), endpoint.mode.clone()),
        (
            "WEGENT_EXECUTOR_HOME".into(),
            endpoint.home.to_string_lossy().into_owned(),
        ),
    ])
}

pub struct RunningBroker {
    endpoint: Endpoint,
    cancel: watch::Sender<bool>,
    task: JoinHandle<()>,
    revocations: JoinHandle<()>,
    automation: JoinHandle<()>,
}

impl Drop for RunningBroker {
    fn drop(&mut self) {
        self.cancel.send_replace(true);
        self.task.abort();
        self.revocations.abort();
        self.automation.abort();
        let mut active = endpoint()
            .lock()
            .expect("plugin broker endpoint lock poisoned");
        if active
            .as_ref()
            .is_some_and(|value| value.url == self.endpoint.url)
        {
            *active = None;
        }
    }
}

#[derive(Clone)]
struct BrokerState<T> {
    transport: T,
    endpoint: Endpoint,
    connected: Arc<AtomicBool>,
    cancel: watch::Sender<bool>,
    capacity: Arc<Semaphore>,
}

pub async fn start<T: LocalBackendTransport>(
    transport: T,
    home: PathBuf,
    connected: Arc<AtomicBool>,
    cloud: bool,
) -> Result<RunningBroker, AuthError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| AuthError("plugin_auth_broker_unavailable"))?;
    let address = listener
        .local_addr()
        .map_err(|_| AuthError("plugin_auth_broker_unavailable"))?;
    let mut nonce = [0u8; 32];
    getrandom::fill(&mut nonce).map_err(|_| AuthError("plugin_auth_broker_unavailable"))?;
    let token: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let endpoint_value = Endpoint {
        url: format!("http://{address}/v1/run"),
        token,
        mode: if cloud { "cloud" } else { "local" }.into(),
        home,
    };
    let (cancel, _) = watch::channel(false);
    let revocation_transport = transport.clone();
    let revocation_home = endpoint_value.home.clone();
    let revocation_connected = connected.clone();
    let mut revocation_cancel = cancel.subscribe();
    let revocations = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = revocation_cancel.changed() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(15)) => {}
            }
            if revocation_connected.load(Ordering::Acquire) {
                tokio::select! {
                    _ = revocation_cancel.changed() => break,
                    _ = super::revoke_pending(revocation_transport.clone(), &revocation_home) => {}
                }
            }
        }
    });
    let automatic_transport = transport.clone();
    let automatic_home = endpoint_value.home.clone();
    let automatic_connected = connected.clone();
    let mut automatic_cancel = cancel.subscribe();
    let automation = tokio::spawn(async move {
        let mut reconciler = super::automation::Reconciler::default();
        loop {
            if automatic_connected.load(Ordering::Acquire) {
                tokio::select! {
                    _ = automatic_cancel.changed() => break,
                    _ = reconciler.reconcile(automatic_transport.clone(), &automatic_home) => {}
                }
            }
            tokio::select! {
                _ = automatic_cancel.changed() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(15)) => {}
            }
        }
    });
    let state = BrokerState {
        transport,
        endpoint: endpoint_value.clone(),
        connected,
        cancel: cancel.clone(),
        capacity: Arc::new(Semaphore::new(16)),
    };
    let app = Router::new()
        .route("/v1/run", post(run::<T>))
        .layer(DefaultBodyLimit::max(65_536))
        .with_state(state);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    *endpoint()
        .lock()
        .expect("plugin broker endpoint lock poisoned") = Some(endpoint_value.clone());
    Ok(RunningBroker {
        endpoint: endpoint_value,
        cancel,
        task,
        revocations,
        automation,
    })
}

async fn run<T: LocalBackendTransport>(
    State(state): State<BrokerState<T>>,
    headers: HeaderMap,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let provided = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    let expected = state.endpoint.token.as_bytes();
    let authorized = provided.len() == expected.len()
        && provided
            .as_bytes()
            .iter()
            .zip(expected)
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0;
    let result = if !authorized || headers.contains_key("origin") {
        Err(AuthError("plugin_auth_broker_unauthorized"))
    } else {
        run_authorized(state, body).await
    };
    let (status, result) = match result {
        Ok(stdout) => (StatusCode::OK, json!({"stdout":stdout})),
        Err(error) => (StatusCode::BAD_REQUEST, json!({"error":error.0})),
    };
    (status, [("cache-control", "no-store")], Json(result))
}

async fn run_authorized<T: LocalBackendTransport>(
    state: BrokerState<T>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> Result<String, AuthError> {
    if !state.connected.load(Ordering::Acquire) {
        return Err(AuthError("plugin_auth_backend_unavailable"));
    }
    let _permit = state
        .capacity
        .try_acquire()
        .map_err(|_| AuthError("plugin_auth_broker_busy"))?;
    let Json(value) = body.map_err(|_| AuthError("plugin_auth_invalid_request"))?;
    let request: ExecutionRequest =
        serde_json::from_value(value).map_err(|_| AuthError("plugin_auth_invalid_request"))?;
    let mut cancelled = state.cancel.subscribe();
    if *cancelled.borrow() {
        return Err(AuthError("plugin_auth_backend_unavailable"));
    }
    tokio::select! {
        result = execute(state.transport, &state.endpoint.home, request) => result,
        _ = cancelled.changed() => Err(AuthError("plugin_auth_backend_unavailable")),
    }
}
