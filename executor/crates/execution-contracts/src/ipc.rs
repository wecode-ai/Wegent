// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;
use std::{future::Future, pin::Pin};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait RuntimeWorkHandler: Send + Sync {
    fn handle_runtime_rpc<'a>(&'a self, data: Value) -> BoxFuture<'a, Result<Value, AppIpcError>>;

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
