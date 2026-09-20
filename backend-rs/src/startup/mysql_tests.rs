// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[path = "../../tests/support/mysql_pool.rs"]
mod pool;

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
