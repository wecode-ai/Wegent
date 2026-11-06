//! Remote workspace access, status, file transport, and task projections.
#![forbid(unsafe_code)]

use std::sync::Arc;
use wegent_access::permissions;
#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
use wegent_capabilities::task_skills;
use wegent_directory::erp_provider;
use wegent_executor_manager::{executor_manager, remote_workspace_payload};
use wegent_http_compat as http_compat;
use wegent_identity::{auth, headers};
use wegent_media::video_result_urls;
use wegent_python_compat::{json_compat, py_set_order};
use wegent_resource_store::crd;
use wegent_task_store::task_store;

pub mod remote_workspace_status;
pub mod remote_workspace_tree;

pub type StatusState =
    Arc<remote_workspace_status::AppState<brz_mysql::MysqlService, brz_redis::RedisService>>;
pub type TreeState =
    Arc<remote_workspace_tree::Deps<brz_mysql::MysqlService, brz_redis::RedisService>>;

brz_http_server::registry!(
    group = remote_workspace_status,
    dependencies(rws: StatusState),
    auth = auth::AppAuthenticator
);
brz_http_server::registry!(
    group = remote_workspace_tree,
    dependencies(rwt: TreeState),
    auth = auth::AppAuthenticator
);

/// Bind both workspace route groups to this deployment's retained services.
pub fn routes(
    status: StatusState,
    tree: TreeState,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    Ok(
        brz_http_server::handlers!(rws = status; group = remote_workspace_status)?
            .merge(brz_http_server::handlers!(rwt = tree; group = remote_workspace_tree)?),
    )
}

/// Derive registered route metadata for the active gateway ownership contract.
pub fn registered_routes() -> Vec<(&'static str, u16)> {
    let status = brz_http_server::__private::inventory::iter::<
        __http_registry_remote_workspace_status::Entry,
    >
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        });
    let tree =
        brz_http_server::__private::inventory::iter::<__http_registry_remote_workspace_tree::Entry>
            .into_iter()
            .flat_map(|entry| {
                (entry.0.routes)()
                    .iter()
                    .map(|route| (route.path, route.methods))
            });
    status.chain(tree).collect()
}
