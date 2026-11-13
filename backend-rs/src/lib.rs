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
pub use workspace_archive::save::archive as archive_task_workspace;

mod admin_connector_apps;
mod admin_im_channels;
mod admin_im_channels_status;
mod admin_marketplace_tags;
mod admin_public_bots;
mod admin_public_ghosts;
mod admin_public_models;
mod admin_public_retrievers;
mod admin_public_shells;
mod admin_public_teams;
mod admin_service_keys;
mod admin_subscription_monitor_errors;
mod admin_system_config_slogan_tips;
mod api_keys;
mod api_v1_wework_notifications_probe;
mod application;
mod apps_installed;
mod attachment_block;
mod attachments;
mod attachments_task_all;
pub use wegent_identity::auth;
mod authenticate;
pub mod background_jobs;
mod board_snapshot;
mod bots;
pub use wegent_celery as celery_broker;
mod chat_attachment_text;
mod chat_guidance;
mod chat_guidance_consume;
mod chat_history;
mod chat_message_update;
mod chat_repository;
mod ci_lint_probe;
mod cloud_project_automations;
mod cloud_projects;
mod cloud_projects_members;
mod cloud_projects_runtime_default;
mod collaboration_templates;
pub use wegent_backend_config as config;
mod connector_runtime;
mod conversion_callback;
pub(crate) use wegent_resource_store::crd;
mod decisions;
mod delivery_storage;
mod delivery_update;
mod device_artifacts;
mod device_command;
pub mod device_commands;
pub mod device_identity;
mod device_identity_lock;
mod device_online_state;
mod device_presence;
mod device_records;
mod device_running_tasks;
mod device_upgrade;
pub mod devices;
mod dingtalk_wikispace;
mod dsh_plugin_storage;
pub use wegent_directory::erp_provider;
pub use wegent_directory::erp_types;
use wegent_executor_manager::executor_manager;
pub mod executor_version;
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
mod incoming_hooks;
mod internal_api_keys;
mod internal_attachments_download;
pub(crate) use wegent_identity::internal_auth;
mod internal_callback;
mod internal_conversion_callback;
mod internal_robot_queue;
pub(crate) use wegent_identity::jwt_compat;
mod knowledge_artifacts;
mod knowledge_base_detail;
mod knowledge_bases_all_grouped;
mod knowledge_bases_list;
mod knowledge_documents_content;
mod knowledge_documents_detail;
mod knowledge_documents_list;
pub mod knowledge_download_policy;
mod knowledge_external_import_status;
mod knowledge_folders;
mod knowledge_multimodal_prompts;
mod knowledge_organization_namespace;
mod knowledge_wiki_bindings;
pub mod llm_proxy;
mod loop_deliveries;
mod loop_item_attachments;
mod loop_item_executions;
pub(crate) mod loop_item_pages;
mod loop_items;
mod loop_node_storage;
mod loop_tasks;
mod market_subscriptions;
mod marketplace_tags;
mod mcp;
mod milestones;
mod project_coordination;
pub use wegent_task_store::task_store_background;
pub use wegent_task_store::task_store_maintenance;

pub use mcp::interactive_form_question::{
    InteractiveFormQuestionNormalizer, InteractiveFormRegistry,
};
pub use mcp::knowledge_external::auth::{
    ExternalKnowledgeAuth, ExternalKnowledgeUser, PersonalApiKeyAuth,
};
#[cfg(test)]
mod app_test_support;
mod mcp_identity;
pub(crate) mod mcp_oauth_credentials;
pub mod mcp_provider_registry;
pub mod mcp_providers;
pub(crate) mod mcp_user_service;
pub use wegent_media::media_policy;
mod method_call_anon;
mod method_login;
mod models_error_recommendations;
use wegent_models as models_unified;
pub use wegent_onboarding::new_user_resources;
mod oauth_clients;
pub use wegent_access::permissions;
pub use wegent_oidc::oidc_callback;
pub use wegent_oidc::oidc_service;
mod pet;
mod plugin_account_auth;
mod plugin_publications;
mod plugins_capabilities_probe;
mod plugins_installed;
mod plugins_marketplace;
mod projects;
pub(crate) mod provider_guidance;
mod quota;
pub(crate) use wegent_git_repositories::repository_tokens;
use wegent_remote_workspace::remote_workspace_status;
use wegent_remote_workspace::remote_workspace_tree;
mod resource_library_listings;
mod resource_library_tags;
mod resource_library_team_icons;
pub(crate) use wegent_resource_store::resource_refs;
mod responses;
use wegent_runtime_check as runtime_check;
mod runtime_profiles;
mod runtime_transcript_search;
mod runtime_work;
mod runtime_work_im_notification_sessions;
mod runtime_work_im_notifications;
mod runtime_work_projection;
mod runtime_work_transcript;
mod runtime_work_transcript_access;
mod runtime_work_transcript_request;
mod runtime_work_transcript_response;
mod sessions;
mod share_knowledge_base_my_permission;
mod shells_unified;
mod shutdown_state;
pub(crate) use wegent_sites::sites;
pub mod skill_market;
mod skills;
mod smart_apps_download;
mod smart_apps_marketplace;
mod snapshots;
pub mod socketio;
pub(crate) use wegent_backend_persistence::sql_support;
#[cfg(test)]
pub(crate) use wegent_backend_test_support as sql_test_support;
pub(crate) use wegent_socket_events::socketio_emit;
pub use wegent_socket_events::socketio_rpc;
mod startup;
mod state;
mod stripe_webhook_probe;
mod subscription_developer_settings;
mod subscription_executions;
mod subscriptions_item;

pub use subscriptions_item::crypto::decrypt_sensitive_data;
mod subscriptions_list;
pub use subscriptions_item::random_token_urlsafe;
pub use subscriptions_list::workspaces as subscription_workspaces;
/// Caller-owned SQL handle for one request-scoped transaction.
pub use wegent_backend_persistence::request_sql;
mod subtasks;
mod system_execute_sql_for_single;
mod tables;
pub use wegent_task_store::task_creation;
mod share_access;
mod task_detail_api;
pub mod task_export_docx;
mod task_mutation_api;
mod task_pipeline_stage_info;
#[path = "task_pipeline_stage_info_repo.rs"]
mod task_pipeline_stage_info_repo;
pub mod task_routing;
mod task_run_metric_hooks;
mod task_run_metrics;
mod task_share_api;
use wegent_capabilities::task_skills;
mod task_source_group;
use wegent_identity::task_token;
pub use wegent_task_store::task_store;
pub use wegent_task_store::task_store_cancel_statements;
pub use wegent_task_store::task_store_create;
pub use wegent_task_store::task_store_default;
pub use wegent_task_store::task_store_edit;
pub use wegent_task_store::task_store_executor_reference;
pub use wegent_task_store::task_store_listing;
pub use wegent_task_store::task_store_personal;
pub use wegent_task_store::task_store_pipeline;
pub use wegent_task_store::task_store_project;
pub use wegent_task_store::task_store_project_count;
pub use wegent_task_store::task_store_projects;
pub use wegent_task_store::task_store_public_share;
pub use wegent_task_store::task_store_statements;
pub use wegent_task_store::task_store_subtask_content;
pub use wegent_task_store::task_store_subtask_writes;
pub use wegent_task_store::task_store_tables;
pub use wegent_task_store::task_store_traits;
mod tasks_db_projection;
mod tasks_list;
mod tasks_lite_group;
mod tasks_lite_personal;
mod tasks_search;
pub use tasks_search::statements as tasks_search_statements;
mod admin_marketplace_resources;
mod admin_templates;
mod git_connection_inbox;
mod teams;
pub mod token_issuers;
mod tokens_probe;
mod transaction_outcome;
mod url_metadata;
mod url_metadata_extract;
pub(crate) use wegent_network_policy::url_ssrf;
mod user_git_accounts_sync_summary;
mod user_login_probe;
mod user_mcp_oauth;
pub use wegent_backend_users::user_profile;
use wegent_backend_users::users_features;
pub use wegent_identity::user_reader;
mod users_me_mcps_providers_services;
use wegent_backend_users::users_me_proxy_config;
mod users_me_subscription_invitations;
use wegent_backend_users::users_runtime_configs;
mod v1_resources;
pub use wegent_media::video_result_urls;
mod web_scraper;
mod web_scraper_create_document;
use wegent_identity::wework_auth_tokens;
mod stand_in_issue_events;
mod wework_notification_preferences;
mod wework_notifications;
mod wework_runtime_downloads;
mod wework_transcript_archive_storage;
mod wework_transcript_encryption;
mod wework_transcript_lease_release;
mod wework_transcript_lease_transaction;
mod wework_transcript_segment_manifest;
mod wework_transcripts;
mod wework_transcripts_lease;
mod wework_transcripts_segments;
mod wiki_connections;
mod work_queues;
mod workspace_archive;
mod workspace_detail;
mod workspace_members;
mod workspace_rendering;
mod workspaces;
mod workspaces_execution_environments;

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
mod git_route_ownership_tests;
