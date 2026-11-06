//! OIDC web and CLI authorization, user provisioning, and provider caches.
#![forbid(unsafe_code)]
use std::sync::Arc;
use wegent_backend_config as config;
use wegent_http_compat as http_compat;
use wegent_identity::auth;

mod entry_route;
pub mod oidc_callback;
pub mod oidc_cli_callback;
pub mod oidc_cli_login;
pub mod oidc_cli_poll;
pub mod oidc_login;
pub mod oidc_service;
pub mod state;
use wegent_backend_persistence::sql_support;
use wegent_identity::user_reader;
use wegent_network_policy::http_trust;
use wegent_python_compat::json_compat;

brz_http_server::registry!(dependencies(state: Arc<state::AppState>), auth = auth::AppAuthenticator);

/// Register authentication routes with the retained database and session services.
pub fn routes(
    state: Arc<state::AppState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
}

/// Derive route ownership metadata from this library's actual HTTP registry.
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
