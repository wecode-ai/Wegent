// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! SQL row loads for the task-detail endpoint.
//!
//! Every statement mirrors the source SQLAlchemy rendering against the
//! sharded physical tables (`tasks_{:04}` / `subtasks_{:04}`, selected by
//! the configured store), now using brz-mysql routed `{{tasks}}`/
//! `{{subtasks}}` tokens with unqualified column names and `?` placeholders.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlRow};
use chrono::NaiveDateTime;
use serde_json::Value;

use crate::json_compat::OpaqueJson;
use crate::task_routing::TaskPolicy;
use crate::task_routing::{ByTaskId, ByUserId};

const TASK_BY_OWNER_SQL: &str = "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \
    FROM {{tasks}} \
    WHERE id = ? AND user_id = ? \
    LIMIT 1";
const WORKSPACE_BY_REF_SQL: &str = "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \
    FROM {{tasks}} \
    WHERE user_id = ? AND kind = 'Workspace' AND name = ? AND namespace = ? AND is_active = 1 \
    LIMIT 1";
const SUBTASKS_BY_TASK_SQL: &str = "SELECT id, user_id, task_id, team_id, title, bot_ids, `role`, executor_namespace, executor_name, \
        executor_deleted_at, prompt, message_id, parent_id, status, progress, result, error_message, \
        created_at, updated_at, completed_at, sender_type, sender_user_id, reply_to_subtask_id \
    FROM {{subtasks}} \
    WHERE task_id = ? \
    ORDER BY message_id ASC, created_at ASC";

/// A `tasks_{:04}` row selected with the full unqualified projection.
#[derive(Debug)]
pub(crate) struct TaskRow {
    pub id: i64,
    pub user_id: i64,
    pub json: Value,
    pub project_id: Option<i64>,
    pub client_origin: Option<String>,
}

fn decode_task_row(row: &MysqlRow) -> brz_mysql::MysqlResult<TaskRow> {
    Ok(TaskRow {
        id: row.get_required("id")?,
        user_id: row.get_required("user_id")?,
        json: row.get_required::<brz_mysql::Json<Value>>("json")?.0,
        project_id: row.get("project_id")?,
        client_origin: row.get("client_origin")?,
    })
}

/// `ShardedTaskStore.get_active_non_deleted_task` with the optional
/// `client_origin` filter (`get_task_by_id` passes the query value).
///
/// New-format ids route to `get_task_by_states` (shard table, no SQL
/// deletion predicate; the JSON status is filtered in Rust like the source
/// `_is_json_deleted`). Legacy ids fall through to the base
/// `SqlAlchemyTaskStore.get_active_non_deleted_task`, whose SQLAlchemy
/// `text("JSON_EXTRACT(json, '$.status.status') != 'DELETE'")` predicate
/// sits between the `is_active` and `client_origin` filters.
pub(crate) async fn get_active_non_deleted_task<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    task_id: i64,
    client_origin: Option<&str>,
) -> brz_mysql::MysqlResult<Option<TaskRow>>
where
    M: brz_mysql::Mysql,
{
    let mut sql = String::from(
        "SELECT id, user_id, kind, name, namespace, json, is_active,
                created_at, updated_at, project_id, client_origin, is_group_chat
         FROM {{tasks}}
         WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2)",
    );
    if !(task_policy.is_scoped_id)(task_id as u64) {
        sql.push_str(" AND JSON_EXTRACT(json, '$.status.status') != 'DELETE'");
    }
    if client_origin.is_some() {
        sql.push_str(" AND client_origin = ?");
    }
    sql.push_str(" LIMIT 1");
    let mysql = mysql.route(ByTaskId(task_id as u64));
    let row: Option<MysqlRow> = match client_origin {
        Some(origin) => mysql.fetch_optional(&sql, (task_id, origin)).await?,
        None => mysql.fetch_optional(&sql, (task_id,)).await?,
    };
    Ok(row
        .as_ref()
        .map(decode_task_row)
        .transpose()?
        .filter(|task| !json_status_is_delete(&task.json)))
}

/// `ShardedTaskStore._is_json_deleted`.
pub(crate) fn json_status_is_delete(payload: &Value) -> bool {
    crate::crd::json_status_is_delete(payload)
}

/// `SqlAlchemyTaskAccessStore._get_accessible_task` (owner id projection
/// used by `is_member` / `get_task_owner_id`).
pub(crate) async fn get_accessible_task_owner<M>(
    mysql: &M,
    task_id: i64,
) -> brz_mysql::MysqlResult<Option<i64>>
where
    M: brz_mysql::Mysql,
{
    let row: Option<MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(
            "SELECT id, user_id \nFROM {{tasks}} \n\
             WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2) \n LIMIT 1",
            (task_id,),
        )
        .await?;
    Ok(row
        .as_ref()
        .and_then(|row| row.get_required::<i64>("user_id").ok()))
}

/// `is_member`'s approved member-row check (only reached when the requesting
/// user is not the task owner).
pub(crate) async fn is_approved_member<M>(
    mysql: &M,
    task_id: i64,
    user_id: i64,
) -> brz_mysql::MysqlResult<bool>
where
    M: brz_mysql::Mysql,
{
    #[derive(FromMysqlRow)]
    struct MemberId {
        #[allow(dead_code)]
        id: i64,
    }
    let row: Option<MemberId> = mysql
        .fetch_optional(
            "SELECT resource_members.id AS resource_members_id \nFROM resource_members \n\
             WHERE resource_members.resource_type = 'Task' AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved' AND resource_members.copied_resource_id = 0 \n\
             LIMIT 1",
            (task_id, user_id.to_string()),
        )
        .await?;
    Ok(row.is_some())
}

/// `task_store.get_by_id` with the owner filter.
///
/// New-format ids query their shard table directly. Legacy ids go through
/// `ShardedTaskStore._migrated_legacy_task_model`: first the base-table
/// owner lookup (`SELECT user_id FROM {{tasks}} WHERE id = ? [AND user_id = ?]`,
/// routed by `ByTaskId` which resolves to the base table for legacy ids),
/// then the shard-table existence check (routed by `ByUserId`), then the
/// full row on whichever table holds the task (shard when migrated, base
/// otherwise).
pub(crate) async fn get_task_by_id_with_owner<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    task_id: i64,
    owner_user_id: i64,
) -> brz_mysql::MysqlResult<Option<TaskRow>>
where
    M: brz_mysql::Mysql,
{
    if (task_policy.is_scoped_id)(task_id as u64) || !task_policy.resolve_migrated_legacy {
        let row: Option<MysqlRow> = mysql
            .route(ByTaskId(task_id as u64))
            .fetch_optional(TASK_BY_OWNER_SQL, (task_id, owner_user_id))
            .await?;
        return row.as_ref().map(decode_task_row).transpose();
    }
    // `_legacy_task_owner_user_id`: base-table owner lookup with the owner
    // filter applied server-side. `ByTaskId` on a legacy id routes to the
    // base `tasks` table.
    let owner_row: Option<MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(
            "SELECT user_id \nFROM {{tasks}} \n\
             WHERE id = ? AND user_id = ? \n LIMIT 1",
            (task_id, owner_user_id),
        )
        .await?;
    if owner_row.is_none() {
        // Owner filter missed on the base table: `get_by_id` returns None
        // without touching the shard tables.
        return Ok(None);
    }
    // `_migrated_legacy_task_model` existence check on the owner's shard.
    let exists: Option<MysqlRow> = mysql
        .route(ByUserId(owner_user_id as u64))
        .fetch_optional(
            "SELECT id \nFROM {{tasks}} \nWHERE id = ? \n LIMIT 1",
            (task_id,),
        )
        .await?;
    // When migrated, route by the owner; otherwise by the legacy task id
    // (resolves to the base table).
    let row: Option<MysqlRow> = if exists.is_some() {
        mysql
            .route(ByUserId(owner_user_id as u64))
            .fetch_optional(TASK_BY_OWNER_SQL, (task_id, owner_user_id))
            .await?
    } else {
        mysql
            .route(ByTaskId(task_id as u64))
            .fetch_optional(TASK_BY_OWNER_SQL, (task_id, owner_user_id))
            .await?
    };
    row.as_ref().map(decode_task_row).transpose()
}

/// `task_store.get_workspace_by_ref` on the owner's shard table.
pub(crate) async fn get_workspace_by_ref<M>(
    mysql: &M,
    owner_user_id: i64,
    name: &str,
    namespace: &str,
) -> brz_mysql::MysqlResult<Option<TaskRow>>
where
    M: brz_mysql::Mysql,
{
    let row: Option<MysqlRow> = mysql
        .route(ByUserId(owner_user_id as u64))
        .fetch_optional(WORKSPACE_BY_REF_SQL, (owner_user_id, name, namespace))
        .await?;
    row.as_ref().map(decode_task_row).transpose()
}

/// `ShardedSubtaskStore._owner_matches_task_id` guard query.
pub(crate) async fn owner_matches_task_id<M>(
    mysql: &M,
    task_id: i64,
    owner_user_id: i64,
) -> brz_mysql::MysqlResult<bool>
where
    M: brz_mysql::Mysql,
{
    let row: Option<MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(
            "SELECT id \nFROM {{tasks}} \nWHERE id = ? AND user_id = ? \n LIMIT 1",
            (task_id, owner_user_id),
        )
        .await?;
    Ok(row.is_some())
}

/// A `subtasks_{:04}` row.
#[derive(Debug)]
pub(crate) struct SubtaskRow {
    pub id: i64,
    pub user_id: i64,
    pub task_id: i64,
    pub team_id: Option<i64>,
    pub title: Option<String>,
    pub bot_ids: OpaqueJson,
    pub role: String,
    pub executor_namespace: Option<String>,
    pub executor_name: Option<String>,
    pub prompt: Option<String>,
    pub message_id: i64,
    pub parent_id: Option<i64>,
    pub status: String,
    pub progress: i64,
    pub result: Option<OpaqueJson>,
    pub error_message: Option<String>,
    pub created_at: Option<NaiveDateTime>,
    pub updated_at: Option<NaiveDateTime>,
    pub completed_at: Option<NaiveDateTime>,
    pub sender_type: Option<String>,
    pub sender_user_id: Option<i64>,
    pub reply_to_subtask_id: Option<i64>,
}

fn decode_subtask_row(row: &MysqlRow) -> brz_mysql::MysqlResult<SubtaskRow> {
    Ok(SubtaskRow {
        id: row.get_required("id")?,
        user_id: row.get_required("user_id")?,
        task_id: row.get_required("task_id")?,
        team_id: row.get("team_id")?,
        title: row.get("title")?,
        bot_ids: row
            .get_required::<brz_mysql::Json<OpaqueJson>>("bot_ids")?
            .0,
        role: row.get_required("role")?,
        executor_namespace: row.get("executor_namespace")?,
        executor_name: row.get("executor_name")?,
        prompt: row.get("prompt")?,
        message_id: row.get_required("message_id")?,
        parent_id: row.get("parent_id")?,
        status: row.get_required("status")?,
        progress: row.get_required("progress")?,
        result: row
            .get::<brz_mysql::Json<OpaqueJson>>("result")?
            .map(|json| json.0),
        error_message: row.get("error_message")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        completed_at: row.get("completed_at")?,
        sender_type: row.get("sender_type")?,
        sender_user_id: row.get("sender_user_id")?,
        reply_to_subtask_id: row.get("reply_to_subtask_id")?,
    })
}

/// `ShardedSubtaskStore.list_by_task_ordered` (message_id, created_at).
pub(crate) async fn list_subtasks_by_task<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    task_id: i64,
    owner_user_id: i64,
) -> brz_mysql::MysqlResult<Vec<SubtaskRow>>
where
    M: brz_mysql::Mysql,
{
    // New-format ids route by `ByTaskId`; legacy ids resolve the migrated
    // shard through the base-table owner + shard existence check
    // (`_subtask_model_for_task_lookup`).
    let rows: Vec<MysqlRow> =
        if (task_policy.is_scoped_id)(task_id as u64) || !task_policy.resolve_migrated_legacy {
            mysql
                .route(ByTaskId(task_id as u64))
                .fetch_all(SUBTASKS_BY_TASK_SQL, (task_id,))
                .await?
        } else {
            // `_legacy_task_owner_user_id`: base-table owner lookup.
            let owner_row: Option<MysqlRow> = mysql
                .route(ByTaskId(task_id as u64))
                .fetch_optional(
                    "SELECT user_id \nFROM {{tasks}} \n\
                 WHERE id = ? AND user_id = ? \n LIMIT 1",
                    (task_id, owner_user_id),
                )
                .await?;
            let use_owner_shard = if owner_row.is_none() {
                false
            } else {
                // Confirm the migrated row exists in the owner's shard table.
                let exists: Option<MysqlRow> = mysql
                    .route(ByUserId(owner_user_id as u64))
                    .fetch_optional(
                        "SELECT id \nFROM {{tasks}} \nWHERE id = ? \n LIMIT 1",
                        (task_id,),
                    )
                    .await?;
                exists.is_some()
            };
            if use_owner_shard {
                mysql
                    .route(ByUserId(owner_user_id as u64))
                    .fetch_all(SUBTASKS_BY_TASK_SQL, (task_id,))
                    .await?
            } else {
                mysql
                    .route(ByTaskId(task_id as u64))
                    .fetch_all(SUBTASKS_BY_TASK_SQL, (task_id,))
                    .await?
            }
        };
    rows.iter().map(decode_subtask_row).collect()
}

/// One `subtask_contexts` row (`_attach_contexts`'s batch load).
#[derive(Debug, FromMysqlRow)]
pub(crate) struct ContextRow {
    pub subtask_contexts_id: i64,
    pub subtask_contexts_subtask_id: i64,
    pub subtask_contexts_context_type: String,
    pub subtask_contexts_name: Option<String>,
    pub subtask_contexts_status: Option<String>,
    #[mysql(rename = "subtask_contexts_type_data")]
    pub subtask_contexts_type_data: Option<Json<OpaqueJson>>,
}

/// `ShardedSubtaskStore._attach_contexts`: contexts ordered by id.
pub(crate) async fn list_contexts<M>(
    mysql: &M,
    subtask_ids: &[i64],
) -> brz_mysql::MysqlResult<Vec<ContextRow>>
where
    M: brz_mysql::Mysql,
{
    if subtask_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = subtask_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Mysql::fetch_all(
        mysql,
        &format!(
            "SELECT subtask_contexts.id AS subtask_contexts_id, \
             subtask_contexts.subtask_id AS subtask_contexts_subtask_id, \
             subtask_contexts.user_id AS subtask_contexts_user_id, \
             subtask_contexts.context_type AS subtask_contexts_context_type, \
             subtask_contexts.name AS subtask_contexts_name, \
             subtask_contexts.status AS subtask_contexts_status, \
             subtask_contexts.error_message AS subtask_contexts_error_message, \
             subtask_contexts.binary_data AS subtask_contexts_binary_data, \
             subtask_contexts.image_base64 AS subtask_contexts_image_base64, \
             subtask_contexts.extracted_text AS subtask_contexts_extracted_text, \
             subtask_contexts.text_length AS subtask_contexts_text_length, \
             subtask_contexts.type_data AS subtask_contexts_type_data, \
             subtask_contexts.created_at AS subtask_contexts_created_at, \
             subtask_contexts.updated_at AS subtask_contexts_updated_at \n\
             FROM subtask_contexts \nWHERE subtask_contexts.subtask_id IN ({ids}) \
             ORDER BY subtask_contexts.id ASC"
        ),
        (),
    )
    .await
}

/// `add_group_chat_info_to_task`'s approved member count.
pub(crate) async fn count_approved_members<M>(
    mysql: &M,
    task_id: i64,
) -> brz_mysql::MysqlResult<usize>
where
    M: brz_mysql::Mysql,
{
    let rows: Vec<MysqlRow> = Mysql::fetch_all(
        mysql,
        "SELECT resource_members.id AS resource_members_id, \
         resource_members.resource_type AS resource_members_resource_type, \
         resource_members.resource_id AS resource_members_resource_id, \
         resource_members.entity_type AS resource_members_entity_type, \
         resource_members.entity_id AS resource_members_entity_id, \
         resource_members.entity_display_name AS resource_members_entity_display_name, \
         resource_members.user_id AS resource_members_user_id, \
         resource_members.`role` AS resource_members_role, \
         resource_members.status AS resource_members_status, \
         resource_members.invited_by_user_id AS resource_members_invited_by_user_id, \
         resource_members.share_link_id AS resource_members_share_link_id, \
         resource_members.reviewed_by_user_id AS resource_members_reviewed_by_user_id, \
         resource_members.reviewed_at AS resource_members_reviewed_at, \
         resource_members.copied_resource_id AS resource_members_copied_resource_id, \
         resource_members.requested_at AS resource_members_requested_at, \
         resource_members.created_at AS resource_members_created_at, \
         resource_members.updated_at AS resource_members_updated_at \n\
         FROM resource_members \nWHERE resource_members.resource_type = 'Task' \
         AND resource_members.resource_id = ? AND resource_members.status = 'approved'",
        (task_id,),
    )
    .await?;
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delete_status_detected_in_json() {
        assert!(json_status_is_delete(&serde_json::json!({
            "status": {"status": "DELETE"}
        })));
        assert!(!json_status_is_delete(&serde_json::json!({
            "status": {"status": "PENDING"}
        })));
    }
}

#[cfg(test)]
mod sql_tests {
    use super::*;
    use crate::sql_test_support::{QueryCapture, Route};

    #[tokio::test]
    async fn active_task_query_keeps_legacy_filters_and_binds_origin() {
        for task_id in [42, 700_000_000_001_i64] {
            for origin in [None, Some(""), Some("client'\\name")] {
                let mysql = QueryCapture::default();
                get_active_non_deleted_task(
                    &mysql,
                    TaskPolicy {
                        is_scoped_id: |id| id != 42,
                        resolve_migrated_legacy: true,
                    },
                    task_id,
                    origin,
                )
                .await
                .unwrap();
                let queries = mysql.queries();
                let query = &queries[0];
                assert_eq!(query.route, Route::Task(task_id as u64));
                assert_eq!(query.args, 1 + usize::from(origin.is_some()));
                assert_eq!(query.sql.contains("JSON_EXTRACT"), task_id == 42);
                assert_eq!(
                    query.sql.contains("AND client_origin = ?"),
                    origin.is_some()
                );
                assert!(query.sql.ends_with("LIMIT 1"));
                assert!(!query.sql.contains("client'"));
                if task_id == 42 && origin.is_some() {
                    assert!(
                        query
                            .sql
                            .contains("!= 'DELETE' AND client_origin = ? LIMIT 1")
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn owner_query_expands_active_states_and_static_queries_keep_tokens() {
        let mysql = QueryCapture::default();
        get_accessible_task_owner(&mysql, 42).await.unwrap();
        get_task_by_id_with_owner(
            &mysql,
            TaskPolicy {
                is_scoped_id: |_| true,
                resolve_migrated_legacy: true,
            },
            700_000_000_001_i64,
            7,
        )
        .await
        .unwrap();
        get_workspace_by_ref(&mysql, 7, "workspace", "default")
            .await
            .unwrap();
        let queries = mysql.queries();
        assert!(queries[0].sql.contains("is_active IN (1, 2)"));
        assert_eq!(queries[2].route, Route::User(7));
        crate::sql_test_support::assert_routed_sql(SUBTASKS_BY_TASK_SQL, 1);
    }
}
