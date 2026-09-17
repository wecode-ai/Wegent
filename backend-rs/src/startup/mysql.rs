// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The application's single lazy MySQL pool and task routing policy.
use brz_mysql::{MysqlResult, MysqlService, MysqlServiceOptions};
use std::time::Duration;

pub fn connect(database_url: &str) -> MysqlResult<MysqlService> {
    // Source SessionLocal: pool_size=10 + max_overflow=20, recycle=3600,
    // utf8mb4 and +08:00. Clients cloned for injection share this one pool.
    let options = MysqlServiceOptions::default()
        .with_max_connections(30)
        .with_max_lifetime(Some(Duration::from_secs(3600)))
        .with_charset("utf8mb4")
        .with_timezone("+08:00");
    // Construction is lazy. Plain SQL bypasses routing; task templates use
    // the repository's explicit key. There is no feature-local policy setup.
    Ok(
        MysqlService::connect_lazy_with_options(database_url, options)?
            .with_route(crate::task_routing::NoSharding),
    )
}

#[cfg(test)]
#[path = "mysql_tests.rs"]
pub(crate) mod tests;
