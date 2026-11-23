// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Project assistant participation and assignment reception receipts.

#![forbid(unsafe_code)]

use brz_mysql::{MysqlResult, MysqlService};
use std::sync::Arc;
use wegent_http_compat::FastApiError;
use wegent_identity::auth::AppAuthenticator;

pub mod assignment_index;
pub mod assignment_receipts;
mod assistant_participation;
mod human_requests;

#[cfg(test)]
use wegent_backend_test_support as sql_test_support;

#[cfg(feature = "test-support")]
pub mod test_support {
    pub use super::assignment_receipts::test_support::*;
    pub use super::assistant_participation::test_support::*;
}

#[async_trait::async_trait]
pub trait ParticipationSupport: Send + Sync {
    async fn active_owner(&self, task_id: i64) -> MysqlResult<Option<i64>>;
    async fn ensure_issue_shadow(&self, item_id: &str, user_id: i32) -> Result<(), FastApiError>;
    async fn require_issue_read(&self, item_id: &str, user_id: i32) -> Result<(), FastApiError>;
}

pub struct ParticipationState {
    pub mysql: MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub local_emit: Arc<dyn wegent_project_notifications::LocalEmit>,
    pub support: Arc<dyn ParticipationSupport>,
}

brz_http_server::registry!(
    group = project_participation,
    dependencies(state: Arc<ParticipationState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<ParticipationState>,
) -> Result<brz_http_server::Router<AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state; group = project_participation)
}

pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_project_participation::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
