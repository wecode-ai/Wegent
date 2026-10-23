//! SQL row loads for the task-detail endpoint.
//!
//! Every task and subtask statement lives in the task store, which owns the
//! physical table choice; this module decodes the rows it returns and keeps
//! the reads that carry no table choice.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlRow};
use chrono::NaiveDateTime;
use serde_json::Value;

use brz_json::OpaqueJson;

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

/// `task_store.get_active_non_deleted_task` through the store, keeping the
/// source's `_is_json_deleted` filter over the decoded status.
pub(crate) async fn get_active_non_deleted_task(
    task_store: &dyn crate::task_store::TaskStore,
    task_id: i64,
    client_origin: Option<&str>,
) -> brz_mysql::MysqlResult<Option<TaskRow>> {
    let row = task_store
        .get_active_task_by_id(task_id, client_origin)
        .await?;
    Ok(row
        .as_ref()
        .map(decode_task_row)
        .transpose()?
        .filter(|task| !json_status_is_delete(&task.json)))
}

/// `SqlAlchemyTaskAccessStore._get_accessible_task`'s owner id through the
/// store's active-task owner projection.
pub(crate) async fn get_accessible_task_owner(
    task_store: &dyn crate::task_store::TaskStore,
    task_id: i64,
) -> brz_mysql::MysqlResult<Option<i64>> {
    let row = task_store.get_task_owner_id(task_id).await?;
    Ok(row
        .as_ref()
        .and_then(|row| row.get_required::<i64>("user_id").ok()))
}

/// `task_store.get_by_id` with the owner filter, through the store.
pub(crate) async fn get_task_by_id_with_owner(
    task_store: &dyn crate::task_store::TaskStore,
    task_id: i64,
    owner_user_id: i64,
) -> brz_mysql::MysqlResult<Option<TaskRow>> {
    let row = task_store.get_task_owned(task_id, owner_user_id).await?;
    row.as_ref().map(decode_task_row).transpose()
}

/// `task_store.get_workspace_by_ref`, through the store.
pub(crate) async fn get_workspace_by_ref(
    task_store: &dyn crate::task_store::TaskStore,
    owner_user_id: i64,
    name: &str,
    namespace: &str,
) -> brz_mysql::MysqlResult<Option<TaskRow>> {
    let row = task_store
        .get_workspace_by_ref(owner_user_id, name, namespace)
        .await?;
    row.as_ref().map(decode_task_row).transpose()
}

/// `ShardedTaskStore._is_json_deleted`.
pub(crate) fn json_status_is_delete(payload: &Value) -> bool {
    crate::crd::json_status_is_delete(payload)
}

/// `is_member`'s approved member-row check (only reached when the requesting
/// user is not the task owner).
///
/// Only row presence matters here, so the query selects a positional scalar
/// instead of coupling the probe to SQLAlchemy's labeled projection name.
pub(crate) async fn is_approved_member<M>(
    mysql: &M,
    task_id: i64,
    user_id: i64,
) -> brz_mysql::MysqlResult<bool>
where
    M: brz_mysql::Mysql,
{
    let row: Option<i64> = mysql
        .fetch_optional(
            "SELECT 1 \nFROM resource_members \n\
             WHERE resource_members.resource_type = 'Task' AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved' AND resource_members.copied_resource_id = 0 \n\
             LIMIT 1",
            (task_id, user_id.to_string()),
        )
        .await?;
    Ok(approved_member_row_exists(row))
}

fn approved_member_row_exists(row: Option<i64>) -> bool {
    row.is_some()
}

/// Task ids the viewer may read: owned by them or shared with them.
///
/// Conversation references expose the referenced task's title, so a task-detail
/// response must only carry the ones the viewer can actually open.
pub(crate) async fn accessible_task_ids<M>(
    mysql: &M,
    task_ids: &[i64],
    user_id: i64,
) -> brz_mysql::MysqlResult<Vec<i64>>
where
    M: brz_mysql::Mysql,
{
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(FromMysqlRow)]
    struct TaskIdRow {
        task_id: i64,
    }
    let ids = task_ids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT DISTINCT tasks.id AS task_id \nFROM tasks \n\
         LEFT JOIN resource_members rm ON rm.resource_type = 'Task' \
         AND rm.resource_id = tasks.id AND rm.entity_type = 'user' \
         AND rm.entity_id = ? AND rm.status = 'approved' \
         AND rm.copied_resource_id = 0 \n\
         WHERE tasks.id IN ({ids}) AND tasks.kind = 'Task' AND tasks.is_active = 1 \n\
         AND (tasks.user_id = ? OR rm.id IS NOT NULL)"
    );
    let rows: Vec<TaskIdRow> = mysql
        .fetch_all(&sql, (user_id.to_string(), user_id))
        .await?;
    Ok(rows.into_iter().map(|row| row.task_id).collect())
}

/// One `list_by_task_ordered` listing, decoded: the subtasks and the contexts
/// the store attached on the path that resolved its own table.
pub(crate) struct SubtaskListing {
    pub subtasks: Vec<SubtaskRow>,
    pub contexts: Option<Vec<ContextRow>>,
}

/// `subtask_store.list_by_task_ordered` (message_id, created_at).
pub(crate) async fn list_subtasks_by_task(
    task_store: &dyn crate::task_store::TaskStore,
    task_id: i64,
    owner_user_id: i64,
) -> brz_mysql::MysqlResult<SubtaskListing> {
    let listing = task_store
        .list_subtasks_by_task_ordered(task_id, owner_user_id)
        .await?;
    Ok(SubtaskListing {
        subtasks: listing
            .rows
            .iter()
            .map(decode_subtask_row)
            .collect::<brz_mysql::MysqlResult<_>>()?,
        contexts: listing
            .contexts
            .map(|rows| {
                rows.into_iter()
                    .map(ContextRow::from_mysql_row)
                    .collect::<brz_mysql::MysqlResult<Vec<_>>>()
            })
            .transpose()?,
    })
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

/// `add_group_chat_info_to_task`'s approved member count
/// (`task_detail_helpers.py:172-192`).
///
/// The source filters `copied_resource_id == 0` because approving a share
/// recipient also writes an approved `resource_members` row whose
/// `copied_resource_id` is the copied task; without the predicate the count
/// includes share records and the statement no longer matches the source SQL.
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
         AND resource_members.resource_id = ? AND resource_members.status = 'approved' \
         AND resource_members.copied_resource_id = 0",
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

    #[tokio::test]
    async fn approved_member_probe_uses_a_positional_presence_scalar() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();

        let is_member = is_approved_member(&mysql, 42, 7).await.unwrap();

        assert!(!is_member);
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 2);
        assert_eq!(queries[0].first_integer, Some(42));
        assert!(queries[0].sql.starts_with("SELECT 1 FROM resource_members"));
    }

    #[test]
    fn approved_member_probe_accepts_a_present_row() {
        assert!(approved_member_row_exists(Some(1)));
        assert!(!approved_member_row_exists(None));
    }
}
