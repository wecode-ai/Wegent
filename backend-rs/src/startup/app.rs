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
    // `executor_version_service` is created once with the application's Redis
    // service: its refresh worker is started here, at process startup, so a
    // device listing only enqueues the refresh a cache miss requires.
    let executor_version =
        crate::executor_version::ExecutorVersionService::from_redis(redis.clone());

    Ok(AppState {
        entity_resolvers: crate::permissions::EntityResolvers::public(mysql.clone()),
        user_profile: Arc::new(crate::user_profile::DefaultUserViewExtension),
        user_git_info: Arc::new(crate::user_profile::StoredGitInfo),
        media_policy: Arc::new(crate::media_policy::DefaultMediaPolicy),
        document_download_policy: Arc::new(
            crate::knowledge_download_policy::DefaultDocumentDownloadPolicy,
        ),
        task_policy: crate::task_routing::TaskPolicy::default(),
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
        oidc_config: config,
        oidc,
        oidc_callback,
        shutdown: Arc::new(ShutdownState::default()),
        attachment_http,
        erp: Arc::new(NoopErpProvider),
        video_result_urls: Arc::new(crate::video_result_urls::NoVideoResultUrlRefresh),
        cloud_runtime_features: Arc::new(crate::devices::NoCloudRuntimeFeatures),
        executor_version,
    })
}
