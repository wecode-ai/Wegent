// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Project-scoped active-task counting (`SqlAlchemyTaskStore` /
//! `ShardedTaskStore` `count_active_project_tasks` and
//! `count_active_tasks_by_project`).
//!
//! Split from [`crate::task_store::TaskStore`] so each source file stays
//! within the file-size bound; `TaskStore` extends this trait, so
//! `dyn TaskStore` still exposes the methods.
//!
//! The public store renders one `SELECT count(tasks.id)` statement per call.
//! A sharded deployment overrides `count_active_project_tasks` with
//! `len(list_active_project_tasks(...))`, reusing the merge the list read
//! performs, so its dependency stream is the two list queries.
use std::collections::HashMap;

use async_trait::async_trait;
use brz_mysql::{Mysql, MysqlResult, MysqlRow};

use crate::task_store_statements::{StatementArg, TASKS_TABLE};

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

    /// `task_store.count_active_tasks_by_project`: the active-task count of
    /// each requested `(project_id, user_id)` pair, keyed by project id. An
    /// empty request returns no counts without a statement (the source's
    /// `if not project_owners: return {}` guard).
    async fn count_active_tasks_by_project(
        &self,
        project_owners: &[(i64, i64)],
        client_origin: Option<&str>,
    ) -> MysqlResult<HashMap<i64, i64>>;
}

/// The JSON deletion predicate as SQLAlchemy renders
/// `model.json["status"]["status"].as_string()`, qualified by `table`.
pub fn active_task_status_predicate(table: &str) -> String {
    format!(
        "coalesce(CASE JSON_EXTRACT(JSON_EXTRACT({table}.json, '$.\"status\"'), \
         '$.\"status\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(\
         JSON_EXTRACT({table}.json, '$.\"status\"'), '$.\"status\"')) END, '') != 'DELETE'"
    )
}

/// `SqlAlchemyTaskStore.count_active_tasks_by_project`'s grouped count for
/// `table`: the active non-deleted tasks of the requested project/owner pairs,
/// grouped by `project_id`.
fn count_active_tasks_by_project_statement(
    table: &str,
    client_origin: bool,
    pairs: usize,
) -> String {
    let placeholders = vec!["(?, ?)"; pairs].join(", ");
    let mut sql = format!(
        "SELECT {table}.project_id, count({table}.id) AS count_1 \nFROM {table} \n\
         WHERE {table}.kind = 'Task' AND {table}.is_active = 1 AND {}",
        active_task_status_predicate(table)
    );
    if client_origin {
        sql.push_str(&format!(" AND {table}.client_origin = ?"));
    }
    sql.push_str(&format!(
        " AND ({table}.project_id, {table}.user_id) IN ({placeholders}) \
         GROUP BY {table}.project_id"
    ));
    sql
}

/// The bound values of [`count_active_tasks_by_project_statement`], in the
/// statement's placeholder order: the optional origin, then each pair.
fn count_active_tasks_by_project_args(
    project_owners: &[(i64, i64)],
    client_origin: Option<&str>,
) -> Vec<StatementArg> {
    let mut args =
        Vec::with_capacity(project_owners.len() * 2 + usize::from(client_origin.is_some()));
    if let Some(origin) = client_origin {
        args.push(StatementArg::Str(origin.to_string()));
    }
    for (project_id, user_id) in project_owners {
        args.push(StatementArg::Int(*project_id));
        args.push(StatementArg::Int(*user_id));
    }
    args
}

/// `SqlAlchemyTaskStore.count_active_tasks_by_project` on the base table.
/// `table` is the physical table a deployment's store reads (the sharded
/// store sums its own base and shard reads instead).
pub async fn count_active_tasks_by_project_read<M: Mysql>(
    mysql: &M,
    table: &str,
    project_owners: &[(i64, i64)],
    client_origin: Option<&str>,
) -> MysqlResult<HashMap<i64, i64>> {
    if project_owners.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = count_active_tasks_by_project_statement(
        table,
        client_origin.is_some(),
        project_owners.len(),
    );
    let rows: Vec<MysqlRow> = mysql
        .fetch_all(
            sql,
            count_active_tasks_by_project_args(project_owners, client_origin),
        )
        .await?;
    let mut counts = HashMap::with_capacity(rows.len());
    for row in &rows {
        let project_id: i64 = row.get_required("project_id")?;
        let count: i64 = row.get_required("count_1")?;
        *counts.entry(project_id).or_insert(0) += count;
    }
    Ok(counts)
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

    async fn count_active_tasks_by_project(
        &self,
        project_owners: &[(i64, i64)],
        client_origin: Option<&str>,
    ) -> MysqlResult<HashMap<i64, i64>> {
        count_active_tasks_by_project_read(&self.mysql, TASKS_TABLE, project_owners, client_origin)
            .await
    }
}
