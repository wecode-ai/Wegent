// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Installed plugin synchronization and device account authorization.

#![forbid(unsafe_code)]

use std::sync::Arc;

use wegent_access::permissions;
use wegent_backend_config as config;
use wegent_backend_persistence::sql_support;
use wegent_device_identity as device_identity;
use wegent_devices::device_online_state as devices;
use wegent_http_compat as http_compat;
use wegent_identity::{auth, headers, jwt_compat, user_reader, wework_auth_tokens};
use wegent_plugin_catalog::plugins_marketplace;
use wegent_python_compat::json_compat;
use wegent_socket_events::{socketio_emit, socketio_rpc};

#[cfg(test)]
use wegent_backend_test_support as sql_test_support;

mod dsh_plugin_storage;
pub mod plugin_account_auth;
mod plugins_installed;

#[cfg(feature = "test-support")]
pub mod test_support;

pub use plugins_installed::removal_sync::has_pending_removals;
pub use plugins_installed::{
    CapabilityDispatch, DispatchOutcome, PluginPreparation, prepare_plugins_for_registered_device,
    record_registration_sync_result, sync_registration_capabilities,
};

#[derive(Clone)]
pub struct PluginState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub auth: config::AuthConfig,
    pub attachment_http: brz_http::Client,
    pub entity_resolvers: permissions::EntityResolvers,
    pub socketio_rpc: Option<Arc<socketio_rpc::SocketIoRpc>>,
}

brz_http_server::registry!(
    dependencies(state: Arc<PluginState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<PluginState>,
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
