// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Team and Bot catalogues, access checks, and related user views.
#![forbid(unsafe_code)]

use brz_mysql::MysqlService;
use brz_redis::RedisService;
use std::sync::Arc;
use wegent_access::permissions::{self, EntityResolvers};
use wegent_backend_config as config;
use wegent_backend_persistence::sql_support;
#[cfg(test)]
use wegent_backend_test_support::{self as json_contract_tests, self as sql_test_support};
#[cfg(test)]
use wegent_directory::erp_provider;
use wegent_directory::erp_provider::ErpProvider;
use wegent_http_compat as http_compat;
#[cfg(test)]
use wegent_identity::jwt_compat;
use wegent_identity::{auth, headers};
use wegent_python_compat::json_compat;
use wegent_resource_store::crd;
use wegent_task_store::task_store::TaskStore;

mod admin_public_bots;
mod admin_public_teams;
mod bots;
mod teams;

pub use teams::{auth::TeamsUser, auth_error::AuthError};

pub struct TeamsState {
    pub mysql: MysqlService,
    pub redis: Option<RedisService>,
    pub erp: Arc<dyn ErpProvider + Send + Sync>,
    pub entity_resolvers: EntityResolvers,
    pub task_store: Arc<dyn TaskStore>,
}

brz_http_server::registry!(
    group = teams,
    dependencies(state: Arc<TeamsState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<TeamsState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state; group = teams)
}

/// Registered paths and method bits used by the gateway ownership tests.
pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_teams::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
