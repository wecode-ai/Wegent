// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Owned agent readiness and execution environment queries.

#![forbid(unsafe_code)]

use std::sync::Arc;
use wegent_access::permissions::EntityResolvers;
use wegent_backend_persistence::sql_support;
use wegent_backend_users::users_runtime_configs;
use wegent_devices::devices;
use wegent_directory::erp_provider::ErpProvider;
use wegent_http_compat as http_compat;
use wegent_identity::{auth, user_reader};

mod shells_unified;
mod v1_resources;

pub struct ResourceReadinessState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub erp: Arc<dyn ErpProvider + Send + Sync>,
    pub entity_resolvers: EntityResolvers,
}

brz_http_server::registry!(
    dependencies(state: Arc<ResourceReadinessState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<ResourceReadinessState>,
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
