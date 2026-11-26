// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;
use std::{future::Future, pin::Pin};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub type TurnObserver = std::sync::Arc<dyn Fn(&crate::emitter::EventEnvelope) + Send + Sync>;

/// Releases a suspended Shell interaction and returns the bound attempt and its terminal delivery.
pub type CancelSuspendedTurn =
    Box<dyn FnOnce() -> Option<(String, BoxFuture<'static, bool>)> + Send>;

pub trait ShellTurn: Send + Sync {
    fn start(&self) -> BoxFuture<'_, crate::ExecutionOutcome>;
    fn interrupt(&self);
}

/// Authenticated protocol destination for one platform attempt.
pub trait PlatformTurn: Send + Sync {
    fn request(&self) -> wegent_protocol::ExecutionRequest;
    fn task_id(&self) -> &str;
    fn authorized(&self) -> bool;
    fn backend_origin(&self) -> Option<&str>;
    fn starting(&self, observer: Option<TurnObserver>);
    fn created(&self) -> BoxFuture<'_, Result<(), String>>;
    fn terminal(
        &self,
        outcome: crate::ExecutionOutcome,
    ) -> BoxFuture<'_, Option<crate::emitter::EventEnvelope>>;
    fn deliver_terminal(
        &self,
        event: crate::emitter::EventEnvelope,
    ) -> BoxFuture<'_, Result<(), String>>;
}

pub trait RuntimeWorkHandler: Send + Sync {
    fn handle_runtime_rpc<'a>(&'a self, data: Value) -> BoxFuture<'a, Result<Value, AppIpcError>>;

    fn running_platform_task_ids(&self, _scope: &str) -> Vec<String> {
        Vec::new()
    }

    fn submit_platform_turn<'a>(
        &'a self,
        _session: String,
        _subtask: String,
        _turn: std::sync::Arc<dyn PlatformTurn>,
        _shell: std::sync::Arc<dyn ShellTurn>,
    ) -> BoxFuture<'a, Result<crate::RunnerResult, AppIpcError>> {
        Box::pin(async {
            Err(AppIpcError::new(
                "runtime_unavailable",
                "Device scheduler unavailable",
            ))
        })
    }

    fn cancel_platform_turn<'a>(
        &'a self,
        _session: String,
        _subtask: Option<String>,
        _remember: bool,
        _suspended: CancelSuspendedTurn,
    ) -> BoxFuture<'a, bool> {
        Box::pin(async { false })
    }

    /// Resolve the authenticated service owner without exposing account credentials to plugins.
    fn connection_service_owner<'a>(&'a self) -> BoxFuture<'a, Result<i64, AppIpcError>> {
        Box::pin(async {
            Err(AppIpcError::new(
                "cloud_unavailable",
                "Connected account is unavailable",
            ))
        })
    }

    /// The grant is supplied by the native endpoint, never deserialized from RPC input.
    fn handle_connection_read_rpc<'a>(
        &'a self,
        _method: &'a str,
        _payload: Value,
        _grant: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>> {
        Box::pin(async {
            Err(AppIpcError::new(
                "permission_denied",
                "Verified connection reads are unavailable",
            ))
        })
    }

    fn reconcile_bound_task_statuses<'a>(&'a self) -> BoxFuture<'a, ()> {
        Box::pin(async {})
    }

    fn handle_codex_app_server_rpc<'a>(
        &'a self,
        _data: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>> {
        Box::pin(async {
            Err(AppIpcError::new(
                "codex_app_server_unavailable",
                "Codex app-server handler is not available",
            ))
        })
    }
}

pub trait BackendConnectionHandler: Send + Sync {
    fn configure_plugin_auth<'a>(
        &'a self,
        _params: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>> {
        Box::pin(async {
            Err(AppIpcError::new(
                "plugin_auth_http_unsupported",
                "Native plugin authorization is unavailable",
            ))
        })
    }
    fn plugin_local_sync<'a>(
        &'a self,
        _params: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>> {
        Box::pin(async {
            Err(AppIpcError::new(
                "plugin_local_sync_unsupported",
                "Local plugin synchronization is unavailable",
            ))
        })
    }

    fn execute_plugin_auth<'a>(
        &'a self,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>>;
    fn migrate_plugin_auth<'a>(
        &'a self,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>>;
    fn configure_backend<'a>(&'a self, params: Value) -> BoxFuture<'a, Result<Value, AppIpcError>>;
    fn backend_quota<'a>(&'a self) -> BoxFuture<'a, Result<Value, AppIpcError>>;
    fn backend_status<'a>(&'a self) -> BoxFuture<'a, Result<Value, AppIpcError>>;
    fn plugin_device_route<'a>(
        &'a self,
        params: Value,
    ) -> BoxFuture<'a, Result<Value, AppIpcError>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppIpcError {
    pub code: String,
    pub message: String,
    pub retry_after_ms: Option<u64>,
    pub provider_code: Option<String>,
}

impl AppIpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retry_after_ms: None,
            provider_code: None,
        }
    }

    pub fn with_retry_after_ms(mut self, delay: u64) -> Self {
        self.retry_after_ms = Some(delay.clamp(1, 3_600_000));
        self
    }
}
