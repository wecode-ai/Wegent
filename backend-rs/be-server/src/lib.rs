// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// The assembled Responses create future includes nested dispatch and completion.
#![recursion_limit = "256"]

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
pub use attachments::context_store::{SubtaskContextRow, get_context_optional_with_user};
pub use attachments::external_media::{
    AttachmentDownload, ExternalMediaReference, ExternalMediaRelay, ExternalMediaRequest,
    ExternalPlayback, ExternalPlaybackResolver, MediaStream, NoExternalPlaybackResolver,
    PlaybackDeliveryMode,
};
pub use attachments::minio_client::{
    MinioConfig, encode_object_path, ensure_bucket_exists, stat_object,
};
pub use attachments::s3_signing::{
    EMPTY_BODY_SHA256, SignedRequest, amz_timestamp_now, hex_sha256, sign_headers,
};
pub use attachments::storage::get_attachment_binary_data;
pub use attachments::upload::{
    AttachmentUploadBackend, ExternalAttachmentStorageResult, ExternalAttachmentUploadError,
    ExternalAttachmentUploadRequest, ImagePid, ImageUploadRequest, S3StorageBackend,
    StoreObjectRequest, UploadBackendError,
};
pub use brz_http_gateway::{
    BoxError, ConfigError, ExclusionRule, Gateway, GatewayBody, GatewayResponse,
    MatchedService as RustApi, OriginService, ProxyConfigError, RejectMatched as NoRustApi,
    RouteRule, RouteTable, RoutesConfig, bind, serve,
};
pub use brz_http_server as http_server;
pub use celery_broker::CeleryBroker;
pub use config::{init_env, init_env_file};
pub use filters::RequestIdFilter;
pub use git_repositories::GitRepositoriesService;
pub use hybrid::{
    HybridConfig, load_routes_config, run_hybrid, run_hybrid_with_gateway,
    run_hybrid_with_services, serve_hybrid, serve_hybrid_application,
    serve_hybrid_application_with_gateway, serve_hybrid_application_with_services,
};
pub use knowledge_documents_content::access::is_organization_namespace;
pub use repository_tokens::{RepositoryTokenResolver, StoredRepositoryTokens};
pub use startup::app::build as build_app_state;
pub use startup::app::{
    build_with_clients as build_app_state_with_clients, clients as build_database_clients,
};
pub use startup::database::prepare as prepare_database;
pub mod initialization;
pub mod migrations;
pub use startup::mysql::connect as connect_mysql;
pub use startup::redis::cache_client as build_cache_client;
pub use state::AppState;
pub use workspace_archive::archive_task_workspace;

mod api_v1_wework_notifications_probe;
mod application;
use wegent_attachments as attachments;
mod attachment_access;
#[cfg(test)]
mod attachment_route_tests;
use wegent_attachments::attachments_task_all;
pub use wegent_identity::auth;
mod authenticate;
pub mod background_jobs;
pub use wegent_celery as celery_broker;
pub(crate) use wegent_project_coordination::board_snapshot;
mod chat_guidance;
mod chat_guidance_consume;
mod ci_lint_probe;
pub mod cloud_device_deletion;
mod cloud_projects;
mod collaboration_templates;
pub use wegent_backend_config as config;
mod conversion_callback;
pub(crate) use wegent_resource_store::crd;
#[cfg(test)]
mod decision_route_tests;
mod delivery_update;
#[cfg(test)]
mod device_artifact_route_tests;
#[cfg(test)]
mod device_command;
pub use wegent_devices::{device_commands, device_identity, devices, executor_version};
pub(crate) use wegent_devices::{
    device_identity_lock, device_online_state, device_presence, device_running_tasks,
};
mod device_records;
mod device_runtime_owner;
mod executor_binding;
#[cfg(test)]
mod knowledge_external_route_tests;
mod runtime_observations;
pub use wegent_directory::erp_provider;
pub use wegent_directory::erp_types;
use wegent_executor_manager::executor_manager;
mod experimental_dag_probe;
mod filters;
pub(crate) use wegent_git_repositories::git_repositories;
mod groups;
use wegent_http_compat::fallback as http_fallback;
pub(crate) use wegent_identity::headers;
pub use wegent_network_policy::http_trust;
mod hybrid;
mod im_private_sessions;
mod im_stand_in_bindings;
#[cfg(test)]
mod incoming_hooks;
pub(crate) use wegent_identity::internal_auth;
mod internal_callback;
mod internal_conversion_callback;
mod internal_robot_queue;
mod internal_services;
pub(crate) use wegent_identity::jwt_compat;
use wegent_knowledge::{
    knowledge_artifacts, knowledge_bases_all_grouped, knowledge_documents_content,
};
pub use wegent_knowledge_access::download_policy as knowledge_download_policy;
mod knowledge_dispatch;
#[cfg(test)]
mod knowledge_route_tests;
pub use wegent_llm_proxy as llm_proxy;
#[cfg(test)]
mod llm_proxy_cors_tests;
mod local_project_import;
pub(crate) use wegent_project_coordination::{
    delivery_storage, loop_item_executions, loop_item_pages, loop_node_storage,
};
mod assistant_shares;
mod loop_tasks;
mod mcp;
mod milestones;
mod personal_issues;
pub use wegent_project_notifications::{IssueImRecipient, IssueImRecipientResolver};
mod project_coordination;
mod project_group_roles;
#[cfg(test)]
mod project_read_route_ownership_tests;
pub use wegent_task_store::task_store_background;
pub use wegent_task_store::task_store_maintenance;

pub use mcp::interactive_form_question::{
    InteractiveFormQuestionNormalizer, InteractiveFormRegistry,
};
pub use wegent_knowledge_access::auth::{
    ExternalKnowledgeAuth, ExternalKnowledgeUser, PersonalApiKeyAuth,
};
#[cfg(test)]
mod app_test_support;
mod external_connector_authorization;
mod mcp_identity;
#[cfg(test)]
pub(crate) use wegent_mcp_providers::user_mcp_oauth;
pub use wegent_mcp_providers::{mcp_provider_registry, mcp_providers};
pub use wegent_media::media_policy;
mod method_call_anon;
mod method_login;
mod model_primary_group_icons;
mod models_error_recommendations;
use wegent_models as models_unified;
pub use wegent_onboarding::new_user_resources;
mod oauth_clients;
pub use wegent_access::permissions;
pub use wegent_oidc::oidc_callback;
pub use wegent_oidc::oidc_service;
mod pet;
mod plugins_capabilities_probe;
mod quota;
pub(crate) use wegent_git_repositories::repository_tokens;
use wegent_remote_workspace::remote_workspace_status;
use wegent_remote_workspace::remote_workspace_tree;
mod resource_library_team_icons;
pub(crate) use wegent_resource_store::resource_refs;
mod responses;
use wegent_runtime_check as runtime_check;
mod runtime_model_auth;
mod runtime_work;
mod sessions;
mod shutdown_state;
pub(crate) use wegent_sites::sites;
pub use wegent_skill_market as skill_market;
#[cfg(test)]
mod skill_market_route_tests;
mod snapshots;
pub mod socketio;
pub(crate) use wegent_backend_persistence::sql_support;
#[cfg(test)]
pub(crate) use wegent_backend_test_support as sql_test_support;
pub(crate) use wegent_socket_events::socketio_emit;
pub use wegent_socket_events::socketio_rpc;
mod external_agents;
mod startup;
mod state;
mod stripe_webhook_probe;

/// Caller-owned SQL handle for one request-scoped transaction.
pub use wegent_backend_persistence::request_sql;
pub use wegent_identity::random_token_urlsafe;
pub use wegent_identity::sensitive_data::decrypt_sensitive_data;
pub use wegent_task_store::subscription_workspaces;
#[cfg(test)]
mod subscription_route_ownership_tests;
mod system_execute_sql_for_single;
pub use wegent_task_export_docx as task_export_docx;
pub use wegent_task_store::task_creation;
#[cfg(test)]
mod task_mutation_route_ownership_tests;
mod task_pipeline_stage_info;
#[path = "task_pipeline_stage_info_repo.rs"]
mod task_pipeline_stage_info_repo;
pub mod task_routing;
mod task_view_state;
use wegent_capabilities::task_skills;
pub(crate) use wegent_execution_runtime::task_run_metrics;
pub(crate) use wegent_protocol::chat_errors;
mod task_source_group;
use wegent_identity::task_token;
pub use wegent_task_store::message_pair;
pub use wegent_task_store::owned_statements as tasks_search_statements;
pub use wegent_task_store::task_store;
pub use wegent_task_store::task_store_cancel_statements;
pub use wegent_task_store::task_store_create;
pub use wegent_task_store::task_store_default;
pub use wegent_task_store::task_store_edit;
pub use wegent_task_store::task_store_executor_reference;
pub use wegent_task_store::task_store_history;
pub use wegent_task_store::task_store_listing;
pub use wegent_task_store::task_store_personal;
pub use wegent_task_store::task_store_pipeline;
pub use wegent_task_store::task_store_project;
pub use wegent_task_store::task_store_project_count;
pub use wegent_task_store::task_store_projects;
pub use wegent_task_store::task_store_public_share;
pub use wegent_task_store::task_store_runtime_reads;
pub use wegent_task_store::task_store_statements;
pub use wegent_task_store::task_store_subscription_reads;
pub use wegent_task_store::task_store_subtask_content;
pub use wegent_task_store::task_store_subtask_writes;
pub use wegent_task_store::task_store_tables;
pub use wegent_task_store::task_store_traits;
pub mod token_issuers;
mod tokens_probe;
pub(crate) use wegent_backend_persistence::transaction_outcome;
mod user_git_accounts_sync_summary;
mod user_login_probe;
pub use wegent_backend_users::user_profile;
use wegent_backend_users::users_features;
use wegent_backend_users::users_me_proxy_config;
use wegent_backend_users::users_runtime_configs;
pub use wegent_identity::user_reader;
pub use wegent_media::video_result_urls;
#[cfg(test)]
mod web_content_route_tests;
use wegent_identity::wework_auth_tokens;
mod stand_in_account;
mod stand_in_issue_events;
mod wework_runtime_downloads;
mod work_queues;
mod workspace_archive;

// Shared route registrations stay at crate scope for the HTTP macros.
// Public routes are composed by startup::routes.
brz_http_server::registry!(
    dependencies(state: Arc<AppState>),
    auth = auth::AppAuthenticator
);
brz_socket_io::registry!(
    dependencies(app: Arc<AppState>, runtime: Arc<crate::socketio::runtime::SocketRuntime>)
);

#[cfg(test)]
mod json_contract_tests;

pub use wegent_http_compat as http_compat;
pub use wegent_python_compat::{json_compat, json_decode_error, py_set_order};

#[cfg(test)]
mod chat_subtask_route_ownership_tests;
#[cfg(test)]
mod git_route_ownership_tests;
#[cfg(test)]
mod plugin_publication_route_tests;
#[cfg(test)]
mod plugin_release_route_tests;
#[cfg(test)]
mod plugin_runtime_gateway_tests;
#[cfg(test)]
mod plugins_installed_download_route_tests;
