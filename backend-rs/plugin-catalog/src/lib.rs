// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Plugin marketplace queries, publication workflow, and release publishing.

#![forbid(unsafe_code)]

use std::sync::Arc;

use wegent_access::permissions;
use wegent_backend_config as config;
use wegent_backend_persistence::transaction_outcome;
use wegent_devices::device_identity;
use wegent_http_compat as http_compat;
use wegent_identity::{auth, jwt_compat};
use wegent_python_compat::json_compat;
use wegent_socket_events::socketio_emit;

#[cfg(test)]
use wegent_backend_test_support as sql_test_support;

mod plugin_publications;
mod plugin_release_publish;
pub mod plugins_marketplace;

pub struct CatalogState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub entity_resolvers: permissions::EntityResolvers,
}

brz_http_server::registry!(
    dependencies(state: Arc<CatalogState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<CatalogState>,
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
