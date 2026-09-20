// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared backend library, migrated APIs, and hybrid gateway assembly.
//!
//! The public entrypoint can construct and serve an application independently
//! using its own configuration:
//!
//! ```no_run
//! use std::sync::Arc;
//! use wegent_backend_rs::{Application, HybridConfig, build_app_state, init_env, run_hybrid};
//!
//! fn main() -> Result<(), wegent_backend_rs::BoxError> {
//!     // Must run before the process spawns any thread.
//!     init_env();
//!     let runtime = tokio::runtime::Runtime::new()?;
//!     runtime.block_on(async {
//!         let state = Arc::new(build_app_state().await?);
//!         let application = Application::build(state).await?;
//!         run_hybrid(HybridConfig::from_env()?, application).await
//!     })
//! }
//! ```
//!
#[cfg(test)]
extern crate self as wegent_backend_rs;
use std::sync::Arc;

pub use application::Application;
pub use brz_http_gateway::{
    BoxError, ConfigError, Gateway, GatewayBody, GatewayResponse, MatchedService as RustApi,
    OriginService, ProxyConfigError, RejectMatched as NoRustApi, RouteRule, RouteTable,
    RoutesConfig, bind, serve,
};
pub use brz_http_server as http_server;
pub use config::{init_env, init_env_file};
pub use hybrid::{HybridConfig, run_hybrid, serve_hybrid, serve_hybrid_application};
pub use startup::app::build as build_app_state;
pub use startup::mysql::connect as connect_mysql;
pub use state::AppState;

mod application;
mod apps_installed;
mod attachment_block;
mod attachments;
mod attachments_task_all;
pub mod auth;
mod auth_login;
mod board_snapshot;
mod chat_attachment_text;
mod chat_history;
mod chat_repository;
mod cloud_project_automations;
mod cloud_projects;
mod cloud_projects_members;
pub mod config;
mod connector_runtime;
mod crd;
mod devices;
pub mod erp_provider;
pub mod erp_types;
mod groups;
mod headers;
pub mod http_compat;
mod http_fallback;
mod hybrid;
mod internal_auth;
mod knowledge_artifacts;
mod knowledge_base_detail;
mod knowledge_bases_all_grouped;
mod knowledge_documents_content;
mod knowledge_documents_list;
pub mod knowledge_download_policy;
mod loop_item_pages;
mod loop_tasks;
pub mod media_policy;
mod models_unified;
mod oidc_callback;
mod oidc_service;
pub mod permissions;
mod pet;
mod plugins_installed;
mod plugins_marketplace;
mod projects;
mod quota;
mod remote_workspace_status;
mod remote_workspace_tree;
mod resource_library_listings;
mod resource_refs;
mod responses;
mod runtime_check;
mod shutdown_state;
mod skills;
#[cfg(test)]
mod sql_test_support;
mod startup;
mod state;
mod subscription_executions;
mod subscriptions_list;
pub use subscriptions_list::workspaces as subscription_workspaces;
mod tables;
mod task_detail_api;
pub mod task_export_docx;
mod task_pipeline_stage_info;
#[path = "task_pipeline_stage_info_repo.rs"]
mod task_pipeline_stage_info_repo;
pub mod task_routing;
mod task_skills;
mod tasks_lite_personal;
mod teams;
pub mod user_profile;
pub mod user_reader;
mod users_default_teams;
mod users_me;
mod users_search;
mod users_welcome_config;
pub mod video_result_urls;
mod wework_notifications;
mod wework_transcripts;
mod work_queues;

// Shared route registrations stay at crate scope for the HTTP macros.
// Public routes are composed by startup::routes.
brz_http_server::registry!(dependencies(state: Arc<AppState>));
brz_http_server::registry!(
    group = runtime_check,
    dependencies(rc: startup::RuntimeCheckState)
);
brz_http_server::registry!(
    group = models_unified,
    dependencies(mu: startup::ModelsState)
);
brz_http_server::registry!(
    group = remote_workspace_status,
    dependencies(rws: startup::StatusState)
);
brz_http_server::registry!(
    group = remote_workspace_tree,
    dependencies(rwt: startup::TreeState)
);

#[cfg(test)]
mod json_contract_tests;

/// JSON input compatibility for legacy projections.
pub mod json_compat;

mod remote_workspace_payload;
