// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;

use axum::{http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};
use tokio::net::TcpListener;

use wegent_executor::{
    callback::{CallbackRetryConfig, CallbackSink},
    emitter::EventEnvelope,
    runner::EventSink,
};

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        // SAFETY: the key is static and this test is the only writer.
        unsafe { std::env::set_var(key, value) };
        Self { key, previous }
    }

    fn remove(key: &'static str) -> Self {
        let previous = std::env::var(key).ok();
        // SAFETY: the key is static and this test is the only writer.
        unsafe { std::env::remove_var(key) };
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            // SAFETY: the key is static and this test is the only writer.
            unsafe { std::env::set_var(self.key, previous) };
        } else {
            // SAFETY: the key is static and this test is the only writer.
            unsafe { std::env::remove_var(self.key) };
        }
    }
}

/// Serialize tests that mutate process-wide callback configuration.
static CONFIG_ENV_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

#[tokio::test]
async fn health_acknowledges_only_the_matching_callback_projection() {
    use axum::{body::Body, http::Request};
    use sha2::{Digest, Sha256};
    use tower::ServiceExt;
    use wegent_executor::server::create_docker_router_from_env;

    let _config_env = CONFIG_ENV_LOCK.lock().await;
    let config_dir = tempfile::tempdir().unwrap();
    let _config_dir = EnvGuard::set("WEGENT_CONFIG_DIR", config_dir.path().to_str().unwrap());
    let app = create_docker_router_from_env().unwrap();
    let probe = |token: &str| {
        let request = Request::builder()
            .uri("/health")
            .header(
                "x-wegent-callback-digest",
                format!("{:x}", Sha256::digest(token.as_bytes())),
            )
            .body(Body::empty())
            .unwrap();
        app.clone().oneshot(request)
    };
    let token = "fixture-callback-token";

    assert!(!probe(token)
        .await
        .unwrap()
        .headers()
        .contains_key("x-wegent-callback-ready"));

    std::fs::write(config_dir.path().join("executor_callback_token"), token).unwrap();
    assert!(!probe(token)
        .await
        .unwrap()
        .headers()
        .contains_key("x-wegent-callback-ready"));

    std::fs::write(
        config_dir.path().join("callback_url"),
        "http://localhost/executor-manager/callback",
    )
    .unwrap();
    assert!(!probe("previous-token")
        .await
        .unwrap()
        .headers()
        .contains_key("x-wegent-callback-ready"));

    let response = probe(token).await.unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(response.headers()["x-wegent-callback-ready"], "true");
}

#[tokio::test]
async fn callback_sink_posts_event_envelope_as_json() {
    let received = Arc::new(Mutex::new(Vec::<Value>::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/callback", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/callback",
        post({
            let received = received.clone();
            move |Json(payload): Json<Value>| async move {
                received.lock().unwrap().push(payload);
                Json(json!({"status": "SUCCESS"}))
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let sink = test_callback_sink(url);
    sink.send(sample_event()).await.unwrap();

    let events = received.lock().unwrap().clone();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event_type"], "response.created");
    assert_eq!(events[0]["task_id"], 1);
    assert_eq!(events[0]["subtask_id"], 2);
    assert_eq!(events[0]["data"]["type"], "response.created");
    assert_eq!(events[0]["validation_id"], "validation-1");
}

#[tokio::test]
async fn callback_sink_sends_task_scoped_authorization() {
    let received_headers = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/callback", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/callback",
        post({
            let received_headers = received_headers.clone();
            move |headers: axum::http::HeaderMap, Json(_payload): Json<Value>| async move {
                received_headers.lock().unwrap().push(
                    headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                );
                Json(json!({"status": "SUCCESS"}))
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let sink = CallbackSink::new_with_credentials(
        url,
        Some("callback-token".to_owned()),
        CallbackRetryConfig::new(3, Duration::from_millis(0), Duration::from_millis(0)),
    )
    .unwrap();
    sink.send(sample_event()).await.unwrap();

    assert_eq!(
        received_headers.lock().unwrap().as_slice(),
        [Some("WegentExecutorBinding callback-token".to_owned())].as_slice()
    );
}

#[tokio::test]
async fn callback_sink_reads_warm_pool_token_from_config_file() {
    let _config_env = CONFIG_ENV_LOCK.lock().await;
    let temp_dir = tempfile::tempdir().expect("temp config dir");
    std::fs::write(
        temp_dir.path().join("executor_callback_token"),
        " warm-pool-callback-token
",
    )
    .expect("write callback token");

    let received_headers = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/callback", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/callback",
        post({
            let received_headers = received_headers.clone();
            move |headers: axum::http::HeaderMap, Json(_payload): Json<Value>| async move {
                received_headers.lock().unwrap().push(
                    headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                );
                Json(json!({"status": "SUCCESS"}))
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    // The sink captures the config directory and reads the mounted credential when sending.
    let _config_dir = EnvGuard::set(
        "WEGENT_CONFIG_DIR",
        temp_dir.path().to_str().expect("valid config path"),
    );
    let _direct_token = EnvGuard::remove("EXECUTOR_CALLBACK_TOKEN");
    let sink = CallbackSink::new(url).expect("callback sink");
    drop(_config_dir);
    sink.send(sample_event()).await.unwrap();

    assert_eq!(
        received_headers.lock().unwrap().as_slice(),
        [Some(
            "WegentExecutorBinding warm-pool-callback-token".to_owned()
        )]
        .as_slice()
    );
}

#[tokio::test]
async fn callback_sink_skips_empty_url() {
    let sink =
        CallbackSink::new_with_credentials("", None, CallbackRetryConfig::default()).unwrap();

    sink.send(sample_event()).await.unwrap();
}

#[tokio::test]
async fn callback_sink_returns_status_and_url_for_non_success_response() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/callback", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/callback",
        post(|| async { (StatusCode::INTERNAL_SERVER_ERROR, "backend unavailable") }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let sink = test_callback_sink(url.clone());
    let error = sink.send(sample_event()).await.unwrap_err();

    assert!(error.contains("status=500"));
    assert!(error.contains(&url));
}

#[tokio::test]
async fn callback_sink_reads_mounted_config_after_sink_creation() {
    let _config_env = CONFIG_ENV_LOCK.lock().await;
    let temp_dir = tempfile::tempdir().expect("temp config dir");
    let token_path = temp_dir.path().join("executor_callback_token");

    let received_headers = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/callback", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/callback",
        post({
            let received_headers = received_headers.clone();
            move |headers: axum::http::HeaderMap, Json(_payload): Json<Value>| async move {
                received_headers.lock().unwrap().push(
                    headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                );
                Json(json!({"status": "SUCCESS"}))
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let _config_dir = EnvGuard::set(
        "WEGENT_CONFIG_DIR",
        temp_dir.path().to_str().expect("valid config path"),
    );
    let _direct_token = EnvGuard::remove("EXECUTOR_CALLBACK_TOKEN");
    let sink = CallbackSink::new("").expect("callback sink");
    std::fs::write(temp_dir.path().join("callback_url"), url).expect("write callback URL");
    std::fs::write(&token_path, "late-callback-token\n").expect("write callback token");
    sink.send(sample_event()).await.unwrap();

    assert_eq!(
        received_headers.lock().unwrap().as_slice(),
        [Some("WegentExecutorBinding late-callback-token".to_owned())].as_slice()
    );
}

#[tokio::test]
async fn callback_sink_retries_non_success_response_before_succeeding() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let received = Arc::new(Mutex::new(Vec::<Value>::new()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/callback", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/callback",
        post({
            let attempts = attempts.clone();
            let received = received.clone();
            move |Json(payload): Json<Value>| async move {
                received.lock().unwrap().push(payload);
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    return (StatusCode::INTERNAL_SERVER_ERROR, "backend unavailable");
                }
                (StatusCode::OK, "ok")
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let sink = test_callback_sink(url);
    sink.send(sample_event()).await.unwrap();

    assert_eq!(attempts.load(Ordering::SeqCst), 2);
    assert_eq!(received.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn callback_sink_retries_non_success_response_until_limit() {
    let attempts = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/callback", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/callback",
        post({
            let attempts = attempts.clone();
            move || async move {
                attempts.fetch_add(1, Ordering::SeqCst);
                (StatusCode::INTERNAL_SERVER_ERROR, "backend unavailable")
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    let sink = test_callback_sink(url.clone());
    let error = sink.send(sample_event()).await.unwrap_err();

    assert_eq!(attempts.load(Ordering::SeqCst), 3);
    assert!(error.contains("status=500"));
    assert!(error.contains(&url));
}

#[tokio::test]
async fn callback_sink_rejects_non_numeric_backend_task_identity() {
    let sink = CallbackSink::new("http://127.0.0.1:9/callback").unwrap();
    let error = sink
        .send(EventEnvelope {
            task_id: "runtime-task".to_owned(),
            ..sample_event()
        })
        .await
        .unwrap_err();

    assert!(error.contains("callback task identity is not numeric"));
}

fn sample_event() -> EventEnvelope {
    EventEnvelope {
        event_type: "response.created".to_owned(),
        task_id: "1".to_owned(),
        subtask_id: "2".to_owned(),
        data: json!({"type": "response.created"}),
        message_id: None,
        executor_name: None,
        executor_namespace: None,
        validation_id: Some("validation-1".to_owned()),
    }
}

fn test_callback_sink(callback_url: String) -> CallbackSink {
    CallbackSink::new_with_retry_config(
        callback_url,
        CallbackRetryConfig::new(3, Duration::from_millis(0), Duration::from_millis(0)),
    )
    .unwrap()
}
