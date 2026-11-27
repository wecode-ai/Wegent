// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Device identity, presence, commands, and listing.

#![forbid(unsafe_code)]

use std::sync::Arc;
use wegent_backend_config as config;
pub use wegent_device_identity as device_identity;
use wegent_http_compat as http_compat;
use wegent_identity::auth;
use wegent_python_compat::json_compat;
use wegent_resource_store::crd;
use wegent_task_store::task_store;

pub mod cloud_device_deletion;
mod cloud_upgrade_threshold;
pub mod device_command;
pub mod device_commands;
pub mod device_identity_lock;
pub mod device_online_state;
pub mod device_presence;
pub mod device_running_tasks;
pub mod device_upgrade;
pub mod devices;
pub mod executor_version;

pub struct DevicesState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub socketio_rpc: Option<Arc<wegent_socket_events::socketio_rpc::SocketIoRpc>>,
    pub task_store: Arc<dyn task_store::TaskStore>,
    pub cloud_runtime_features: Arc<dyn devices::CloudRuntimeFeatures>,
    pub executor_version: executor_version::ExecutorVersionService,
}

brz_http_server::registry!(
    dependencies(state: Arc<DevicesState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<DevicesState>,
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

pub mod runner_catalog;
pub mod runtime_features;
mod runtime_profiles;
