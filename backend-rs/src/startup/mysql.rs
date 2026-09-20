// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The application's single lazy MySQL pool and task routing policy.
use brz_mysql::{MysqlResult, MysqlService, MysqlServiceOptions};
use std::time::Duration;

pub fn connect(database_url: &str) -> MysqlResult<MysqlService> {
    connect_read_write(database_url, None)
}

/// Creates the shared MySQL service with an optional read-only pool.
pub fn connect_read_write(master_url: &str, slave_url: Option<&str>) -> MysqlResult<MysqlService> {
    // Deployment pool capacity is 256 per role; recycle, charset, and timezone
    // retain the source SessionLocal behavior. Cloned clients share these pools.
    let options = MysqlServiceOptions::default()
        .with_max_connections(256)
        .with_max_lifetime(Some(Duration::from_secs(3600)))
        .with_charset("utf8mb4")
        .with_timezone("+08:00");
    // Construction is lazy. Plain SQL bypasses routing; task templates use
    // the repository's explicit key. There is no feature-local policy setup.
    let service = match slave_url {
        Some(slave_url) => {
            MysqlService::connect_lazy_read_write_with_options(master_url, slave_url, options)?
        }
        None => MysqlService::connect_lazy_with_options(master_url, options)?,
    };
    Ok(service.with_route(crate::task_routing::NoSharding))
}

#[cfg(test)]
#[path = "mysql_tests.rs"]
pub(crate) mod tests;
