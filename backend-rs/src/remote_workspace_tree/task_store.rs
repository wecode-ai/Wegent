// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Sharded task/subtask lookup resolution for the remote-workspace tree
//! chain.
//!
//! Mirrors the source sharded stores (`ShardedTaskStore` and
//! `ShardedSubtaskStore`). A new-format task id selects the shard table
//! encoded in the id. A legacy id resolves the migrated copy
//! through the base `tasks` owner index and the owner's shard table
//! (`_model_for_task_id_lookup` / `_migrated_legacy_task_model` /
//! `_subtask_model_for_task_lookup`), which is also the recorded dependency
//! sequence of the legacy cases: the owner probe, the migrated-copy probe,
//! and only then the row load from the shard table.
use brz_mysql::{FromMysqlRow, Mysql, MysqlArgs, MysqlResult};

use super::error::ApiError;
use crate::task_routing::{ByTaskId, ByUserId, TaskPolicy};

/// The physical table selection of one task or subtask row lookup.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TableRoute {
    /// Base `tasks` / `subtasks` through the task-id routing key.
    ByTaskId(u64),
    /// The owner's shard tables through the owner routing key.
    ByOwner(i64),
}

/// Run one row lookup against the route's physical table. The bound key
/// types are the shared `task_routing` newtypes because the deployment's
/// routing policy downcasts exactly those.
pub(crate) async fn fetch_optional<M, A, T>(
    mysql: &M,
    route: TableRoute,
    sql: &str,
    args: A,
) -> MysqlResult<Option<T>>
where
    M: Mysql,
    A: MysqlArgs + Send,
    T: FromMysqlRow + Send,
{
    match route {
        TableRoute::ByTaskId(task_id) => {
            mysql
                .route(ByTaskId(task_id))
                .fetch_optional(sql, args)
                .await
        }
        TableRoute::ByOwner(owner_user_id) => {
            mysql
                .route(ByUserId(owner_user_id.unsigned_abs()))
                .fetch_optional(sql, args)
                .await
        }
    }
}

/// Run one row-set lookup against the route's physical table.
pub(crate) async fn fetch_all<M, A, T>(
    mysql: &M,
    route: TableRoute,
    sql: &str,
    args: A,
) -> MysqlResult<Vec<T>>
where
    M: Mysql,
    A: MysqlArgs + Send,
    T: FromMysqlRow + Send,
{
    match route {
        TableRoute::ByTaskId(task_id) => mysql.route(ByTaskId(task_id)).fetch_all(sql, args).await,
        TableRoute::ByOwner(owner_user_id) => {
            mysql
                .route(ByUserId(owner_user_id.unsigned_abs()))
                .fetch_all(sql, args)
                .await
        }
    }
}

/// One `tasks.user_id` projection of the owner probe.
#[derive(Debug, FromMysqlRow)]
struct OwnerRow {
    user_id: i64,
}

/// One `tasks.id` projection of the migrated-copy probe.
#[derive(Debug, FromMysqlRow)]
struct IdProbeRow {
    #[allow(dead_code)]
    id: i64,
}

/// The task column list of the source ORM renders.
const TASK_COLUMNS: &str = "id, user_id, kind, name, namespace, json, is_active, created_at, \
     updated_at, project_id, client_origin, is_group_chat";

/// One active-task render over `{{tasks}}` with an optional extra predicate.
fn active_task_select(extra_predicate: &str) -> String {
    let mut sql = String::from("SELECT ");
    sql.push_str(TASK_COLUMNS);
    sql.push_str(" FROM {{tasks}} WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2)");
    sql.push_str(extra_predicate);
    sql.push_str(" LIMIT 1");
    sql
}

/// `SqlAlchemyTaskAccessStore._get_accessible_task`: the active-task query
/// behind `is_member` and `get_task_owner_id` — kind Task and active states,
/// with no JSON deletion filter.
pub(crate) fn accessible_task_sql() -> String {
    active_task_select("")
}

/// `ShardedTaskStore.get_active_non_deleted_task`: the ORM entity query for
/// the task id. A legacy id queries the base `tasks` table with the JSON
/// `status.status != 'DELETE'` exclusion pushed into SQL (the unsharded
/// `SqlAlchemyTaskStore` render); a shard-table read applies that check in
/// Rust, so its statement keeps the plain active filter.
pub(crate) fn active_task_sql(task_id: u64, policy: TaskPolicy) -> String {
    if (policy.is_scoped_id)(task_id) {
        active_task_select("")
    } else {
        active_task_select(" AND JSON_EXTRACT(json, '$.status.status') != 'DELETE'")
    }
}

/// `ShardedTaskStore._legacy_task_owner_user_id`: the owner probe against the
/// base `tasks` table, with the optional owner filter the caller passes.
pub(crate) async fn legacy_owner_user_id<M: Mysql>(
    mysql: &M,
    task_id: u64,
    owner_user_id: Option<i64>,
) -> Result<Option<i64>, ApiError> {
    let mut sql = "SELECT user_id \nFROM {{tasks}} \nWHERE id = ?".to_owned();
    if owner_user_id.is_some() {
        sql.push_str(" AND user_id = ?");
    }
    sql.push_str(" \n LIMIT 1");
    let row: Option<OwnerRow> = match owner_user_id {
        Some(owner) => {
            fetch_optional(
                mysql,
                TableRoute::ByTaskId(task_id),
                &sql,
                (task_id as i64, owner),
            )
            .await
        }
        None => {
            fetch_optional(
                mysql,
                TableRoute::ByTaskId(task_id),
                &sql,
                (task_id as i64,),
            )
            .await
        }
    }
    .map_err(super::error::database_query_failed)?;
    Ok(row.map(|row| row.user_id))
}

/// `_migrated_legacy_task_model`'s migrated-copy probe on the owner's shard
/// table.
const MIGRATED_COPY_SQL: &str = "SELECT id \nFROM {{tasks}} \nWHERE id = ? \n LIMIT 1";

/// `_migrated_legacy_task_model`: the owner probe followed by the
/// migrated-copy probe on the owner's shard table. The result carries the
/// shard selection only when both probes hit.
pub(crate) async fn migrated_legacy_table<M: Mysql>(
    mysql: &M,
    task_id: u64,
    owner_user_id: Option<i64>,
) -> Result<Option<TableRoute>, ApiError> {
    let Some(owner) = legacy_owner_user_id(mysql, task_id, owner_user_id).await? else {
        return Ok(None);
    };
    // `db.query(model.id).filter(model.id == task_id).first()`.
    let row: Option<IdProbeRow> = fetch_optional(
        mysql,
        TableRoute::ByOwner(owner),
        MIGRATED_COPY_SQL,
        (task_id as i64,),
    )
    .await
    .map_err(super::error::database_query_failed)?;
    Ok(row.is_some().then_some(TableRoute::ByOwner(owner)))
}

/// `ShardedTaskStore._model_for_task_id_lookup` and
/// `ShardedSubtaskStore._subtask_model_for_task_lookup`: the physical table
/// for one task or subtask lookup. New-format ids route by their own shard;
/// legacy ids probe the base owner index and then the owner's shard table,
/// falling back to the base tables when no migrated copy exists. A
/// deployment without the sharded store keeps the base tables.
pub(crate) async fn resolve_table<M: Mysql>(
    mysql: &M,
    policy: TaskPolicy,
    task_id: u64,
    owner_user_id: Option<i64>,
) -> Result<TableRoute, ApiError> {
    if (policy.is_scoped_id)(task_id) || !policy.resolve_migrated_legacy {
        return Ok(TableRoute::ByTaskId(task_id));
    }
    Ok(migrated_legacy_table(mysql, task_id, owner_user_id)
        .await?
        .unwrap_or(TableRoute::ByTaskId(task_id)))
}

/// `ShardedSubtaskStore.list_by_task_ordered`'s `_owner_matches_task_id`
/// guard: the task row on the id's own table must belong to the owner.
const OWNER_MATCH_SQL: &str =
    "SELECT id \nFROM {{tasks}} \nWHERE id = ? AND user_id = ? \n LIMIT 1";

/// `_owner_matches_task_id`.
pub(crate) async fn owner_matches_task_id<M: Mysql>(
    mysql: &M,
    task_id: u64,
    owner_user_id: i64,
) -> Result<bool, ApiError> {
    let row: Option<IdProbeRow> = fetch_optional(
        mysql,
        TableRoute::ByTaskId(task_id),
        OWNER_MATCH_SQL,
        (task_id as i64, owner_user_id),
    )
    .await
    .map_err(super::error::database_query_failed)?;
    Ok(row.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::{QueryCapture, Route};

    /// A new-format id carries a nonzero uid field at bit 37.
    fn is_scoped_id(task_id: u64) -> bool {
        ((1_u64 << 37)..=(1_u64 << 53)).contains(&task_id)
    }

    fn scoped_policy() -> TaskPolicy {
        TaskPolicy {
            is_scoped_id,
            resolve_migrated_legacy: true,
        }
    }

    /// A legacy id probes the base owner index first. Without a recorded
    /// migrated copy the shard probe is not reached and the base table stays.
    #[tokio::test]
    async fn legacy_resolution_probes_the_base_owner_index_first() {
        let mysql = QueryCapture::default();
        let route = resolve_table(&mysql, scoped_policy(), 4_920_558, Some(5_848))
            .await
            .expect("resolve");
        assert_eq!(route, TableRoute::ByTaskId(4_920_558));
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].route, Route::Task(4_920_558));
        assert_eq!(queries[0].args, 2);
        assert_eq!(
            queries[0].sql,
            "SELECT user_id FROM {{tasks}} WHERE id = ? AND user_id = ? LIMIT 1"
        );
    }

    #[test]
    fn migrated_copy_probe_and_owner_probe_keep_their_shapes() {
        crate::sql_test_support::assert_routed_sql(MIGRATED_COPY_SQL, 1);
        assert!(MIGRATED_COPY_SQL.contains("FROM {{tasks}}"));
        crate::sql_test_support::assert_routed_sql(OWNER_MATCH_SQL, 2);
    }

    #[test]
    fn legacy_active_task_render_pushes_the_json_delete_filter() {
        let legacy = active_task_sql(4_920_558, scoped_policy());
        crate::sql_test_support::assert_routed_sql(&legacy, 1);
        assert!(legacy.contains("JSON_EXTRACT(json, '$.status.status') != 'DELETE'"));
        assert!(legacy.ends_with("LIMIT 1"));

        let scoped = active_task_sql(412_179_421_613_503, scoped_policy());
        crate::sql_test_support::assert_routed_sql(&scoped, 1);
        assert!(!scoped.contains("JSON_EXTRACT"));

        let accessible = accessible_task_sql();
        crate::sql_test_support::assert_routed_sql(&accessible, 1);
        assert!(!accessible.contains("JSON_EXTRACT"));
        assert!(accessible.contains("is_active IN (1, 2)"));
    }

    #[tokio::test]
    async fn new_format_ids_resolve_without_probing() {
        let mysql = QueryCapture::default();
        let task_id = 412_179_421_613_503;
        let route = resolve_table(&mysql, scoped_policy(), task_id, Some(2_999))
            .await
            .expect("resolve");
        assert_eq!(route, TableRoute::ByTaskId(task_id));
        assert!(mysql.queries().is_empty());
    }

    #[tokio::test]
    async fn deployments_without_the_sharded_store_never_probe() {
        let mysql = QueryCapture::default();
        let route = resolve_table(&mysql, TaskPolicy::default(), 4_920_558, Some(5_848))
            .await
            .expect("resolve");
        assert_eq!(route, TableRoute::ByTaskId(4_920_558));
        assert!(mysql.queries().is_empty());
    }

    #[tokio::test]
    async fn owner_matches_task_id_binds_the_id_table() {
        let mysql = QueryCapture::default();
        assert!(
            !owner_matches_task_id(&mysql, 412_179_421_613_503, 2_999)
                .await
                .expect("guard")
        );
        let queries = mysql.queries();
        assert_eq!(queries[0].route, Route::Task(412_179_421_613_503));
        assert_eq!(queries[0].args, 2);
    }

    #[tokio::test]
    async fn owner_probe_omits_the_owner_filter_when_absent() {
        let mysql = QueryCapture::default();
        assert_eq!(
            legacy_owner_user_id(&mysql, 4_920_558, None)
                .await
                .expect("probe"),
            None
        );
        let queries = mysql.queries();
        assert_eq!(queries[0].args, 1);
        assert_eq!(queries[0].route, Route::Task(4_920_558));
    }
}
