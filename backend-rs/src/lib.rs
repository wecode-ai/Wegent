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
    ExternalPlayback, ExternalPlaybackResolver, MediaStream, NoExternalPlaybackResolver,
    PlaybackDeliveryMode,
};
pub use attachments::minio_client::{MinioConfig, encode_object_path, ensure_bucket_exists};
pub use attachments::s3_signing::{
    EMPTY_BODY_SHA256, SignedRequest, amz_timestamp_now, hex_sha256, sign_headers,
};
pub use attachments::upload::{
    AttachmentUploadBackend, ImagePid, ImageUploadRequest, StoreObjectRequest, UploadBackendError,
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
    HybridConfig, load_routes_config, run_hybrid, run_hybrid_with_gateway, serve_hybrid,
    serve_hybrid_application, serve_hybrid_application_with_gateway,
};
pub use knowledge_documents_content::access::is_organization_namespace;
pub use repository_tokens::{RepositoryTokenResolver, StoredRepositoryTokens};
pub use startup::app::build as build_app_state;
pub use startup::mysql::connect as connect_mysql;
pub use startup::redis::cache_client as build_cache_client;
pub use state::AppState;

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
mod admin_users;
mod api_keys;
mod api_v1_wework_notifications_probe;
mod application;
mod apps_installed;
mod attachment_block;
mod attachments;
mod attachments_task_all;
pub mod auth;
mod auth_login;
mod authenticate;
mod board_snapshot;
mod bots;
mod celery_broker;
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
pub mod config;
mod connector_runtime;
mod conversion_callback;
mod crd;
mod decisions;
mod delivery_storage;
mod device_command;
pub mod device_commands;
pub mod device_identity;
mod device_online_state;
mod device_records;
mod device_running_tasks;
mod device_upgrade;
pub mod devices;
mod dingtalk_wikispace;
mod dsh_plugin_storage;
pub mod erp_provider;
pub mod erp_types;
mod executor_manager;
pub mod executor_version;
mod experimental_dag_probe;
mod filters;
mod git_repositories;
mod groups;
mod headers;
pub mod http_compat;
mod http_fallback;
pub mod http_trust;
mod hybrid;
mod im_private_sessions;
mod incoming_hooks;
mod internal_api_keys;
mod internal_attachments_download;
mod internal_auth;
mod internal_callback;
mod internal_conversion_callback;
mod internal_robot_queue;
pub mod json_decode_error;
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
mod loop_tasks;
mod market_subscriptions;
mod marketplace_tags;
mod mcp;

pub use mcp::interactive_form_question::{
    InteractiveFormQuestionNormalizer, InteractiveFormRegistry,
};
pub use mcp::knowledge_external::auth::{
    ExternalKnowledgeAuth, ExternalKnowledgeUser, PersonalApiKeyAuth,
};
mod mcp_identity;
pub mod mcp_providers;
pub mod media_policy;
mod method_call_anon;
mod method_login;
mod models_error_recommendations;
mod models_unified;
pub mod new_user_resources;
mod oauth_clients;
pub mod oidc_callback;
mod oidc_cli_callback;
mod oidc_cli_login;
mod oidc_cli_poll;
mod oidc_login;
pub mod oidc_service;
pub mod permissions;
mod pet;
mod plugin_publications;
mod plugins_capabilities_probe;
mod plugins_installed;
mod plugins_marketplace;
mod projects;
mod py_set_order;
mod quota;
mod remote_workspace_status;
mod remote_workspace_tree;
mod repository_tokens;
mod resource_library_listings;
mod resource_library_tags;
mod resource_library_team_icons;
mod resource_refs;
mod responses;
mod runtime_check;
mod runtime_profiles;
mod runtime_work;
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
mod site_app_types;
mod sites;
pub mod skill_market;
mod skills;
mod smart_apps_download;
mod smart_apps_marketplace;
mod snapshots;
mod socketio_emit;
pub mod socketio_rpc;
mod sql_support;
#[cfg(test)]
mod sql_test_support;
mod startup;
mod state;
mod stripe_webhook_probe;
mod subscription_developer_settings;
mod subscription_executions;
mod subscriptions_item;
mod subscriptions_list;
pub use subscriptions_item::random_token_urlsafe;
pub use subscriptions_list::workspaces as subscription_workspaces;
mod subtasks;
mod system_execute_sql_for_single;
mod tables;
pub mod task_creation;
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
mod task_skills;
mod task_source_group;
pub mod task_store;
mod task_store_cancel_statements;
mod task_store_create;
mod task_store_default;
mod task_store_edit;
mod task_store_executor_reference;
mod task_store_listing;
mod task_store_pipeline;
mod task_store_project;
mod task_store_project_count;
mod task_store_projects;
mod task_store_public_share;
mod task_store_statements;
mod task_store_subtask_content;
mod task_store_subtask_writes;
mod task_store_tables;
mod task_store_traits;
mod task_token;
mod tasks_db_projection;
mod tasks_list;
mod tasks_lite_group;
mod tasks_lite_personal;
mod tasks_search;
pub use tasks_search::statements as tasks_search_statements;
mod admin_marketplace_resources;
mod admin_templates;
mod teams;
pub mod token_issuers;
mod tokens_probe;
mod url_metadata;
mod url_metadata_extract;
mod url_ssrf;
mod user_git_accounts_sync_summary;
mod user_login_probe;
pub mod user_profile;
pub mod user_reader;
mod users_default_teams;
mod users_features;
mod users_me;
mod users_me_available_channels;
mod users_me_mcps_providers_services;
mod users_me_proxy_config;
mod users_me_subscription_invitations;
mod users_me_update;
mod users_me_wegent_runtime;
mod users_me_wegent_runtime_token;
mod users_runtime_configs;
mod users_search;
mod users_welcome_config;
mod v1_resources;
pub mod video_result_urls;
mod web_scraper;
mod web_scraper_create_document;
mod wework_auth;
mod wework_auth_refresh;
mod wework_auth_tokens;
mod wework_notification_preferences;
mod wework_notifications;
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
