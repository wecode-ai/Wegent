// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Arc, Mutex};

use axum::{routing::post, Json, Router};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use wegent_executor::{callback::CallbackSink, emitter::EventEnvelope, runner::EventSink};

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

    let sink = CallbackSink::new(url).unwrap();
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

fn sample_event() -> EventEnvelope {
    EventEnvelope {
        event_type: "response.created".to_owned(),
        task_id: 1,
        subtask_id: 2,
        data: json!({"type": "response.created"}),
        message_id: None,
        executor_name: None,
        executor_namespace: None,
    }
}
