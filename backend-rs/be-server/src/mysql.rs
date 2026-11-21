// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The application's single lazy MySQL pool.
//!
//! Ported from the reference implementation's `src/startup/mysql.rs`. The pool
//! policy mirrors the source SQLAlchemy engine that serves requests
//! (`app/db/session.py:SessionLocal`, reached through `app.api.dependencies.get_db`):
//! `pool_size=DB_POOL_SIZE` (20) plus `max_overflow=DB_MAX_OVERFLOW` (40),
//! `pool_recycle=DB_POOL_RECYCLE` (3600), charset `utf8mb4`, and the session
//! time zone offset `+08:00`.

use std::time::Duration;

use brz_mysql::{MysqlResult, MysqlService, MysqlServiceOptions};

/// Source `DB_POOL_SIZE` (20) + `DB_MAX_OVERFLOW` (40): the sync engine's
/// total capacity. The reference used the async engine's smaller
/// `DB_ASYNC_POOL_SIZE` + `DB_ASYNC_MAX_OVERFLOW` (30) instead.
const MAX_CONNECTIONS: u32 = 60;
/// Source `DB_POOL_RECYCLE` (seconds).
const MAX_LIFETIME: Duration = Duration::from_secs(3600);
/// Source `DB_POOL_TIMEOUT` (seconds).
const ACQUIRE_TIMEOUT: Duration = Duration::from_secs(30);

/// Creates the process-wide lazy MySQL pool.
///
/// Construction is lazy: no connection is opened until the first query, so a
/// failed or slow database does not prevent the gateway from starting.
///
/// # Errors
///
/// Returns the driver error when `database_url` cannot be parsed.
pub fn connect(database_url: &str) -> MysqlResult<MysqlService> {
    let options = MysqlServiceOptions::default()
        .with_max_connections(MAX_CONNECTIONS)
        .with_acquire_timeout(ACQUIRE_TIMEOUT)
        .with_max_lifetime(Some(MAX_LIFETIME))
        .with_charset("utf8mb4")
        .with_timezone("+08:00");
    MysqlService::connect_lazy_with_options(database_url, options)
}
