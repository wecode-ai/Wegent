//! User profiles, account settings, runtime configuration, and directory routes.
#![forbid(unsafe_code)]
use std::sync::Arc;
use wegent_backend_config as config;
#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
#[cfg(test)]
use wegent_backend_test_support as json_contract_tests;
use wegent_http_compat as http_compat;
#[cfg(test)]
use wegent_identity::jwt_compat;
use wegent_identity::{auth, user_reader};
use wegent_python_compat::json_compat;

pub mod admin_users;
pub mod state;
pub mod user_profile;
pub mod users_default_teams;
pub mod users_features;
pub mod users_me;
pub mod users_me_available_channels;
pub mod users_me_proxy_config;
pub mod users_me_update;
pub mod users_me_wegent_runtime;
pub mod users_me_wegent_runtime_token;
pub mod users_runtime_configs;
pub mod users_search;
pub mod users_welcome_config;

brz_http_server::registry!(dependencies(state: Arc<state::AppState>), auth = auth::AppAuthenticator);

/// Register account routes with this deployment's existing user and Git services.
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
