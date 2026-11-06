//! Authorized task runtime checkpoints and streaming-state reads.

#![forbid(unsafe_code)]

#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
use wegent_http_compat as http_compat;
pub use wegent_identity::auth;
use wegent_task_store::task_store;
mod runtime_check;
pub use runtime_check::*;

pub type RuntimeCheckState = AppState<brz_mysql::MysqlService, brz_redis::RedisService>;

brz_http_server::registry!(
    group = runtime_check,
    dependencies(rc: RuntimeCheckState),
    auth = auth::AppAuthenticator
);

/// Bind the checkpoint route to the deployment's retained SQL and Redis clients.
pub fn routes(
    state: RuntimeCheckState,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(rc = state; group = runtime_check)
}

/// Registered paths and HTTP method bits used to verify the active gateway route table.
pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_runtime_check::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
