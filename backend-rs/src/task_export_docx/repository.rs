// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Source-facing row loads for the DOCX export endpoint.
//!
//! Every statement mirrors the recorded source SQLAlchemy rendering: labeled
//! `users_*` projections, the sharded `tasks_{:04}` / `subtasks_{:04}`
//! physical tables selected by the configured store, the batched
//! `subtask_contexts` load, and the unfiltered `users` id lookups used for
//! sender display names.

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlRow};
use chrono::NaiveDateTime;

use crate::json_compat::OpaqueJson;
use crate::task_routing::{ByTaskId, TaskPolicy};

/// `db.query(User).filter(User.id == ..., User.is_active.is_(True))` —
/// the download-token user load.
pub(crate) const ACTIVE_USER_BY_ID: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? AND users.is_active IS true \
     LIMIT 1";

/// `db.query(User).filter(User.id == ...)` — the sender-name loads.
pub(crate) const USER_BY_ID: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? \
     LIMIT 1";

/// A `users` row for the export path; only `user_name` is consumed.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct UserRow {
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_id")]
    pub id: i64,
    #[mysql(rename = "users_user_name")]
    pub user_name: String,
}

/// A `tasks_{:04}` row; the export consumes `user_id` and `json`.
#[derive(Debug)]
pub(crate) struct TaskRow {
    pub user_id: i64,
    pub json: serde_json::Value,
}

fn decode_task_row(row: &MysqlRow) -> brz_mysql::MysqlResult<TaskRow> {
    Ok(TaskRow {
        user_id: row.get_required("user_id")?,
        json: row.get_required::<Json<serde_json::Value>>("json")?.0,
    })
}

/// `task_store.get_task_by_states` (new-format ids route to the shard table).
pub(crate) async fn get_task_by_states<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    task_id: i64,
) -> brz_mysql::MysqlResult<Option<TaskRow>>
where
    M: Mysql,
{
    let sql = "SELECT id, user_id, kind, name, namespace, json, is_active, \
         created_at, updated_at, project_id, client_origin, is_group_chat \
         FROM {{tasks}} \
         WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2) \
         LIMIT 1";
    let row: Option<MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(sql, (task_id,))
        .await?;
    let _ = task_policy;
    row.as_ref().map(decode_task_row).transpose()
}

/// `_get_accessible_task`'s owner projection: the membership pre-check.
pub(crate) async fn get_accessible_task_owner<M>(
    mysql: &M,
    task_id: i64,
) -> brz_mysql::MysqlResult<Option<i64>>
where
    M: Mysql,
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
    M: Mysql,
{
    #[derive(FromMysqlRow)]
    struct MemberId {
        #[allow(dead_code, reason = "selected to match source column list")]
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

/// A `subtasks_{:04}` row for the export.
#[derive(Debug)]
pub(crate) struct SubtaskRow {
    pub id: i64,
    pub role: String,
    pub prompt: Option<String>,
    pub result: Option<OpaqueJson>,
    #[allow(dead_code, reason = "selected to match source column list")]
    pub message_id: i64,
    pub sender_user_id: Option<i64>,
    pub updated_at: Option<NaiveDateTime>,
}

fn decode_subtask_row(row: &MysqlRow) -> brz_mysql::MysqlResult<SubtaskRow> {
    Ok(SubtaskRow {
        id: row.get_required("id")?,
        role: row.get_required("role")?,
        prompt: row.get("prompt")?,
        result: row.get::<Json<OpaqueJson>>("result")?.map(|json| json.0),
        message_id: row.get_required("message_id")?,
        sender_user_id: row.get("sender_user_id")?,
        updated_at: row.get("updated_at")?,
    })
}

/// `subtask_store.list_by_task_ordered` with `order_by="id"` and the optional
/// `message_ids` filter. New-format ids route to the shard table directly.
pub(crate) async fn list_subtasks_ordered<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    task_id: i64,
    message_ids: Option<&[i64]>,
) -> brz_mysql::MysqlResult<Vec<SubtaskRow>>
where
    M: Mysql,
{
    if message_ids.is_some_and(|ids| ids.is_empty()) {
        return Ok(Vec::new());
    }
    let mut sql = String::from(
        "SELECT id, user_id, task_id, team_id, title, bot_ids, `role`, \
         executor_namespace, executor_name, executor_deleted_at, prompt, \
         message_id, parent_id, status, progress, result, error_message, \
         created_at, updated_at, completed_at, sender_type, sender_user_id, \
         reply_to_subtask_id \
         FROM {{subtasks}} \
         WHERE task_id = ?",
    );
    let ids = message_ids.unwrap_or_default();
    if !ids.is_empty() {
        let list = ids
            .iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" AND message_id IN ({list})"));
    }
    sql.push_str(" ORDER BY id ASC");
    let rows: Vec<MysqlRow> = if (task_policy.is_scoped_id)(task_id as u64) {
        mysql
            .route(ByTaskId(task_id as u64))
            .fetch_all(&sql, (task_id,))
            .await?
    } else {
        // Legacy ids resolve the migrated shard through the base-table owner
        // lookup (`_subtask_model_for_task_lookup`), which this endpoint has
        // already loaded; the base-table fallback covers unmigrated tasks.
        mysql.fetch_all(&sql, (task_id,)).await?
    };
    rows.iter().map(decode_subtask_row).collect()
}

/// One `subtask_contexts` row (`_attach_contexts`' batch load).
#[derive(Debug, FromMysqlRow)]
pub(crate) struct ContextRow {
    #[mysql(rename = "subtask_contexts_id")]
    #[allow(dead_code, reason = "selected to match source column list")]
    pub id: i64,
    #[mysql(rename = "subtask_contexts_subtask_id")]
    pub subtask_id: i64,
    #[mysql(rename = "subtask_contexts_context_type")]
    pub context_type: String,
    #[mysql(rename = "subtask_contexts_name")]
    pub name: Option<String>,
    #[mysql(rename = "subtask_contexts_type_data")]
    pub type_data: Option<Json<OpaqueJson>>,
}

/// `ShardedSubtaskStore._attach_contexts`: contexts ordered by id.
pub(crate) async fn list_contexts<M>(
    mysql: &M,
    subtask_ids: &[i64],
) -> brz_mysql::MysqlResult<Vec<ContextRow>>
where
    M: Mysql,
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
