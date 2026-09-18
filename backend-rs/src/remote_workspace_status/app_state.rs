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

#[allow(dead_code)]
pub struct AppState<M: Mysql, R: Redis> {
    pub config: AppConfig,
    pub task_policy: crate::task_routing::TaskPolicy,
    pub mysql: M,
    pub users: UserStore,
    pub http: HttpDependencies,
    pub jwt: JwtVerifier,
    pub cache: CacheClients<R>,
}

impl<M: Mysql, R: Redis> AppState<M, R> {
    pub fn new(
        config: AppConfig,
        mysql: M,
        http: HttpDependencies,
        cache: CacheClients<R>,
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
        }
    }
}
