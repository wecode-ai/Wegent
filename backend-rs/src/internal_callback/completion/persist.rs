// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `persist_completed_result` and the task-status update it triggers
//! (`app/services/chat/storage/db.py`, `app/services/chat/trigger/lifecycle.py`).
use brz_mysql::{FromMysqlCol, Json, Mysql, MysqlRow};
use brz_redis::Redis;
use chrono::NaiveDateTime;
use serde_json::{Map, Value, json};

use super::Completion;
use super::sql;
use super::task_column;
use crate::internal_callback::py_json::python_dumps;
use crate::internal_callback::session;
use crate::task_store::subtask_column_index;

/// `TaskStatus`'s field order (`app/schemas/kind.py`), used to render the task
/// CRD's `status` object the way `model_dump(mode="json")` does.
const TASK_STATUS_ORDER: [&str; 12] = [
    "state",
    "message",
    "status",
    "progress",
    "result",
    "errorMessage",
    "createdAt",
    "updatedAt",
    "completedAt",
    "subTasks",
    "app",
    "archive",
];

/// The `Task` CRD's top-level field order (`app/schemas/kind.py`).
const TASK_CRD_ORDER: [&str; 5] = ["apiVersion", "kind", "metadata", "spec", "status"];

/// `TaskMetadata`'s field order.
const TASK_METADATA_ORDER: [&str; 4] = ["name", "namespace", "displayName", "labels"];

/// `TaskSpec`'s field order.
const TASK_SPEC_ORDER: [&str; 12] = [
    "title",
    "prompt",
    "teamRef",
    "workspaceRef",
    "is_group_chat",
    "knowledgeBaseRefs",
    "knowledgeBaseScopes",
    "externalKnowledgeRefs",
    "device_id",
    "execution",
    "fork",
    "currentStage",
];

/// The `status.result` model's field order (`SubtaskResult`).
const TASK_RESULT_ORDER: [&str; 18] = [
    "usage",
    "value",
    "blocks",
    "sources",
    "silent_exit",
    "stop_reason",
    "file_changes",
    "loaded_skills",
    "messages_chain",
    "context_metrics",
    "executor_session",
    "reasoning_content",
    "retrieval_summary",
    "silent_exit_reason",
    "context_compactions",
    "deferred_user_input",
    "standalone_chat_workspace_path",
    "deferred_user_input_tool_use_id",
];

fn subtask_column<T: FromMysqlCol>(row: &MysqlRow, column: &str) -> Option<T> {
    let index = subtask_column_index(column)?;
    row.get_at::<Option<T>>(index).ok().flatten()
}

/// Re-render one task CRD document the way `Task.model_dump(mode="json")` does.
///
/// The source validates the stored document into its pydantic models and dumps
/// them again, so the written key order is the model's field order rather than
/// whatever order the row happened to hold.
fn render_task_crd(payload: Map<String, Value>) -> Map<String, Value> {
    let mut out = reorder(&payload, &TASK_CRD_ORDER);
    if let Some(Value::Object(metadata)) = out.get("metadata").cloned() {
        out.insert(
            "metadata".into(),
            Value::Object(reorder(&metadata, &TASK_METADATA_ORDER)),
        );
    }
    if let Some(Value::Object(spec)) = out.get("spec").cloned() {
        out.insert(
            "spec".into(),
            Value::Object(reorder(&spec, &TASK_SPEC_ORDER)),
        );
    }
    if let Some(Value::Object(status)) = out.get("status").cloned() {
        let mut status = reorder(&status, &TASK_STATUS_ORDER);
        if let Some(Value::Object(result)) = status.get("result").cloned() {
            status.insert(
                "result".into(),
                Value::Object(reorder(&result, &TASK_RESULT_ORDER)),
            );
        }
        out.insert("status".into(), Value::Object(status));
    }
    out
}

/// Re-render an object with `order` first, then any remaining keys in their
/// original order.
fn reorder(object: &Map<String, Value>, order: &[&str]) -> Map<String, Value> {
    let mut out = Map::new();
    for key in order {
        if let Some(value) = object.get(*key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    for (key, value) in object {
        if !out.contains_key(key) {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// `persist_completed_result`: persist the terminal subtask state, update the
/// task's status, then clean the streaming state up.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn persist_completed_result<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    subtask_id: i64,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
    executor_name: Option<&str>,
    executor_namespace: Option<&str>,
) {
    let normalized_status = status.to_uppercase();
    if let Some(owner_task_id) = update_subtask_status(
        ctx,
        subtask_id,
        &normalized_status,
        result,
        error,
        executor_name,
        executor_namespace,
    )
    .await
    {
        update_task_status(ctx, owner_task_id, subtask_id).await;
    }
    if normalized_status == "COMPLETED" {
        persist_standalone_workspace_path(ctx, task_id, result).await;
    }
    if let Err(failure) =
        session::cleanup_streaming_state(ctx.redis, subtask_id, Some(task_id)).await
    {
        tracing::warn!(%failure, "callback streaming cleanup failed");
    }
}

/// `_update_subtask_sync`: rewrite the subtask's terminal fields. Returns the
/// subtask's task id so the caller can update the task, or `None` when the row
/// is missing.
#[allow(clippy::too_many_arguments)]
async fn update_subtask_status<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    subtask_id: i64,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
    executor_name: Option<&str>,
    executor_namespace: Option<&str>,
) -> Option<i64> {
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(subtask_id as u64));
    let row: MysqlRow = mysql
        .fetch_optional(sql::subtask_by_id(ctx.tables), (subtask_id,))
        .await
        .ok()
        .flatten()?;
    // `SubtaskStore.get_by_id` (`sqlalchemy_subtask_store.py:321-330`)
    // eager-loads `Subtask.contexts` with `subqueryload`, so the source issues
    // this read even though the update never consumes it.
    let _contexts: Vec<MysqlRow> = mysql
        .fetch_all(sql::contexts_by_subtask(), (subtask_id,))
        .await
        .unwrap_or_default();
    let owner_task_id = subtask_column::<i64>(&row, "task_id").unwrap_or(0);
    let existing_executor_name = subtask_column::<String>(&row, "executor_name");
    // The ORM projection labels every column `{table}_{column}`, so the stored
    // result is read by its position in that projection.
    let existing_result: Option<Value> =
        subtask_column::<Json<Value>>(&row, "result").map(|json| json.0);

    let mut stored = result
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    if let (Value::Object(stored_object), Some(Value::Object(existing))) =
        (&mut stored, existing_result.as_ref())
        && existing
            .get("silent_exit")
            .is_some_and(|value| !value.is_null())
    {
        stored_object.insert("silent_exit".into(), existing["silent_exit"].clone());
        if let Some(reason) = existing.get("silent_exit_reason") {
            stored_object.insert("silent_exit_reason".into(), reason.clone());
        }
    }
    let stored_result = sanitize_result_for_storage(&stored);
    let stored_json = python_dumps(&stored_result);
    // `_before_flush` reads the committed error message and result for the
    // task-run metrics, so capture the message before `error` is flattened.
    let metrics_message = crate::task_run_metrics::failure_message(error, Some(&stored_result));

    let now = local_datetime();
    let with_executor = executor_name.is_some_and(|name| !name.is_empty())
        && existing_executor_name.is_none_or(|name| name.is_empty());
    let with_error = error.is_some();
    let namespace = executor_namespace.unwrap_or_default();
    let name = executor_name.unwrap_or_default();
    let error = error.unwrap_or_default();
    let sql = sql::update_subtask_terminal(ctx.tables, with_error, with_executor);

    let outcome = match (with_executor, with_error) {
        (true, true) => {
            mysql
                .execute(
                    sql,
                    (
                        namespace,
                        name,
                        status,
                        stored_json,
                        error,
                        now.clone(),
                        now,
                        subtask_id,
                    ),
                )
                .await
        }
        (true, false) => {
            mysql
                .execute(
                    sql,
                    (
                        namespace,
                        name,
                        status,
                        stored_json,
                        now.clone(),
                        now,
                        subtask_id,
                    ),
                )
                .await
        }
        (false, true) => {
            mysql
                .execute(
                    sql,
                    (status, stored_json, error, now.clone(), now, subtask_id),
                )
                .await
        }
        (false, false) => {
            mysql
                .execute(sql, (status, stored_json, now.clone(), now, subtask_id))
                .await
        }
    };
    if let Err(failure) = outcome {
        tracing::warn!(%failure, "callback subtask update failed");
        return None;
    }
    // `_db_session` (`app/services/chat/storage/db.py:65-77`) commits when the
    // subtask update's session block exits, before the task status update runs.
    if let Err(failure) = mysql.execute("COMMIT", ()).await {
        tracing::warn!(%failure, "callback subtask update commit failed");
        return None;
    }
    publish_task_run_metrics(ctx, &row, subtask_id, status, metrics_message).await;
    Some(owner_task_id)
}

/// `TaskRunMetricHooks._after_commit` (`app/services/task_run_metric_hooks.py:157-175`):
/// a committed assistant-subtask mutation publishes the task-run metrics. The
/// hook logs and swallows a store failure, so a Redis error leaves the caller's
/// committed result intact.
async fn publish_task_run_metrics<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    row: &MysqlRow,
    subtask_id: i64,
    status: &str,
    message: Option<String>,
) {
    let Some(event) = subtask_metric_event(
        subtask_column::<String>(row, "role").as_deref(),
        subtask_column::<NaiveDateTime>(row, "created_at"),
        subtask_id,
        status,
        message,
    ) else {
        return;
    };
    if let Err(failure) =
        crate::task_run_metrics::record_events(ctx.redis, std::slice::from_ref(&event)).await
    {
        tracing::warn!(%failure, "task run metrics publish failed");
    }
}

/// The `TaskRunMetricEvent` one committed subtask status change produces.
///
/// `_before_flush` tracks assistant subtasks only and this flow never changes a
/// subtask's role, so the committed role is the tracked role. The update path
/// modifies an existing subtask, so it never records the id in the run totals,
/// while a status change always syncs the failure aggregates.
fn subtask_metric_event(
    role: Option<&str>,
    created_at: Option<NaiveDateTime>,
    subtask_id: i64,
    status: &str,
    message: Option<String>,
) -> Option<crate::task_run_metrics::SubtaskMetricEvent> {
    if role != Some("ASSISTANT") {
        return None;
    }
    Some(crate::task_run_metrics::SubtaskMetricEvent {
        subtask_id,
        created_at: created_at?,
        failed: status == "FAILED",
        state_changed_at: super::handlers::now_local(),
        message,
        record_total: false,
        sync_failure: true,
    })
}

/// `_update_task_status_sync`: re-derive the task's status from its assistant
/// subtasks and rewrite the task CRD.
async fn update_task_status<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    changed_subtask_id: i64,
) {
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    let task: Option<MysqlRow> = mysql
        .fetch_optional(sql::active_task_statement(ctx.tables.tasks), (task_id,))
        .await
        .ok()
        .flatten();
    let Some(task) = task else {
        return;
    };
    let owner_user_id = task_column::<i64>(&task, "user_id").unwrap_or(0);
    let task_json: Option<Value> = task_column::<Json<Value>>(&task, "json").map(|json| json.0);

    // `list_assistant_by_task`'s owner guard, then the ordered listing.
    let _owner: Vec<MysqlRow> = mysql
        .fetch_all(
            sql::owner_matches_task_id_statement(ctx.tables.tasks),
            (task_id, owner_user_id),
        )
        .await
        .unwrap_or_default();
    let subtasks: Vec<MysqlRow> = mysql
        .fetch_all(sql::assistant_subtasks(ctx.tables), (task_id,))
        .await
        .unwrap_or_default();
    let Some(last) = subtasks.last() else {
        return;
    };
    let last_status = subtask_column::<String>(last, "status").unwrap_or_default();
    // `list_assistant_by_task` labels its columns too, so the last subtask's
    // result — the payload `_apply_status_update` writes into the task CRD's
    // `status.result` — is decoded positionally.
    let mut last_result: Option<Value> =
        subtask_column::<Json<Value>>(last, "result").map(|json| json.0);

    let found = subtasks
        .iter()
        .any(|row| subtask_column::<i64>(row, "id") == Some(changed_subtask_id));
    let changed: Option<MysqlRow> = if !found && last_result.is_none() {
        mysql
            .fetch_optional(sql::subtask_by_id(ctx.tables), (changed_subtask_id,))
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    if let Some(row) = changed {
        last_result = subtask_column::<Json<Value>>(&row, "result").map(|json| json.0);
    }

    let Some(Value::Object(mut payload)) = task_json else {
        return;
    };
    let Some(Value::Object(status_object)) = payload.get("status").cloned() else {
        return;
    };
    let Some((new_status, progress)) =
        collaboration_status(ctx, &mysql, task_id, &payload, &last_status).await
    else {
        return;
    };

    let now = local_isoformat();
    let mut updated = status_object;
    updated.insert("status".into(), Value::String(new_status.clone()));
    if let Some(result) = last_result {
        updated.insert("result".into(), result);
    }
    if let Some(progress) = progress {
        updated.insert("progress".into(), json!(progress));
    }
    if matches!(
        new_status.as_str(),
        "COMPLETED" | "CANCELLED" | "PENDING_CONFIRMATION"
    ) {
        updated.insert("completedAt".into(), Value::String(now.clone()));
    }
    if last_status == "FAILED" {
        updated.insert(
            "errorMessage".into(),
            subtask_column::<String>(last, "error_message").map_or(Value::Null, Value::String),
        );
    }
    updated.insert("updatedAt".into(), Value::String(now.clone()));
    payload.insert("status".into(), Value::Object(updated));

    let json_text = python_dumps(&Value::Object(render_task_crd(payload)));
    let row_updated_at = local_datetime();
    let sql = sql::update_task_json_statement(ctx.tables.tasks);
    if let Err(failure) = mysql
        .execute(sql, (json_text, row_updated_at, task_id))
        .await
    {
        tracing::warn!(%failure, "callback task update failed");
        return;
    }
    // `_db_session` (`app/services/chat/storage/db.py:65-77`) commits when the
    // task status update's session block exits.
    if let Err(failure) = mysql.execute("COMMIT", ()).await {
        tracing::warn!(%failure, "callback task update commit failed");
    }
}

/// `CollaborationStrategyFactory.get_strategy_for_task` plus
/// `get_task_status_on_subtask_complete`.
async fn collaboration_status<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    mysql: &M,
    task_id: i64,
    payload: &Map<String, Value>,
    subtask_status: &str,
) -> Option<(String, Option<i64>)> {
    // `get_regular_active_task`: the exact task read the factory issues.
    let routed = mysql.route(crate::task_routing::ByTaskId(task_id as u64));
    let _regular: Option<MysqlRow> = routed
        .fetch_optional(
            sql::regular_active_task_statement(ctx.tables.tasks),
            (task_id,),
        )
        .await
        .ok()
        .flatten();

    // `_get_team_from_task_ref`: the Team Kind behind the task CRD's teamRef.
    let collaboration_model = match payload
        .get("spec")
        .and_then(|spec| spec.get("teamRef"))
        .and_then(Value::as_object)
    {
        Some(team_ref) => {
            let name = team_ref
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let namespace = team_ref
                .get("namespace")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match team_ref.get("user_id").and_then(Value::as_i64) {
                Some(owner) => {
                    let team: Option<MysqlRow> = routed
                        .fetch_optional(sql::team_by_owner(), (owner, namespace, name))
                        .await
                        .ok()
                        .flatten();
                    team.and_then(|row| row.get::<Json<Value>>("kinds_json").ok().flatten())
                        .and_then(|json| {
                            json.0
                                .get("spec")
                                .and_then(|spec| spec.get("collaborationModel"))
                                .and_then(Value::as_str)
                                .map(str::to_string)
                        })
                }
                None => None,
            }
        }
        None => None,
    };

    // `PipelineCollaborationStrategy`: a stage that requires confirmation holds
    // the task at `PENDING_CONFIRMATION` instead of completing it.
    if collaboration_model.as_deref() == Some("pipeline")
        && subtask_status == "COMPLETED"
        && stage_requires_confirmation(payload)
    {
        return Some(("PENDING_CONFIRMATION".to_string(), Some(100)));
    }
    // `DefaultCollaborationStrategy.get_task_status_on_subtask_complete`: map
    // the subtask status directly, defaulting to the subtask status itself.
    Some(match subtask_status {
        "COMPLETED" => ("COMPLETED".to_string(), Some(100)),
        "CANCELLED" => ("CANCELLED".to_string(), Some(100)),
        "FAILED" => ("FAILED".to_string(), None),
        "RUNNING" => ("RUNNING".to_string(), None),
        other => (other.to_string(), None),
    })
}

/// `PipelineCollaborationStrategy`: whether the task's current stage demands
/// user confirmation before advancing.
fn stage_requires_confirmation(payload: &Map<String, Value>) -> bool {
    payload
        .get("spec")
        .and_then(|spec| spec.get("currentStage"))
        .and_then(|stage| stage.get("requireConfirmation"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// `_persist_standalone_workspace_path`: store a local executor's standalone
/// chat workspace path on the task CRD.
async fn persist_standalone_workspace_path<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    task_id: i64,
    result: Option<&Value>,
) {
    let Some(path) = result
        .and_then(|value| value.get("standalone_chat_workspace_path"))
        .filter(|value| !value.is_null())
        .cloned()
    else {
        return;
    };
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64));
    let task: Option<MysqlRow> = mysql
        .fetch_optional(sql::active_task_statement(ctx.tables.tasks), (task_id,))
        .await
        .ok()
        .flatten();
    let Some(task) = task else {
        return;
    };
    let Some(Value::Object(mut payload)) =
        task_column::<Json<Value>>(&task, "json").map(|json| json.0)
    else {
        return;
    };
    match payload
        .entry("spec")
        .or_insert_with(|| Value::Object(Map::new()))
    {
        Value::Object(spec) => {
            spec.insert("standaloneChatWorkspacePath".into(), path);
        }
        _ => return,
    }
    let json_text = python_dumps(&Value::Object(render_task_crd(payload)));
    let now = local_datetime();
    let sql = sql::update_task_json_statement(ctx.tables.tasks);
    let _ = mysql.execute(sql, (json_text, now, task_id)).await;
}

/// `datetime.now()` in the `DATETIME(6)` form the source binds to its columns.
fn local_datetime() -> String {
    chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string()
}

/// `datetime.now().isoformat()`: microsecond precision, no offset.
fn local_isoformat() -> String {
    chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%dT%H:%M:%S%.6f")
        .to_string()
}

/// `sanitize_result_for_storage`: drop tool input/output from stored thinking
/// steps, leaving every other field untouched.
fn sanitize_result_for_storage(result: &Value) -> Value {
    let Some(object) = result.as_object() else {
        return result.clone();
    };
    let Some(Value::Array(steps)) = object.get("thinking") else {
        return result.clone();
    };
    let mut copy = object.clone();
    copy.insert(
        "thinking".into(),
        Value::Array(
            steps
                .iter()
                .map(|step| match step {
                    Value::Object(step) => {
                        let mut step = step.clone();
                        step.shift_remove("input");
                        step.shift_remove("output");
                        Value::Object(step)
                    }
                    other => other.clone(),
                })
                .collect(),
        ),
    );
    Value::Object(copy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `_before_flush` tracks assistant subtasks: a user subtask, an untracked
    /// row, and a missing creation stamp publish nothing.
    #[test]
    fn only_assistant_subtask_changes_produce_a_metric_event() {
        let created = chrono::NaiveDate::from_ymd_opt(2026, 10, 16)
            .expect("valid date")
            .and_hms_opt(10, 56, 4)
            .expect("valid time");
        assert!(subtask_metric_event(Some("USER"), Some(created), 7, "COMPLETED", None).is_none());
        assert!(subtask_metric_event(Some("ASSISTANT"), None, 7, "COMPLETED", None).is_none());
        let event = subtask_metric_event(
            Some("ASSISTANT"),
            Some(created),
            7,
            "FAILED",
            Some("boom".to_string()),
        )
        .expect("assistant subtask recorded");
        assert_eq!(event.subtask_id, 7);
        assert_eq!(event.created_at, created);
        assert!(event.failed);
        assert!(event.sync_failure);
        assert!(!event.record_total);
        assert_eq!(event.message.as_deref(), Some("boom"));
    }

    #[test]
    fn task_crd_is_rendered_in_the_model_field_order() {
        let stored = json!({
            "status": {"progress": 100, "state": "Available", "status": "COMPLETED"},
            "apiVersion": "agent.wecode.io/v1",
            "spec": {"fork": null, "title": "t", "prompt": "p"},
            "kind": "Task",
            "metadata": {"labels": {"source": "chat_shell"}, "name": "task-1", "namespace": "default"},
        });
        let rendered = render_task_crd(stored.as_object().unwrap().clone());
        assert_eq!(
            python_dumps(&Value::Object(rendered)),
            "{\"apiVersion\": \"agent.wecode.io/v1\", \"kind\": \"Task\", \
             \"metadata\": {\"name\": \"task-1\", \"namespace\": \"default\", \"labels\": {\"source\": \"chat_shell\"}}, \
             \"spec\": {\"title\": \"t\", \"prompt\": \"p\", \"fork\": null}, \
             \"status\": {\"state\": \"Available\", \"status\": \"COMPLETED\", \"progress\": 100}}"
        );
    }
}
