// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Real HTTP gateway, JWT, MySQL Model lookup and LLM streaming regression.
//! Only the external model service is simulated. Socket barriers establish both
//! slow cases before virtual time advances against the production timeout policy.

use anyhow::{Context as _, Result};
use brz_mysql::MysqlService;
use brz_redis::Redis as _;
use serde_json::{Value, json};
use std::{path::Path, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::Instant,
};
use wegent_backend_rs::{
    Application, Gateway, HybridConfig, OriginService, RouteTable, auth::AppAuthenticator, bind,
    build_app_state, config::AuthConfig, http_server::ServerConfig, llm_proxy::LlmProxyCredentials,
    serve,
};

const PATH: &str = "/api/runtime-work/llm-responses-proxy/responses";
const MODEL_DELAY: Duration = Duration::from_secs(121);
const TEST_BUDGET: Duration = Duration::from_secs(160);
const JWT_KEY: &str = "llm-proxy-e2e-signing-key";
const PROVIDER_KEY: &str = "llm-proxy-e2e-provider-key";
pub(super) const FIRST_EVENT: &[u8] =
    b"event: response.output_text.delta\ndata: {\"delta\":\"first\"}\n\n";
pub(super) const LAST_EVENT: &[u8] =
    b"event: response.completed\ndata: {\"status\":\"completed\"}\n\n";

/// Seeds actual authentication rows and two user-owned Model CRDs.
pub(super) async fn seed_models(mysql: &MysqlService, provider_url: &str) {
    for sql in [
        "CREATE TABLE users (
            id INT PRIMARY KEY, user_name VARCHAR(100), password_hash VARCHAR(100) DEFAULT '',
            email VARCHAR(100), git_info JSON, is_active TINYINT DEFAULT 1,
            role VARCHAR(20) DEFAULT 'user', auth_source VARCHAR(20) DEFAULT 'password',
            preferences TEXT, created_at DATETIME, updated_at DATETIME)",
        "INSERT INTO users (id,user_name,git_info,preferences,created_at,updated_at)
            VALUES (7,'llm-proxy-e2e',JSON_OBJECT(),'{}',NOW(),NOW())",
        "CREATE TABLE kinds (
            id BIGINT PRIMARY KEY, user_id INT, kind VARCHAR(20), name VARCHAR(100),
            namespace VARCHAR(100), json JSON, is_active TINYINT DEFAULT 1,
            created_at DATETIME DEFAULT '2026-01-01', updated_at DATETIME DEFAULT '2026-01-01')",
    ] {
        mysql.execute(sql, ()).await.unwrap();
    }
    for (id, mode) in [(1, "headers"), (2, "stream")] {
        let model = json!({"spec": {"protocol": "openai-responses", "apiFormat": "responses",
            "modelConfig": {"env": {"model_id": "provider-model", "api_key": PROVIDER_KEY,
                "base_url": format!("{provider_url}/v1/{mode}")}}}});
        mysql
            .execute(
                "INSERT INTO kinds (id,user_id,kind,name,namespace,json)
                VALUES (?,7,'Model',?,'default',CAST(? AS JSON))",
                (id, format!("slow-{mode}"), model.to_string()),
            )
            .await
            .unwrap();
    }
}

pub(super) struct HttpApp {
    pub(super) url: String,
    stops: [oneshot::Sender<()>; 2],
    tasks: [JoinHandle<()>; 2],
}

impl HttpApp {
    /// Builds the real application and routes through the checked-in hybrid table.
    async fn start(mysql: MysqlService) -> Self {
        Self::start_with(mysql, None, Duration::from_secs(600)).await
    }

    /// Allows scheduling fault injection around the real stored-key resolver.
    /// A larger observer budget isolates the handler's deadline from server hygiene.
    pub(super) async fn start_with(
        mysql: MysqlService,
        credentials: Option<Arc<dyn LlmProxyCredentials>>,
        origin_budget: Duration,
    ) -> Self {
        let mut state = build_app_state().await.unwrap();
        state.mysql = mysql;
        if let Some(credentials) = credentials {
            state.llm_proxy_credentials = credentials;
        }
        state.auth = AuthConfig {
            jwt_key: JWT_KEY.into(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".into(),
        };
        let redis = state.redis.as_ref().expect("real Redis is required");
        let probe: i64 = redis
            .eval("return 1", ["llm-proxy-e2e"], ["1"])
            .await
            .unwrap();
        assert_eq!(probe, 1);
        let state = Arc::new(state);
        let application = Application::build(Arc::clone(&state)).await.unwrap();
        // The ordinary E2E uses the production 600s origin budget. Deadline
        // contract cases give the observer extra time to see the handler's error.
        let server = wegent_backend_rs::http_server::Server::bind_with_authenticator_and_config(
            "127.0.0.1:0".parse().unwrap(),
            application.routes,
            AppAuthenticator::new(state),
            ServerConfig {
                request_timeout: origin_budget,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let origin = format!("http://{}", server.local_addr().unwrap())
            .parse()
            .unwrap();
        let config = HybridConfig::new(
            "127.0.0.1:0".parse().unwrap(),
            "http://127.0.0.1:1".parse().unwrap(),
            RouteTable::empty(),
        )
        .with_routes_file(&Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml"))
        .unwrap();
        assert!(config.selects_rust(&http::Method::POST, PATH));
        // No Python stub: incorrect route selection fails at the closed origin.
        let gateway = Gateway::new(
            config.routes,
            OriginService::new(&origin).unwrap(),
            &config.python_upstream,
        )
        .unwrap();
        let listener = bind(config.listen_address).await.unwrap();
        let url = format!("http://{}{PATH}", listener.local_addr().unwrap());
        let (api_stop, api_stopped) = oneshot::channel();
        let api = tokio::spawn(async move {
            server
                .serve_until(async {
                    let _ = api_stopped.await;
                })
                .await
                .unwrap();
        });
        let (stop, stopped) = oneshot::channel();
        let gateway = tokio::spawn(async move {
            serve(
                listener,
                gateway,
                async {
                    let _ = stopped.await;
                },
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        });
        Self {
            url,
            stops: [stop, api_stop],
            tasks: [gateway, api],
        }
    }

    /// Drains both real listeners before disposing of the database.
    pub(super) async fn stop(self) {
        for stop in self.stops {
            stop.send(()).unwrap();
        }
        for task in self.tasks {
            task.await.unwrap();
        }
    }
}

/// Reads and validates the model request, including DB-resolved credentials/model ID.
pub(super) async fn model_request(stream: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    loop {
        let mut buffer = [0; 4096];
        let count = stream.read(&mut buffer).await.unwrap();
        assert!(count > 0, "model request ended before its body");
        bytes.extend_from_slice(&buffer[..count]);
        let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
            continue;
        };
        let head = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
        let length: usize = head
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        if bytes.len() < end + 4 + length {
            continue;
        }
        assert!(head.contains(&format!("authorization: bearer {PROVIDER_KEY}")));
        let body: Value = serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
        assert_eq!(body["model"], "provider-model");
        assert_eq!(body["input"], "llm-proxy-timeout-e2e");
        return head.lines().next().unwrap().to_owned();
    }
}

#[derive(Debug)]
struct ModelGate {
    before_headers: bool,
    release: oneshot::Sender<()>,
}

/// Holds headers or the final event until the real client reaches the time barrier.
async fn model_response(mut stream: TcpStream, ready: mpsc::UnboundedSender<ModelGate>) {
    let line = model_request(&mut stream).await;
    let before_headers = line == "post /v1/headers/responses http/1.1";
    assert!(before_headers || line == "post /v1/stream/responses http/1.1");
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        FIRST_EVENT.len() + LAST_EVENT.len()
    );
    if !before_headers {
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(FIRST_EVENT).await.unwrap();
    }
    let (release, released) = oneshot::channel();
    ready
        .send(ModelGate {
            before_headers,
            release,
        })
        .unwrap();
    released
        .await
        .expect("model response released after the virtual delay");
    if before_headers {
        stream.write_all(head.as_bytes()).await.unwrap();
        stream.write_all(FIRST_EVENT).await.unwrap();
    }
    stream.write_all(LAST_EVENT).await.unwrap();
}

/// Runs both real provider sockets and exposes their scheduling barriers.
async fn start_model() -> (String, mpsc::UnboundedReceiver<ModelGate>, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (ready_tx, ready) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        let mut cases = tokio::task::JoinSet::new();
        for _ in 0..2 {
            let (stream, _) = listener.accept().await.unwrap();
            cases.spawn(model_response(stream, ready_tx.clone()));
        }
        while let Some(result) = cases.join_next().await {
            result.unwrap();
        }
    });
    (url, ready, task)
}

/// Advances confirmed dependency waits, keeping real socket I/O on a resumed clock.
pub(super) async fn advance_time(duration: Duration) {
    tokio::time::pause();
    tokio::time::advance(duration).await;
    tokio::time::resume();
    tokio::task::yield_now().await;
}

struct ProxyResult {
    status: u16,
    content_type: String,
    body: Vec<u8>,
    first_event_after: Duration,
    completed_after: Duration,
}

/// Builds a real authenticated model request without setting a business deadline.
pub(super) fn proxy_builder(
    http: &brz_http::Client,
    url: &str,
    mode: &str,
) -> Result<brz_http::RequestBuilder> {
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &json!({"sub": "llm-proxy-e2e", "exp": chrono::Utc::now().timestamp() + 300}),
        &jsonwebtoken::EncodingKey::from_secret(JWT_KEY.as_bytes()),
    )?;
    Ok(http.post(url)?
        .header("authorization", format!("Bearer {token}"))
        .header("x-wegent-model-type", "user")
        .header("x-wegent-model-namespace", "default")
        .header("x-wegent-model-user-id", "7")
        .header("content-type", "application/json")
        .body(json!({"model": format!("slow-{mode}"), "input": "llm-proxy-timeout-e2e", "stream": true}).to_string()))
}

/// Consumes the complete SSE stream through the public HTTP gateway, without retries.
async fn proxy_request(
    http: &brz_http::Client,
    url: &str,
    mode: &str,
    mut first_event: Option<oneshot::Sender<()>>,
) -> Result<ProxyResult> {
    let start = Instant::now();
    let mut response = proxy_builder(http, url, mode)?.send().await?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()?
        .to_owned();
    let mut body = Vec::new();
    let mut first_event_after = None;
    while let Some(chunk) = response.chunk().await? {
        body.extend_from_slice(&chunk);
        if first_event_after.is_none() && body.len() >= FIRST_EVENT.len() {
            first_event_after = Some(start.elapsed());
            if let Some(first_event) = first_event.take() {
                first_event.send(()).unwrap();
            }
        }
    }
    Ok(ProxyResult {
        status,
        content_type,
        body,
        first_event_after: first_event_after.unwrap_or_else(|| start.elapsed()),
        completed_after: start.elapsed(),
    })
}

/// Waits for both authenticated model requests and an end-to-end first SSE event.
async fn model_barriers(
    ready: &mut mpsc::UnboundedReceiver<ModelGate>,
    first_event: oneshot::Receiver<()>,
) -> [ModelGate; 2] {
    let first = ready.recv().await.expect("first model request");
    let second = ready.recv().await.expect("second model request");
    assert_ne!(
        first.before_headers, second.before_headers,
        "both slow stages must be present"
    );
    first_event
        .await
        .expect("the first SSE event reached the client before advancing time");
    [first, second]
}

/// Drives the actual proxy futures while establishing and releasing virtual-time barriers.
async fn slow_requests(
    http: &brz_http::Client,
    url: &str,
    ready: &mut mpsc::UnboundedReceiver<ModelGate>,
) -> (Result<ProxyResult>, Result<ProxyResult>) {
    let deadline = Instant::now() + TEST_BUDGET;
    let (first_event, received) = oneshot::channel();
    let headers = proxy_request(http, url, "headers", None);
    let stream = proxy_request(http, url, "stream", Some(first_event));
    tokio::pin!(headers, stream);
    let gates = tokio::time::timeout_at(deadline, async {
        tokio::select! {
            result = &mut headers => panic!("headers completed before model release: {:?}", result.map(|reply| reply.status)),
            result = &mut stream => panic!("stream completed before model release: {:?}", result.map(|reply| reply.status)),
            gates = model_barriers(ready, received) => gates,
        }
    }).await.expect("real requests must reach both model barriers");
    advance_time(MODEL_DELAY).await;
    for gate in gates {
        gate.release.send(()).unwrap();
    }
    tokio::time::timeout_at(deadline, async { tokio::join!(headers, stream) })
        .await
        .expect("both proxy requests must finish within the test budget")
}

/// Proves the production route survives both former 120s read-timeout failures.
#[tokio::test]
#[ignore = "requires disposable MySQL and Redis; invoked by Backend Rust CI"]
async fn llm_proxy_slow_headers_and_streaming_http_e2e() {
    let wall_start = std::time::Instant::now();
    for variable in ["DATABASE_URL", "REDIS_URL"] {
        let url = url::Url::parse(&std::env::var(variable).expect("explicit E2E URL")).unwrap();
        assert_eq!(
            url.host_str(),
            Some("127.0.0.1"),
            "loopback fixture required"
        );
    }
    let database = super::fixture::Fixture::new().await;
    let (provider_url, mut ready, mut provider) = start_model().await;
    seed_models(&database.mysql, &provider_url).await;
    let app = HttpApp::start(database.mysql.clone()).await;
    let client = brz_http::Client::builder()
        .timeout(TEST_BUDGET)
        .read_timeout(TEST_BUDGET)
        .build()
        .unwrap();
    let unauthenticated = client
        .post(&app.url)
        .unwrap()
        .body(b"{}".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status().as_u16(), 401);
    let (headers, stream) = slow_requests(&client, &app.url, &mut ready).await;
    let provider_result = tokio::time::timeout(Duration::from_secs(5), &mut provider).await;
    if provider_result.is_err() {
        provider.abort();
    }
    app.stop().await;
    database.close().await;
    let headers = headers.context("delayed response headers failed").unwrap();
    let stream = stream.context("delayed stream chunk failed").unwrap();
    for (mode, result) in [("headers", &headers), ("stream", &stream)] {
        assert_eq!(
            result.status,
            200,
            "{mode}: {}",
            String::from_utf8_lossy(&result.body)
        );
        assert_eq!(result.content_type, "text/event-stream; charset=utf-8");
        assert_eq!(
            result.body,
            [FIRST_EVENT, LAST_EVENT].concat(),
            "{mode}: complete stream required"
        );
        assert!(
            result.completed_after >= MODEL_DELAY,
            "the original timeout must be exceeded"
        );
        eprintln!(
            "LLM proxy HTTP E2E: {mode}, status={}, virtual_elapsed={:?}, bytes={}",
            result.status,
            result.completed_after,
            result.body.len()
        );
    }
    assert!(headers.first_event_after >= MODEL_DELAY);
    assert!(
        stream.first_event_after < MODEL_DELAY,
        "the first SSE event must arrive before the delayed final event"
    );
    provider_result
        .expect("model provider must handle both requests")
        .unwrap();
    eprintln!(
        "LLM proxy HTTP E2E: wall_elapsed={:?}",
        wall_start.elapsed()
    );
}
