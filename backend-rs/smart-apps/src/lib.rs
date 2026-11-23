// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Smart App discovery, access, and artifact delivery.

#![forbid(unsafe_code)]

use std::sync::Arc;

use wegent_access::permissions;
use wegent_backend_config as config;
use wegent_backend_persistence::sql_support;
use wegent_http_compat as http_compat;
use wegent_identity::{auth, user_reader};

mod smart_apps_download;
mod smart_apps_marketplace;

pub struct SmartAppsState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub entity_resolvers: permissions::EntityResolvers,
    pub auth: config::AuthConfig,
    pub attachment_http: brz_http::Client,
}

brz_http_server::registry!(
    dependencies(state: Arc<SmartAppsState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<SmartAppsState>,
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
