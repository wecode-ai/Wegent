use super::*;
use crate::local::backend::{EventHandler, LocalBackendConfig, LocalBackendTransport};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Mutex as StdMutex,
};
use tokio::sync::Barrier;

type TestFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, String>> + Send + 'a>>;

#[derive(Clone)]
struct Transport {
    calls: Arc<AtomicUsize>,
}

impl LocalBackendTransport for Transport {
    fn connect<'a>(&'a self, _: &'a LocalBackendConfig) -> TestFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn disconnect<'a>(&'a self) -> TestFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn call<'a>(&'a self, event: &'a str, payload: Value, _: Duration) -> TestFuture<'a, Value> {
        assert_eq!(event, "plugin.task_token.issue");
        assert_eq!(payload.as_object().unwrap().len(), 1);
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            Ok(
                json!({"success": true, "auth_token": format!("task-secret-{}", payload["task_id"].as_str().unwrap()), "expires_in": 86400}),
            )
        })
    }
    fn emit<'a>(&'a self, _: &'a str, _: Value) -> TestFuture<'a, ()> {
        panic!("no broadcast")
    }
    fn on(&self, _: &str, _: EventHandler) {
        panic!("no subscriptions")
    }
}

#[derive(Clone)]
struct ConcurrentTransport {
    barrier: Arc<Barrier>,
}

impl LocalBackendTransport for ConcurrentTransport {
    fn connect<'a>(&'a self, _: &'a LocalBackendConfig) -> TestFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn disconnect<'a>(&'a self) -> TestFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn call<'a>(&'a self, _: &'a str, payload: Value, _: Duration) -> TestFuture<'a, Value> {
        let barrier = self.barrier.clone();
        Box::pin(async move {
            barrier.wait().await;
            Ok(json!({
                "success": true,
                "auth_token": format!("task-{}", payload["task_id"].as_str().unwrap()),
                "expires_in": 86400
            }))
        })
    }
    fn emit<'a>(&'a self, _: &'a str, _: Value) -> TestFuture<'a, ()> {
        panic!("no broadcast")
    }
    fn on(&self, _: &str, _: EventHandler) {
        panic!("no subscriptions")
    }
}

#[tokio::test]
async fn issuer_exchanges_distinct_executions_concurrently() {
    let registration = issuer::spawn(
        ConcurrentTransport {
            barrier: Arc::new(Barrier::new(2)),
        },
        Arc::new(AtomicBool::new(true)),
    );

    let issued = tokio::time::timeout(Duration::from_secs(1), async {
        tokio::join!(
            registration.issuer.issue("first"),
            registration.issuer.issue("second")
        )
    })
    .await
    .expect("independent exchanges should not block the issuer queue");

    assert_eq!(issued.0.unwrap().value, "task-first");
    assert_eq!(issued.1.unwrap().value, "task-second");
}

#[tokio::test]
async fn task_token_upstreams_require_https_except_for_loopback() {
    let registration = issuer::spawn(
        Transport {
            calls: Arc::new(AtomicUsize::new(0)),
        },
        Arc::new(AtomicBool::new(true)),
    );
    let request = ExecutionRequest {
        task_id: "secure".into(),
        ..Default::default()
    };
    let server = |url: &str| {
        BTreeMap::from([(
            "business".into(),
            json!({
                "url": url,
                "headers": {"Authorization": "Bearer ${{task_token}}"}
            }),
        )])
    };

    let error = match prepare_servers(
        &request,
        server("http://business.example/mcp"),
        Ok(registration.issuer.clone()),
    )
    .await
    {
        Ok(_) => panic!("non-loopback HTTP should be rejected"),
        Err(error) => error,
    };
    assert!(error.contains("requires HTTPS"));
    assert!(prepare_servers(
        &request,
        server("http://localhost:3000/mcp"),
        Ok(registration.issuer.clone()),
    )
    .await
    .is_ok());
    assert!(prepare_servers(
        &request,
        server("https://business.example/mcp"),
        Ok(registration.issuer.clone()),
    )
    .await
    .is_ok());
}

#[tokio::test]
async fn routes_are_task_scoped_and_closed_when_execution_finishes() {
    let calls = Arc::new(AtomicUsize::new(0));
    let registration = issuer::spawn(
        Transport {
            calls: calls.clone(),
        },
        Arc::new(AtomicBool::new(true)),
    );
    let received = Arc::new(StdMutex::new(Vec::<String>::new()));
    let received_handler = received.clone();
    let server = Router::new().route(
        "/mcp",
        any(move |headers: HeaderMap| {
            let received = received_handler.clone();
            async move {
                received
                    .lock()
                    .unwrap()
                    .push(headers["authorization"].to_str().unwrap().into());
                (
                    [("mcp-session-id", "session")],
                    axum::Json(json!({"result": "ok"})),
                )
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/mcp", listener.local_addr().unwrap());
    let server_task = tokio::spawn(async move {
        axum::serve(listener, server).await.unwrap();
    });
    let config = BTreeMap::from([(
        "business".into(),
        json!({"url": upstream, "headers": {"Authorization": "Bearer ${{task_token}}"}}),
    )]);
    let request = |id: &str| ExecutionRequest {
        task_id: id.into(),
        auth_token: Some("login-secret-must-not-leak".into()),
        ..Default::default()
    };
    let a = prepare_servers(
        &request("a"),
        config.clone(),
        Ok(registration.issuer.clone()),
    )
    .await
    .unwrap();
    let b = prepare_servers(&request("b"), config, Ok(registration.issuer.clone()))
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let a_url = a.servers["business"]["url"].as_str().unwrap().to_owned();
    for prepared in [&a, &b] {
        assert!(!serde_json::to_string(&prepared.servers)
            .unwrap()
            .contains("secret"));
        let response = client
            .post(prepared.servers["business"]["url"].as_str().unwrap())
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert_eq!(response.headers()["mcp-session-id"], "session");
    }
    assert_eq!(
        *received.lock().unwrap(),
        ["Bearer task-secret-a", "Bearer task-secret-b"]
    );
    // Renew in memory without changing either task identity or the configured route.
    a.identity.as_ref().unwrap().token.lock().await.expires = tokio::time::Instant::now();
    assert!(client
        .post(&a_url)
        .send()
        .await
        .unwrap()
        .status()
        .is_success());
    assert_eq!(
        received.lock().unwrap().last().unwrap(),
        "Bearer task-secret-a"
    );
    assert_eq!(
        client
            .post(&a_url)
            .header("Origin", "https://evil.invalid")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    drop(registration);
    assert_eq!(
        client.post(&a_url).send().await.unwrap().status(),
        StatusCode::BAD_GATEWAY
    );
    drop(a);
    server_task.abort();
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[test]
fn materialization_preserves_source_and_excludes_only_declared_remote_mcps() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join(".codex-plugin")).unwrap();
    std::fs::write(
        root.path().join(".codex-plugin/plugin.json"),
        json!({"name": "fixture", "mcpServers": "./.mcp.json"}).to_string(),
    )
    .unwrap();
    let source = json!({"mcpServers": {
        "private": {"url": "https://business.invalid/mcp", "headers": {"Authorization": "Bearer ${{task_token}}"}},
        "public": {"url": "https://public.invalid/mcp"},
        "local": {"command": "node", "args": ["server.js"]}
    }}).to_string();
    std::fs::write(root.path().join(".mcp.json"), &source).unwrap();
    let first = package::materialize(root.path(), false).unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first, package::materialize(root.path(), false).unwrap());
    assert_eq!(
        std::fs::read_to_string(root.path().join(".mcp.json")).unwrap(),
        source
    );
    let native: Value = serde_json::from_str(
        &std::fs::read_to_string(root.path().join(".wegent-native-mcp-codex.json")).unwrap(),
    )
    .unwrap();
    assert!(native["mcpServers"]["private"].is_null());
    assert!(native["mcpServers"]["public"].is_object());
    assert!(native["mcpServers"]["local"].is_object());
}

#[test]
fn runtime_specific_plugin_declarations_stay_independent() {
    let root = tempfile::tempdir().unwrap();
    for runtime in ["codex", "claude"] {
        std::fs::create_dir(root.path().join(format!(".{runtime}-plugin"))).unwrap();
        std::fs::write(
            root.path().join(format!(".{runtime}-plugin/plugin.json")),
            json!({"mcpServers": {runtime: {"url": "https://business.invalid/mcp", "headers": {"Authorization": "Bearer ${{task_token}}"}}}}).to_string(),
        ).unwrap();
    }
    for _ in 0..2 {
        assert_eq!(
            package::materialize(root.path(), false)
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["codex"]
        );
        assert_eq!(
            package::materialize(root.path(), true)
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["claude"]
        );
    }
}

#[tokio::test]
async fn only_task_authenticated_plugins_require_a_connected_account() {
    let request = ExecutionRequest::default();
    assert!(
        prepare_servers(&request, BTreeMap::new(), Err("offline".into()))
            .await
            .is_ok()
    );
    let config = BTreeMap::from([(
        "business".into(),
        json!({"url": "https://business.invalid/mcp", "headers": {"Authorization": "Bearer ${{task_token}}"}}),
    )]);
    assert!(
        prepare_servers(&request, config.clone(), Err("offline".into()))
            .await
            .is_err()
    );
    let request = ExecutionRequest {
        task_id: "real-task".into(),
        auth_token: Some("login-secret".into()),
        ..Default::default()
    };
    assert!(prepare_servers(&request, config, Err("offline".into()))
        .await
        .is_err());
}

#[tokio::test]
async fn legacy_sse_announces_only_the_authenticated_local_endpoint() {
    let calls = Arc::new(AtomicUsize::new(0));
    let registration = issuer::spawn(Transport { calls }, Arc::new(AtomicBool::new(true)));
    let app = Router::new()
        .route(
            "/sse",
            any(|| async {
                (
                    [("content-type", "text/event-stream")],
                    "event: endpoint\r\ndata: /messages?session=one\r\n\r\n",
                )
            }),
        )
        .route(
            "/messages",
            any(|headers: HeaderMap| async move {
                assert_eq!(headers["authorization"], "Bearer task-secret-stable");
                StatusCode::ACCEPTED
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream = format!("http://{}/sse", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let request = ExecutionRequest {
        task_id: "turn-id".into(),
        extra: serde_json::Map::from_iter([("runtimeLocalTaskId".into(), json!("stable"))]),
        ..Default::default()
    };
    let prepared = prepare_servers(&request, BTreeMap::from([("sse".into(), json!({"type": "sse", "url": upstream, "headers": {"Authorization": "Bearer ${{task_token}}"}}))]), Ok(registration.issuer.clone())).await.unwrap();
    let client = reqwest::Client::new();
    let url = prepared.servers["sse"]["url"].as_str().unwrap();
    let response = client.get(url).send().await.unwrap().text().await.unwrap();
    assert_eq!(
        response,
        format!("event: endpoint\ndata: {url}/messages\n\n")
    );
    assert_eq!(
        client
            .post(format!("{url}/messages"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::ACCEPTED
    );
    let identity = prepared.identity.as_ref().unwrap().clone();
    drop(prepared);
    assert!(identity.token().await.is_err());
    task.abort();
}

#[test]
fn claude_default_mcp_autoload_is_filtered_without_losing_task_declarations() {
    let root = tempfile::tempdir().unwrap();
    for runtime in ["codex", "claude"] {
        std::fs::create_dir(root.path().join(format!(".{runtime}-plugin"))).unwrap();
        std::fs::write(
            root.path().join(format!(".{runtime}-plugin/plugin.json")),
            json!({"mcpServers":"./.mcp.json"}).to_string(),
        )
        .unwrap();
    }
    std::fs::write(root.path().join(".mcp.json"), json!({"private":{"url":"https://business.invalid/mcp", "headers":{"Authorization":"Bearer ${{task_token}}"}}, "public":{"url":"https://public.invalid/mcp"}}).to_string()).unwrap();
    for claude in [true, false, true, false] {
        let prepared = package::materialize(root.path(), claude).unwrap();
        assert_eq!(prepared.len(), 1);
        assert!(prepared.contains_key("private"));
        let default: Value =
            serde_json::from_slice(&std::fs::read(root.path().join(".mcp.json")).unwrap()).unwrap();
        assert!(default["mcpServers"]["private"].is_null());
        assert!(default["mcpServers"]["public"].is_object());
    }
}
