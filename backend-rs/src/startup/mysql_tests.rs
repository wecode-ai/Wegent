// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[path = "../../tests/support/mysql_pool.rs"]
mod pool;

use std::time::Duration;

#[test]
fn public_pool_keeps_the_source_statement_horizon() {
    // Arrange: the source session (`app/db/session.py`) sets `pool_timeout` and
    // PyMySQL charset/`init_command` only, so a running statement is never
    // killed by a shorter driver-side deadline.
    let options = super::pool_options();

    // Act + Assert: the statement deadline keeps the source's only database
    // deadline (`DB_POOL_TIMEOUT`, 30s) instead of the driver default (3s).
    assert_eq!(options.query_timeout, Duration::from_secs(30));
    assert_eq!(options.acquire_timeout, Duration::from_secs(2));
    assert!(options.slow_acquire_threshold <= options.acquire_timeout);
}

#[tokio::test]
async fn public_master_and_slave_pools_allow_256_connections_each() {
    let mysql = super::connect_read_write(
        "mysql://writer:secret@127.0.0.1:3306/wegent",
        Some("mysql://reader:secret@127.0.0.2:3306/wegent"),
    )
    .unwrap();
    assert_eq!(mysql.pool_stats().max_connections, 256);
    assert_eq!(mysql.read_pool_stats().max_connections, 256);
    mysql.close().await;
}

#[tokio::test]
async fn public_pool_keeps_new_task_ids_on_base_tables() {
    pool::assert_shared_pool(|mysql| mysql, "SELECT id FROM `tasks` WHERE id = ?").await;
}
