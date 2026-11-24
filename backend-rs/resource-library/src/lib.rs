// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Resource discovery, publication, bindings, and skill downloads.

#![forbid(unsafe_code)]

use std::sync::Arc;

use wegent_access::permissions;
use wegent_backend_config as config;
use wegent_http_compat as http_compat;
use wegent_identity::{auth, headers, internal_auth, jwt_compat};
use wegent_python_compat::py_set_order;
use wegent_resource_store::crd;
use wegent_task_store::task_store;

#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
#[cfg(test)]
use wegent_backend_test_support as json_contract_tests;

mod admin_marketplace_resources;
mod admin_marketplace_tags;
mod admin_public_ghosts;
mod admin_public_models;
mod admin_public_retrievers;
mod admin_public_shells;
mod admin_templates;
mod marketplace_tags;
mod resource_library_listings;
mod resource_library_tags;
mod skills;

pub struct ResourceLibraryState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub task_store: Arc<dyn task_store::TaskStore>,
    pub erp: Arc<dyn wegent_directory::erp_provider::ErpProvider + Send + Sync>,
    pub entity_resolvers: permissions::EntityResolvers<brz_redis::RedisService>,
}

brz_http_server::registry!(
    dependencies(state: Arc<ResourceLibraryState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<ResourceLibraryState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
}

/// Registered paths and method bits used by the gateway ownership tests.
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
