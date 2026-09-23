// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The application's single lazy MySQL pool and task routing policy.
use brz_mysql::{MysqlResult, MysqlService, MysqlServiceOptions};
use std::time::Duration;

/// Deployment pool capacity per role.
const MAX_CONNECTIONS: u32 = 256;
/// Source `DB_POOL_RECYCLE` (seconds).
const MAX_LIFETIME: Duration = Duration::from_secs(3600);
/// Statement deadline.
///
/// The source session (`app/db/session.py:_create_engine`) builds the engine
/// with `pool_timeout=settings.DB_POOL_TIMEOUT` and
/// `connect_args={"charset": "utf8mb4", "init_command": ...}` only: it never
/// sets PyMySQL's `read_timeout`, so a statement that is already running is
/// never killed. `DB_POOL_TIMEOUT` (30s) is the only database deadline the
/// source configures, so the target keeps that horizon rather than the
/// driver default `MysqlServiceOptions::default()` applies (3s), which killed
/// legitimate multi-second statements with `MysqlError::QueryTimedOut`.
const QUERY_TIMEOUT: Duration = Duration::from_secs(30);

pub fn connect(database_url: &str) -> MysqlResult<MysqlService> {
    connect_read_write(database_url, None)
}

/// Pool and session options applied to every pool this module creates.
pub(crate) fn pool_options() -> MysqlServiceOptions {
    // Deployment pool capacity is 256 per role; recycle, charset, and timezone
    // retain the source SessionLocal behavior. Cloned clients share these
    // pools. The statement deadline follows the source, which sets no
    // per-statement timeout.
    MysqlServiceOptions::default()
        .with_max_connections(MAX_CONNECTIONS)
        .with_max_lifetime(Some(MAX_LIFETIME))
        .with_query_timeout(QUERY_TIMEOUT)
        .with_charset("utf8mb4")
        .with_timezone("+08:00")
}

/// Creates the shared MySQL service with an optional read-only pool.
pub fn connect_read_write(master_url: &str, slave_url: Option<&str>) -> MysqlResult<MysqlService> {
    let options = pool_options();
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
