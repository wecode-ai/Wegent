// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared application state: configuration plus the long-lived MySQL and
//! Redis services, the retained OIDC client, the employee directory, and the
//! graceful-shutdown flag.
use crate::config::AuthConfig;
use crate::config::InternalChatConfig;
use crate::config::OidcConfig;
use crate::erp_provider::ErpProvider;
use crate::oidc_callback::OidcCallbackHandler;
use crate::oidc_service::OidcService;
use crate::shutdown_state::ShutdownState;
use crate::user_reader::UserByIdReader;
use std::sync::Arc;

/// Application-wide state retained for the process lifetime.
pub struct AppState {
    pub entity_resolvers: crate::permissions::EntityResolvers,
    pub user_profile: Arc<dyn crate::user_profile::UserViewExtension>,
    /// Current-user `GET /api/users/me` `git_info` resolution. The public
    /// default renders the stored column.
    pub user_git_info: Arc<dyn crate::user_profile::UserGitInfoProvider>,
    pub media_policy: Arc<dyn crate::media_policy::MediaPolicy>,
    pub document_download_policy: Arc<dyn crate::knowledge_download_policy::DocumentDownloadPolicy>,
    pub task_policy: crate::task_routing::TaskPolicy,
    /// Lookup strategy for Workspace resources referenced by subscriptions.
    pub workspace_repository: Arc<dyn crate::subscriptions_list::workspaces::WorkspaceRepository>,
    pub auth: AuthConfig,
    pub internal_chat: InternalChatConfig,
    /// JWT decode keys for the plugins-installed endpoint (active first,
    /// then `JWT_LEGACY_SECRET_KEYS`), as `Arc<str>` handles.
    pub jwt_secret_keys: Vec<std::sync::Arc<str>>,
    pub jwt_algorithm: String,
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub oidc_config: OidcConfig,
    pub oidc: OidcService,
    /// Callback selected by the application before route construction.
    pub oidc_callback: std::sync::Arc<dyn OidcCallbackHandler + Send + Sync>,
    pub(crate) shutdown: std::sync::Arc<ShutdownState>,
    /// Storage-object HTTP client for the attachment download path
    /// (`MinIOStorageBackend`); shares no state with the OIDC client.
    pub attachment_http: brz_http::Client,
    /// Optional employee directory. The public default returns no external
    /// employee identities or department memberships.
    pub erp: std::sync::Arc<dyn ErpProvider + Send + Sync>,
    /// Video URL refresh for assembled task detail responses. The public
    /// default leaves every result payload unchanged.
    pub video_result_urls: Arc<dyn crate::video_result_urls::VideoResultUrlRefresh>,
    /// `userReader.get_by_id` strategy. The public default is the direct
    /// SQL reader; an application whose deployment replaces the reader
    /// (for example with a read-through cache) registers its own
    /// implementation before route construction.
    pub user_reader: Arc<dyn UserByIdReader>,
    /// `GET /api/devices` `runtime_features` projection for the cloud device
    /// group. The public default renders none; an application whose
    /// configured cloud store projects cached Runtime features registers its
    /// own implementation before route construction.
    pub cloud_runtime_features: Arc<dyn crate::devices::CloudRuntimeFeatures>,
    /// `executor_version_service`: the cached executor version every device
    /// listing reads, plus the process-owned background refresh its cache miss
    /// starts. Built with the process Redis service at startup.
    pub executor_version: crate::executor_version::ExecutorVersionService,
}
