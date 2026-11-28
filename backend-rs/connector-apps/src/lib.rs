// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Connector App catalog, OAuth grants, and tool execution.

#![forbid(unsafe_code)]

use std::sync::Arc;
use wegent_backend_config as config;
use wegent_http_compat as http_compat;
use wegent_identity::{auth, jwt_compat, sensitive_data, task_token};
use wegent_python_compat::json_compat;

#[cfg(test)]
use wegent_backend_test_support as sql_test_support;

mod admin_connector_apps;
mod apps_installed;
mod connector_runtime;
mod execution_apps;
pub mod external_authorization;
mod mcp_server;

pub use apps_installed::connection::{ConnectorCredentialError, connected_access_token};
pub use apps_installed::service::ConnectorApp;
pub use execution_apps::{ExecutionApp, ExecutionApps, execution_apps};

#[cfg(feature = "test-support")]
pub mod test_support {
    pub use crate::apps_installed::db::KindRow;
    pub use crate::apps_installed::service::row_to_app;
    pub use crate::connector_runtime::loading::deferred_tools;
}

pub struct ConnectorState {
    pub tasks_table: &'static str,
    pub mysql: brz_mysql::MysqlService,
    pub auth: config::AuthConfig,
}

brz_http_server::registry!(
    dependencies(state: Arc<ConnectorState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<ConnectorState>,
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
