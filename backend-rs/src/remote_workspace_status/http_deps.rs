// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Outbound HTTP dependencies built once at startup, matching the source
//! `httpx.Client` transport policy of `app.services.remote_workspace_service`.

use anyhow::Result;
use brz_http::{Client, Endpoint};

pub struct HttpDependencies {
    /// `{executor_manager_url}/executor-manager/sandboxes/{task_id}` resolved
    /// per request because the task id is part of the path; the retained
    /// builder carries the transport policy.
    client: Client,
    executor_manager_base: String,
}

impl HttpDependencies {
    pub fn new(client: Client, executor_manager_url: &str) -> Self {
        Self {
            client,
            executor_manager_base: executor_manager_url.trim_end_matches('/').to_string(),
        }
    }

    /// GET `{base}/executor-manager/sandboxes/{task_id}`. The metric name is
    /// stabilized because the task id is high-cardinality.
    pub fn sandbox_status_endpoint(&self, task_id: i64) -> Result<Endpoint> {
        self.client
            .endpoint_named(
                format!(
                    "{}/executor-manager/sandboxes/{task_id}",
                    self.executor_manager_base
                ),
                "http://executor-manager/executor-manager/sandboxes/:task_id",
            )
            .map_err(anyhow::Error::from)
    }

    /// GET `{base}/executor-manager/executor/address` with the
    /// `executor_name` / `executor_namespace` query parameters.
    pub fn executor_address_endpoint(&self) -> Result<Endpoint> {
        self.client
            .endpoint_named(
                format!(
                    "{}/executor-manager/executor/address",
                    self.executor_manager_base
                ),
                "http://executor-manager/executor-manager/executor/address",
            )
            .map_err(anyhow::Error::from)
    }
}
