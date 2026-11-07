// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authenticated Sites catalogue with a caller-owned upstream client.

#![forbid(unsafe_code)]

mod site_app_types;
pub mod sites;
pub use wegent_backend_config as config;
pub use wegent_http_compat as http_compat;
pub use wegent_identity::auth;

brz_http_server::registry!(
    dependencies(sites: std::sync::Arc<sites::SitesClient>),
    auth = auth::AppAuthenticator
);

/// Register all Sites routes against this deployment's retained upstream client.
pub fn routes(
    client: std::sync::Arc<sites::SitesClient>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(sites = client)
}

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
