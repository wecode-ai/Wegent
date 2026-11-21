// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Provider discovery, installed service preferences, and user OAuth.

#![forbid(unsafe_code)]

use std::sync::Arc;
use wegent_backend_config as config;
use wegent_backend_persistence::transaction_outcome;
use wegent_http_compat as http_compat;
use wegent_identity::auth;
use wegent_network_policy::http_trust;
use wegent_python_compat::json_compat;

mod mcp_oauth_credentials;
pub mod mcp_provider_registry;
pub mod mcp_providers;
pub mod mcp_user_service;
pub mod user_mcp_oauth;
mod users_me_mcps_providers_services;

pub struct ProviderState {
    pub mysql: brz_mysql::MysqlService,
    pub mcp_providers: Arc<mcp_providers::McpProviderRegistry>,
}

brz_http_server::registry!(
    dependencies(state: Arc<ProviderState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<ProviderState>,
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
