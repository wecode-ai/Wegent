// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Executor-manager HTTP dependency for the task delete path.
//!
//! Mirrors the httpx calls `app.services.execution._ExecutorRuntimeClient`
//! issues during `delete_task`:
//!
//! * `get_sandbox` — `GET {base}/executor-manager/sandboxes/{id}` with a 30s
//!   timeout, mapping 404 to "not found" and any other failure to "failed";
//! * `delete_sandbox` — `DELETE {base}/executor-manager/sandboxes/{id}` with a
//!   180s timeout;
//! * `cleanup_sandbox_by_task_id` — `POST
//!   {base}/executor-manager/sandboxes/cleanup-by-task` with a 180s timeout;
//! * `executor_kinds_service.delete_executor_task_sync` — `POST
//!   {base}/executor-manager/executor/delete` with a 30s timeout.
//!
//! The client is built once at startup from `EXECUTOR_MANAGER_URL` (source
//! default `http://localhost:8001`) and retained for the process lifetime.

use std::time::Duration;

use anyhow::{Context as _, Result};
use brz_http::{Client, Endpoint};
use serde::Serialize;

use brz_json::OpaqueJson;

/// `settings.EXECUTOR_MANAGER_URL`'s source default (`app/core/config.py`).
pub const DEFAULT_EXECUTOR_MANAGER_URL: &str = "http://localhost:8001";

/// `settings.EXECUTOR_CANCEL_TASK_URL`'s source default
/// (`app/core/config.py`).
pub const DEFAULT_EXECUTOR_CANCEL_TASK_URL: &str =
    "http://localhost:8001/executor-manager/tasks/cancel";

/// `_call_executor_cancel`'s httpx timeout.
const CANCEL_TASK_TIMEOUT: Duration = Duration::from_secs(60);

/// `_ExecutorRuntimeClient.get_sandbox`'s httpx timeout.
const GET_SANDBOX_TIMEOUT: Duration = Duration::from_secs(30);
/// `delete_sandbox` / `cleanup_sandbox_by_task_id`'s httpx timeout.
const SANDBOX_MUTATION_TIMEOUT: Duration = Duration::from_secs(180);
/// `delete_executor_task_sync`'s requests timeout.
const DELETE_EXECUTOR_TIMEOUT: Duration = Duration::from_secs(30);
/// `ArchiveService._call_executor_restore`'s httpx timeout.
const EXECUTOR_RESTORE_TIMEOUT: Duration = Duration::from_secs(120);

/// `_ExecutorRuntimeClient.get_sandbox`'s result: the source's
/// `(payload, error)` pair collapsed to the branches `delete_task` reads.
#[derive(Debug)]
pub enum SandboxLookup {
    /// HTTP 200 with a decodable body.
    Found,
    /// HTTP 404 (`(None, None)`).
    NotFound,
    /// Any other failure (`(None, Some(error))`).
    Failed,
}

/// `cleanup_sandbox_by_task_id`'s request body.
#[derive(Serialize)]
struct CleanupByTaskRequest {
    task_id: i64,
    dry_run: bool,
    archive_before_delete: bool,
}

/// `_call_executor_cancel`'s request body.
#[derive(Serialize)]
struct ExecutorCancelRequest {
    task_id: i64,
}

/// `executor_kinds_service.delete_executor_task_sync`'s request body.
#[derive(Serialize)]
struct ExecutorDeleteRequest<'a> {
    executor_name: &'a str,
    executor_namespace: &'a str,
}

/// `ArchiveService._call_executor_restore`'s request body.
#[derive(Serialize)]
struct ExecutorRestoreRequest<'a> {
    task_id: i64,
    download_url: &'a str,
    executor_name: &'a str,
    executor_namespace: &'a str,
    runtime_type: &'a str,
}

/// The retained executor-manager client and its resolved base URL.
///
/// Cloning shares the retained HTTP client; request-scoped code takes a clone
/// of the startup-owned instance instead of building a new pool.
#[derive(Clone)]
pub struct ExecutorManager {
    client: Client,
    base: String,
    /// `settings.EXECUTOR_CANCEL_TASK_URL`, which the source keeps as an
    /// independent absolute URL rather than deriving it from the manager base.
    cancel_url: String,
}

impl ExecutorManager {
    /// Build the client from `EXECUTOR_MANAGER_URL` and
    /// `EXECUTOR_CANCEL_TASK_URL`, falling back to the source defaults when
    /// either is unset.
    pub fn from_env() -> Result<Self> {
        let base = std::env::var("EXECUTOR_MANAGER_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_EXECUTOR_MANAGER_URL.to_owned());
        let cancel_url = std::env::var("EXECUTOR_CANCEL_TASK_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_EXECUTOR_CANCEL_TASK_URL.to_owned());
        Self::with_cancel_url(base, cancel_url)
    }

    pub fn new(base: impl Into<String>) -> Result<Self> {
        let base = base.into();
        let cancel_url = format!(
            "{}/executor-manager/tasks/cancel",
            base.trim_end_matches('/')
        );
        Self::with_cancel_url(base, cancel_url)
    }

    fn with_cancel_url(base: impl Into<String>, cancel_url: String) -> Result<Self> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            // Override Breeze's 400ms socket-read default. Each operation's
            // existing request deadline below remains the tighter bound.
            .read_timeout(SANDBOX_MUTATION_TIMEOUT)
            .build()
            .context("failed to build the executor-manager HTTP client")?;
        Ok(Self {
            client,
            base: base.into().trim_end_matches('/').to_owned(),
            cancel_url,
        })
    }

    /// `GET {base}/executor-manager/sandboxes/{task_id}`.
    fn sandbox_endpoint(&self, task_id: &str) -> Result<Endpoint> {
        self.client
            .endpoint_named(
                format!("{}/executor-manager/sandboxes/{task_id}", self.base),
                sandbox_metric_name(&self.base),
            )
            .map_err(anyhow::Error::from)
    }

    /// `_ExecutorRuntimeClient.get_sandbox`.
    pub async fn get_sandbox(&self, task_id: &str) -> SandboxLookup {
        let Ok(endpoint) = self.sandbox_endpoint(task_id) else {
            return SandboxLookup::Failed;
        };
        let response = match endpoint.get().timeout(GET_SANDBOX_TIMEOUT).send().await {
            Ok(response) => response,
            Err(_) => return SandboxLookup::Failed,
        };
        let status = response.status().as_u16();
        if status == 404 {
            return SandboxLookup::NotFound;
        }
        if !(200..300).contains(&status) {
            return SandboxLookup::Failed;
        }
        // `response.json()` accepts any JSON document; a body that does not
        // decode is the source's exception branch.
        match response.json::<OpaqueJson>().await {
            Ok(_) => SandboxLookup::Found,
            Err(_) => SandboxLookup::Failed,
        }
    }

    /// `_ExecutorRuntimeClient.delete_sandbox`: `(deleted, error)`.
    pub async fn delete_sandbox(&self, task_id: &str) -> (bool, Option<String>) {
        let Ok(endpoint) = self.sandbox_endpoint(task_id) else {
            return (false, Some("sandbox endpoint unavailable".to_owned()));
        };
        let response = match endpoint
            .delete()
            .timeout(SANDBOX_MUTATION_TIMEOUT)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => return (false, Some(error.to_string())),
        };
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            (true, None)
        } else {
            (false, Some(format!("HTTP {status}")))
        }
    }

    /// `_ExecutorRuntimeClient.cleanup_sandbox_by_task_id`; the caller only
    /// logs the outcome, so the parsed body is not consumed.
    pub async fn cleanup_sandbox_by_task(&self, task_id: i64) {
        let Ok(endpoint) = self.client.endpoint_named(
            format!("{}/executor-manager/sandboxes/cleanup-by-task", self.base),
            format!("{}/executor-manager/sandboxes/cleanup-by-task", self.base),
        ) else {
            return;
        };
        let body = CleanupByTaskRequest {
            task_id,
            dry_run: false,
            archive_before_delete: false,
        };
        let _ = endpoint
            .post()
            .json(&body)
            .timeout(SANDBOX_MUTATION_TIMEOUT)
            .send()
            .await;
    }

    /// `_call_executor_cancel`: `POST {EXECUTOR_CANCEL_TASK_URL}` with
    /// `{"task_id": task_id}`. The source logs an HTTP error (status plus the
    /// first 1000 characters of the body) or a transport error and never
    /// propagates it, so a failure cannot change the cancel response.
    pub async fn cancel_task(&self, task_id: i64) {
        let endpoint = match self
            .client
            .endpoint_named(self.cancel_url.clone(), self.cancel_url.clone())
        {
            Ok(endpoint) => endpoint,
            Err(error) => {
                tracing::error!(%task_id, %error, "executor cancel endpoint unavailable");
                return;
            }
        };
        let response = match endpoint
            .post()
            .json(&ExecutorCancelRequest { task_id })
            .timeout(CANCEL_TASK_TIMEOUT)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                tracing::error!(
                    %task_id,
                    %error,
                    "error calling executor_manager to cancel task"
                );
                return;
            }
        };
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            return;
        }
        let body = response.text().await.unwrap_or_default();
        let preview: String = body.chars().take(1000).collect();
        tracing::error!(
            %task_id,
            status,
            body = %preview,
            "executor_manager rejected the task cancel"
        );
    }

    /// `executor_kinds_service.delete_executor_task_sync`: a synchronous POST
    /// to `EXECUTOR_DELETE_TASK_URL`. A failure is reported to the caller,
    /// which logs and continues.
    pub async fn delete_executor_task(
        &self,
        executor_name: &str,
        executor_namespace: &str,
    ) -> Result<()> {
        let endpoint = self
            .client
            .endpoint_named(
                format!("{}/executor-manager/executor/delete", self.base),
                format!("{}/executor-manager/executor/delete", self.base),
            )
            .map_err(anyhow::Error::from)?;
        let body = ExecutorDeleteRequest {
            executor_name,
            executor_namespace,
        };
        let response = endpoint
            .post()
            .json(&body)
            .timeout(DELETE_EXECUTOR_TIMEOUT)
            .send()
            .await
            .context("failed to call the executor delete endpoint")?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            anyhow::bail!("executor delete returned HTTP {status}")
        }
        let result = response
            .json::<serde_json::Value>()
            .await
            .context("failed to decode the executor delete result")?;
        // The manager returns HTTP 200 for business failures too. Already
        // absent runtimes satisfy the same cleanup postcondition as deletion.
        if result == serde_json::Value::Bool(true)
            || matches!(
                result.get("status").and_then(serde_json::Value::as_str),
                Some("success" | "not_found")
            )
        {
            return Ok(());
        }
        anyhow::bail!(
            "executor delete was not confirmed (status={})",
            result
                .get("status")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("missing")
        )
    }

    /// `ArchiveService._call_executor_restore`: `POST
    /// {base}/executor-manager/executor/restore` with a 120s timeout. The
    /// source returns the decoded JSON body, or `None` on any transport error,
    /// non-2xx status, or undecodable body.
    pub async fn restore_workspace(
        &self,
        task_id: i64,
        download_url: &str,
        executor_name: &str,
        executor_namespace: &str,
        runtime_type: &str,
    ) -> Option<serde_json::Value> {
        let endpoint = self
            .client
            .endpoint_named(
                format!("{}/executor-manager/executor/restore", self.base),
                format!("{}/executor-manager/executor/restore", self.base),
            )
            .ok()?;
        let body = ExecutorRestoreRequest {
            task_id,
            download_url,
            executor_name,
            executor_namespace,
            runtime_type,
        };
        let response = endpoint
            .post()
            .json(&body)
            .timeout(EXECUTOR_RESTORE_TIMEOUT)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.json::<serde_json::Value>().await.ok()
    }
}

/// Groups sandbox requests by configured service address rather than task ID.
pub(crate) fn sandbox_metric_name(base: &str) -> String {
    format!(
        "{}/executor-manager/sandboxes/:task_id",
        base.trim_end_matches('/')
    )
}

#[cfg(test)]
mod metric_name_tests {
    #[test]
    fn sandbox_metric_preserves_service_address_and_templates_id() {
        assert_eq!(
            super::sandbox_metric_name("https://manager.example:8443/prefix/"),
            "https://manager.example:8443/prefix/executor-manager/sandboxes/:task_id"
        );
    }
}

#[cfg(test)]
mod tests;
