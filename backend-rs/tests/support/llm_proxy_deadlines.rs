// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Production-route deadline contracts over real HTTP, JWT, MySQL and Redis.
//! Scheduling gates add latency around the real stored-key resolver; no key or
//! resolver result is fabricated. Only the external model service is simulated.

use super::{
    fixture::Fixture,
    llm_proxy_timeouts::{
        FIRST_EVENT, HttpApp, LAST_EVENT, advance_time as advance, model_request, proxy_builder,
        seed_models,
    },
};
use async_trait::async_trait;
use brz_http::reqwest::Error;
use serde_json::Value;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt as _,
    net::TcpListener,
    sync::{Notify, mpsc, oneshot},
    task::JoinHandle,
};
use wegent_backend_rs::{
    http_compat::FastApiError,
    llm_proxy::{CredentialRequest, LlmProxyCredentials, StoredLlmProxyCredentials},
};

const OBSERVER_BUDGET: Duration = Duration::from_secs(660);
const MIDDLE_EVENT: &[u8] = b"event: response.output_text.delta\ndata: {\"delta\":\"middle\"}\n\n";

struct GatedStoredCredentials {
    entered: Arc<Notify>,
    release: Mutex<Option<oneshot::Receiver<()>>>,
}

#[async_trait]
impl LlmProxyCredentials for GatedStoredCredentials {
    async fn provider_api_key(
        &self,
        request: CredentialRequest<'_>,
    ) -> Result<String, FastApiError> {
        let release = self
            .release
            .lock()
            .unwrap()
            .take()
            .expect("one request per gate");
        self.entered.notify_one();
        release.await.expect("credential scheduling gate released");
        StoredLlmProxyCredentials.provider_api_key(request).await
    }
}

struct CredentialGate {
    entered: Arc<Notify>,
    release: oneshot::Sender<()>,
}

impl CredentialGate {
    /// Inserts a scheduling barrier without replacing the production resolver.
    fn new() -> (Arc<dyn LlmProxyCredentials>, Self) {
        let entered = Arc::new(Notify::new());
        let (release, released) = oneshot::channel();
        (
            Arc::new(GatedStoredCredentials {
                entered: Arc::clone(&entered),
                release: Mutex::new(Some(released)),
            }),
            Self { entered, release },
        )
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ModelMode {
    Complete,
    HoldHeaders,
    ActiveStream,
}

struct Model {
    url: String,
    ready: oneshot::Receiver<()>,
    middle: Arc<Notify>,
    calls: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl Model {
    /// Holds a real provider connection open at the selected protocol boundary.
    async fn start(mode: ModelMode) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (ready_tx, ready) = oneshot::channel();
        let middle = Arc::new(Notify::new());
        let next = Arc::clone(&middle);
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = Arc::clone(&calls);
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            observed.fetch_add(1, Ordering::SeqCst);
            model_request(&mut socket).await;
            ready_tx.send(()).unwrap();
            if mode == ModelMode::HoldHeaders {
                std::future::pending::<()>().await;
            }
            let length = FIRST_EVENT.len()
                + LAST_EVENT.len()
                + if mode == ModelMode::ActiveStream {
                    MIDDLE_EVENT.len()
                } else {
                    0
                };
            socket.write_all(format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {length}\r\nconnection: close\r\n\r\n").as_bytes()).await.unwrap();
            socket.write_all(FIRST_EVENT).await.unwrap();
            if mode == ModelMode::ActiveStream {
                next.notified().await;
                socket.write_all(MIDDLE_EVENT).await.unwrap();
                std::future::pending::<()>().await;
            }
            socket.write_all(LAST_EVENT).await.unwrap();
        });
        Self {
            url,
            ready,
            middle,
            calls,
            task,
        }
    }

    /// Cancels a deliberately stalled provider after the client assertions.
    async fn stop(self) {
        if self.task.is_finished() {
            self.task.await.unwrap();
        } else {
            self.task.abort();
            assert!(self.task.await.unwrap_err().is_cancelled());
        }
    }
}

struct Case {
    database: Fixture,
    model: Model,
    app: HttpApp,
}

impl Case {
    /// Reuses the suite's disposable services and the real production route registry.
    async fn new(mode: ModelMode, credentials: Option<Arc<dyn LlmProxyCredentials>>) -> Self {
        for variable in ["DATABASE_URL", "REDIS_URL"] {
            let url = url::Url::parse(&std::env::var(variable).expect("explicit E2E URL")).unwrap();
            assert_eq!(url.host_str(), Some("127.0.0.1"));
        }
        let database = Fixture::new().await;
        let model = Model::start(mode).await;
        seed_models(&database.mysql, &model.url).await;
        let app = HttpApp::start_with(database.mysql.clone(), credentials, OBSERVER_BUDGET).await;
        Self {
            database,
            model,
            app,
        }
    }

    /// Builds an observer whose budget is longer than the production request budget.
    fn request(&self) -> ObservedRequest {
        let http = brz_http::Client::builder()
            .timeout(OBSERVER_BUDGET)
            .read_timeout(OBSERVER_BUDGET)
            .build()
            .unwrap();
        let request = proxy_builder(&http, &self.app.url, "stream").unwrap();
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&bytes);
        let (progress_tx, progress) = mpsc::unbounded_channel();
        let started = tokio::time::Instant::now();
        let task = tokio::spawn(async move {
            let mut response = request.send().await?;
            let status = response.status().as_u16();
            while let Some(chunk) = response.chunk().await? {
                let size = {
                    let mut bytes = captured.lock().unwrap();
                    bytes.extend_from_slice(&chunk);
                    bytes.len()
                };
                progress_tx.send(size).unwrap();
            }
            Ok((status, captured.lock().unwrap().clone()))
        });
        ObservedRequest {
            started,
            task,
            progress,
            bytes,
        }
    }

    /// Stops both listeners before dropping the isolated database.
    async fn close(self) {
        self.model.stop().await;
        self.app.stop().await;
        self.database.close().await;
    }
}

struct ObservedRequest {
    started: tokio::time::Instant,
    task: JoinHandle<Result<(u16, Vec<u8>), Error>>,
    progress: mpsc::UnboundedReceiver<usize>,
    bytes: Arc<Mutex<Vec<u8>>>,
}

impl ObservedRequest {
    /// Includes authentication and real I/O time instead of accumulating it onto virtual waits.
    async fn advance_to(&self, seconds: u64) {
        let target = self.started + Duration::from_secs(seconds);
        advance(target.saturating_duration_since(tokio::time::Instant::now())).await;
    }

    /// Waits for bytes read through the actual forward_upstream response stream.
    async fn read_through(&mut self, size: usize) {
        while self
            .progress
            .recv()
            .await
            .expect("response stream still open")
            < size
        {}
    }

    /// Bounds real socket dispatch after virtual time has crossed a business deadline.
    async fn finish(self) -> Result<(u16, Vec<u8>), Error> {
        tokio::time::timeout(Duration::from_secs(10), self.task)
            .await
            .expect("production route must finish after its deadline")
            .unwrap()
    }
}

#[tokio::test]
#[ignore = "requires disposable MySQL and Redis; invoked by Backend Rust CI"]
async fn credentials_can_finish_after_the_former_30_second_window() {
    let (resolver, gate) = CredentialGate::new();
    let case = Case::new(ModelMode::Complete, Some(resolver)).await;
    let request = case.request();
    gate.entered.notified().await;
    advance(Duration::from_secs(31)).await;
    assert!(
        !gate.release.is_closed(),
        "credential lookup was cancelled before the request deadline"
    );
    gate.release.send(()).unwrap();
    let reply = request.finish().await.unwrap();
    assert_eq!(reply.0, 200);
    assert_eq!(reply.1, [FIRST_EVENT, LAST_EVENT].concat());
    case.close().await;
}

#[tokio::test]
#[ignore = "requires disposable MySQL and Redis; invoked by Backend Rust CI"]
async fn pending_credentials_return_503_only_at_the_request_deadline() {
    let (resolver, gate) = CredentialGate::new();
    let case = Case::new(ModelMode::Complete, Some(resolver)).await;
    let request = case.request();
    gate.entered.notified().await;
    request.advance_to(599).await;
    assert!(
        !gate.release.is_closed(),
        "credentials expired before 600 seconds"
    );
    assert!(!request.task.is_finished());
    request.advance_to(601).await;
    let reply = request.finish().await.unwrap();
    assert_eq!(reply.0, 503);
    let body: Value = serde_json::from_slice(&reply.1).unwrap();
    assert_eq!(body["detail"], "Model credentials unavailable");
    assert!(
        gate.release.is_closed(),
        "expired credential work must be cancelled"
    );
    assert_eq!(case.model.calls.load(Ordering::SeqCst), 0);
    case.close().await;
}

#[tokio::test]
#[ignore = "requires disposable MySQL and Redis; invoked by Backend Rust CI"]
async fn pending_upstream_headers_return_502_at_the_request_deadline() {
    let mut case = Case::new(ModelMode::HoldHeaders, None).await;
    let request = case.request();
    (&mut case.model.ready).await.unwrap();
    request.advance_to(599).await;
    assert!(!request.task.is_finished());
    request.advance_to(601).await;
    let reply = request.finish().await.unwrap();
    assert_eq!(reply.0, 502);
    let body: Value = serde_json::from_slice(&reply.1).unwrap();
    assert!(
        body["detail"]
            .as_str()
            .unwrap()
            .starts_with("Upstream request failed:")
    );
    case.close().await;
}

#[tokio::test]
#[ignore = "requires disposable MySQL and Redis; invoked by Backend Rust CI"]
async fn active_production_stream_shares_the_credential_deadline() {
    let (resolver, gate) = CredentialGate::new();
    let case = Case::new(ModelMode::ActiveStream, Some(resolver)).await;
    let mut request = case.request();
    gate.entered.notified().await;
    request.advance_to(300).await;
    gate.release
        .send(())
        .expect("credential phase must retain the 600 second budget");
    request.read_through(FIRST_EVENT.len()).await;
    request.advance_to(500).await;
    case.model.middle.notify_one();
    request
        .read_through(FIRST_EVENT.len() + MIDDLE_EVENT.len())
        .await;
    request.advance_to(599).await;
    assert!(
        !request.task.is_finished(),
        "the active response must remain open before 600 seconds"
    );
    let bytes = Arc::clone(&request.bytes);
    request.advance_to(601).await;
    assert!(
        request.finish().await.is_err(),
        "the actual production response body must terminate at the original deadline"
    );
    assert_eq!(*bytes.lock().unwrap(), [FIRST_EVENT, MIDDLE_EVENT].concat());
    case.close().await;
}
