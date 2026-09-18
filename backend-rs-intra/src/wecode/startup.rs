//! Internal resource initialization and API registration.
use super::state::WecodeAppState;
use anyhow::{Context as _, Result};
use brz_redis::{RedisService, RedisServiceOptions};
use std::sync::Arc;
use wegent_backend_rs::AppState;

pub(crate) type SharedWecodeAppState = Arc<WecodeAppState<RedisService>>;

brz_http_server::registry!(
    group = wecode_apis,
    dependencies(wecode: SharedWecodeAppState)
);

/// Retain the existing public state and create private services once at startup.
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
    let app = Arc::new(app);
    let aigc_quota_endpoint = super::aigc::build_endpoint(super::aigc::AIGC_QUOTA_URL)
        .context("failed to build AIGC quota endpoint")?;
    Ok(Arc::new(WecodeAppState {
        app,
        tauth_redis,
        aigc_quota_endpoint,
    }))
}

pub(crate) fn routes(
    wecode: SharedWecodeAppState,
) -> Result<brz_http_server::Router, brz_http_server::RegistryError> {
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
                "/api/cloud-devices/config",
                "/api/grey/status",
                "/api/wecode/external-knowledge/:provider/knowledge-bases",
            ]
        );
    }
}
