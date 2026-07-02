// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};
use wegent_executor::{
    config::device::{ConnectionConfig, DeviceConfig, UpdateConfig},
    local::backend::{
        local_backend_connection_failure_log_line, local_backend_registered_log_line,
        local_backend_starting_log_line, EventHandler, LocalBackendClient, LocalBackendConfig,
        LocalBackendRunner, LocalBackendTransport,
    },
};

static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn local_backend_config_uses_heartbeat_call_timeout_env() {
    let _env = EnvGuard::set("LOCAL_HEARTBEAT_CALL_TIMEOUT", "12");

    let config = LocalBackendConfig::from_device_config(DeviceConfig {
        device_id: "device-1".to_owned(),
        device_name: "Device One".to_owned(),
        device_type: "local".to_owned(),
        bind_shell: "claudecode".to_owned(),
        connection: ConnectionConfig {
            backend_url: "http://localhost:8000".to_owned(),
            auth_token: "wg-token".to_owned(),
        },
        ..DeviceConfig::default()
    });

    assert_eq!(config.heartbeat_timeout, Duration::from_secs(12));
}

#[tokio::test]
async fn send_heartbeat_propagates_timeout_error_and_passes_configured_timeout() {
    let transport =
        ScriptedTransport::with_call_results(vec![Err("device:heartbeat timed out".to_owned())]);
    let mut config = local_backend_config();
    config.heartbeat_timeout = Duration::from_secs(12);
    let client = LocalBackendClient::new(config.clone(), transport.clone());

    let error = client
        .send_heartbeat(config.heartbeat_timeout)
        .await
        .unwrap_err();

    assert_eq!(error, "device:heartbeat timed out");
    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].event, "device:heartbeat");
    assert_eq!(calls[0].timeout, Duration::from_secs(12));
}

#[tokio::test]
async fn send_heartbeat_propagates_transport_error() {
    let transport = ScriptedTransport::with_call_results(vec![Err("socket closed".to_owned())]);
    let client = LocalBackendClient::new(local_backend_config(), transport);

    let error = client
        .send_heartbeat(Duration::from_secs(2))
        .await
        .unwrap_err();

    assert_eq!(error, "socket closed");
}

#[test]
fn local_backend_connection_failure_log_line_includes_backend_url() {
    let line = local_backend_connection_failure_log_line(
        "http://localhost:8000",
        "device:register timed out",
    );

    assert_log_timestamp(&line);
    assert!(
        line.ends_with(
            " local backend connection failed backend_url=http://localhost:8000 error=\"device:register timed out\""
        )
    );
}

#[test]
fn local_backend_starting_log_line_includes_backend_url_and_device() {
    let line = local_backend_starting_log_line("http://localhost:8000", "device-1");

    assert_log_timestamp(&line);
    assert!(line.ends_with(
        " local backend runner starting backend_url=http://localhost:8000 device_id=device-1"
    ));
}

#[test]
fn local_backend_registered_log_line_includes_backend_url_and_device() {
    let line = local_backend_registered_log_line("http://localhost:8000", "device-1");

    assert_log_timestamp(&line);
    assert!(line.ends_with(
        " local backend registered backend_url=http://localhost:8000 device_id=device-1"
    ));
}

fn assert_log_timestamp(line: &str) {
    let timestamp = &line[..19];
    assert_eq!(timestamp.as_bytes()[4], b'-');
    assert_eq!(timestamp.as_bytes()[7], b'-');
    assert_eq!(timestamp.as_bytes()[10], b' ');
    assert_eq!(timestamp.as_bytes()[13], b':');
    assert_eq!(timestamp.as_bytes()[16], b':');
}

#[tokio::test]
async fn runner_reconnects_after_repeated_heartbeat_failures() {
    let transport = ScriptedTransport::with_call_results(vec![
        Ok(json!({"success": true})),
        Err("heartbeat timeout 1".to_owned()),
        Err("heartbeat timeout 2".to_owned()),
        Err("heartbeat timeout 3".to_owned()),
        Ok(json!({"success": true})),
    ]);
    let mut config = local_backend_config();
    config.heartbeat_interval = Duration::from_millis(5);
    config.heartbeat_timeout = Duration::from_millis(1);
    config.reconnect_delay = Duration::from_millis(1);
    config.reconnect_delay_max = Duration::from_millis(1);
    let runner = LocalBackendRunner::new(config, transport.clone());

    let task = tokio::spawn(runner.run_forever());

    transport.wait_for_connects(2).await;
    task.abort();
    let _ = task.await;

    assert!(transport.connects() >= 2);
    assert!(transport.disconnects() >= 1);
    assert!(transport.event_count("device:heartbeat") >= 3);
}

#[derive(Clone, Debug)]
struct RecordedCall {
    event: String,
    timeout: Duration,
}

#[derive(Clone, Default)]
struct ScriptedTransport {
    calls: Arc<Mutex<Vec<RecordedCall>>>,
    call_results: Arc<Mutex<VecDeque<Result<Value, String>>>>,
    handlers: Arc<Mutex<Vec<(String, EventHandler)>>>,
    connects: Arc<Mutex<usize>>,
    disconnects: Arc<Mutex<usize>>,
    notify: Arc<tokio::sync::Notify>,
}

impl ScriptedTransport {
    fn with_call_results(results: Vec<Result<Value, String>>) -> Self {
        Self {
            call_results: Arc::new(Mutex::new(results.into())),
            ..Self::default()
        }
    }

    fn calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().unwrap().clone()
    }

    fn connects(&self) -> usize {
        *self.connects.lock().unwrap()
    }

    fn disconnects(&self) -> usize {
        *self.disconnects.lock().unwrap()
    }

    fn event_count(&self, event: &str) -> usize {
        self.calls()
            .iter()
            .filter(|call| call.event == event)
            .count()
    }

    async fn wait_for_connects(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if self.connects() >= count {
                    return;
                }
                self.notify.notified().await;
            }
        })
        .await
        .unwrap();
    }
}

impl LocalBackendTransport for ScriptedTransport {
    fn connect<'a>(
        &'a self,
        _config: &'a LocalBackendConfig,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            *self.connects.lock().unwrap() += 1;
            self.notify.notify_waiters();
            Ok(())
        })
    }

    fn disconnect<'a>(&'a self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            *self.disconnects.lock().unwrap() += 1;
            self.notify.notify_waiters();
            Ok(())
        })
    }

    fn call<'a>(
        &'a self,
        event: &'a str,
        _payload: Value,
        timeout: Duration,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(RecordedCall {
                event: event.to_owned(),
                timeout,
            });
            self.notify.notify_waiters();
            self.call_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Ok(json!({"success": true})))
        })
    }

    fn emit<'a>(
        &'a self,
        _event: &'a str,
        _payload: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn on(&self, event: &str, handler: EventHandler) {
        self.handlers
            .lock()
            .unwrap()
            .push((event.to_owned(), handler));
    }
}

fn local_backend_config() -> LocalBackendConfig {
    LocalBackendConfig {
        backend_url: "http://localhost:8000".to_owned(),
        auth_token: "wg-token".to_owned(),
        device_id: "device-1".to_owned(),
        device_name: "Device One".to_owned(),
        device_type: "local".to_owned(),
        app_device_id: String::new(),
        bind_shell: "claudecode".to_owned(),
        executor_version: "test-version".to_owned(),
        client_ip: "192.0.2.10".to_owned(),
        runtime_transfer_host: "192.0.2.10".to_owned(),
        heartbeat_interval: Duration::from_secs(30),
        heartbeat_timeout: Duration::from_secs(10),
        registration_timeout: Duration::from_secs(10),
        reconnect_delay: Duration::from_secs(1),
        reconnect_delay_max: Duration::from_secs(30),
        configured_capabilities: Vec::new(),
        runtime_auth_home: std::env::temp_dir()
            .join(format!("wegent-resilience-contract-{}", std::process::id())),
        local_workspace_root: std::env::temp_dir().join(format!(
            "wegent-resilience-workspace-{}",
            std::process::id()
        )),
        update: UpdateConfig::default(),
    }
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let guard = ENV_LOCK.lock().unwrap();
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self {
            key,
            previous,
            _guard: guard,
        }
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
