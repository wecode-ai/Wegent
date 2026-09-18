// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task resource repository mirroring the runtime-check read path in
//! `Wegent/backend`:
//!
//! - `task_store.get_active_non_deleted_task`
//!   (`app/stores/tasks/sqlalchemy_task_store.py` and
//!   the configured store),
//! - `task_access_store.is_member`
//!   (`app/stores/tasks/sqlalchemy_access_store.py`),
//! - `task_store.get_workspace_by_ref`,
//! - team resolution (`app/services/adapters/task_kinds/converters.py`).
//!
//! Every statement uses brz-mysql routed `{{tasks}}`/`{{subtasks}}` tokens
//! with unqualified column names and `?` placeholders. Legacy task ids
//! (below the user-scoped id bit layout in the configured store)
//! route to the base `tasks` table through `ByTaskId`; new-format ids route
//! by their embedded uid; workspace lookups by owner route by `ByUserId`.
use anyhow::Result;

use brz_mysql::{Mysql, MysqlRow};

use super::auth::model::UserRow;
use crate::crd::CrdDocument;
use crate::json_compat::OpaqueJson;
use crate::task_routing::{ByTaskId, ByUserId};

const ACTIVE_TASK_SQL_BASE: &str = "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \
    FROM {{tasks}} \
    WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2)";

/// `get_active_non_deleted_task` (the configured store): new-format task ids
/// query the id-selected shard model with the active-state filter only
/// (`ShardedTaskStore.get_task_by_states`) and apply the JSON
/// `status.status != 'DELETE'` exclusion in the application
/// (`_is_json_deleted`); legacy ids delegate to the unsharded store
/// (`SqlAlchemyTaskStore.get_active_non_deleted_task`), whose render pushes
/// the `JSON_EXTRACT(json, '$.status.status') != 'DELETE'` filter into SQL
/// on the base `tasks` table.
fn active_task_sql(task_policy: crate::task_routing::TaskPolicy, task_id: i64) -> String {
    let mut sql = ACTIVE_TASK_SQL_BASE.to_string();
    if !(task_policy.is_scoped_id)(task_id as u64) {
        sql.push_str(" AND JSON_EXTRACT(json, '$.status.status') != 'DELETE'");
    }
    sql.push_str(" LIMIT 1");
    sql
}
const WORKSPACE_BY_REF_SQL: &str = "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, project_id, \
        client_origin, is_group_chat \
    FROM {{tasks}} \
    WHERE user_id = ? AND kind = 'Workspace' AND name = ? AND namespace = ? AND is_active = 1 \
    LIMIT 1";

/// The task-row fields the runtime-check response consumes.
#[derive(Debug)]
pub(crate) struct TaskResourceRow {
    pub user_id: i64,
    pub json: OpaqueJson,
    #[allow(dead_code)] // fallback for `status.updatedAt` in `task_checkpoint`
    pub updated_at: chrono::NaiveDateTime,
}

fn decode_task_row(row: &MysqlRow) -> brz_mysql::MysqlResult<TaskResourceRow> {
    Ok(TaskResourceRow {
        user_id: row.get_required("user_id")?,
        // The `json` column is a MySQL JSON column; retain it as validated
        // opaque data until a typed task projection consumes it.
        json: row.get_required::<brz_mysql::Json<OpaqueJson>>("json")?.0,
        updated_at: row.get_required("updated_at")?,
    })
}

/// Minimal task CRD projection used by the runtime-check response.
#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct TaskCrd {
    #[serde(default)]
    pub status: Option<TaskCrdStatus>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct TaskCrdStatus {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<chrono::NaiveDateTime>,
}

impl TaskResourceRow {
    /// The parsed CRD, the way `Task.model_validate(task.json)` sees it.
    pub(crate) fn crd(&self) -> Result<TaskCrd> {
        Ok(serde_json::from_str(self.json.to_raw_value().get())?)
    }
}

/// Mirror of `get_active_non_deleted_task` (the configured store):
/// for new-format task ids the sharded store queries the id-selected shard
/// model with the active-state filter only (`get_task_by_states`) and applies
/// the JSON `status.status != 'DELETE'` exclusion in the application
/// (`_is_json_deleted`); the SQL-level `JSON_EXTRACT` filter is only rendered
/// by the legacy base-table path, which these ids never take.
pub(crate) async fn get_active_non_deleted_task<M>(
    mysql: &M,
    task_policy: crate::task_routing::TaskPolicy,
    task_id: i64,
) -> Result<Option<TaskResourceRow>>
where
    M: brz_mysql::Mysql,
{
    let row: Option<MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(&active_task_sql(task_policy, task_id), (task_id,))
        .await?;
    Ok(row
        .as_ref()
        .map(decode_task_row)
        .transpose()?
        .filter(|task| !json_status_is_delete(&task.json)))
}

/// `ShardedTaskStore._is_json_deleted`: a task counts as deleted only when
/// the CRD `status.status` field equals `"DELETE"`.
fn json_status_is_delete(payload: &OpaqueJson) -> bool {
    CrdDocument::project_opaque(payload).is_deleted()
}

/// Mirror of `task_access_store.is_member`: `_get_accessible_task`
/// (id + kind Task + active states, no JSON filter) then owner or approved
/// resource membership.
pub(crate) async fn is_task_member<M>(
    mysql: &M,
    _task_policy: crate::task_routing::TaskPolicy,
    task_id: i64,
    user_id: i64,
) -> Result<bool>
where
    M: brz_mysql::Mysql,
{
    // `_get_accessible_task` never applies the JSON DELETE filter, so the
    // policy parameter is retained only to keep the configured-store mirror
    // signature aligned with `get_active_non_deleted_task`.
    let row: Option<MysqlRow> = mysql
        .route(ByTaskId(task_id as u64))
        .fetch_optional(
            "SELECT id, user_id, kind, name, namespace, json, is_active, created_at, updated_at, \
             project_id, client_origin, is_group_chat \
             FROM {{tasks}} \
             WHERE id = ? AND kind = 'Task' AND is_active IN (1, 2) \
             LIMIT 1",
            (task_id,),
        )
        .await?;
    let task = row.as_ref().map(decode_task_row).transpose()?;
    let Some(task) = task else {
        return Ok(false);
    };
    if task.user_id == user_id {
        return Ok(true);
    }
    // Approved member probe (`is_member`'s `resource_members` query).
    #[derive(brz_mysql::FromMysqlRow)]
    struct MemberRow {
        #[mysql(rename = "resource_members_id")]
        #[allow(dead_code)]
        id: i64,
    }
    let member: Option<MemberRow> = mysql
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
    Ok(member.is_some())
}

/// Mirror of `get_workspace_by_ref`: the sharded store probes the owner's
/// physical shard table via `{{tasks}}` routed by `ByUserId`.
pub(crate) async fn get_workspace_by_ref<M>(
    mysql: &M,
    owner_user_id: i64,
    name: &str,
    namespace: &str,
) -> Result<Option<TaskResourceRow>>
where
    M: brz_mysql::Mysql,
{
    let row: Option<MysqlRow> = mysql
        .route(ByUserId(owner_user_id as u64))
        .fetch_optional(WORKSPACE_BY_REF_SQL, (owner_user_id, name, namespace))
        .await?;
    Ok(row.as_ref().map(decode_task_row).transpose()?)
}

/// Mirror of `resolve_task_ref_team`'s direct owner query: `teamRef.user_id`
/// set (the recorded public team uses `0`) queries the `kinds` table by
/// owner. Returns the resolved team id (unused by the response; kept for the
/// source call topology).
pub(crate) async fn resolve_team_id<M>(
    mysql: &M,
    team_user_id: i64,
    namespace: &str,
    name: &str,
) -> Result<Option<i64>>
where
    M: brz_mysql::Mysql,
{
    let row: Option<MysqlRow> = Mysql::fetch_optional(
        mysql,
        "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
         kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
         kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
         kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
         kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
         WHERE kinds.user_id = ? AND kinds.kind = 'Team' AND kinds.namespace = ? \
         AND kinds.name = ? AND kinds.is_active = true \n LIMIT 1",
        (team_user_id, namespace, name),
    )
    .await?;
    Ok(row
        .as_ref()
        .and_then(|row| row.get_required::<i64>("kinds_id").ok()))
}

/// `userReader.get_by_id` MySQL fallback (`UserReader.get_by_id`): the full
/// labeled users projection filtered by id.
pub(crate) async fn get_user_by_id<M>(mysql: &M, user_id: i64) -> Result<Option<UserRow>>
where
    M: brz_mysql::Mysql,
{
    let row: Option<UserRow> = mysql
        .fetch_optional(
            "SELECT users.id AS users_id, users.user_name AS users_user_name, \
             users.password_hash AS users_password_hash, users.email AS users_email, \
             users.git_info AS users_git_info, users.is_active AS users_is_active, \
             users.`role` AS users_role, users.auth_source AS users_auth_source, \
             users.preferences AS users_preferences, users.created_at AS users_created_at, \
             users.updated_at AS users_updated_at \
             FROM users \
             WHERE users.id = ? \
             LIMIT 1",
            (user_id,),
        )
        .await?;
    Ok(row)
}

/// The runtime-check fields extracted from a task row, mirroring
/// `convert_to_task_dict`: `task["status"]` is the CRD `status.status` and
/// `task["updated_at"]` prefers the CRD `status.updatedAt` with the raw
/// `tasks.updated_at` column as fallback.
pub(crate) struct TaskCheckpoint {
    pub status: String,
    pub updated_at: Option<chrono::NaiveDateTime>,
}

/// Extract the runtime-check checkpoint from a task row.
pub(crate) fn task_checkpoint(row: &TaskResourceRow) -> Result<TaskCheckpoint> {
    let crd = row.crd()?;
    let status = crd
        .status
        .as_ref()
        .and_then(|status| status.status.clone())
        .unwrap_or_else(|| "PENDING".to_string());
    let updated_at = crd
        .status
        .as_ref()
        .and_then(|status| status.updated_at)
        .or(Some(row.updated_at));
    Ok(TaskCheckpoint { status, updated_at })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_prefers_crd_status_updated_at() {
        let row = TaskResourceRow {
            user_id: 3005,
            json: OpaqueJson::from(serde_json::json!({
                "status": {
                    "status": "CANCELLED",
                    "updatedAt": "2026-05-14T18:01:04.604583"
                }
            })),
            updated_at: chrono::NaiveDateTime::parse_from_str(
                "2026-05-13T11:30:28",
                "%Y-%m-%dT%H:%M:%S",
            )
            .unwrap(),
        };
        let checkpoint = task_checkpoint(&row).unwrap();
        assert_eq!(checkpoint.status, "CANCELLED");
        assert_eq!(
            checkpoint.updated_at.map(|value| value.to_string()),
            Some("2026-05-14 18:01:04.604583".to_string())
        );
    }

    #[test]
    fn checkpoint_falls_back_to_the_row_timestamp_and_pending_status() {
        let row = TaskResourceRow {
            user_id: 1,
            json: OpaqueJson::from(serde_json::json!({})),
            updated_at: chrono::NaiveDateTime::parse_from_str(
                "2026-05-13T11:30:28",
                "%Y-%m-%dT%H:%M:%S",
            )
            .unwrap(),
        };
        let checkpoint = task_checkpoint(&row).unwrap();
        assert_eq!(checkpoint.status, "PENDING");
        assert_eq!(
            checkpoint.updated_at.unwrap().to_string(),
            "2026-05-13 11:30:28"
        );
    }
}

#[cfg(test)]
mod sql_tests {
    use super::*;
    use crate::sql_test_support::{QueryCapture, Route};

    #[tokio::test]
    async fn active_task_and_workspace_queries_preserve_routing_tokens() {
        // The deployed classification (`is_new_task_id`): user-scoped ids
        // have a nonzero uid at bit 37+.
        let policy = crate::task_routing::TaskPolicy {
            is_scoped_id: |id: u64| id >= (1_u64 << 37),
            resolve_migrated_legacy: true,
        };
        let mysql = QueryCapture::default();
        // New-format id: no SQL-level JSON filter.
        let new_id = 69_956_427_469_753_u64;
        get_active_non_deleted_task(&mysql, policy, new_id as i64)
            .await
            .unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].route, Route::Task(new_id));
        assert!(queries[0].sql.contains("is_active IN (1, 2)"));
        assert!(!queries[0].sql.contains("JSON_EXTRACT"));

        let mysql = QueryCapture::default();
        // Legacy id (the recorded task 64267 shape): the base-table render
        // carries the SQL-level DELETE filter.
        get_active_non_deleted_task(&mysql, policy, 42)
            .await
            .unwrap();
        let queries = mysql.queries();
        assert!(queries[0].sql.contains("JSON_EXTRACT"));
        assert!(!is_task_member(&mysql, policy, 42, 7).await.unwrap());
        get_workspace_by_ref(&mysql, 7, "workspace", "default")
            .await
            .unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 3);
        assert_eq!(queries[0].route, Route::Task(42));
        assert!(!queries[1].sql.contains("JSON_EXTRACT"));
        assert_eq!(queries[2].route, Route::User(7));
        assert_eq!(queries[2].args, 3);
    }
}
