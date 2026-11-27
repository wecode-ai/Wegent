// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Chat history, attachment text, and subtask records on the shared task store.

#![forbid(unsafe_code)]

use std::sync::Arc;

use wegent_identity::auth::AppAuthenticator;
use wegent_task_store::task_store::TaskStore;

mod chat_attachment_text;
mod chat_history;
mod chat_history_checkpoint;
mod chat_history_window;
mod chat_message_update;
pub mod chat_repository;
mod chat_subtask_record;

pub use chat_history::{HistoryQuery, HistoryResponse, get_chat_history_value};

pub struct ChatHistoryState {
    pub mysql: brz_mysql::MysqlService,
    pub task_store: Arc<dyn TaskStore>,
}

brz_http_server::registry!(
    dependencies(state: Arc<ChatHistoryState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<ChatHistoryState>,
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
