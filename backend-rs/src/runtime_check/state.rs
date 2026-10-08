// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Request dependencies supplied by the application at startup.
use super::config::Config;
use brz_mysql::Mysql;
use brz_redis::Redis;
use std::sync::Arc;

pub struct AppState<M: Mysql, R: Redis> {
    #[allow(
        dead_code,
        reason = "retained for source-compatible state construction"
    )]
    pub config: Config,
    pub mysql: M,
    /// Task and subtask row reads; the application supplies the deployment's
    /// store before route construction.
    pub task_store: Arc<dyn crate::task_store::TaskStore>,
    /// Retains the existing streaming/user-cache connection behavior. Missing
    /// clients degrade to cache misses when Redis was unavailable at startup.
    pub redis: Option<R>,
    #[allow(
        dead_code,
        reason = "route authentication now runs through AppAuthenticator"
    )]
    pub users: super::users::Users,
}

impl<M: Mysql, R: Redis> AppState<M, R> {
    pub fn new(
        config: Config,
        mysql: M,
        task_store: Arc<dyn crate::task_store::TaskStore>,
        redis: Option<R>,
    ) -> Self {
        Self {
            config,
            mysql,
            task_store,
            redis,
            users: super::users::Users,
        }
    }
}
