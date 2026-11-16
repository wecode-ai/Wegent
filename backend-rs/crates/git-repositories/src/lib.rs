// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Git provider integration with domain-owned HTTP routes and refresh workers.

#![forbid(unsafe_code)]

pub mod git_repositories;
pub mod repository_tokens;
pub use wegent_http_compat as http_compat;
pub use wegent_identity::auth;
pub use wegent_network_policy::http_trust;

use std::sync::Arc;

pub struct GitState {
    pub git_repositories: Arc<git_repositories::GitRepositoriesService>,
    pub repository_tokens: Arc<dyn repository_tokens::RepositoryTokenResolver>,
}

brz_http_server::registry!(
    dependencies(state: Arc<GitState>),
    auth = auth::AppAuthenticator
);

/// Compose Git routes without creating another client, cache, or refresh worker.
pub fn routes(
    state: Arc<GitState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
}

#[cfg(test)]
pub use wegent_backend_test_support as json_contract_tests;

/// Registered paths and HTTP method bits used to verify the active gateway route table.
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
