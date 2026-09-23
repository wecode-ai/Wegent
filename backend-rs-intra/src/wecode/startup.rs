//! Internal resource initialization and API registration.
use super::state::WecodeAppState;
use anyhow::{Context as _, Result};
use brz_redis::{RedisService, RedisServiceOptions};
use std::sync::Arc;
use wegent_backend_rs::AppState;

pub(crate) type SharedWecodeAppState = Arc<WecodeAppState<RedisService>>;

brz_http_server::registry!(
    group = wecode_apis,
    dependencies(wecode: SharedWecodeAppState),
    auth = wegent_backend_rs::auth::AppAuthenticator
);

/// Retain the existing public state and create private services once at startup.
///
/// # Database session collation
///
/// The shared MySQL service is opened from `DATABASE_URL` and optional
/// `DATABASE_SLAVE_URL` by `wegent_backend_rs::build_app_state` before this
/// runs, so the session
/// collation must be pinned on that URL. It has to match the collation the
/// source driver's session ends up with: PyMySQL issues `SET NAMES utf8mb4`
/// when it connects, which leaves `collation_connection` at the server's
/// default collation for the `utf8mb4` character set (`utf8mb4_0900_ai_ci` on
/// MySQL 8.0). A server-derived string compared against a schema column
/// inherits the session collation, so `resource_members.entity_id =
/// CAST(namespace.id AS CHAR)` in the `GET /api/teams` union raises
/// `ER_CANT_AGGREGATE_2COLLATIONS` (1267) whenever the two differ. Pin the
/// collation on the connection URL rather than adding per-statement collations
/// to the migrated SQL.
pub async fn build(mut app: AppState) -> Result<SharedWecodeAppState> {
    // Customize the owned public state before any handlers clone it.
    // with_route shares the existing pool; it does not create a second pool.
    app.mysql = app.mysql.with_route(super::sharding::TaskRouting);
    app.task_policy = wegent_backend_rs::task_routing::TaskPolicy {
        is_scoped_id: super::sharding::is_new_task_id,
        resolve_migrated_legacy: true,
    };
    app.workspace_repository = Arc::new(super::subscription_workspaces::ShardedWorkspaceRepository);
    app.erp = erp_provider(app.mysql.clone());
    app.user_profile = Arc::new(super::user_profile::WecodeUserProfile);
    // The `GET /api/users/me` wrapper resolves the current user's stored Git
    // credentials through the internal token service (`GetUserGitInfo`).
    // `WecodeGitInfo` owns the retained token-service client.
    app.user_git_info = Arc::new(
        super::git_tokens::WecodeGitInfo::new().context("failed to build the Git token source")?,
    );
    app.media_policy = Arc::new(super::media_policy::WecodeMediaPolicy);
    app.document_download_policy =
        Arc::new(super::document_download_policy::WecodeDocumentDownloadPolicy);
    app.entity_resolvers =
        wegent_backend_rs::permissions::EntityResolvers::public(app.mysql.clone());
    app.entity_resolvers.register(
        "org_department",
        super::entity_resolver::DepartmentResolver(app.erp.clone()),
    );
    // Source app/services/tauth.py: a dedicated endpoint, not REDIS_URL.
    let endpoint = "rm7455.eos.grid.sina.com.cn:7455:0".to_string();
    let tauth_redis = match RedisService::noshard_with_options(
        endpoint.clone(),
        [endpoint],
        RedisServiceOptions::default(),
    )
    .await
    {
        Ok(redis) => Some(redis),
        Err(error) => {
            tracing::warn!(%error, "failed to initialize TAuth Redis service");
            None
        }
    };
    // `register_video_generation_extension(WeiboVideoGenerationExtension())`:
    // the internal video integration re-signs the playback URLs of task detail
    // responses. It shares the TAuth Redis client with the AIGC playback route.
    app.video_result_urls = Arc::new(super::video_result_urls::WeiboVideoResultUrls::new(
        tauth_redis.clone(),
    ));
    // `SERVICE_EXTENSION=wecode.cache` replaces `userReader` with the cached
    // reader (`wecode/cache/users.py`): `user:v2:data` read-through with the
    // public SQL fallback. The cache client comes from `get_redis_client()`,
    // which builds an independent client from `REDIS_URL` and optional
    // `REDIS_SLAVE_URL` — the extension keeps its own connections instead of
    // sharing the application client the rate limiter and other services use.
    // An unavailable Redis leaves the public SQL reader in place, mirroring
    // `CachedUserReader.wrap()` returning `None`.
    let user_cache_redis = wegent_backend_rs::build_cache_client().await;
    super::user_cache::install(&mut app, user_cache_redis);
    // `wecode.service.nevis_client.nevis_client`: one client built at import
    // time from the Nevis settings, shared by every cloud-device endpoint.
    let nevis_client = super::nevis::NevisClient::new(super::nevis::NevisSettings::from_env())
        .context("failed to build the Nevis HTTP client")?;
    // `wecode.service.cloud_device_provider.CloudDeviceProvider.
    // _project_runtime_features`: the internal cloud store advertises the
    // sandbox Runtime's desktop capability only while the Nevis client is
    // configured, so the projection is decided once at startup.
    app.cloud_runtime_features = Arc::new(
        super::cloud_device_runtime_features::CloudDeviceRuntimeFeatures::new(
            nevis_client.is_configured(),
        ),
    );
    let app = Arc::new(app);
    let aigc_quota_endpoint = super::aigc::build_endpoint(super::aigc::AIGC_QUOTA_URL)
        .context("failed to build AIGC quota endpoint")?;
    let aigc_quota = super::aigc::AigcQuotaService::new(aigc_quota_endpoint, app.redis.clone());
    Ok(Arc::new(WecodeAppState {
        app,
        tauth_redis,
        aigc_quota,
        nevis_client,
    }))
}

pub(crate) fn routes(
    wecode: SharedWecodeAppState,
) -> Result<
    brz_http_server::Router<wegent_backend_rs::auth::AppAuthenticator>,
    brz_http_server::RegistryError,
> {
    brz_http_server::handlers!(wecode = wecode; group = self::wecode_apis)
}

/// Select the private implementation of the public ERP provider contract.
fn erp_provider(
    mysql: brz_mysql::MysqlService,
) -> Arc<dyn wegent_backend_rs::erp_provider::ErpProvider + Send + Sync> {
    Arc::new(super::erp_provider_impl::ErpClientProvider {
        client: super::erp::ErpClient::new(&super::erp_config::AppConfig::from_env()),
        mysql,
    })
}

#[cfg(test)]
mod tests {
    use brz_http_server::__private::inventory;

    #[test]
    fn private_routes_are_registered_once_in_the_private_group() {
        let mut paths: Vec<_> = inventory::iter::<super::__http_registry_wecode_apis::Entry>
            .into_iter()
            .flat_map(|entry| (entry.0.routes)().iter().map(|route| route.path))
            .collect();
        paths.sort_unstable();
        assert_eq!(
            paths,
            [
                "/api/aigc-video/media/playback",
                "/api/cloud-devices/:device_id/status",
                "/api/cloud-devices/config",
                "/api/grey/status",
                "/api/wecode/external-knowledge/:provider/knowledge-bases",
            ]
        );
    }
}
