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
    /// Post-update `git_info` masking for `PUT /api/users/me`. The public
    /// default returns no mask, so the public update emits no second write; an
    /// application whose deployment keeps placeholder Git credentials registers
    /// its own implementation before route construction.
    pub user_git_info_mask: Arc<dyn crate::user_profile::UserGitInfoMasker>,
    pub media_policy: Arc<dyn crate::media_policy::MediaPolicy>,
    /// `_stream_external_attachment`: the registered external media playback
    /// resolvers and their relay. The public default resolves nothing.
    pub external_media: Arc<dyn crate::attachments::external_media::ExternalMediaRelay>,
    /// `POST /api/attachments/upload`'s application-owned storage backend and
    /// best-effort source image upload. The public default
    /// keeps bytes in `subtask_contexts.binary_data` and uploads no image.
    pub attachment_upload: Arc<dyn crate::attachments::upload::AttachmentUploadBackend>,
    /// `resolve_external_attachment_playback` for the chat-history video
    /// blocks. The public default resolves nothing.
    pub external_playback: Arc<dyn crate::attachments::external_media::ExternalPlaybackResolver>,
    pub document_download_policy: Arc<dyn crate::knowledge_download_policy::DocumentDownloadPolicy>,
    /// Task and subtask row reads. The public default reads the single
    /// `tasks` / `subtasks` tables; an application whose deployment resolves
    /// task storage differently registers its own implementation before route
    /// construction.
    pub task_store: Arc<dyn crate::task_store::TaskStore>,
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
    /// Process-lifetime Celery publisher for work the source detaches from a
    /// request (`index_document_task.delay(...)`). Its subscriber keeps the
    /// result-backend lane off the shared Redis writer session.
    pub celery: crate::CeleryBroker,
    /// Process-owned Socket.IO Redis-adapter subscription used by migrated
    /// handlers that perform an interactive `sio.call` round trip.
    pub socketio_rpc: Option<std::sync::Arc<crate::socketio_rpc::SocketIoRpc>>,
    pub oidc_config: OidcConfig,
    pub oidc: OidcService,
    /// Callback selected by the application before route construction.
    pub oidc_callback: std::sync::Arc<dyn OidcCallbackHandler + Send + Sync>,
    pub(crate) shutdown: std::sync::Arc<ShutdownState>,
    /// Storage-object HTTP client for the attachment download path
    /// (`MinIOStorageBackend`); shares no state with the OIDC client.
    pub attachment_http: brz_http::Client,
    /// `GET /api/utils/url-metadata`'s page-fetch client
    /// (`app.services.url_metadata.fetch_url_metadata`): a process-lifetime
    /// redirect-following client with the source's 5-second timeout.
    pub url_metadata_http: brz_http::Client,
    /// Single-attempt decision provider client: no redirects and a 30s budget.
    pub decision_http: brz_http::Client,
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
    /// Skill market providers for `GET /api/skill-market/search`. The public
    /// default registers none; an application with a market registers its
    /// provider before route construction.
    pub skill_market: crate::skill_market::SkillMarketRegistry,
    /// MCP provider plugins for `POST /api/mcp-providers/{provider_key}/servers`.
    /// The public default registers none; an application with providers
    /// registers its plugins before route construction.
    pub mcp_providers: crate::mcp_providers::McpProviderRegistry,
    /// `GET /api/devices` `runtime_features` projection for the cloud device
    /// group. The public default renders none; an application whose
    /// configured cloud store projects cached Runtime features registers its
    /// own implementation before route construction.
    pub cloud_runtime_features: Arc<dyn crate::devices::CloudRuntimeFeatures>,
    /// `executor_version_service`: the cached executor version every device
    /// listing reads, plus the process-owned background refresh its cache miss
    /// starts. Built with the process Redis service at startup.
    pub executor_version: crate::executor_version::ExecutorVersionService,
    /// Retained executor-manager HTTP client for the task delete path's
    /// sandbox/executor cleanup calls.
    pub executor_manager: crate::executor_manager::ExecutorManager,
    /// Retained Sites project-API client for `GET /api/sites`. Built once at
    /// startup from `SITES_API_BASE_URL` / `SITES_API_TOKEN`; a missing base
    /// URL is rendered per request as the `503 sites_not_available` body.
    pub sites: crate::sites::SitesClient,
    /// Provider credential resolution shared by the LLM and decision gateways.
    /// The public default returns the processed Model CRD value; an application
    /// whose Model CRDs carry user-scoped
    /// placeholders registers its own resolver before route construction.
    pub llm_proxy_credentials: Arc<dyn crate::llm_proxy::LlmProxyCredentials>,
    /// `gitlab_provider_patch._resolve_tokens_for_user`: stored `"***"` GitLab
    /// tokens for `GET /api/git/repositories`. The public default keeps the
    /// stored value.
    pub repository_tokens: Arc<dyn crate::repository_tokens::RepositoryTokenResolver>,
    /// `GET /api/git/repositories` aggregation: the retained provider HTTP
    /// client, the domain cache adapter, and the background full-fetch worker.
    pub git_repositories: crate::git_repositories::GitRepositoriesService,
    /// `create_response`'s background execution dispatch: one process-owned
    /// worker built at startup so the fire-and-forget executor/chat-shell
    /// dispatch is initialization-owned rather than a request-owned task.
    pub responses_dispatch: std::sync::Arc<crate::responses::dispatch::ResponsesDispatch>,
    /// `OutboundTokenService._collect_extra_claims`: extra JWT claims for
    /// `POST /api/v1/token-issuers/{issuer_id}/issue`. The public default
    /// contributes none; an application whose deployment patches the source
    /// service (for example to inject `employee_id`) registers its own
    /// implementation before route construction.
    pub token_issuer_extra_claims: Arc<dyn crate::token_issuers::OutboundTokenExtraClaims>,
}
