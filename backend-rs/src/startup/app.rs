// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Standalone public state: base tables and optional directory extensions.
use crate::config::OidcConfig;
use crate::erp_provider::NoopErpProvider;
use crate::oidc_service::OidcService;
use crate::shutdown_state::ShutdownState;
use crate::state::AppState;
use crate::user_reader::PublicUserReader;
use crate::{attachments, config, oidc_callback};
use anyhow::{Context as _, Result};
use std::sync::Arc;

pub async fn build() -> Result<AppState> {
    // `Settings.LOCAL_DEVICE_COMMANDS` is validated while the source process
    // starts; an invalid value fails startup instead of the first command.
    crate::device_commands::init_from_env().context("failed to load LOCAL_DEVICE_COMMANDS")?;

    let config = OidcConfig::from_env();
    let oidc = OidcService::new(&config).context("failed to build OIDC provider client")?;

    // Applications may replace the default callback before routes are assembled.
    let oidc_callback: Arc<dyn oidc_callback::OidcCallbackHandler + Send + Sync> =
        Arc::new(oidc_callback::DefaultOidcCallbackHandler);

    let auth = config::AuthConfig::from_env();
    let database =
        config::DatabaseConfig::from_env().context("failed to load database configuration")?;
    let redis_config =
        config::RedisConfig::from_env().context("failed to load redis configuration")?;

    let internal_chat = config::InternalChatConfig::from_env();
    let jwt_algorithm = auth.algorithm.clone();
    let mut jwt_secret_keys = vec![std::sync::Arc::from(auth.jwt_key.as_str())];
    for legacy in auth.legacy_jwt_keys.iter() {
        let candidate: std::sync::Arc<str> = std::sync::Arc::from(legacy.as_str());
        if !jwt_secret_keys.contains(&candidate) {
            jwt_secret_keys.push(candidate);
        }
    }
    let attachment_http = attachments::minio_client::build_client()?;
    let attachment_upload: Arc<dyn attachments::upload::AttachmentUploadBackend> =
        match config::env_or_dotenv("ATTACHMENT_STORAGE_BACKEND")
            .unwrap_or_else(|| "mysql".to_owned())
            .to_ascii_lowercase()
            .as_str()
        {
            "minio" | "s3" => Arc::new(attachments::upload::S3StorageBackend::new(
                attachment_http.clone(),
                attachments::minio_client::MinioConfig::from_env()
                    .context("S3 attachment storage requires endpoint and credentials")?,
            )),
            _ => Arc::new(attachments::upload::MySqlStorageBackend),
        };
    let decision_http = crate::decisions::provider::build_client()?;
    let url_metadata_http =
        crate::url_metadata::build_client().context("failed to build the url-metadata client")?;
    let master_url = database.mysql_url();
    let slave_url = database.mysql_slave_url();
    let mysql = super::mysql::connect_read_write(&master_url, slave_url.as_deref())
        .context("failed to connect MySQL service")?;
    // The source tolerates an unavailable Redis for the endpoints that use
    // it as a cache (membership/online-info reads degrade to misses); the
    // connection is therefore best-effort, matching the source deployment.
    let redis = match super::redis::shared(&redis_config).await {
        Ok(service) => Some(service),
        Err(error) => {
            tracing::warn!(%error, "failed to connect Redis service; continuing without Redis-backed caches");
            None
        }
    };
    // The Celery result consumer keeps its own connection
    // (`celery/backends/redis.py:ResultConsumer.start`). It is best-effort like
    // the shared service: without it an index dispatch fails exactly as an
    // unreachable source broker would.
    let celery_subscriber = if redis.is_some() {
        match super::redis::celery_subscriber(&redis_config).await {
            Ok(service) => Some(service),
            Err(error) => {
                tracing::warn!(%error, "failed to connect the Celery result subscriber");
                None
            }
        }
    } else {
        None
    };
    let celery = crate::celery_broker::CeleryBroker::new(celery_subscriber);
    // `executor_version_service` is created once with the application's Redis
    // service: its refresh worker is started here, at process startup, so a
    // device listing only enqueues the refresh a cache miss requires.
    let executor_version =
        crate::executor_version::ExecutorVersionService::from_redis(redis.clone())
            .context("failed to build the executor-version service")?;
    // The source Socket.IO server's `AsyncRedisManager` subscribes to the
    // adapter channel once per process. Migrated interactive RPC handlers share
    // that process-owned subscription instead of opening one per request.
    let socketio_rpc = Some(crate::socketio_rpc::SocketIoRpc::start(&redis_config));
    // `GET /api/git/repositories`: the retained provider HTTP client and the
    // process-owned background full-fetch worker are built here so the worker
    // is initialization-owned.
    let git_repositories = crate::git_repositories::GitRepositoriesService::new(redis.clone())
        .context("failed to build the repository-service client")?;

    Ok(AppState {
        entity_resolvers: crate::permissions::EntityResolvers::public(mysql.clone()),
        seed_tasks: crate::new_user_resources::default_tasks(mysql.clone()),
        user_profile: Arc::new(crate::user_profile::DefaultUserViewExtension),
        user_git_info: Arc::new(crate::user_profile::StoredGitInfo),
        user_git_info_mask: Arc::new(crate::user_profile::NoGitInfoMasking),
        media_policy: Arc::new(crate::media_policy::DefaultMediaPolicy),
        external_media: Arc::new(crate::attachments::external_media::NoExternalMediaRelay),
        attachment_upload,
        external_playback: Arc::new(crate::attachments::external_media::NoExternalPlaybackResolver),
        document_download_policy: Arc::new(
            crate::knowledge_download_policy::DefaultDocumentDownloadPolicy,
        ),
        task_store: Arc::new(crate::task_store::DefaultTaskStore::new(mysql.clone())),
        workspace_repository: Arc::new(
            crate::subscriptions_list::workspaces::BaseWorkspaceRepository,
        ),
        user_reader: Arc::new(PublicUserReader::new(mysql.clone())),
        auth,
        internal_chat,
        jwt_secret_keys,
        jwt_algorithm,
        mysql,
        redis,
        celery,
        socketio_rpc,
        oidc_config: config,
        oidc,
        oidc_callback,
        shutdown: Arc::new(ShutdownState::default()),
        attachment_http,
        decision_http,
        url_metadata_http,
        erp: Arc::new(NoopErpProvider),
        video_result_urls: Arc::new(crate::video_result_urls::NoVideoResultUrlRefresh),
        cloud_runtime_features: Arc::new(crate::devices::NoCloudRuntimeFeatures),
        skill_market: crate::skill_market::SkillMarketRegistry::default(),
        mcp_providers: crate::mcp_providers::McpProviderRegistry::default(),
        interactive_form: crate::InteractiveFormRegistry::default(),
        executor_version,
        executor_manager: crate::executor_manager::ExecutorManager::from_env()
            .context("failed to build the executor-manager client")?,
        sites: crate::sites::SitesClient::from_env()
            .context("failed to build the Sites HTTP client")?,
        llm_proxy_credentials: Arc::new(crate::llm_proxy::StoredLlmProxyCredentials),
        repository_tokens: Arc::new(crate::repository_tokens::StoredRepositoryTokens),
        git_repositories,
        // The outbound token issuer's `_collect_extra_claims` seam: the
        // open-source core contributes no extra claims.
        token_issuer_extra_claims: Arc::new(crate::token_issuers::NoExtraClaims),
        external_knowledge_auth: Arc::new(crate::mcp::knowledge_external::auth::PersonalApiKeyAuth),
        // `create_response`'s background dispatch worker is spawned here so the
        // fire-and-forget executor/chat-shell dispatch is initialization-owned.
        responses_dispatch: Arc::new(crate::responses::dispatch::ResponsesDispatch::spawn()),
    })
}
