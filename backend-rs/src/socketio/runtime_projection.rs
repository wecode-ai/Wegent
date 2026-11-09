// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Durable projection behind `/local-executor` `runtime:event`.
//!
//! Source: `loop_item_execution_service.handle_runtime_event` and
//! `ProjectChatService.project_runtime_event` as called by
//! `device_namespace._project_chat_runtime_event_sync`. Every value is a bound
//! SQL parameter; only placeholder counts are structural.

use brz_mysql::{MysqlResult, MysqlRow, MysqlTransaction};
use chrono::Utc;
use serde_json::{Map, Value, json};

use crate::background_jobs::project::completion::Message;
use crate::device_identity::{
    DeviceKindRow, KINDS_DEVICE_QUERY, record_id_from_route, unambiguous_device_identity_ids,
};
use crate::loop_tasks::loop_repository::EXECUTION_COLUMNS;
use crate::sql_support::StatementArg;
use crate::state::AppState;

use super::execution_aggregate::{
    CAPACITY_STATUSES, ERROR_LIMIT, ExecutionRow, TERMINAL_RUN_STATUSES, accept_observation,
    bind_activity_runtime_turn, finish_linked_activity, set_automation_run_status,
    transition_terminal,
};

/// `loop_datetime_is_unset` for `project_chat_messages.deleted_at`.
const UNSET_DELETED_AT: &str = "(project_chat_messages.deleted_at IS NULL OR project_chat_messages.deleted_at IN \
     ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))";
/// `PROJECT_CHAT_COMPLETED_EVENTS`.
const COMPLETED_EVENTS: [&str; 9] = [
    "response.completed",
    "chat:done",
    "done",
    "task.done",
    "turn.done",
    "turn.completed",
    "runtime.task.completed",
    "runtime_task.completed",
    "runtime.tasks.completed",
];
/// `PROJECT_CHAT_FAILED_EVENTS`.
const FAILED_EVENTS: [&str; 10] = [
    "response.failed",
    "response.incomplete",
    "error",
    "chat:error",
    "failed",
    "task.failed",
    "turn.failed",
    "runtime.task.failed",
    "runtime_task.failed",
    "runtime.tasks.failed",
];
/// `PROJECT_CHAT_CANCELLED_EVENTS`.
const CANCELLED_EVENTS: [&str; 5] = [
    "cancelled",
    "canceled",
    "runtime.task.cancelled",
    "runtime_task.cancelled",
    "runtime.tasks.cancelled",
];
/// `PROJECT_CHAT_COMPLETED_STATUSES`.
const COMPLETED_STATUSES: [&str; 5] = ["completed", "done", "succeeded", "success", "idle"];
/// `PROJECT_CHAT_FAILED_STATUSES`.
const FAILED_STATUSES: [&str; 3] = ["failed", "failure", "error"];
/// `PROJECT_CHAT_CANCELLED_STATUSES`.
const CANCELLED_STATUSES: [&str; 2] = ["cancelled", "canceled"];

/// `json.dumps(envelope)` for the live channel and `json.dumps([view])` for the
/// adapter message both keep Python's separators and key order.
fn projected_view(message: &Message) -> Value {
    message.view()
}

pub(super) fn event_data(payload: &Value) -> Option<&Map<String, Value>> {
    payload.get("data").and_then(Value::as_object)
}

/// `ProjectChatService._project_chat_terminal_status`.
fn terminal_status(event_name: &str, payload: &Value) -> Option<&'static str> {
    if CANCELLED_EVENTS.contains(&event_name) {
        return Some("cancelled");
    }
    let data = event_data(payload);
    let status_value = data
        .and_then(|data| {
            data.get("status")
                .or_else(|| data.get("taskStatus"))
                .or_else(|| data.get("task_status"))
        })
        .or_else(|| payload.get("status"))
        .and_then(Value::as_str);
    let normalized =
        status_value.map(|value| value.trim().replace(['_', '-'], "").to_ascii_lowercase());
    if let Some(normalized) = normalized.as_deref()
        && CANCELLED_STATUSES.contains(&normalized)
    {
        return Some("cancelled");
    }
    if COMPLETED_EVENTS.contains(&event_name) {
        return Some("completed");
    }
    if FAILED_EVENTS.contains(&event_name) {
        return Some("failed");
    }
    if let Some(normalized) = normalized.as_deref() {
        if COMPLETED_STATUSES.contains(&normalized) {
            return Some("completed");
        }
        if FAILED_STATUSES.contains(&normalized) {
            return Some("failed");
        }
    }
    None
}

/// `LoopItemExecutionService._error_text`.
fn error_text(value: &Value) -> String {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    text.chars().take(ERROR_LIMIT).collect()
}

/// `_project_chat_final_text`.
fn final_text(payload: &Value) -> Option<String> {
    let data = event_data(payload);
    for source in [data, payload.get("data").and_then(Value::as_object)]
        .into_iter()
        .flatten()
    {
        for key in ["value", "text", "content", "output_text"] {
            if let Some(value) = source.get(key).and_then(Value::as_str)
                && !value.is_empty()
            {
                return Some(value.to_owned());
            }
        }
        if let Some(result) = source.get("result").and_then(Value::as_object) {
            for key in ["value", "text", "content", "output_text"] {
                if let Some(value) = result.get(key).and_then(Value::as_str)
                    && !value.is_empty()
                {
                    return Some(value.to_owned());
                }
            }
        }
    }
    None
}

/// `payload.get("eventSeq", payload.get("event_seq"))` coerced like `int()`.
fn event_seq(payload: &Value) -> Option<i64> {
    let raw = payload
        .get("eventSeq")
        .or_else(|| payload.get("event_seq"))?;
    if raw.is_boolean() {
        return None;
    }
    let parsed = raw
        .as_i64()
        .or_else(|| raw.as_f64().map(|value| value as i64))
        .or_else(|| raw.as_str().and_then(|value| value.trim().parse().ok()))?;
    (parsed > 0).then_some(parsed)
}

/// `_project_chat_runtime_event_sync`'s runtime identity.
pub(super) struct RuntimeIdentity<'a> {
    pub(super) event_name: &'a str,
    pub(super) runtime_task_id: String,
    pub(super) payload: &'a Value,
}

impl<'a> RuntimeIdentity<'a> {
    pub(super) fn parse(envelope: &'a Value) -> Option<Self> {
        let event_name = envelope.get("event").and_then(Value::as_str)?;
        let payload = envelope.get("payload")?;
        let object = payload.as_object()?;
        let runtime_task_id = ["taskId", "task_id", "localTaskId", "local_task_id"]
            .into_iter()
            .filter_map(|key| object.get(key).and_then(Value::as_str))
            .find(|value| !value.is_empty())?;
        Some(Self {
            event_name,
            runtime_task_id: runtime_task_id.to_owned(),
            payload,
        })
    }
}

/// `loop_item_execution_service.execution_for_runtime` statement. Device ids
/// and the task id are bound parameters; only the placeholder count is
/// structural.
fn execution_statement(device_count: usize, owner: bool) -> String {
    let placeholders = vec!["?"; device_count].join(", ");
    let owner = if owner {
        " AND loop_item_executions.executor_owner_user_id = ?"
    } else {
        ""
    };
    format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
         WHERE loop_item_executions.runtime_device_id IN ({placeholders}) \
         AND loop_item_executions.runtime_task_id = ? \
         AND loop_item_executions.status IN ({CAPACITY_STATUSES}){owner} \
         ORDER BY loop_item_executions.id DESC \n LIMIT 1"
    )
}

fn execution_args(device_ids: &[String], task_id: &str, owner: Option<i64>) -> Vec<StatementArg> {
    let mut args = device_ids
        .iter()
        .cloned()
        .map(StatementArg::Str)
        .collect::<Vec<_>>();
    args.push(StatementArg::Str(task_id.to_owned()));
    if let Some(owner) = owner {
        args.push(StatementArg::Int(owner));
    }
    args
}

/// `ProjectChatService._streaming_activity_for_runtime`'s candidate lookup.
fn streaming_candidate_statement(device_count: usize) -> String {
    let placeholders = vec!["?"; device_count].join(", ");
    format!(
        "SELECT project_chat_messages.id AS project_chat_messages_id \n\
         FROM project_chat_messages \n\
         WHERE project_chat_messages.runtime_device_id IN ({placeholders}) \
         AND project_chat_messages.runtime_task_id = ? \
         AND project_chat_messages.sender_type = 'agent' \
         AND project_chat_messages.status IN ('pending', 'streaming') \
         AND {UNSET_DELETED_AT} \
         ORDER BY project_chat_messages.id DESC \n LIMIT 1"
    )
}

/// `_streaming_activity_for_runtime`'s locked-row read.
const STREAMING_ROW_QUERY: &str = "SELECT * FROM project_chat_messages \
     WHERE project_chat_messages.id = ? AND project_chat_messages.status IN ('pending', 'streaming') \
     AND (project_chat_messages.deleted_at IS NULL OR project_chat_messages.deleted_at IN \
     ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) FOR UPDATE";

/// `runtime_device_identity_ids(..., owner_user_id=<owner>)`.
async fn owned_identity_ids<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Vec<String>> {
    let devices: Vec<DeviceKindRow> = transaction
        .fetch_all(KINDS_DEVICE_QUERY, (user_id,))
        .await?;
    Ok(unambiguous_device_identity_ids(&devices, device_id))
}

async fn execution_for_runtime<T: MysqlTransaction>(
    transaction: &mut T,
    device_ids: &[String],
    task_id: &str,
    owner: Option<i64>,
) -> MysqlResult<Option<ExecutionRow>> {
    transaction
        .fetch_optional(
            execution_statement(device_ids.len(), owner.is_some()),
            execution_args(device_ids, task_id, owner),
        )
        .await
}

/// `handle_runtime_event`: the execution aggregate's acceptance rules and
/// transitions. Returns the elected row when the event was accepted.
async fn handle_runtime_event<T: MysqlTransaction>(
    transaction: &mut T,
    row: ExecutionRow,
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<Option<ExecutionRow>> {
    let terminal = terminal_status(identity.event_name, identity.payload);
    let seq = event_seq(identity.payload);
    // The socket projection calls `handle_runtime_event` with
    // `allow_unsequenced_terminal=False`, so any event without an event
    // sequence is rejected, terminal or not.
    if seq.is_none() {
        tracing::warn!(
            execution = row.id,
            task = identity.runtime_task_id,
            event = identity.event_name,
            "Rejected Runtime event without sequence"
        );
        return Ok(None);
    }
    if let Some(seq) = seq
        && seq <= row.last_event_seq.unwrap_or(0)
    {
        return Ok(None);
    }
    if row.is_terminal() {
        return Ok(None);
    }
    let now = Utc::now().naive_utc();
    let data = event_data(identity.payload);
    let (status, error, note, reason, observed_state) = match terminal {
        Some("completed") => (
            "completed",
            String::new(),
            final_text(identity.payload),
            "runtime_succeeded",
            "succeeded",
        ),
        Some("failed") => {
            let value = identity
                .payload
                .get("error")
                .or_else(|| data.and_then(|data| data.get("error")))
                .cloned()
                .unwrap_or_else(|| json!("Runtime task ended with failed"));
            (
                "failed",
                error_text(&value),
                None,
                "runtime_failed",
                "failed",
            )
        }
        Some(_) => {
            let value = identity
                .payload
                .get("error")
                .or_else(|| data.and_then(|data| data.get("error")));
            let error = value.map(error_text).unwrap_or_default();
            (
                "cancelled",
                error.clone(),
                (!error.is_empty()).then_some(error),
                "runtime_cancelled",
                "cancelled",
            )
        }
        None => {
            let updated = accept_observation(transaction, &row, seq.unwrap_or(0), now).await?;
            if updated != 1 {
                return Ok(None);
            }
            set_automation_run_status(transaction, row.automation_run_id.as_deref(), "running")
                .await?;
            let turn_id = identity
                .payload
                .get("subtaskId")
                .or_else(|| identity.payload.get("subtask_id"))
                .and_then(Value::as_str);
            bind_activity_runtime_turn(transaction, &row, turn_id).await?;
            return Ok(Some(ExecutionRow {
                status: Some(if row.status_or_empty() == "cancel_requested" {
                    "cancel_requested".to_owned()
                } else {
                    "running".to_owned()
                }),
                version: row.version.map(|version| version + 1),
                last_event_seq: seq,
                started_at: Some(row.started_at.unwrap_or(now)),
                ..row
            }));
        }
    };
    let updated = transition_terminal(
        transaction,
        &row,
        status,
        &error,
        note.as_deref(),
        Some(row.version.unwrap_or(0)),
        seq,
        reason,
        observed_state,
        now,
    )
    .await?;
    if updated != 1 {
        return Ok(None);
    }
    let run_status = match status {
        "completed" => "succeeded",
        "failed" => "failed",
        _ => "cancelled",
    };
    set_automation_run_status(transaction, row.automation_run_id.as_deref(), run_status).await?;
    finish_linked_activity(transaction, &row, status, note.as_deref().or(Some(&error))).await?;
    // `notify_execution_lifecycle` is supplementary and best-effort in the
    // source; the inbox notification domain has no Rust port yet.
    tracing::warn!(
        execution = row.id,
        status,
        "Execution lifecycle notification is not ported"
    );
    // `_publish_execution_item_change` broadcasts the loop item only when its
    // version moved during the projection; the loop-item change publisher has
    // no Rust port yet.
    tracing::warn!(
        execution = row.id,
        loop_item = row.loop_item_id.as_deref(),
        reason = "runtime_execution_status",
        "Loop item change publication is not ported"
    );
    Ok(Some(ExecutionRow {
        status: Some(status.to_owned()),
        version: row.version.map(|version| version + 1),
        last_event_seq: seq,
        ..row
    }))
}

/// The message view `_forward_runtime_event` emits, plus its mode.
pub(super) struct Projected {
    pub(super) message: Value,
    pub(super) delta: bool,
}

/// `project_runtime_event`: the streaming chat projection.
async fn project_runtime_event<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<Option<Projected>> {
    // `project_runtime_event` expands aliases only for an App record route;
    // every other transport identity queries the submitted id alone.
    let device_ids = if record_id_from_route(device_id).is_some() {
        owned_identity_ids(transaction, user_id, device_id).await?
    } else {
        vec![device_id.to_owned()]
    };
    let candidate: Option<MysqlRow> = transaction
        .fetch_optional(streaming_candidate_statement(device_ids.len()), {
            let mut args = device_ids
                .iter()
                .cloned()
                .map(StatementArg::Str)
                .collect::<Vec<_>>();
            args.push(StatementArg::Str(identity.runtime_task_id.clone()));
            args
        })
        .await?;
    let Some(candidate) = candidate else {
        // No open activity: `project_runtime_event` falls back to
        // `_open_activity_from_execution`, which re-reads the active execution
        // by the submitted device identity with no owner filter. The read
        // itself is part of the source's observable dependency graph.
        let submitted = [device_id.to_owned()];
        let unowned =
            execution_for_runtime(transaction, &submitted, &identity.runtime_task_id, None).await?;
        if unowned.is_some() {
            // `open_execution_activity` (activity creation, profile compile,
            // push) has no Rust port yet. The recorded traffic never reaches
            // it because no active execution exists for the task.
            tracing::warn!(
                task = identity.runtime_task_id,
                "Opening a missing activity from the execution fallback is not ported"
            );
        }
        return Ok(None);
    };
    let candidate_id: i64 = candidate.get_required("project_chat_messages_id")?;
    let message: Option<Message> = transaction
        .fetch_optional(STREAMING_ROW_QUERY, (candidate_id,))
        .await?;
    let Some(mut message) = message else {
        return Ok(None);
    };
    if let Some(run_id) = message
        .metadata
        .0
        .get("automation_run_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        let run: Option<MysqlRow> = transaction
            .fetch_optional(
                "SELECT status FROM loop_items WHERE id=? AND resource_type='automation_run'",
                (run_id,),
            )
            .await?;
        let run_status = run
            .as_ref()
            .and_then(|row| row.get::<String>("status").ok().flatten())
            .unwrap_or_default();
        if TERMINAL_RUN_STATUSES.contains(&run_status.as_str()) {
            return Ok(None);
        }
    }
    let data = event_data(identity.payload);
    let has_subagent = identity.event_name.contains("subagent")
        || data.is_some_and(|data| {
            ["subagent_name", "subagentName", "executor_name"]
                .into_iter()
                .any(|key| data.contains_key(key))
        });
    if has_subagent {
        // Subagent activity creation belongs to the project-chat activity
        // domain; the guard is kept so the parent projection never misapplies
        // a child event to the parent message.
        tracing::warn!(
            event = identity.event_name,
            "Subagent Runtime event projection is not ported"
        );
        return Ok(None);
    }
    if identity.event_name == "response.completed" {
        // `ProjectChatService.project_runtime_event`'s completed-activity
        // restore (`completed_activity_for_turn`, `can_restore_reconciled_completion`,
        // `reconciled_activity_for_runtime`) repairs a turn whose activity was
        // closed by a reconciliation; it is not ported yet and must not be
        // approximated here.
        tracing::warn!(
            task = identity.runtime_task_id,
            "response.completed activity restoration is not ported"
        );
    }
    let terminal = terminal_status(identity.event_name, identity.payload);
    let now = Utc::now().naive_utc();
    let mut metadata = message.metadata.0.as_object().cloned().unwrap_or_default();
    let (content, status, message_type) = match identity.event_name {
        "response.output_text.delta" | "response.refusal.delta" => {
            let Some(delta) = data
                .and_then(|data| data.get("delta"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            else {
                return Ok(None);
            };
            let content = format!("{}{delta}", message.content);
            metadata.insert("run_status".into(), json!("running"));
            message.content = content.clone();
            message.metadata = brz_mysql::Json(Value::Object(metadata));
            message.updated_at = now;
            transaction
                .execute(
                    "UPDATE project_chat_messages SET content=?, metadata=?, updated_at=? WHERE id=?",
                    (
                        message.content.as_str(),
                        brz_mysql::Json(message.metadata.0.clone()),
                        now,
                        message.id,
                    ),
                )
                .await?;
            // The delta emission carries only this chunk, like the source's
            // `model_copy(update={"content": delta, ...})`.
            let mut view = projected_view(&message);
            view["content"] = json!(delta);
            view["metadata"] = json!({"contentMode": "delta"});
            return Ok(Some(Projected {
                message: view,
                delta: true,
            }));
        }
        "response.output_text.done" => {
            let snapshot = data
                .and_then(|data| {
                    data.get("text")
                        .or_else(|| data.get("value"))
                        .or_else(|| data.get("output_text"))
                })
                .and_then(Value::as_str);
            match snapshot {
                Some(text) => (
                    text.to_owned(),
                    message.status.clone(),
                    message.message_type.clone(),
                ),
                None => return Ok(None),
            }
        }
        "response.created" | "response.in_progress" => {
            metadata.insert("run_status".into(), json!("running"));
            (
                message.content.clone(),
                "streaming".to_owned(),
                message.message_type.clone(),
            )
        }
        _ => match terminal {
            Some("completed") => (
                final_text(identity.payload).unwrap_or_else(|| message.content.clone()),
                "completed".to_owned(),
                "text".to_owned(),
            ),
            Some("failed") => (
                identity
                    .payload
                    .get("error")
                    .or_else(|| data.and_then(|data| data.get("error")))
                    .map(error_text)
                    .unwrap_or_default(),
                "failed".to_owned(),
                message.message_type.clone(),
            ),
            Some(_) => (
                identity
                    .payload
                    .get("error")
                    .or_else(|| data.and_then(|data| data.get("error")))
                    .map(error_text)
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "AI execution was cancelled.".to_owned()),
                "cancelled".to_owned(),
                "text".to_owned(),
            ),
            None => return Ok(None),
        },
    };
    if let Some(run_status) = match terminal {
        Some("completed") => Some("succeeded"),
        Some("failed") => Some("failed"),
        Some(_) => Some("cancelled"),
        None => None,
    } {
        metadata.insert("run_status".into(), json!(run_status));
    }
    if status == "failed" {
        metadata.insert("error".into(), json!(content));
    }
    message.content = content;
    message.status = status;
    message.message_type = message_type;
    message.metadata = brz_mysql::Json(Value::Object(metadata));
    message.updated_at = now;
    transaction
        .execute(
            "UPDATE project_chat_messages SET content=?, status=?, message_type=?, metadata=?, updated_at=? WHERE id=?",
            (
                message.content.as_str(),
                message.status.as_str(),
                message.message_type.as_str(),
                brz_mysql::Json(message.metadata.0.clone()),
                now,
                message.id,
            ),
        )
        .await?;
    Ok(Some(Projected {
        message: projected_view(&message),
        delta: false,
    }))
}

/// `_project_chat_runtime_event_sync`: the execution projection then the chat
/// projection, both inside the source's single request transaction.
pub(super) async fn project(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<Option<Projected>> {
    let device_id = device_id.to_owned();
    state
        .mysql
        .with_transaction(async |transaction| {
            project_in_transaction(transaction, user_id, &device_id, identity).await
        })
        .await
}

/// The statement sequence `_project_chat_runtime_event_sync` issues inside its
/// request transaction.
async fn project_in_transaction<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<Option<Projected>> {
    let task_id = identity.runtime_task_id.clone();
    let event_name = identity.event_name.to_owned();
    // `_project_chat_runtime_event_sync` resolves the execution itself before
    // handing the event to `handle_runtime_event`.
    let ids = owned_identity_ids(transaction, user_id, device_id).await?;
    let execution = execution_for_runtime(transaction, &ids, &task_id, Some(user_id)).await?;
    // `handle_runtime_event` re-resolves the device and re-reads the same
    // execution; both reads are observable Source dependencies.
    let handle_ids = owned_identity_ids(transaction, user_id, device_id).await?;
    let handle_row =
        execution_for_runtime(transaction, &handle_ids, &task_id, Some(user_id)).await?;
    let matched = match handle_row {
        Some(row) => handle_runtime_event(transaction, row, identity).await?,
        None => None,
    };
    if execution.is_some() && matched.is_none() {
        // Rejected by execution truth. `can_restore_reconciled_completion`
        // only reopens an already elected terminal completion, which the
        // projected activity already owns.
        tracing::info!(
            user_id,
            device_id,
            task_id,
            event = event_name,
            "Runtime event projection rejected by execution truth"
        );
        return Ok(None);
    }
    project_runtime_event(transaction, user_id, device_id, identity).await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlError, MysqlExecution};

    use super::*;

    #[test]
    fn statements_bind_every_value_instead_of_inlining_literals() {
        let statement = execution_statement(2, true);
        assert!(statement.contains("runtime_device_id IN (?, ?)"));
        assert!(statement.contains("runtime_task_id = ?"));
        assert!(statement.contains("executor_owner_user_id = ?"));
        assert!(!statement.contains("'d30dc060"));
        let streaming = streaming_candidate_statement(1);
        assert!(streaming.contains("runtime_device_id IN (?)"));
        assert!(streaming.contains("runtime_task_id = ?"));
    }

    #[test]
    fn quoted_task_ids_cannot_reach_the_sql_text() {
        let statement = execution_statement(1, false);
        assert!(!statement.contains("runtime_task_id = '"));
        let args = execution_args(&["a'b".to_owned()], "c'd", None);
        assert_eq!(args.len(), 2);
    }

    #[test]
    fn terminal_events_normalize_like_the_source() {
        let completed = json!({"data": {"status": "completed"}});
        assert_eq!(
            terminal_status("response.created", &completed),
            Some("completed")
        );
        // `cancel_requested` normalizes to `cancelrequested`, which is not a
        // cancelled status, so the event family decides.
        let cancel_requested = json!({"data": {"status": "cancel_requested"}});
        assert_eq!(
            terminal_status("response.incomplete", &cancel_requested),
            Some("failed")
        );
        let cancelled = json!({"data": {"status": "cancelled"}});
        assert_eq!(
            terminal_status("response.incomplete", &cancelled),
            Some("cancelled")
        );
        assert_eq!(
            terminal_status("response.incomplete", &json!({})),
            Some("failed")
        );
        assert_eq!(
            terminal_status("response.completed", &json!({})),
            Some("completed")
        );
        assert_eq!(
            terminal_status("runtime.task.cancelled", &json!({})),
            Some("cancelled")
        );
        assert_eq!(terminal_status("response.block.created", &json!({})), None);
    }

    #[test]
    fn the_event_sequence_uses_python_int_coercion() {
        assert_eq!(event_seq(&json!({"eventSeq": 3})), Some(3));
        assert_eq!(event_seq(&json!({"eventSeq": "4"})), Some(4));
        assert_eq!(event_seq(&json!({"eventSeq": 0})), None);
        assert_eq!(event_seq(&json!({"eventSeq": true})), None);
        assert_eq!(event_seq(&json!({})), None);
    }

    #[test]
    fn the_final_text_prefers_the_runtime_value() {
        let payload = json!({"data": {"value": "answer", "text": "other"}});
        assert_eq!(final_text(&payload).as_deref(), Some("answer"));
        let payload = json!({"data": {"response": {"output": []}}});
        assert_eq!(final_text(&payload), None);
    }

    /// A transaction that records every read's collapsed SQL and argument count.
    #[derive(Clone, Default)]
    struct RecordingTransaction {
        queries: Arc<Mutex<Vec<(String, usize)>>>,
    }

    impl RecordingTransaction {
        fn queries(&self) -> Vec<(String, usize)> {
            self.queries.lock().unwrap().clone()
        }

        fn record<S: AsRef<str>, A: MysqlArgs>(&mut self, sql: S, args: &A) {
            let collapsed = sql
                .as_ref()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            self.queries.lock().unwrap().push((collapsed, args.len()));
        }
    }

    impl MysqlTransaction for RecordingTransaction {
        async fn execute<S, A>(&mut self, _: S, _: A) -> MysqlResult<MysqlExecution>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
        {
            Ok(MysqlExecution {
                rows_affected: 0,
                last_insert_id: 0,
            })
        }

        async fn fetch_optional<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Option<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            self.record(sql, &args);
            Ok(None)
        }

        async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Err(MysqlError::RowNotFound)
        }

        fn fetch<'a, S, A, T>(
            &'a mut self,
            _: S,
            _: A,
        ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'a
        where
            S: AsRef<str> + Send + 'a,
            A: MysqlArgs + Send + 'a,
            T: FromMysqlRow + Send + 'a,
        {
            futures_util::stream::empty()
        }

        async fn fetch_all<S, A, T>(&mut self, sql: S, args: A) -> MysqlResult<Vec<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            self.record(sql, &args);
            Ok(Vec::new())
        }
    }

    fn runtime_identity(payload: Value) -> RuntimeIdentity<'static> {
        let payload = Box::leak(Box::new(payload));
        RuntimeIdentity {
            event_name: "response.block.created",
            runtime_task_id: "runtime-958444342".to_owned(),
            payload,
        }
    }

    #[tokio::test]
    async fn a_projection_reads_the_execution_twice_before_the_chat_projection() {
        // The Source resolves the execution in `_project_chat_runtime_event_sync`
        // and `handle_runtime_event` re-reads it. A missing streaming activity
        // then falls back to `_open_activity_from_execution`'s unowned read.
        // Every one of those reads is an observable dependency.
        let recorder = RecordingTransaction::default();
        let mut transaction = recorder.clone();
        let identity = runtime_identity(json!({"taskId": "runtime-958444342"}));
        let projected = project_in_transaction(
            &mut transaction,
            3246,
            "d30dc060-a1e9-40d6-bbfe-9cecf790f04d",
            &identity,
        )
        .await
        .expect("the projection runs");
        assert!(projected.is_none());

        let queries = recorder.queries();
        let statements = queries
            .iter()
            .map(|(sql, _)| sql.as_str())
            .collect::<Vec<_>>();
        assert_eq!(queries.len(), 6, "{statements:#?}");
        // identity, owner-scoped execution, identity again, execution again.
        assert!(statements[0].contains("FROM kinds"), "{}", statements[0]);
        assert!(
            statements[1].contains("FROM loop_item_executions"),
            "{}",
            statements[1]
        );
        assert!(
            statements[1].contains("executor_owner_user_id = ?"),
            "{}",
            statements[1]
        );
        assert!(statements[2].contains("FROM kinds"), "{}", statements[2]);
        assert_eq!(statements[1], statements[3]);
        // streaming candidate, then the unowned execution fallback.
        assert!(
            statements[4].contains("FROM project_chat_messages"),
            "{}",
            statements[4]
        );
        assert!(
            statements[5].contains("FROM loop_item_executions"),
            "{}",
            statements[5]
        );
        assert!(
            !statements[5].contains("executor_owner_user_id = ?"),
            "the fallback reads without an owner predicate: {}",
            statements[5]
        );
        // identity (1), owner execution (3), identity (1), owner execution (3),
        // candidate (2), unowned execution (2).
        assert_eq!(
            queries.iter().map(|(_, args)| *args).collect::<Vec<_>>(),
            vec![1, 3, 1, 3, 2, 2]
        );
    }

    #[tokio::test]
    async fn an_app_record_route_expands_aliases_for_the_chat_projection() {
        // `project_runtime_event` expands aliases only for an App record route,
        // adding one owner-scoped identity read before the streaming lookup.
        let recorder = RecordingTransaction::default();
        let mut transaction = recorder.clone();
        let identity = runtime_identity(json!({"taskId": "runtime-958444342"}));
        let projected =
            project_in_transaction(&mut transaction, 3246, "app-record-268663", &identity)
                .await
                .expect("the projection runs");
        assert!(projected.is_none());
        let queries = recorder.queries();
        assert_eq!(queries.len(), 7, "{:?}", queries);
        assert!(queries[4].0.contains("FROM kinds"), "{}", queries[4].0);
    }
}
