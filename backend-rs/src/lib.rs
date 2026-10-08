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
pub use attachments::external_media::{
    AttachmentDownload, ExternalMediaReference, ExternalMediaRelay, ExternalMediaRequest,
    MediaStream,
};
pub use brz_http_gateway::{
    BoxError, ConfigError, ExclusionRule, Gateway, GatewayBody, GatewayResponse,
    MatchedService as RustApi, OriginService, ProxyConfigError, RejectMatched as NoRustApi,
    RouteRule, RouteTable, RoutesConfig, bind, serve,
};
pub use brz_http_server as http_server;
pub use config::{init_env, init_env_file};
pub use filters::RequestIdFilter;
pub use hybrid::{
    HybridConfig, load_routes_config, run_hybrid, run_hybrid_with_gateway, serve_hybrid,
    serve_hybrid_application, serve_hybrid_application_with_gateway,
};
pub use startup::app::build as build_app_state;
pub use startup::mysql::connect as connect_mysql;
pub use startup::redis::cache_client as build_cache_client;
pub use state::AppState;

mod admin_connector_apps;
mod admin_im_channels;
mod admin_im_channels_status;
mod admin_marketplace_tags;
mod admin_plugin_publications;
mod admin_public_bots;
mod admin_public_ghosts;
mod admin_public_models;
mod admin_public_retrievers;
mod admin_public_shells;
mod admin_public_teams;
mod admin_service_keys;
mod admin_subscription_monitor_errors;
mod admin_system_config_slogan_tips;
mod admin_users;
mod api_keys;
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
mod device_identity;
mod device_records;
mod device_running_tasks;
pub mod devices;
pub mod erp_provider;
pub mod erp_types;
mod executor_manager;
pub mod executor_version;
mod filters;
mod groups;
mod headers;
pub mod http_compat;
mod http_fallback;
mod hybrid;
mod internal_auth;
mod knowledge_artifacts;
mod knowledge_base_detail;
mod knowledge_bases_all_grouped;
mod knowledge_bases_list;
mod knowledge_documents_content;
mod knowledge_documents_list;
pub mod knowledge_download_policy;
mod knowledge_organization_namespace;
mod loop_item_pages;
mod loop_tasks;
mod market_subscriptions;
mod marketplace_tags;
mod mcp;
pub mod media_policy;
mod models_error_recommendations;
mod models_unified;
mod oidc_callback;
mod oidc_service;
pub mod permissions;
mod pet;
mod plugins_installed;
mod plugins_marketplace;
mod projects;
mod py_set_order;
mod quota;
mod remote_workspace_status;
mod remote_workspace_tree;
mod resource_library_listings;
mod resource_library_tags;
mod resource_refs;
mod responses;
mod runtime_check;
mod runtime_work_im_notifications;
mod shutdown_state;
mod site_app_types;
mod sites;
pub mod skill_market;
mod skills;
mod sql_support;
#[cfg(test)]
mod sql_test_support;
mod startup;
mod state;
mod subscription_developer_settings;
mod subscription_executions;
mod subscriptions_item;
mod subscriptions_list;
pub use subscriptions_list::workspaces as subscription_workspaces;
mod tables;
mod task_detail_api;
pub mod task_export_docx;
mod task_mutation_api;
mod task_pipeline_stage_info;
#[path = "task_pipeline_stage_info_repo.rs"]
mod task_pipeline_stage_info_repo;
pub mod task_routing;
mod task_skills;
pub mod task_store;
mod task_store_listing;
mod task_store_project;
mod task_store_projects;
mod task_store_statements;
mod tasks_lite_group;
mod tasks_lite_personal;
mod tasks_search;
pub use tasks_search::statements as tasks_search_statements;
mod admin_marketplace_resources;
mod admin_templates;
mod teams;
mod user_git_accounts_sync_summary;
pub mod user_profile;
pub mod user_reader;
mod users_default_teams;
mod users_features;
mod users_me;
mod users_me_available_channels;
mod users_me_mcps_providers_services;
mod users_me_proxy_config;
mod users_runtime_configs;
mod users_search;
mod users_welcome_config;
pub mod video_result_urls;
mod wework_notifications;
mod wework_transcript_encryption;
mod wework_transcripts;
mod work_queues;

// Shared route registrations stay at crate scope for the HTTP macros.
// Public routes are composed by startup::routes.
brz_http_server::registry!(
    dependencies(state: Arc<AppState>),
    auth = auth::AppAuthenticator
);
brz_http_server::registry!(
    group = runtime_check,
    dependencies(rc: startup::RuntimeCheckState),
    auth = auth::AppAuthenticator
);
brz_http_server::registry!(
    group = models_unified,
    dependencies(mu: startup::ModelsState),
    auth = auth::AppAuthenticator
);
brz_http_server::registry!(
    group = remote_workspace_status,
    dependencies(rws: startup::StatusState),
    auth = auth::AppAuthenticator
);
brz_http_server::registry!(
    group = remote_workspace_tree,
    dependencies(rwt: startup::TreeState),
    auth = auth::AppAuthenticator
);

#[cfg(test)]
mod json_contract_tests;

/// JSON input compatibility for legacy projections.
pub mod json_compat;

mod remote_workspace_payload;
