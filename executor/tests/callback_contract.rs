// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use axum::{http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};
use tokio::net::TcpListener;

use wegent_executor::{
    callback::{CallbackRetryConfig, CallbackSink},
    emitter::EventEnvelope,
    runner::EventSink,
};

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
}

#[tokio::test]
async fn callback_sink_skips_empty_url() {
    let sink = CallbackSink::new("").unwrap();

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
    }
}

fn test_callback_sink(callback_url: String) -> CallbackSink {
    CallbackSink::new_with_retry_config(
        callback_url,
        CallbackRetryConfig::new(3, Duration::from_millis(0), Duration::from_millis(0)),
    )
    .unwrap()
}
