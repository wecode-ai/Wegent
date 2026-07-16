// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};
use wegent_executor::{
    config::device::UpdateConfig,
    local::backend::{EventHandler, LocalBackendConfig, LocalBackendRunner, LocalBackendTransport},
    protocol::{ExecutionRequest, TaskStatus},
    server::{RunnerResult, TaskRunner},
};

#[tokio::test]
async fn task_execute_preserves_skill_identity_token() {
    let transport = RecordingTransport::default();
    let task_runner = RecordingTaskRunner::default();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        task_runner.clone(),
    );
    runner.register_handlers();

    let handler = transport.handler("task:execute").unwrap();
    let ack = handler(json!({
        "task_id": 1,
        "subtask_id": 2,
        "skill_identity_token": "skill-jwt",
    }))
    .await;

    assert_eq!(ack, None);
    let submitted = task_runner.submitted();
    assert_eq!(submitted.len(), 1);
    assert_eq!(
        submitted[0].skill_identity_token.as_deref(),
        Some("skill-jwt")
    );
}

#[tokio::test]
async fn task_cancel_marks_registered_task_as_cancel_requested() {
    let transport = RecordingTransport::default();
    let task_runner = RecordingTaskRunner::default();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        task_runner.clone(),
    );
    runner.register_handlers();

    transport.handler("task:execute").unwrap()(json!({"task_id": 10, "subtask_id": 20})).await;
    transport.handler("task:cancel").unwrap()(json!({"task_id": 10, "subtask_id": 20})).await;

    assert!(runner.is_cancel_requested("10", Some("20")));
    let snapshot = runner.cancellation_snapshot();
    assert_eq!(snapshot.cancel_requested_task_ids, vec!["10".to_owned()]);
    assert!(snapshot.pending_task_ids.is_empty());
    assert!(snapshot.pending_subtask_ids.is_empty());
}

#[tokio::test]
async fn task_cancel_before_registration_is_stored_by_subtask_and_consumed_on_execute() {
    let transport = RecordingTransport::default();
    let task_runner = RecordingTaskRunner::default();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        task_runner.clone(),
    );
    runner.register_handlers();

    transport.handler("task:cancel").unwrap()(json!({"task_id": 10, "subtask_id": 20})).await;

    let pending = runner.cancellation_snapshot();
    assert!(pending.pending_task_ids.is_empty());
    assert_eq!(pending.pending_subtask_ids, vec!["20".to_owned()]);
    assert!(pending.cancel_requested_task_ids.is_empty());

    transport.handler("task:execute").unwrap()(json!({"task_id": 10, "subtask_id": 20})).await;

    let consumed = runner.cancellation_snapshot();
    assert!(runner.is_cancel_requested("10", Some("20")));
    assert!(consumed.pending_task_ids.is_empty());
    assert!(consumed.pending_subtask_ids.is_empty());
    assert_eq!(consumed.cancel_requested_task_ids, vec!["10".to_owned()]);
}

#[tokio::test]
async fn task_cancel_before_registration_without_subtask_is_stored_by_task() {
    let transport = RecordingTransport::default();
    let task_runner = RecordingTaskRunner::default();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        task_runner,
    );
    runner.register_handlers();

    transport.handler("task:cancel").unwrap()(json!({"task_id": 11})).await;

    let snapshot = runner.cancellation_snapshot();
    assert_eq!(snapshot.pending_task_ids, vec!["11".to_owned()]);
    assert!(snapshot.pending_subtask_ids.is_empty());
    assert!(snapshot.cancel_requested_task_ids.is_empty());
}

#[derive(Clone, Default)]
struct RecordingTransport {
    handlers: Arc<Mutex<Vec<(String, EventHandler)>>>,
}

impl RecordingTransport {
    fn handler(&self, event: &str) -> Option<EventHandler> {
        self.handlers
            .lock()
            .unwrap()
            .iter()
            .find(|(name, _)| name == event)
            .map(|(_, handler)| Arc::clone(handler))
    }
}

impl LocalBackendTransport for RecordingTransport {
    fn connect<'a>(
        &'a self,
        _config: &'a LocalBackendConfig,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn disconnect<'a>(&'a self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn call<'a>(
        &'a self,
        _event: &'a str,
        _payload: Value,
        _timeout: Duration,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(async { Ok(json!({"success": true})) })
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

#[derive(Clone, Default)]
struct RecordingTaskRunner {
    submitted: Arc<Mutex<Vec<ExecutionRequest>>>,
}

impl RecordingTaskRunner {
    fn submitted(&self) -> Vec<ExecutionRequest> {
        self.submitted.lock().unwrap().clone()
    }
}

impl TaskRunner for RecordingTaskRunner {
    type SubmitFuture = Pin<Box<dyn Future<Output = RunnerResult> + Send>>;

    fn submit(&self, request: ExecutionRequest) -> Self::SubmitFuture {
        self.submitted.lock().unwrap().push(request);
        Box::pin(async { RunnerResult::accepted(TaskStatus::Running) })
    }
}

fn local_backend_config() -> LocalBackendConfig {
    LocalBackendConfig {
        backend_url: "http://localhost:8000".to_owned(),
        auth_token: "wg-token".to_owned(),
        device_id: "device-1".to_owned(),
        runtime_instance_id: "runtime-1".to_owned(),
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
            .join(format!("wegent-dispatch-contract-{}", std::process::id())),
        local_workspace_root: std::env::temp_dir()
            .join(format!("wegent-dispatch-workspace-{}", std::process::id())),
        update: UpdateConfig::default(),
    }
}
