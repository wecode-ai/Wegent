// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authorized task queries and their response projections.
#![forbid(unsafe_code)]

use brz_mysql::MysqlService;
use std::sync::Arc;
#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
use wegent_http_compat as http_compat;
use wegent_identity::{auth, user_reader::UserByIdReader};
use wegent_resource_store::crd;
use wegent_task_store::task_store::{self, TaskStore};

mod tasks_db_projection;
mod tasks_list;
mod tasks_lite_group;
mod tasks_lite_personal;
mod tasks_search;

pub struct TasksState {
    pub mysql: MysqlService,
    pub task_store: Arc<dyn TaskStore>,
    pub user_reader: Arc<dyn UserByIdReader>,
}

brz_http_server::registry!(
    group = tasks,
    dependencies(state: Arc<TasksState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<TasksState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state; group = tasks)
}

/// Registered paths and method bits used by the gateway ownership tests.
pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_tasks::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
