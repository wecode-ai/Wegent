// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task/subtask/kind reads for `GET /api/v1/responses/{response_id}`.
//!
//! Mirrors the source call chain of
//! `app.api.endpoints.openapi_responses.get_response`:
//! `task_kinds_service.get_task_by_id`
//! (`TaskStore.get_active_non_deleted_task` +
//! `TaskAccessStore.is_member` +
//! `converters.convert_to_task_dict`), `subtask_store
//! .list_by_task_for_user_ordered`, and `task_store.get_task_by_states`
//! — all through the configured task/subtask repository. Public startup maps
//! the route keys to base tables; the private startup maps them to physical
//! shard tables.
//!
//! The source SQLAlchemy session renders every one of these reads as one
//! text `COM_QUERY` with the full mapped-column projection labeled
//! `{table}_{column}` and scalar filters inlined as literals; the target
//! uses brz-mysql routed `{{tasks}}`/`{{subtasks}}` tokens with unqualified
//! column names and `?` placeholders.
use crate::json_compat::OpaqueJson;
use crate::task_routing::{ByTaskId, ByUserId, TaskPolicy};
use brz_mysql::{Json, Mysql, MysqlResult, MysqlRow};
use chrono::NaiveDateTime;

const ACTIVE_TASK_SQL: &str = "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \
    FROM {{tasks}} \
    WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2) \
    LIMIT 1";
const WORKSPACE_BY_REF_SQL: &str = "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \
    FROM {{tasks}} \
    WHERE user_id = ? AND kind = 'Workspace' AND name = ? AND namespace = ? AND is_active = 1 \
    LIMIT 1";
const SUBTASKS_BY_OWNER_SQL: &str = "SELECT id, user_id, task_id, team_id, title, bot_ids, `role`, executor_namespace, executor_name, \
        executor_deleted_at, prompt, message_id, parent_id, status, progress, result, error_message, \
        created_at, updated_at, completed_at, sender_type, sender_user_id, reply_to_subtask_id \
    FROM {{subtasks}} \
    WHERE task_id = ? AND user_id = ? \
    ORDER BY message_id ASC";
const ACTIVE_TASK_BY_OWNER_SQL: &str = "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \
    FROM {{tasks}} \
    WHERE id = ? AND kind = 'Task' AND is_active IN (1) AND user_id = ? \
    LIMIT 1";

/// One `tasks`/`tasks_{:04}` row projection used by the response flow.
#[derive(Debug)]
pub struct TaskRow {
    pub id: i64,
    pub user_id: i32,
    pub json: Json<OpaqueJson>,
    /// Row `created_at` (naive local `DATETIME`), fallback for `created_at`.
    pub created_at: Option<NaiveDateTime>,
}

impl TaskRow {
    /// Decode one row of the unqualified task projection.
    fn from_row(row: &MysqlRow) -> MysqlResult<Self> {
        Ok(Self {
            id: row.get_required("id")?,
            user_id: row.get_required("user_id")?,
            json: row.get_required("json")?,
            created_at: row.get("created_at")?,
        })
    }
}

/// One `subtasks`/`subtasks_{:04}` row projection used for output items.
#[derive(Debug)]
pub struct SubtaskRow {
    pub id: i64,
    #[allow(dead_code)]
    pub user_id: i32,
    #[allow(dead_code)]
    pub task_id: i64,
    /// Role enum text (`USER` / `ASSISTANT`).
    pub role: String,
    /// Status enum text (`PENDING` / `RUNNING` / ...).
    pub status: String,
    /// `result` JSON column; SQL NULL stays `None`.
    pub result:
        Option<Json<crate::json_compat::JsonProjection<super::output_builder::ResultInput>>>,
}

impl SubtaskRow {
    /// Decode one row of the unqualified subtask projection.
    fn from_row(row: &MysqlRow) -> MysqlResult<Self> {
        Ok(Self {
            id: row.get_required("id")?,
            user_id: row.get_required("user_id")?,
            task_id: row.get_required("task_id")?,
            role: row.get_required("role")?,
            status: row.get_required("status")?,
            result: row.get("result")?,
        })
    }
}

/// One `kinds` row projection (Team lookup).
#[derive(Debug)]
pub struct KindRow {
    #[allow(dead_code)]
    pub id: i64,
    #[allow(dead_code)]
    pub json: Json<OpaqueJson>,
}

/// The 9-column `Kind` projection, labeled `kinds_{column}`.
fn kind_columns() -> String {
    [
        "id",
        "user_id",
        "kind",
        "name",
        "namespace",
        "json",
        "is_active",
        "created_at",
        "updated_at",
    ]
    .iter()
    .map(|column| format!("kinds.{column} AS kinds_{column}"))
    .collect::<Vec<_>>()
    .join(", ")
}

/// `TaskStore.get_active_non_deleted_task`: state filter plus the
/// application-side JSON `status.status != 'DELETE'` exclusion.
pub async fn get_active_non_deleted_task<M>(mysql: &M, task_id: i64) -> MysqlResult<Option<TaskRow>>
where
    M: Mysql,
{
    let row: Option<MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(ACTIVE_TASK_SQL, (task_id,))
        .await?;
    Ok(row
        .as_ref()
        .map(TaskRow::from_row)
        .transpose()?
        .filter(|task| !json_status_is_delete(&task.json.0)))
}

/// `TaskAccessStore.is_member` -> `_get_accessible_task`
/// (`task_store.get_active_task`): the same active-state task lookup.
pub async fn get_accessible_task<M>(mysql: &M, task_id: i64) -> MysqlResult<Option<TaskRow>>
where
    M: Mysql,
{
    let row: Option<MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(ACTIVE_TASK_SQL, (task_id,))
        .await?;
    row.as_ref().map(TaskRow::from_row).transpose()
}

/// `SqlAlchemyTaskAccessStore.is_member` member check: approved
/// `resource_members` row (entity_id is the stringified user id). Only
/// issued when the viewer is not the task owner.
async fn is_approved_member<M>(mysql: &M, task_id: i64, user_id: i32) -> MysqlResult<bool>
where
    M: Mysql,
{
    let row: Option<MysqlRow> = mysql
        .fetch_optional(
            "SELECT resource_members.id AS resource_members_id \nFROM resource_members \n\
             WHERE resource_members.resource_type = 'Task' \
             AND resource_members.resource_id = ? \
             AND resource_members.entity_type = 'user' \
             AND resource_members.entity_id = ? \
             AND resource_members.status = 'approved' \
             AND resource_members.copied_resource_id = 0 \n LIMIT 1",
            (task_id, user_id.to_string()),
        )
        .await?;
    Ok(row.is_some())
}

/// `task_access_store.is_member` (the configured task repository).
pub async fn is_member<M>(mysql: &M, task_id: i64, user_id: i32) -> MysqlResult<bool>
where
    M: Mysql,
{
    let task = get_accessible_task(mysql, task_id).await?;
    let Some(task) = task else {
        return Ok(false);
    };
    if task.user_id == user_id {
        return Ok(true);
    }
    is_approved_member(mysql, task_id, user_id).await
}

/// `task_store.get_workspace_by_ref` (`convert_to_task_dict`). The public
/// policy uses the base table; the private migration policy additionally
/// probes the owner's routed table before the base-table fallback.
pub async fn get_workspace_by_ref<M>(
    mysql: &M,
    task_policy: TaskPolicy,
    owner_user_id: i32,
    name: &str,
    namespace: &str,
) -> MysqlResult<bool>
where
    M: Mysql,
{
    if task_policy.resolve_migrated_legacy {
        let row: Option<MysqlRow> = mysql
            .route(ByUserId(owner_user_id as u64))
            .fetch_optional(WORKSPACE_BY_REF_SQL, (owner_user_id, name, namespace))
            .await?;
        if row.is_some() {
            return Ok(true);
        }
    }
    // The zero routing key selects the public/base table; the actual owner
    // remains a separate SQL parameter in the WHERE clause.
    let row: Option<MysqlRow> = mysql
        .route(ByUserId(0))
        .fetch_optional(WORKSPACE_BY_REF_SQL, (owner_user_id, name, namespace))
        .await?;
    Ok(row.is_some())
}

/// `resolve_task_ref_team`: when the CRD `spec.teamRef.user_id` is set, the
/// Team kind row is selected by owner/kind/namespace/name; otherwise
/// `kindReader.get_by_name_and_namespace` resolves it by viewer.
pub async fn resolve_team<M>(
    mysql: &M,
    task: &TaskRow,
    viewer_user_id: i32,
) -> MysqlResult<Option<KindRow>>
where
    M: Mysql,
{
    let task_crd = crate::crd::CrdDocument::project_opaque(&task.json.0);
    let Some(team_ref) = task_crd
        .spec
        .as_ref()
        .and_then(|spec| spec.team_ref.as_ref())
    else {
        return Ok(None);
    };
    let name = team_ref.name();
    let namespace = team_ref.namespace();
    let columns = kind_columns();
    // All resolution paths render the same labeled `kinds` lookup with the
    // owner/viewer/group selector. The recorded source COM_QUERY inlines the
    // selector as an unquoted integer literal (`kinds.user_id = 89`), so the
    // prepared-statement parameter must bind as an integer, never a string.
    let owner = team_owner_id(&task_crd, namespace, viewer_user_id);
    let row: Option<MysqlRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {columns} \nFROM kinds \nWHERE kinds.user_id = ? \
                 AND kinds.kind = 'Team' AND kinds.namespace = ? \
                 AND kinds.name = ? AND kinds.is_active = true \n LIMIT 1"
            ),
            (owner, namespace, name),
        )
        .await?;
    Ok(row.as_ref().map(|row| KindRow {
        id: row.get_required("kinds_id").unwrap_or_default(),
        json: row
            .get_required("kinds_json")
            .unwrap_or_else(|_| Json(serde_json::from_str("null").unwrap())),
    }))
}

/// `SubtaskStore.list_by_task_for_user_ordered`: the configured routed table
/// filtered by `task_id` and `user_id`, ordered by `message_id`.
pub async fn list_subtasks_for_user_ordered<M>(
    mysql: &M,
    task_id: i64,
    user_id: i32,
) -> MysqlResult<Vec<SubtaskRow>>
where
    M: Mysql,
{
    let rows: Vec<MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_all(SUBTASKS_BY_OWNER_SQL, (task_id, user_id))
        .await?;
    rows.iter().map(SubtaskRow::from_row).collect()
}

/// `task_store.get_task_by_states(states=[STATE_ACTIVE],
/// owner_user_id=user_id)` for the model-string reconstruction.
pub async fn get_task_by_states_active_owned<M>(
    mysql: &M,
    task_id: i64,
    owner_user_id: i32,
) -> MysqlResult<Option<TaskRow>>
where
    M: Mysql,
{
    let row: Option<MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(ACTIVE_TASK_BY_OWNER_SQL, (task_id, owner_user_id))
        .await?;
    row.as_ref().map(TaskRow::from_row).transpose()
}

/// `resolve_task_ref_team` owner selector: an explicit `teamRef.user_id`
/// (non-null, numeric) selects the direct owner query; otherwise the source
/// `resolve_task_ref_team` runs only when the ref carries a user id, so the
/// fallback keeps the recorded viewer/group selector shape
/// (`get_personal` for `default`, `get_group` otherwise) as an integer id.
fn team_owner_id(task_crd: &crate::crd::CrdDocument, namespace: &str, viewer_user_id: i32) -> i64 {
    task_crd
        .spec
        .as_ref()
        .and_then(|spec| spec.team_ref.as_ref())
        .and_then(|team_ref| team_ref.user_id.as_ref())
        .and_then(|id| id.integer())
        .unwrap_or_else(|| {
            if namespace == "default" {
                i64::from(viewer_user_id)
            } else {
                0
            }
        })
}

/// `ShardedTaskStore._is_json_deleted`.
fn json_status_is_delete(payload: &OpaqueJson) -> bool {
    crate::crd::CrdDocument::project_opaque(payload).is_deleted()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task_row(json: serde_json::Value) -> TaskRow {
        TaskRow {
            id: 1,
            user_id: 89,
            json: Json(OpaqueJson::from(json)),
            created_at: None,
        }
    }

    #[test]
    fn detects_delete_status() {
        assert!(json_status_is_delete(&OpaqueJson::from(
            serde_json::json!({"status": {"status": "DELETE"}})
        )));
        assert!(!json_status_is_delete(&OpaqueJson::from(
            serde_json::json!({"status": {"status": "RUNNING"}})
        )));
    }

    #[test]
    fn team_owner_selector_binds_team_ref_user_id() {
        let task = task_row(serde_json::json!({
            "spec": {"teamRef": {"name": "example-team", "namespace": "example", "user_id": 1001}},
        }));
        let crd = crate::crd::CrdDocument::project_opaque(&task.json.0);
        assert_eq!(team_owner_id(&crd, "example", 2001), 1001);

        let text_id = task_row(serde_json::json!({
            "spec": {"teamRef": {"name": "t", "namespace": "example", "user_id": "1001"}},
        }));
        let crd = crate::crd::CrdDocument::project_opaque(&text_id.json.0);
        assert_eq!(team_owner_id(&crd, "example", 2001), 1001);

        let unset = task_row(serde_json::json!({
            "spec": {"teamRef": {"name": "t", "namespace": "default"}},
        }));
        let crd = crate::crd::CrdDocument::project_opaque(&unset.json.0);
        assert_eq!(team_owner_id(&crd, "default", 2001), 2001);
        assert_eq!(team_owner_id(&crd, "example", 2001), 0);
    }

    #[tokio::test]
    async fn kinds_owner_parameter_binds_as_integer() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let task = task_row(serde_json::json!({
            "spec": {"teamRef": {"name": "example-team", "namespace": "example", "user_id": 1001}},
        }));
        resolve_team(&mysql, &task, 2001).await.unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(
            queries[0].first_integer,
            Some(1001),
            "kinds.user_id must bind as an integer parameter"
        );
    }
}

#[cfg(test)]
mod sql_tests {
    use super::*;
    use crate::sql_test_support::{QueryCapture, Route};

    #[tokio::test]
    async fn response_queries_preserve_routing_and_filters() {
        let mysql = QueryCapture::default();
        get_active_non_deleted_task(&mysql, 42).await.unwrap();
        get_accessible_task(&mysql, 42).await.unwrap();
        get_workspace_by_ref(&mysql, TaskPolicy::default(), 7, "workspace", "default")
            .await
            .unwrap();
        list_subtasks_for_user_ordered(&mysql, 42, 7).await.unwrap();
        get_task_by_states_active_owned(&mysql, 42, 7)
            .await
            .unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 5);
        assert_eq!(queries[0].sql, queries[1].sql);
        assert_eq!(queries[2].route, Route::User(0));
        assert_eq!(queries[2].first_integer, Some(7));
        assert_eq!(queries[3].route, Route::Task(42));
        assert!(queries[3].sql.ends_with("ORDER BY message_id ASC"));
        assert!(queries[4].sql.contains("is_active IN (1) AND user_id = ?"));
    }
}
