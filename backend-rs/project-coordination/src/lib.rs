// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cloud project permissions, board reads, and shared LoopNode persistence.
#![forbid(unsafe_code)]

use brz_mysql::MysqlService;
use std::sync::Arc;
use wegent_backend_config as config;
use wegent_backend_persistence::sql_support;
#[cfg(test)]
use wegent_backend_test_support::{self as json_contract_tests, self as sql_test_support};
use wegent_http_compat as http_compat;
use wegent_identity::{
    auth,
    user_reader::{self, UserByIdReader},
};
use wegent_python_compat::json_compat;

pub mod board_snapshot;
pub mod cloud_projects;
pub mod delivery_storage;
pub mod loop_item_attachments;
pub mod loop_item_executions;
pub mod loop_item_pages;
mod loop_items;
pub mod loop_node_storage;
pub mod loop_tasks;
pub mod project_authority;
pub mod project_chat_message;
pub mod project_device_access;
pub mod project_execution;
pub mod project_group_access;
pub mod project_issues;
pub mod project_profile;
pub mod project_routing_diagnostics;
pub mod project_runner_recovery;
pub mod project_store;

mod cloud_project_automations;
mod cloud_projects_members;
mod cloud_projects_runtime_default;
mod loop_deliveries;

/// Report online status in the same order as the requested owner/route pairs.
#[async_trait::async_trait]
pub trait DevicePresence: Send + Sync {
    async fn online_statuses(&self, devices: &[(i32, String)]) -> Vec<Option<String>>;
}

/// The resolved role used when projecting editability of group-owned Teams.
#[async_trait::async_trait]
pub trait TeamGroupRoles: Send + Sync {
    async fn effective_role(
        &self,
        user_id: i64,
        namespace: &str,
    ) -> brz_mysql::MysqlResult<Option<String>>;
}

pub struct ProjectState {
    pub mysql: MysqlService,
    pub device_presence: Arc<dyn DevicePresence>,
    pub attachment_http: brz_http::Client,
    pub jwt_key: String,
    pub user_reader: Arc<dyn UserByIdReader>,
    pub team_group_roles: Arc<dyn TeamGroupRoles>,
}

impl ProjectState {
    fn loop_item_reads(&self) -> LoopItemReads<'_> {
        LoopItemReads {
            mysql: &self.mysql,
            user_reader: self.user_reader.as_ref(),
        }
    }

    fn external_issue_reads(&self) -> ExternalIssueReads<'_> {
        ExternalIssueReads {
            mysql: &self.mysql,
            attachment_http: &self.attachment_http,
            jwt_key: &self.jwt_key,
        }
    }
}

pub struct LoopItemReads<'a> {
    pub mysql: &'a MysqlService,
    pub user_reader: &'a dyn UserByIdReader,
}

pub struct ExternalIssueReads<'a> {
    pub mysql: &'a MysqlService,
    pub attachment_http: &'a brz_http::Client,
    pub jwt_key: &'a str,
}

brz_http_server::registry!(
    group = project_coordination,
    dependencies(state: Arc<ProjectState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<ProjectState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state; group = project_coordination)
}

/// Registered paths and method bits used by the gateway ownership tests.
pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_project_coordination::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
