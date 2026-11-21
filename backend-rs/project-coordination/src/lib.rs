// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cloud project permissions, board reads, and shared LoopNode persistence.
#![forbid(unsafe_code)]

use brz_mysql::MysqlService;
use brz_redis::RedisService;
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
pub mod loop_item_executions;
pub mod loop_item_pages;
mod loop_items;
pub mod loop_node_storage;
pub mod loop_tasks;

mod cloud_project_automations;
mod cloud_projects_members;
mod cloud_projects_runtime_default;
mod loop_deliveries;

pub struct ProjectState {
    pub mysql: MysqlService,
    pub redis: Option<RedisService>,
    pub attachment_http: brz_http::Client,
    pub jwt_key: String,
    pub user_reader: Arc<dyn UserByIdReader>,
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
