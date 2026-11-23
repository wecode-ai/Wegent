// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Durable observation state, lease-scoped routes, and background delivery.

#![forbid(unsafe_code)]

use std::{sync::Arc, time::Duration};

use serde_json::Value;
use wegent_backend_config as config;
use wegent_http_compat as http_compat;
use wegent_identity::{auth, internal_auth};
use wegent_job_runtime::BackgroundJobsClient;

mod jobs;
mod ledger;

pub use jobs::register_jobs;

pub struct ObservationState {
    pub mysql: brz_mysql::MysqlService,
    pub auth: config::AuthConfig,
}

pub struct ObservationJobState {
    pub observations: ObservationState,
    pub background_jobs: BackgroundJobsClient,
    pub runtime_rpc: Arc<dyn ObservationRpc>,
}

/// Invoke an observation method on the Runtime owned by the specified account.
#[async_trait::async_trait]
pub trait ObservationRpc: Send + Sync {
    async fn call(
        &self,
        owner: i64,
        device: &str,
        method: &str,
        payload: Value,
        timeout: Duration,
    ) -> anyhow::Result<Value>;
}

brz_http_server::registry!(
    dependencies(state: Arc<ObservationState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<ObservationState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
}

pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_http_apis::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}

#[cfg(feature = "test-support")]
pub mod test_support {
    pub use crate::jobs::collect_account;
    pub use crate::ledger::{canonical_hash, command};
}
