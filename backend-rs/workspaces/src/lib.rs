// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Collaborative workspaces, members, and execution environments.

#![forbid(unsafe_code)]

use std::sync::Arc;
use wegent_http_compat as http_compat;
use wegent_identity::auth::{self, AppAuthenticator};
use wegent_identity::user_reader;

mod workspace_detail;
mod workspace_members;
mod workspace_rendering;
mod workspaces;
mod workspaces_execution_environments;

/// Read device presence in the same order as the requested owner/route pairs.
#[async_trait::async_trait]
pub trait DevicePresence: Send + Sync {
    async fn online_info(&self, devices: &[(i32, String)]) -> Vec<Option<serde_json::Value>>;
}

pub struct WorkspaceState {
    pub mysql: brz_mysql::MysqlService,
    pub device_presence: Arc<dyn DevicePresence>,
}

brz_http_server::registry!(
    dependencies(state: Arc<WorkspaceState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<WorkspaceState>,
) -> Result<brz_http_server::Router<AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
}

/// Registered paths and HTTP methods for gateway ownership verification.
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
