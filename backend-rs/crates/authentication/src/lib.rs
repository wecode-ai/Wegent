//! Password login and desktop device authorization with shared identity contracts.
#![forbid(unsafe_code)]
use std::sync::Arc;
use wegent_backend_config as config;
use wegent_http_compat as http_compat;
use wegent_identity::auth;

pub mod auth_login;
pub mod state;
pub mod wework_auth;
pub mod wework_auth_refresh;
#[cfg(test)]
use wegent_http_compat::fallback as http_fallback;
use wegent_identity::{jwt_compat, wework_auth_tokens};

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
