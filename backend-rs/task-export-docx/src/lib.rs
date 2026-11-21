// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/export/docx` — export a task conversation to a
//! DOCX file (`app.api.endpoints.adapter.tasks.export_task_docx` ->
//! `app.services.export.docx_generator.generate_task_docx`).
//!
//! The route authenticates through a short-lived `download_token` JWT
//! (`app.services.auth.docx_export_download_token`) or the optional bearer
//! session, re-checks task membership, loads the task, filtered subtasks,
//! attachment contexts, and sender names, then renders a DOCX package that
//! reproduces the python-docx 1.2.0 `Document()` serialization byte-for-byte
//! (template parts, XML forms, and zip framing) except for the two
//! current-time values the source also embeds (zip entry timestamps and
//! `docProps/core.xml` `dcterms:created`).
#![forbid(unsafe_code)]

use brz_mysql::MysqlService;
use std::sync::Arc;
use wegent_backend_config::AuthConfig;
use wegent_identity::auth;
use wegent_task_store::task_store::TaskStore;

mod emoji;
pub mod generator;
mod markdown;
mod package;
mod repository;
mod router;

pub use generator::test_support;
mod token;
pub mod xml;

pub struct TaskExportState {
    pub mysql: MysqlService,
    pub task_store: Arc<dyn TaskStore>,
    pub auth: AuthConfig,
}

brz_http_server::registry!(
    group = task_export,
    dependencies(state: Arc<TaskExportState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<TaskExportState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state; group = task_export)
}

/// Registered paths and method bits used by the gateway ownership tests.
pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_task_export::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
