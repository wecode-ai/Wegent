// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task and subtask mutation routes on the shared task store.

#![forbid(unsafe_code)]

use std::sync::Arc;

use wegent_executor_manager::executor_manager::ExecutorManager;
use wegent_identity::{auth::AppAuthenticator, user_reader::UserByIdReader};
use wegent_task_views::TaskViewsState;

mod subtask_edit;
mod task_mutation_api;

pub use task_mutation_api::delete_task::delete_task;
pub use task_mutation_api::{TaskUpdateBody, cancel_task, update_task};

pub struct TaskMutationsState {
    pub views: Arc<TaskViewsState>,
    pub executor_manager: ExecutorManager,
    pub user_reader: Arc<dyn UserByIdReader>,
}

brz_http_server::registry!(
    dependencies(state: Arc<TaskMutationsState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<TaskMutationsState>,
) -> Result<brz_http_server::Router<AppAuthenticator>, brz_http_server::RegistryError> {
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
