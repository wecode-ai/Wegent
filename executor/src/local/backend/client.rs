// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, path::Path, pin::Pin, sync::Arc, time::Duration};

use serde_json::{json, Value};

use crate::{emitter::EventEnvelope, runner::EventSink};

use super::{
    capability::{CapabilityReportProvider, DefaultCapabilityReporter},
    tasks::LocalRunningTaskTracker,
    LocalBackendConfig, LocalBackendTransport,
};

const REGISTER_EVENT: &str = "device:register";
const HEARTBEAT_EVENT: &str = "device:heartbeat";
const CODEX_AUTH_TARGET_PATH: &str = "~/.codex/auth.json";

#[derive(Clone)]
pub struct LocalBackendClient<T>
where
    T: LocalBackendTransport,
{
    pub(super) config: Arc<LocalBackendConfig>,
    pub(super) transport: T,
    running_tasks: LocalRunningTaskTracker,
    capability_reporter: Arc<dyn CapabilityReportProvider>,
}

impl<T> LocalBackendClient<T>
where
    T: LocalBackendTransport,
{
    pub fn new(config: LocalBackendConfig, transport: T) -> Self {
        Self::with_capability_reporter(config, transport, DefaultCapabilityReporter::new())
    }

    pub fn with_capability_reporter<R>(
        config: LocalBackendConfig,
        transport: T,
        capability_reporter: R,
    ) -> Self
    where
        R: CapabilityReportProvider,
    {
        Self::with_capability_reporter_and_tracker(
            config,
            transport,
            capability_reporter,
            LocalRunningTaskTracker::default(),
        )
    }

    pub fn with_capability_reporter_and_tracker<R>(
        config: LocalBackendConfig,
        transport: T,
        capability_reporter: R,
        running_tasks: LocalRunningTaskTracker,
    ) -> Self
    where
        R: CapabilityReportProvider,
    {
        Self {
            config: Arc::new(config),
            transport,
            running_tasks,
            capability_reporter: Arc::new(capability_reporter),
        }
    }

    pub async fn connect(&self) -> Result<(), String> {
        if self.config.backend_url.trim().is_empty() {
            return Err("WEGENT_BACKEND_URL is required for local backend mode".to_owned());
        }
        if self.config.auth_token.trim().is_empty() {
            return Err("WEGENT_AUTH_TOKEN is required for local backend mode".to_owned());
        }
        self.transport.connect(&self.config).await
    }

    pub async fn disconnect(&self) -> Result<(), String> {
        self.transport.disconnect().await
    }

    pub async fn register_device(&self, timeout: Duration) -> Result<bool, String> {
        let response = self
            .transport
            .call(REGISTER_EVENT, self.registration_payload(), timeout)
            .await?;
        Ok(ack_success(&response))
    }

    pub async fn send_heartbeat(&self, timeout: Duration) -> Result<bool, String> {
        let response = self
            .transport
            .call(HEARTBEAT_EVENT, self.heartbeat_payload(), timeout)
            .await?;
        Ok(ack_success(&response))
    }

    pub async fn emit_event(&self, event: EventEnvelope) -> Result<(), String> {
        let event_type = event.event_type.clone();
        let payload = serde_json::to_value(event).map_err(|error| error.to_string())?;
        self.transport.emit(&event_type, payload).await
    }

    pub async fn emit_raw_event(&self, event: &str, payload: Value) -> Result<(), String> {
        self.transport.emit(event, payload).await
    }

    pub fn set_running_task_ids<I>(&self, task_ids: I)
    where
        I: IntoIterator<Item = i64>,
    {
        self.running_tasks.set(task_ids);
    }

    fn registration_payload(&self) -> Value {
        json!({
            "device_id": self.config.device_id,
            "name": self.config.device_name,
            "device_type": self.config.device_type,
            "bind_shell": self.config.bind_shell,
            "executor_version": self.config.executor_version,
            "client_ip": self.config.client_ip,
            "runtime_transfer_host": self.config.runtime_transfer_host,
        })
    }

    fn heartbeat_payload(&self) -> Value {
        let running_task_ids = self.running_tasks.running_task_ids();
        json!({
            "device_id": self.config.device_id,
            "running_task_ids": running_task_ids,
            "executor_version": self.config.executor_version,
            "capabilities": self.capability_reporter.build_report(),
            "runtime_auth_files": build_runtime_auth_file_report(&self.config.runtime_auth_home),
            "runtime_transfer_host": self.config.runtime_transfer_host,
        })
    }
}

#[derive(Clone)]
pub struct LocalBackendEventSink<T>
where
    T: LocalBackendTransport,
{
    client: LocalBackendClient<T>,
}

impl<T> LocalBackendEventSink<T>
where
    T: LocalBackendTransport,
{
    pub fn new(client: LocalBackendClient<T>) -> Self {
        Self { client }
    }
}

impl<T> EventSink for LocalBackendEventSink<T>
where
    T: LocalBackendTransport,
{
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let client = self.client.clone();
        Box::pin(async move { client.emit_event(event).await })
    }
}

pub fn build_runtime_auth_file_report(home: &Path) -> Value {
    json!({
        "codex": {
            "target_path": CODEX_AUTH_TARGET_PATH,
            "exists": home.join(".codex").join("auth.json").is_file(),
        }
    })
}

fn ack_success(response: &Value) -> bool {
    if response.get("success").and_then(Value::as_bool) == Some(true) {
        return true;
    }

    response
        .as_array()
        .map(|values| values.iter().any(ack_success))
        .unwrap_or(false)
}
