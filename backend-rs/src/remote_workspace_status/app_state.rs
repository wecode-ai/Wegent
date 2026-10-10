// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Request dependencies supplied by the application at startup.
use super::auth::JwtVerifier;
use super::config::AppConfig;
use super::http_deps::HttpDependencies;
use super::redis_cache::CacheClients;
use super::users::UserStore;
use brz_mysql::Mysql;
use brz_redis::Redis;

/// `refresh_extended_video_result_urls`: the registered video integration
/// and the long-lived client its signing call reuses (the application's
/// attachment client, shared with the task-detail and AIGC playback routes).
pub struct VideoRefresh {
    pub client: brz_http::Client,
    pub extension: std::sync::Arc<dyn crate::video_result_urls::VideoResultUrlRefresh>,
}

#[allow(dead_code)]
pub struct AppState<M: Mysql, R: Redis> {
    pub config: AppConfig,
    /// The task and subtask row provider; this sub-application reads every
    /// task-table row through it.
    pub task_store: std::sync::Arc<dyn crate::task_store::TaskStore>,
    pub mysql: M,
    pub users: UserStore,
    pub http: HttpDependencies,
    pub jwt: JwtVerifier,
    pub cache: CacheClients<R>,
    /// Employee-directory provider for the team redaction check's
    /// entity-derived membership pass.
    pub erp: std::sync::Arc<dyn crate::erp_provider::ErpProvider<R> + Send + Sync>,
    /// The application's entity-binding registry, consumed by the team
    /// resolution's share-permission pass
    /// (`TeamShareService.check_permission`).
    pub entity_resolvers: crate::permissions::EntityResolvers<R>,
    /// The video-result URL refresh registered by this deployment.
    pub video_refresh: VideoRefresh,
}

impl<M: Mysql, R: Redis> AppState<M, R> {
    /// Dependency composition: every retained service is an input, so the
    /// parameter list grows with the sub-application's startup contract.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        config: AppConfig,
        mysql: M,
        task_store: std::sync::Arc<dyn crate::task_store::TaskStore>,
        http: HttpDependencies,
        cache: CacheClients<R>,
        erp: std::sync::Arc<dyn crate::erp_provider::ErpProvider<R> + Send + Sync>,
        entity_resolvers: crate::permissions::EntityResolvers<R>,
        video_refresh: VideoRefresh,
    ) -> Self {
        let jwt = JwtVerifier::new(&config);
        Self {
            users: UserStore,
            task_store,
            config,
            mysql,
            http,
            jwt,
            cache,
            erp,
            entity_resolvers,
            video_refresh,
        }
    }
}
