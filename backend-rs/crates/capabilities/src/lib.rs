//! Skill catalogue authorization, task skill resolution, and cached Kind reads.

#![forbid(unsafe_code)]

use std::sync::Arc;
use wegent_access::permissions;
use wegent_backend_config as config;
use wegent_backend_persistence::{request_sql, sql_support};
#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
#[cfg(test)]
use wegent_backend_test_support as json_contract_tests;
use wegent_directory::erp_provider;
use wegent_http_compat as http_compat;
use wegent_identity::{auth, headers, jwt_compat};
use wegent_python_compat::json_compat;
use wegent_resource_store::{crd, resource_refs};
use wegent_task_store::task_store;

pub mod kind_store;
pub mod read_error;
pub mod skills_unified;
pub mod state;
pub mod task_skills;

brz_http_server::registry!(
    dependencies(state: Arc<state::AppState>),
    auth = auth::AppAuthenticator
);

/// Register capability routes with the deployment's retained services.
pub fn routes(
    state: Arc<state::AppState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
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
