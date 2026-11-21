// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Internal workspace-archive endpoints.
//!
//! Mirrors `app/api/endpoints/internal/workspace_archives.py` and the
//! `app/services/workspace_archive` package. `POST
//! /api/internal/workspace-archives/{task_id}/restore-sandbox` restores a
//! sandbox's workspace files from the task's latest stored archive.
#![forbid(unsafe_code)]

use brz_http::Client;
use std::sync::Arc;
use wegent_backend_config as config;
use wegent_executor_manager::executor_manager::ExecutorManager;
use wegent_http_compat as http_compat;
use wegent_identity::auth::AppAuthenticator;
use wegent_task_store::task_store::TaskStore;

mod handler;
mod save;
mod service;
mod storage;

pub use save::archive;
pub use service::{recovery_archive_available, restore_workspace_for_runtime};

pub struct ArchiveState {
    pub http: Client,
    pub executor_manager: ExecutorManager,
    pub task_store: Arc<dyn TaskStore>,
}

brz_http_server::registry!(
    group = workspace_archive,
    dependencies(state: Arc<ArchiveState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<ArchiveState>,
) -> Result<brz_http_server::Router<AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state; group = workspace_archive)
}

/// Registered paths and method bits used by the gateway ownership tests.
pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_workspace_archive::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
