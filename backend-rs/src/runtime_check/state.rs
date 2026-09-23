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
    /// Retains the existing streaming/user-cache connection behavior. Missing
    /// clients degrade to cache misses when Redis was unavailable at startup.
    pub redis: Option<R>,
    #[allow(
        dead_code,
        reason = "route authentication now runs through AppAuthenticator"
    )]
    pub users: super::users::Users,
    /// `userReader.get_by_id` strategy; the application state's registered
    /// reader is installed by `startup::runtime_check::build`.
    pub user_reader: Arc<dyn crate::user_reader::UserByIdReader>,
    /// Task id classification (`is_new_task_id` in the configured source
    /// store): selects the SQL-level DELETE filter for legacy ids.
    pub task_policy: crate::task_routing::TaskPolicy,
}

impl<M: Mysql, R: Redis> AppState<M, R> {
    pub fn new(
        config: Config,
        mysql: M,
        redis: Option<R>,
        user_reader: Arc<dyn crate::user_reader::UserByIdReader>,
        task_policy: crate::task_routing::TaskPolicy,
    ) -> Self {
        Self {
            config,
            mysql,
            redis,
            users: super::users::Users,
            user_reader,
            task_policy,
        }
    }
}
