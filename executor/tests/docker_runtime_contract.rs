// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use tokio::{
    net::TcpListener,
    time::{timeout, Duration},
};
use tower::ServiceExt;
use wegent_executor::{
    heartbeat::{start_heartbeat, HeartbeatConfig},
    server::create_docker_router_from_env,
};

async fn env_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[tokio::test]
async fn default_docker_router_runs_claude_subprocess_and_sends_callbacks() {
    let fake_claude = write_fake_executable(
        "docker-fake-claude",
        r#"#!/bin/sh
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"docker done"}]}}'
"#,
    );
    let callback = CallbackCapture::start().await;
    let _lock = env_lock().await;
    let _claude = EnvGuard::set("CLAUDE_BINARY_PATH", &fake_claude.display().to_string());
    let _callback = EnvGuard::set("CALLBACK_URL", &callback.url);
    let _executor_name = EnvGuard::set("EXECUTOR_NAME", "pod-from-env");
    let _executor_namespace = EnvGuard::set("EXECUTOR_NAMESPACE", "namespace-from-env");
    let app = create_docker_router_from_env().unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::POST)
                .uri("/v1/responses")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "input": "run in docker",
                        "background": true,
                        "model_config": {
                            "model": "anthropic",
                            "model_id": "claude-sonnet-4"
                        },
                        "metadata": {
                            "task_id": 91,
                            "subtask_id": 92,
                            "bot": [{"shell_type": "ClaudeCode"}]
                        }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let events = callback.wait_for_events(3).await;

    assert_eq!(events[0]["event_type"], "response.created");
    assert_eq!(events[0]["task_id"], 91);
    assert_eq!(events[0]["executor_name"], "pod-from-env");
    assert_eq!(events[0]["executor_namespace"], "namespace-from-env");
    assert_eq!(events[1]["event_type"], "response.output_text.delta");
    assert_eq!(events[1]["data"]["delta"], "docker done");
    assert_eq!(events[2]["event_type"], "response.completed");
    assert_eq!(
        events[2]["data"]["response"]["output"][0]["content"][0]["text"],
        "docker done"
    );
}

#[tokio::test]
async fn docker_heartbeat_posts_to_sandbox_endpoint_from_python_env_contract() {
    let heartbeat = HeartbeatCapture::start().await;
    let config = {
        let _lock = env_lock().await;
        let _enabled = EnvGuard::set("HEARTBEAT_ENABLED", "true");
        let _id = EnvGuard::set("HEARTBEAT_ID", "sandbox-1385");
        let _kind = EnvGuard::set("HEARTBEAT_TYPE", "sandbox");
        let _base = EnvGuard::set("EXECUTOR_MANAGER_HEARTBEAT_BASE_URL", &heartbeat.base_url);
        let _interval = EnvGuard::set("HEARTBEAT_INTERVAL", "1");
        HeartbeatConfig::from_env().unwrap()
    };
    let handle = start_heartbeat(config);

    let calls = heartbeat.wait_for_calls(1).await;
    handle.abort();

    assert_eq!(calls[0]["heartbeat_id"], "sandbox-1385");
    assert_eq!(calls[0]["heartbeat_type"], "sandbox");
    assert_eq!(
        heartbeat.paths.lock().unwrap()[0],
        "/sandboxes/sandbox-1385/heartbeat"
    );
}

struct CallbackCapture {
    url: String,
    events: Arc<Mutex<Vec<Value>>>,
    notify: Arc<tokio::sync::Notify>,
}

struct HeartbeatCapture {
    base_url: String,
    calls: Arc<Mutex<Vec<Value>>>,
    paths: Arc<Mutex<Vec<String>>>,
    notify: Arc<tokio::sync::Notify>,
}

impl HeartbeatCapture {
    async fn start() -> Self {
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let paths = Arc::new(Mutex::new(Vec::<String>::new()));
        let notify = Arc::new(tokio::sync::Notify::new());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().fallback({
            let calls = calls.clone();
            let paths = paths.clone();
            let notify = notify.clone();
            move |request: Request<Body>| async move {
                let path = request.uri().path().to_owned();
                let bytes = axum::body::to_bytes(request.into_body(), usize::MAX)
                    .await
                    .unwrap();
                let payload: Value = serde_json::from_slice(&bytes).unwrap();
                paths.lock().unwrap().push(path);
                calls.lock().unwrap().push(payload);
                notify.notify_waiters();
                Json(json!({"status": "ok"}))
            }
        });
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        Self {
            base_url,
            calls,
            paths,
            notify,
        }
    }

    async fn wait_for_calls(&self, count: usize) -> Vec<Value> {
        timeout(Duration::from_secs(2), async {
            loop {
                let calls = self.calls.lock().unwrap().clone();
                if calls.len() >= count {
                    return calls;
                }
                self.notify.notified().await;
            }
        })
        .await
        .unwrap()
    }
}

impl CallbackCapture {
    async fn start() -> Self {
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let notify = Arc::new(tokio::sync::Notify::new());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/callback", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/callback",
            post({
                let events = events.clone();
                let notify = notify.clone();
                move |Json(payload): Json<Value>| async move {
                    events.lock().unwrap().push(payload);
                    notify.notify_waiters();
                    Json(json!({"status": "SUCCESS"}))
                }
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        Self {
            url,
            events,
            notify,
        }
    }

    async fn wait_for_events(&self, count: usize) -> Vec<Value> {
        timeout(Duration::from_secs(2), async {
            loop {
                let events = self.events.lock().unwrap().clone();
                if events.len() >= count {
                    return events;
                }
                self.notify.notified().await;
            }
        })
        .await
        .unwrap()
    }
}

fn write_fake_executable(name: &str, content: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}
