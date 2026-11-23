// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Legacy project metadata and task associations.

#![forbid(unsafe_code)]

use std::sync::Arc;

use wegent_http_compat as http_compat;
use wegent_identity::auth;
use wegent_python_compat::json_compat;
#[cfg(test)]
use wegent_task_store::task_store;
use wegent_task_store::task_store::TaskStore;

#[cfg(test)]
use wegent_backend_test_support as sql_test_support;

mod projects;

pub use projects::project_config_on;

pub struct ProjectsState {
    pub mysql: brz_mysql::MysqlService,
    pub task_store: Arc<dyn TaskStore>,
}

brz_http_server::registry!(
    dependencies(state: Arc<ProjectsState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<ProjectsState>,
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
