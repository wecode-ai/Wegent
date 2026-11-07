//! Model catalogue aggregation, authorization, and response normalization.

#![forbid(unsafe_code)]

use wegent_access::permissions;
#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
#[cfg(test)]
use wegent_backend_test_support as json_contract_tests;
use wegent_http_compat as http_compat;
use wegent_identity::headers;
#[cfg(test)]
use wegent_identity::jwt_compat;
mod models_unified;
pub use models_unified::*;

pub type ModelsState =
    std::sync::Arc<state::AppState<brz_mysql::MysqlService, brz_redis::RedisService>>;

brz_http_server::registry!(
    group = models_unified,
    dependencies(mu: ModelsState),
    auth = wegent_identity::auth::AppAuthenticator
);

/// Bind catalogue routes to the deployment's retained clients and entity resolvers.
pub fn routes(
    state: ModelsState,
) -> Result<
    brz_http_server::Router<wegent_identity::auth::AppAuthenticator>,
    brz_http_server::RegistryError,
> {
    brz_http_server::handlers!(mu = state; group = models_unified)
}

/// Registered paths and HTTP method bits used to verify the active gateway route table.
pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_models_unified::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
