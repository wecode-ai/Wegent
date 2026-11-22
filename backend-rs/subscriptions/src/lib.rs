// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Subscription configuration, monitoring and MCP reads.

#![forbid(unsafe_code)]

use std::sync::Arc;

use wegent_backend_config::AuthConfig;
use wegent_http_compat as http_compat;
use wegent_identity::{auth, task_token, user_reader};
use wegent_mcp_transport::{protocol, tools, transport};
use wegent_task_store::subscription_workspaces::WorkspaceRepository;

#[cfg(test)]
use wegent_backend_test_support::{self as json_contract_tests, self as sql_test_support};

mod admin_subscription_monitor_errors;
mod market_subscriptions;
mod subscription;
mod subscription_developer_settings;
mod subscription_executions;
mod subscription_read;
mod subscriptions_item;
mod subscriptions_list;
mod users_me_subscription_invitations;

pub use subscriptions_item::calculate_next_execution_time;

pub struct SubscriptionState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub auth: AuthConfig,
    pub workspace_repository: Arc<dyn WorkspaceRepository>,
}

brz_http_server::registry!(
    dependencies(state: Arc<SubscriptionState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<SubscriptionState>,
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
