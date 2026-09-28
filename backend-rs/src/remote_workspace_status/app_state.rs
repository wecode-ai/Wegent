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
    pub task_policy: crate::task_routing::TaskPolicy,
    pub mysql: M,
    pub users: UserStore,
    pub http: HttpDependencies,
    pub jwt: JwtVerifier,
    pub cache: CacheClients<R>,
    /// Employee-directory provider for the team redaction check's
    /// entity-derived membership pass.
    pub erp: std::sync::Arc<dyn crate::erp_provider::ErpProvider<R> + Send + Sync>,
    /// The video-result URL refresh registered by this deployment.
    pub video_refresh: VideoRefresh,
}

impl<M: Mysql, R: Redis> AppState<M, R> {
    pub fn new(
        config: AppConfig,
        mysql: M,
        http: HttpDependencies,
        cache: CacheClients<R>,
        erp: std::sync::Arc<dyn crate::erp_provider::ErpProvider<R> + Send + Sync>,
        video_refresh: VideoRefresh,
    ) -> Self {
        let jwt = JwtVerifier::new(&config);
        Self {
            users: UserStore,
            task_policy: Default::default(),
            config,
            mysql,
            http,
            jwt,
            cache,
            erp,
            video_refresh,
        }
    }
}
