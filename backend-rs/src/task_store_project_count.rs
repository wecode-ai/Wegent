// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Project-scoped active-task counting (`SqlAlchemyTaskStore` /
//! `ShardedTaskStore` `count_active_project_tasks`).
//!
//! Split from [`crate::task_store::TaskStore`] so each source file stays
//! within the file-size bound; `TaskStore` extends this trait, so
//! `dyn TaskStore` still exposes the method.
//!
//! The public store renders one `SELECT count(tasks.id)` statement. A sharded
//! deployment overrides the
//! method with `len(list_active_project_tasks(...))`, reusing the merge the
//! list read performs, so its dependency stream is the two list queries.
use async_trait::async_trait;
use brz_mysql::{Mysql, MysqlResult, MysqlRow};

/// `task_store.count_active_project_tasks`: how many active tasks belong to
/// `project_id`, optionally owned by `owner_user_id` and scoped to a client
/// origin.
#[async_trait]
pub trait TaskStoreProjectCount: Send + Sync {
    async fn count_active_project_tasks(
        &self,
        project_id: i64,
        owner_user_id: Option<i64>,
        client_origin: Option<&str>,
    ) -> MysqlResult<i64>;
}

/// `SqlAlchemyTaskStore.count_active_project_tasks`: the single
/// `count(tasks.id)` read of the base `tasks` table. The predicate order
/// mirrors the source `db.query(func.count(TaskResource.id))` rendering
/// (`project_id`, `is_active`, then the optional `user_id` and
/// `client_origin`). Public as the base-store read a sharded deployment's
/// no-owner branch falls back to.
pub async fn count_active_project_tasks_read<M: Mysql>(
    mysql: &M,
    project_id: i64,
    owner_user_id: Option<i64>,
    client_origin: Option<&str>,
) -> MysqlResult<i64> {
    let mut sql = String::from(
        "SELECT count(tasks.id) AS count_1 \nFROM tasks \n\
         WHERE tasks.project_id = ? AND tasks.is_active = 1",
    );
    let mut owner = None;
    if let Some(user_id) = owner_user_id {
        sql.push_str(" AND tasks.user_id = ?");
        owner = Some(user_id);
    }
    let mut origin = None;
    if let Some(client_origin) = client_origin {
        sql.push_str(" AND tasks.client_origin = ?");
        origin = Some(client_origin);
    }
    let rows: Vec<MysqlRow> = match (owner, origin) {
        (Some(owner), Some(origin)) => mysql.fetch_all(sql, (project_id, owner, origin)).await?,
        (Some(owner), None) => mysql.fetch_all(sql, (project_id, owner)).await?,
        (None, Some(origin)) => mysql.fetch_all(sql, (project_id, origin)).await?,
        (None, None) => mysql.fetch_all(sql, (project_id,)).await?,
    };
    match rows.first() {
        Some(row) => row.get_required("count_1"),
        None => Ok(0),
    }
}

#[async_trait]
impl<M: Mysql> TaskStoreProjectCount for crate::task_store_default::DefaultTaskStore<M> {
    async fn count_active_project_tasks(
        &self,
        project_id: i64,
        owner_user_id: Option<i64>,
        client_origin: Option<&str>,
    ) -> MysqlResult<i64> {
        count_active_project_tasks_read(&self.mysql, project_id, owner_user_id, client_origin).await
    }
}
