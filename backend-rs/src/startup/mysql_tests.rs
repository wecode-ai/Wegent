// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

#[path = "../../tests/support/mysql_pool.rs"]
mod pool;

#[tokio::test]
async fn public_pool_keeps_new_task_ids_on_base_tables() {
    pool::assert_shared_pool(|mysql| mysql, "SELECT id FROM `tasks` WHERE id = ?").await;
}
