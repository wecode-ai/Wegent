// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MySQL readers for `GET /api/attachments/task/{task_id}/all` mirroring the
//! source dependency sequence (`get_all_task_attachments` ->
//! `task_store.get_by_id`, the inline `resource_members` membership query,
//! `subtask_store.list_by_task_unfiltered`, and
//! `context_service.get_attachments_by_task`).
//!
//! Task/subtask rows come from the injected `TaskStore`, which owns the table
//! choice: the public store reads the base `tasks`/`subtasks` tables, while a
//! deployment that resolves task storage differently supplies its own store.
use crate::json_compat::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlRow};
use chrono::NaiveDateTime;

/// A `tasks` row restricted to the ownership columns
/// (`TaskStore.get_by_id`).
#[derive(Debug, FromMysqlRow)]
pub struct TaskRow {
    #[mysql(rename = "user_id")]
    pub user_id: i32,
}

/// `task_store.get_by_id`: the full projection of the task id.
pub async fn get_task_by_id(
    task_store: &dyn crate::task_store::TaskStore,
    task_id: i64,
) -> MysqlResult<Option<TaskRow>> {
    let row = task_store.get_task(task_id).await?;
    row.map(TaskRow::from_mysql_row).transpose()
}

/// The inline approved-membership query from the endpoint: the full
/// `resource_members` labeled projection with scalar filters inlined as
/// literals (only `id` is decoded; `first()` semantics).
pub async fn is_task_member<M>(mysql: &M, task_id: i64, user_id: i64) -> MysqlResult<bool>
where
    M: Mysql,
{
    let member: Option<MysqlRow> = mysql
        .fetch_optional(
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
             resource_members.updated_at AS resource_members_updated_at \
             FROM resource_members \
             WHERE resource_members.resource_type = 'Task' \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved' \
             LIMIT 1",
            (task_id, user_id.to_string()),
        )
        .await?;
    Ok(member.is_some())
}

/// One `subtasks` row; only `id` is consumed by `get_attachments_by_task`.
#[derive(Debug, FromMysqlRow)]
pub struct SubtaskRow {
    pub id: i64,
}

/// `ShardedSubtaskStore.list_by_task_unfiltered`: the task's subtasks, with no
/// ordering (`query.all()`).
pub async fn list_subtask_ids_by_task(
    task_store: &dyn crate::task_store::TaskStore,
    task_id: i64,
) -> MysqlResult<Vec<SubtaskRow>> {
    let rows = task_store.list_subtasks_by_task(task_id).await?;
    rows.into_iter().map(SubtaskRow::from_mysql_row).collect()
}

/// One `subtask_contexts` row (`SubtaskContext`), decoded from the
/// SQLAlchemy-labeled aliases the source statement selects.
#[derive(Debug, FromMysqlRow)]
pub struct ContextRow {
    #[mysql(rename = "subtask_contexts_id")]
    pub id: i64,
    #[mysql(rename = "subtask_contexts_subtask_id")]
    pub subtask_id: i64,
    #[mysql(rename = "subtask_contexts_context_type")]
    #[allow(dead_code)]
    pub context_type: String,
    #[mysql(rename = "subtask_contexts_name")]
    pub name: String,
    #[mysql(rename = "subtask_contexts_status")]
    #[allow(dead_code)]
    pub status: String,
    #[mysql(rename = "subtask_contexts_error_message")]
    pub error_message: String,
    #[mysql(rename = "subtask_contexts_text_length")]
    pub text_length: i32,
    #[mysql(rename = "subtask_contexts_type_data")]
    pub type_data: Option<Json<OpaqueJson>>,
    #[mysql(rename = "subtask_contexts_created_at")]
    pub created_at: Option<NaiveDateTime>,
}

/// `context_service.get_attachments_by_task`: the `subtask_contexts`
/// selection for the task's subtasks, attachment/ready-filtered and ordered
/// by `created_at`. Empty subtask lists short-circuit like the source.
pub async fn get_attachments_by_task<M>(
    mysql: &M,
    subtask_ids: &[i64],
) -> MysqlResult<Vec<ContextRow>>
where
    M: Mysql,
{
    if subtask_ids.is_empty() {
        return Ok(Vec::new());
    }
    // Scalar filters inlined as literals, the subtask ids inlined as a
    // comma-separated list (the recorded source statement shape).
    let ids = subtask_ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    mysql
        .fetch_all(
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
                 subtask_contexts.updated_at AS subtask_contexts_updated_at \
                 FROM subtask_contexts \
                 WHERE subtask_contexts.subtask_id IN ({ids}) \
                 AND subtask_contexts.context_type = 'attachment' \
                 AND subtask_contexts.status = 'ready' \
                 ORDER BY subtask_contexts.created_at"
            ),
            (),
        )
        .await
}
