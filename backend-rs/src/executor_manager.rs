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

use crate::json_compat::OpaqueJson;

/// `settings.EXECUTOR_MANAGER_URL`'s source default (`app/core/config.py`).
pub const DEFAULT_EXECUTOR_MANAGER_URL: &str = "http://localhost:8001";

/// `_ExecutorRuntimeClient.get_sandbox`'s httpx timeout.
const GET_SANDBOX_TIMEOUT: Duration = Duration::from_secs(30);
/// `delete_sandbox` / `cleanup_sandbox_by_task_id`'s httpx timeout.
const SANDBOX_MUTATION_TIMEOUT: Duration = Duration::from_secs(180);
/// `delete_executor_task_sync`'s requests timeout.
const DELETE_EXECUTOR_TIMEOUT: Duration = Duration::from_secs(30);

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

/// `executor_kinds_service.delete_executor_task_sync`'s request body.
#[derive(Serialize)]
struct ExecutorDeleteRequest<'a> {
    executor_name: &'a str,
    executor_namespace: &'a str,
}

/// The retained executor-manager client and its resolved base URL.
pub struct ExecutorManager {
    client: Client,
    base: String,
}

impl ExecutorManager {
    /// Build the client from `EXECUTOR_MANAGER_URL`, falling back to the
    /// source default when unset.
    pub fn from_env() -> Result<Self> {
        let base = std::env::var("EXECUTOR_MANAGER_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_EXECUTOR_MANAGER_URL.to_owned());
        Self::new(base)
    }

    pub fn new(base: impl Into<String>) -> Result<Self> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .context("failed to build the executor-manager HTTP client")?;
        Ok(Self {
            client,
            base: base.into().trim_end_matches('/').to_owned(),
        })
    }

    /// `GET {base}/executor-manager/sandboxes/{task_id}`.
    fn sandbox_endpoint(&self, task_id: &str) -> Result<Endpoint> {
        self.client
            .endpoint_named(
                format!("{}/executor-manager/sandboxes/{task_id}", self.base),
                "http://executor-manager/executor-manager/sandboxes/:task_id",
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
            "http://executor-manager/executor-manager/sandboxes/cleanup-by-task",
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
                "http://executor-manager/executor-manager/executor/delete",
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
        if (200..300).contains(&status) {
            Ok(())
        } else {
            anyhow::bail!("executor delete returned HTTP {status}")
        }
    }
}
