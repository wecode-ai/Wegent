// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Project-session transcript authorization for
//! `POST /api/runtime-work/transcript`.
//!
//! Mirrors `app.services.project_chat.session_access.resolve_project_transcript`
//! (the source revision recorded for this route):
//!
//! 1. `project_chat_service._require_scope` — the point permission statement
//!    (`require_cloud_project_role`) with its permission-source reads, the
//!    `db.get(CloudProject)` entity read, the Issue lookup and
//!    `can_view_item`;
//! 2. `_session_executions` — the addressed runtime executions for the project
//!    Issue and device, post-filtered through the owner's device aliases;
//! 3. `active_task_binding_query` — the active `execution` binding rows for the
//!    same addressed session;
//! 4. `_member_session_owners` — the collaboration member-activity fallback
//!    when neither executions nor bindings own the session.
//!
//! Every string value is bound as a statement parameter; the recorded
//! SQLAlchemy exchange inlined literals, which the replay matcher correlates
//! with the prepared statement's parameters.

use std::collections::HashSet;

use brz_json::adapters::python_truthy;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde_json::Value;

use crate::cloud_projects::members::{ProjectEntityRow, project_entity};
use crate::cloud_projects::{LOOP_ITEMS_COLUMNS, project_access_details, role_for_priority};
use crate::device_identity::{owned_device_identity_ids, resolve_owned_device_alias};
use crate::http_compat::FastApiError;
use crate::loop_tasks::loop_repository::{EXECUTION_COLUMNS, has_permission};

/// `PROJECT_CHAT_MESSAGES` unset sentinel filter for `loop_datetime_is_unset`.
const UNSET_DATETIME_FILTER: &str =
    "({column} IS NULL OR {column} IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))";

/// One addressed project session (`ProjectSessionScope`).
pub(crate) struct ProjectScope<'a> {
    pub project_id: &'a str,
    pub issue_id: &'a str,
}

/// The resolved transcript address: the owning executor user and the exact
/// device/task identity the runtime resolves its persisted session by.
pub(crate) struct ResolvedTranscript {
    pub owner_user_id: i64,
    pub device_id: String,
    pub task_id: String,
}

/// `resolve_project_transcript`.
pub(crate) async fn resolve_project_transcript<M: Mysql>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
    local_task_id: &str,
    scope: &ProjectScope<'_>,
) -> Result<ResolvedTranscript, FastApiError> {
    let project_id = require_project_scope(mysql, user_id, scope).await?;
    // `_session_executions` — the addressed executions for the project Issue.
    let candidate_task_ids = candidate_task_ids(local_task_id);
    let mut executions = session_executions(
        mysql,
        project_id,
        scope.issue_id,
        device_id,
        &candidate_task_ids,
    )
    .await
    .map_err(mysql_failure)?;
    if !executions.is_empty() {
        let owners: HashSet<i64> = executions
            .iter()
            .map(|execution| i64::from(execution.executor_owner_user_id))
            .collect();
        let mut aliases: std::collections::HashMap<i64, Vec<String>> =
            std::collections::HashMap::new();
        for owner in owners {
            aliases.insert(
                owner,
                owned_device_identity_ids(mysql, owner, device_id)
                    .await
                    .map_err(mysql_failure)?,
            );
        }
        executions.retain(|execution| {
            let owner = i64::from(execution.executor_owner_user_id);
            execution.matches_local_task(local_task_id)
                && execution.runtime_device_id.as_deref().is_some_and(|value| {
                    aliases
                        .get(&owner)
                        .is_some_and(|ids| ids.iter().any(|alias| alias == value))
                })
        });
    }

    // `active_task_binding_query(...).all()` — the active `execution` binding
    // rows for the addressed session. The recorded exchange filters the
    // submitted device address directly.
    let bindings =
        active_task_bindings(mysql, project_id, scope.issue_id, device_id, local_task_id)
            .await
            .map_err(mysql_failure)?;

    let mut owners: HashSet<i64> = executions
        .iter()
        .map(|execution| i64::from(execution.executor_owner_user_id))
        .collect();
    owners.extend(
        bindings
            .iter()
            .map(|binding| i64::from(binding.task_user_id)),
    );
    if owners.is_empty() {
        owners = member_session_owners(mysql, project_id, scope.issue_id, device_id, local_task_id)
            .await?;
    }
    if owners.is_empty() || owners.contains(&0) {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::NOT_FOUND,
            "Project session binding not found",
        ));
    }
    if owners.len() != 1 {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::CONFLICT,
            "Project session has conflicting execution owners",
        ));
    }
    let mut task_ids: HashSet<String> = executions
        .iter()
        .map(ExecutionRow::conversation_task_id)
        .collect();
    if task_ids.len() > 1 {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::CONFLICT,
            "Project session has conflicting Runtime task identities",
        ));
    }
    let owner_user_id = *owners.iter().next().expect("one owner");
    Ok(ResolvedTranscript {
        owner_user_id,
        device_id: device_id.to_string(),
        task_id: task_ids
            .drain()
            .next()
            .unwrap_or_else(|| local_task_id.to_string()),
    })
}

/// `_require_scope`: permission check, entity read, Issue lookup and item
/// visibility. Returns the parsed numeric project id.
async fn require_project_scope<M: Mysql>(
    mysql: &M,
    user_id: i64,
    scope: &ProjectScope<'_>,
) -> Result<i64, FastApiError> {
    let project_id = scope
        .project_id
        .parse::<i64>()
        .map_err(|_| FastApiError::unhandled())?;
    let numeric_user_id = i32::try_from(user_id).unwrap_or(i32::MAX);
    // `require_cloud_project_role`: the access statement plus its
    // permission-source reads.
    let Some(access) = project_access_details(mysql, project_id, numeric_user_id)
        .await
        .map_err(mysql_failure)?
    else {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::NOT_FOUND,
            "Cloud project not found",
        ));
    };
    // `db.get(CloudProject, str(cloud_project_id))` — a request-owned read
    // whose entity supplies the projection used by the access helpers.
    let entity = project_entity(mysql, project_id)
        .await
        .map_err(mysql_failure)?;
    let Some(role) = role_for_priority(access.priority) else {
        return Err(FastApiError::unhandled());
    };
    if !has_permission(role, "Viewer") {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::FORBIDDEN,
            "Insufficient permission",
        ));
    }
    let task = task_item(mysql, scope.issue_id, project_id)
        .await
        .map_err(mysql_failure)?;
    let Some(task) = task else {
        // `project.task_provider` is read from the entity returned by the
        // permission check; a missing entity raises in the source.
        let Some(entity) = entity.as_ref() else {
            return Err(FastApiError::unhandled());
        };
        let provider = entity
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.0.value.as_ref())
            .and_then(|metadata| metadata.task_provider.as_deref())
            .unwrap_or("local");
        if matches!(provider, "github" | "gitlab") {
            // External-provider issues are resolved by the external provider
            // in the source; the caller's role is the only local authority.
            return Ok(project_id);
        }
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::NOT_FOUND,
            "Project task not found",
        ));
    };
    if !can_view_item(mysql, role, entity.as_ref(), &task, user_id)
        .await
        .map_err(mysql_failure)?
    {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::NOT_FOUND,
            "Project task not found",
        ));
    }
    if !has_permission(role, "Viewer") {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::FORBIDDEN,
            "Insufficient permission",
        ));
    }
    Ok(project_id)
}

/// `can_view_item`: `Maintainer` and above see every Issue; lower roles need an
/// `open` Issue or a related-item grant.
async fn can_view_item<M: Mysql>(
    mysql: &M,
    role: &str,
    entity: Option<&ProjectEntityRow>,
    task: &TaskAccessRow,
    user_id: i64,
) -> MysqlResult<bool> {
    if has_permission(role, "Maintainer") {
        return Ok(true);
    }
    let default_security = entity
        .and_then(|entity| entity.metadata.as_ref())
        .and_then(|metadata| metadata.0.value.as_ref())
        .and_then(|metadata| metadata.default_issue_security.as_deref())
        .filter(|value| matches!(*value, "open" | "related"))
        .unwrap_or("open");
    let security = task
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.0.get("security_level"))
        .and_then(Value::as_str)
        .filter(|value| matches!(*value, "open" | "related"))
        .unwrap_or(default_security);
    if security == "open" {
        return Ok(true);
    }
    is_related_item(mysql, &task.id, user_id).await
}

/// `is_related_item`: the related-item grant predicate over `loop_items`.
async fn is_related_item<M: Mysql>(mysql: &M, item_id: &str, user_id: i64) -> MysqlResult<bool> {
    let numeric_user_id = i32::try_from(user_id).unwrap_or(i32::MAX);
    let sql = format!(
        "SELECT loop_items.id FROM loop_items WHERE loop_items.id = ?{}",
        related_item_filter_sql(numeric_user_id)
    );
    let row: Option<String> = mysql.fetch_optional(sql, (item_id,)).await?;
    Ok(row.is_some())
}

/// `related_item_filter(user_id)` (the OR groups of
/// `app.services.loop_items.access`), rendered as a trailing `AND (...)`.
fn related_item_filter_sql(user_id: i32) -> String {
    let unlinked = UNSET_DATETIME_FILTER.replace("{column}", "loop_items.unlinked_at");
    let deleted = UNSET_DATETIME_FILTER.replace("{column}", "loop_items.deleted_at");
    format!(
        " AND (loop_items.created_by_user_id = {user_id} \
         OR loop_items.assignee_user_id = {user_id} \
         OR loop_items.id IN (SELECT loop_items.loop_item_id \n\
         FROM loop_items \n\
         WHERE loop_items.task_user_id = {user_id} AND {unlinked} \
         AND loop_items.resource_type IN ('execution')) \
         OR loop_items.id IN (SELECT loop_items.loop_item_id \n\
         FROM loop_items \n\
         WHERE loop_items.user_id = {user_id} \
         AND loop_items.resource_type IN ('collaborator')) \
         OR loop_items.assignee_agent_id IN (SELECT loop_items.id \n\
         FROM loop_items \n\
         WHERE loop_items.created_by_user_id = {user_id} \
         AND loop_items.status = 'active' AND {deleted} \
         AND loop_items.resource_type IN ('chat_agent')))"
    )
}

/// `db.query(LoopItem).filter(...).first()` for the addressed Issue.
async fn task_item<M: Mysql>(
    mysql: &M,
    issue_id: &str,
    project_id: i64,
) -> MysqlResult<Option<TaskAccessRow>> {
    let deleted = UNSET_DATETIME_FILTER.replace("{column}", "loop_items.deleted_at");
    let sql = format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.id = ? AND loop_items.cloud_project_id = ? \
         AND loop_items.resource_type = 'task' AND {deleted} \
         AND loop_items.resource_type IN ('task') \n LIMIT 1"
    );
    mysql
        .fetch_optional(sql, (issue_id, project_id.to_string()))
        .await
}

/// `_session_executions`: the addressed executions for one project Issue.
async fn session_executions<M: Mysql>(
    mysql: &M,
    project_id: i64,
    issue_id: &str,
    device_id: &str,
    task_ids: &[String],
) -> MysqlResult<Vec<ExecutionRow>> {
    if task_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; task_ids.len()].join(", ");
    let sql = format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
         WHERE loop_item_executions.cloud_project_id = ? \
         AND loop_item_executions.loop_item_id = ? \
         AND loop_item_executions.runtime_device_id = ? \
         AND loop_item_executions.runtime_task_id IN ({placeholders})"
    );
    let mut values = vec![
        project_id.to_string(),
        issue_id.to_string(),
        device_id.to_string(),
    ];
    values.extend(task_ids.iter().cloned());
    mysql.fetch_all(sql, values).await
}

/// `active_task_binding_query(...).all()` for the addressed session.
async fn active_task_bindings<M: Mysql>(
    mysql: &M,
    project_id: i64,
    issue_id: &str,
    device_id: &str,
    task_id: &str,
) -> MysqlResult<Vec<BindingRow>> {
    let unlinked = UNSET_DATETIME_FILTER.replace("{column}", "loop_items.unlinked_at");
    let deleted = UNSET_DATETIME_FILTER.replace("{column}", "loop_items.deleted_at");
    let sql = format!(
        "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
         WHERE loop_items.cloud_project_id = ? AND loop_items.loop_item_id = ? \
         AND loop_items.device_id = ? AND loop_items.task_id = ? AND {unlinked} \
         AND {deleted} AND loop_items.resource_type IN ('execution')"
    );
    mysql
        .fetch_all(
            sql,
            (
                project_id.to_string(),
                issue_id.to_string(),
                device_id.to_string(),
                task_id.to_string(),
            ),
        )
        .await
}

/// `_member_session_owners`: authorize one collaboration member activity to a
/// still-current dispatch and its recorded assignment.
async fn member_session_owners<M: Mysql>(
    mysql: &M,
    project_id: i64,
    issue_id: &str,
    device_id: &str,
    local_task_id: &str,
) -> Result<HashSet<i64>, FastApiError> {
    let deleted = UNSET_DATETIME_FILTER.replace("{column}", "project_chat_messages.deleted_at");
    let sql = format!(
        "SELECT project_chat_messages.id AS project_chat_messages_id, \
         project_chat_messages.project_id AS project_chat_messages_project_id, \
         project_chat_messages.task_id AS project_chat_messages_task_id, \
         project_chat_messages.agent_id AS project_chat_messages_agent_id, \
         project_chat_messages.runtime_device_id AS project_chat_messages_runtime_device_id, \
         project_chat_messages.runtime_task_id AS project_chat_messages_runtime_task_id, \
         project_chat_messages.metadata AS project_chat_messages_metadata \
         \nFROM project_chat_messages \n\
         WHERE project_chat_messages.project_id = ? \
         AND project_chat_messages.task_id = ? \
         AND project_chat_messages.runtime_task_id = ? AND {deleted}"
    );
    let activities: Vec<ActivityRow> = mysql
        .fetch_all(
            sql,
            (
                project_id.to_string(),
                issue_id.to_string(),
                local_task_id.to_string(),
            ),
        )
        .await
        .map_err(mysql_failure)?;
    let mut owners = HashSet::new();
    for activity in activities {
        let metadata = activity.metadata_value();
        if metadata.get("activity_type").and_then(Value::as_str) != Some("member_execution") {
            continue;
        }
        let dispatch =
            collaboration_dispatch_for_activity(mysql, project_id, issue_id, &metadata).await?;
        // `collaboration_dispatch_for_activity`: a missing dispatch or one
        // without a runtime device is a 409, not a skipped activity.
        let Some(dispatch) = dispatch else {
            return Err(no_execution_binding());
        };
        if dispatch
            .runtime_device_id
            .as_deref()
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return Err(no_execution_binding());
        }
        // `db.get(LoopItem, request.task_id)`.
        let item: Option<String> = mysql
            .fetch_optional(
                "SELECT loop_items.id FROM loop_items WHERE loop_items.id = ?",
                (issue_id,),
            )
            .await
            .map_err(mysql_failure)?;
        if item.is_none() {
            return Err(FastApiError::detail(
                brz_http_server::StatusCode::NOT_FOUND,
                "Issue not found",
            ));
        }
        if !same_owned_device(mysql, &dispatch, &activity, device_id).await? {
            continue;
        }
        collaboration_member_assignment(
            mysql, project_id, issue_id, &dispatch, &activity, &metadata,
        )
        .await?;
        owners.insert(i64::from(dispatch.executor_owner_user_id));
    }
    Ok(owners)
}

impl ActivityRow {
    /// `ProjectChatMessage.metadata_json` restricted to object values.
    fn metadata_value(&self) -> Value {
        self.metadata
            .as_ref()
            .map(|metadata| metadata.0.clone())
            .unwrap_or(Value::Object(serde_json::Map::new()))
    }
}

/// `collaboration_dispatch_for_activity(..., require_current_assignment=False)`:
/// the durable group dispatch addressed by the activity metadata.
async fn collaboration_dispatch_for_activity<M: Mysql>(
    mysql: &M,
    project_id: i64,
    issue_id: &str,
    metadata: &Value,
) -> Result<Option<ExecutionRow>, FastApiError> {
    let executions = loop_item_executions(mysql, project_id, issue_id)
        .await
        .map_err(mysql_failure)?;
    let execution_id = metadata.get("execution_id").and_then(Value::as_i64);
    let dispatch_id = metadata
        .get("dispatch_id")
        .filter(|value| python_truthy(value))
        .and_then(Value::as_str);
    Ok(executions.into_iter().find(|execution| {
        execution.executor_type() == "collaboration_group_dispatch"
            && (Some(execution.id) == execution_id
                || dispatch_id.is_some_and(|dispatch_id| {
                    execution
                        .runtime_origin_context()
                        .get("dispatch_id")
                        .and_then(Value::as_str)
                        == Some(dispatch_id)
                }))
    }))
}

/// `db.query(LoopItemExecution).filter_by(cloud_project_id, loop_item_id).all()`.
async fn loop_item_executions<M: Mysql>(
    mysql: &M,
    project_id: i64,
    issue_id: &str,
) -> MysqlResult<Vec<ExecutionRow>> {
    let sql = format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
         WHERE loop_item_executions.cloud_project_id = ? \
         AND loop_item_executions.loop_item_id = ?"
    );
    mysql
        .fetch_all(sql, (project_id.to_string(), issue_id.to_string()))
        .await
}

/// `same_owned_device`: compare the recorded activity address with the
/// request's device through the dispatch owner's device aliases.
async fn same_owned_device<M: Mysql>(
    mysql: &M,
    dispatch: &ExecutionRow,
    activity: &ActivityRow,
    device_id: &str,
) -> Result<bool, FastApiError> {
    let Some(left) = activity.runtime_device_id.as_deref() else {
        return Ok(false);
    };
    if left == device_id {
        return Ok(true);
    }
    let aliases =
        owned_device_identity_ids(mysql, i64::from(dispatch.executor_owner_user_id), left)
            .await
            .map_err(mysql_failure)?;
    Ok(aliases.iter().any(|alias| alias == device_id))
}

/// `collaboration_member_assignment(..., require_current_assignment=False)`:
/// verify the recorded member assignment, native task and runner aliases.
async fn collaboration_member_assignment<M: Mysql>(
    mysql: &M,
    project_id: i64,
    issue_id: &str,
    dispatch: &ExecutionRow,
    activity: &ActivityRow,
    metadata: &Value,
) -> Result<(), FastApiError> {
    let Some(dispatch_id) = metadata_string(metadata, "dispatch_id") else {
        return Err(incomplete_member_identity());
    };
    let Some(round_id) = metadata_string(metadata, "coordination_round_id") else {
        return Err(incomplete_member_identity());
    };
    let Some(assignment_id) = metadata_string(metadata, "assignment_id") else {
        return Err(incomplete_member_identity());
    };
    if activity.runtime_device_id.is_none() || activity.runtime_task_id.is_none() {
        return Err(incomplete_member_identity());
    }
    let Some(assignment) = manager_assignment(
        mysql,
        project_id,
        issue_id,
        &dispatch_id,
        &round_id,
        &assignment_id,
    )
    .await?
    else {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::CONFLICT,
            "The collaboration member assignment is unavailable",
        ));
    };
    let expected_task = format!(
        "{}-member-{round_id}-{assignment_id}",
        dispatch.runtime_task_id.as_deref().unwrap_or("None")
    );
    if activity.task_id() != Some(expected_task.as_str())
        || assignment.get("agent_id").and_then(Value::as_str) != activity.agent_id.as_deref()
        || assignment.get("runtime_task_id").and_then(Value::as_str) != Some(expected_task.as_str())
    {
        return Err(member_assignment_mismatch());
    }
    let Some(manager_device_id) = dispatch.runtime_device_id.as_deref() else {
        return Err(no_execution_binding());
    };
    let manager_device = resolve_owned_device_alias(
        mysql,
        i64::from(dispatch.executor_owner_user_id),
        manager_device_id,
    )
    .await
    .map_err(mysql_failure)?;
    let Some(member_device_id) = activity.runtime_device_id.as_deref() else {
        return Err(incomplete_member_identity());
    };
    let member_device = resolve_owned_device_alias(
        mysql,
        i64::from(dispatch.executor_owner_user_id),
        member_device_id,
    )
    .await
    .map_err(mysql_failure)?;
    match (manager_device, member_device) {
        (Some(manager), Some(member)) if manager.id == member.id => Ok(()),
        _ => Err(member_assignment_mismatch()),
    }
}

/// `_manager_assignment`: the recorded manager card carrying one assignment.
async fn manager_assignment<M: Mysql>(
    mysql: &M,
    project_id: i64,
    issue_id: &str,
    dispatch_id: &str,
    round_id: &str,
    assignment_id: &str,
) -> Result<Option<Value>, FastApiError> {
    let sql = "SELECT project_chat_messages.id AS project_chat_messages_id, \
         project_chat_messages.metadata AS project_chat_messages_metadata \
         \nFROM project_chat_messages \n\
         WHERE project_chat_messages.project_id = ? \
         AND project_chat_messages.task_id = ? \
         ORDER BY project_chat_messages.created_at DESC";
    let messages: Vec<ManagerMessageRow> = mysql
        .fetch_all(sql, (project_id.to_string(), issue_id.to_string()))
        .await
        .map_err(mysql_failure)?;
    for message in messages {
        let metadata = message
            .metadata
            .as_ref()
            .map(|metadata| metadata.0.clone())
            .unwrap_or(Value::Object(serde_json::Map::new()));
        if metadata.get("activity_type").and_then(Value::as_str) != Some("manager_assignment")
            || metadata.get("dispatch_id").and_then(Value::as_str) != Some(dispatch_id)
            || metadata
                .get("coordination_round_id")
                .and_then(Value::as_str)
                != Some(round_id)
        {
            continue;
        }
        let Some(assignments) = metadata.get("dispatch_assignments") else {
            break;
        };
        let Some(assignments) = assignments.as_array() else {
            break;
        };
        let found = assignments.iter().find(|assignment| {
            assignment.get("assignment_id").and_then(Value::as_str) == Some(assignment_id)
                && assignment.get("assignee_type").and_then(Value::as_str) == Some("agent")
        });
        return Ok(found.cloned());
    }
    Ok(None)
}

fn metadata_string(metadata: &Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn incomplete_member_identity() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::CONFLICT,
        "The collaboration member session identity is incomplete",
    )
}

fn no_execution_binding() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::CONFLICT,
        "The collaboration activity has no execution binding",
    )
}

fn member_assignment_mismatch() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::CONFLICT,
        "The collaboration member session does not match its assignment",
    )
}

/// `candidate_task_ids = {local_task_id}`, plus the un-suffixed manager task id.
fn candidate_task_ids(local_task_id: &str) -> Vec<String> {
    let mut ids = vec![local_task_id.to_string()];
    if let Some(base) = local_task_id.strip_suffix("-manager-initial") {
        ids.push(base.to_string());
    }
    ids
}

fn mysql_failure(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "runtime transcript dependency failure");
    FastApiError::unhandled()
}

/// The `loop_items` columns of the addressed Issue consumed by the access
/// checks.
#[derive(Debug, FromMysqlRow)]
struct TaskAccessRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<Value>>,
}

/// One `execution` binding row (`LoopItemTaskBinding`) consumed by the session
/// owner resolution.
#[derive(Debug, FromMysqlRow)]
struct BindingRow {
    #[mysql(rename = "loop_items_task_user_id")]
    task_user_id: i32,
}

/// One `project_chat_messages` activity row.
#[derive(Debug, FromMysqlRow)]
struct ActivityRow {
    #[mysql(rename = "project_chat_messages_agent_id")]
    agent_id: Option<String>,
    #[mysql(rename = "project_chat_messages_runtime_device_id")]
    runtime_device_id: Option<String>,
    #[mysql(rename = "project_chat_messages_runtime_task_id")]
    runtime_task_id: Option<String>,
    #[mysql(rename = "project_chat_messages_metadata")]
    metadata: Option<Json<Value>>,
}

impl ActivityRow {
    /// The activity's bound native conversation task id.
    fn task_id(&self) -> Option<&str> {
        self.runtime_task_id
            .as_deref()
            .filter(|value| !value.is_empty())
    }
}

/// The manager-card columns consumed by `_manager_assignment`.
#[derive(Debug, FromMysqlRow)]
struct ManagerMessageRow {
    #[mysql(rename = "project_chat_messages_metadata")]
    metadata: Option<Json<Value>>,
}

/// One `loop_item_executions` row (`LoopItemExecution`) consumed by the
/// session identity resolution.
#[derive(Debug, FromMysqlRow)]
struct ExecutionRow {
    #[mysql(rename = "loop_item_executions_id")]
    id: i64,
    #[mysql(rename = "loop_item_executions_executor_owner_user_id")]
    executor_owner_user_id: i32,
    #[mysql(rename = "loop_item_executions_agent_id")]
    agent_id: String,
    #[mysql(rename = "loop_item_executions_team_id")]
    team_id: i32,
    #[mysql(rename = "loop_item_executions_runtime_device_id")]
    runtime_device_id: Option<String>,
    #[mysql(rename = "loop_item_executions_runtime_task_id")]
    runtime_task_id: Option<String>,
    #[mysql(rename = "loop_item_executions_execution_payload")]
    execution_payload: String,
}

impl ExecutionRow {
    /// `LoopItemExecution.execution_intent`: the decoded intent envelope.
    fn execution_intent(&self) -> Value {
        if self.execution_payload.is_empty() {
            return Value::Object(serde_json::Map::new());
        }
        serde_json::from_str::<Value>(&self.execution_payload)
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()))
    }

    /// `LoopItemExecution.runtime_selection`.
    fn runtime_selection(&self) -> Value {
        let intent = self.execution_intent();
        match intent.get("runtime_selection") {
            Some(Value::Object(_)) => intent["runtime_selection"].clone(),
            _ => intent,
        }
    }

    /// `LoopItemExecution.executor_type`.
    fn executor_type(&self) -> &'static str {
        let selection = self.runtime_selection();
        if let Some(configured) = selection.get("executor_kind").and_then(Value::as_str)
            && matches!(configured, "generic_robot" | "collaboration_group_dispatch")
        {
            return if configured == "collaboration_group_dispatch" {
                "collaboration_group_dispatch"
            } else {
                "generic_robot"
            };
        }
        if !self.agent_id.is_empty() {
            return "project_robot";
        }
        if self.team_id != 0 {
            "wegent_team"
        } else {
            "generic_robot"
        }
    }

    /// `LoopItemExecution.runtime_origin_context`.
    fn runtime_origin_context(&self) -> Value {
        self.execution_intent()
            .get("origin_context")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| Value::Object(serde_json::Map::new()))
    }

    /// `execution_conversation_task_id`.
    fn conversation_task_id(&self) -> String {
        let base = match self.runtime_task_id.as_deref() {
            Some(value) if !value.is_empty() => value.to_string(),
            _ => self.execution_runtime_task_id(),
        };
        if self.executor_type() == "collaboration_group_dispatch" {
            return format!("{base}-manager-initial");
        }
        base
    }

    /// `execution_runtime_task_id`.
    fn execution_runtime_task_id(&self) -> String {
        if let Some(continue_id) = self
            .runtime_origin_context()
            .get("comment_continue_task_id")
            .filter(|value| python_truthy(value))
        {
            return crate::device_commands::python_str(continue_id);
        }
        format!("codex-queue-{}", self.id)
    }

    /// `request.local_task_id in {runtime_task_id, execution_conversation_task_id}`.
    fn matches_local_task(&self, local_task_id: &str) -> bool {
        self.runtime_task_id.as_deref() == Some(local_task_id)
            || self.conversation_task_id() == local_task_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn execution(runtime_task_id: Option<&str>, payload: &str) -> ExecutionRow {
        ExecutionRow {
            id: 41,
            executor_owner_user_id: 86,
            agent_id: String::new(),
            team_id: 0,
            runtime_device_id: Some("device-1".to_string()),
            runtime_task_id: runtime_task_id.map(str::to_string),
            execution_payload: payload.to_string(),
        }
    }

    #[test]
    fn candidate_task_ids_include_the_manager_base_identity() {
        assert_eq!(
            candidate_task_ids("runtime-1"),
            vec!["runtime-1".to_string()]
        );
        assert_eq!(
            candidate_task_ids("runtime-1-manager-initial"),
            vec![
                "runtime-1-manager-initial".to_string(),
                "runtime-1".to_string()
            ]
        );
    }

    #[test]
    fn conversation_task_id_prefers_the_recorded_runtime_task() {
        let row = execution(Some("runtime-9"), "");
        assert_eq!(row.conversation_task_id(), "runtime-9");
        assert!(row.matches_local_task("runtime-9"));
        assert!(!row.matches_local_task("runtime-8"));
    }

    #[test]
    fn conversation_task_id_falls_back_to_the_queue_identity() {
        let row = execution(
            None,
            "{\"origin_context\": {\"comment_continue_task_id\": \"task-7\"}}",
        );
        assert_eq!(row.conversation_task_id(), "task-7");
        let row = execution(None, "");
        assert_eq!(row.conversation_task_id(), "codex-queue-41");
    }

    #[test]
    fn group_dispatch_sessions_expose_the_manager_identity() {
        let payload =
            "{\"runtime_selection\": {\"executor_kind\": \"collaboration_group_dispatch\"}}";
        let row = execution(Some("runtime-9"), payload);
        assert_eq!(row.executor_type(), "collaboration_group_dispatch");
        assert_eq!(row.conversation_task_id(), "runtime-9-manager-initial");
    }

    #[test]
    fn executor_type_matches_the_source_selection_rules() {
        assert_eq!(execution(None, "").executor_type(), "generic_robot");
        let mut row = execution(None, "");
        row.agent_id = "agent-1".to_string();
        assert_eq!(row.executor_type(), "project_robot");
        let mut row = execution(None, "");
        row.team_id = 3;
        assert_eq!(row.executor_type(), "wegent_team");
        let row = execution(
            None,
            "{\"runtime_selection\": {\"executor_kind\": \"generic_robot\"}, \"agent_id\": \"a\"}",
        );
        assert_eq!(row.executor_type(), "generic_robot");
    }

    #[test]
    fn related_item_filter_renders_the_source_subqueries() {
        let sql = related_item_filter_sql(86);
        assert!(sql.contains("loop_items.created_by_user_id = 86"));
        assert!(sql.contains("loop_items.assignee_user_id = 86"));
        assert!(sql.contains("loop_items.resource_type IN ('execution')"));
        assert!(sql.contains("loop_items.resource_type IN ('collaborator')"));
        assert!(sql.contains("loop_items.resource_type IN ('chat_agent')"));
        assert!(sql.contains("'1970-01-01 00:00:01'"));
    }
}
