// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `response.completed`'s completed-activity discovery and restore.
//!
//! Source: `ProjectChatService.project_runtime_event`'s `response.completed`
//! branch (`app/services/project_chat/service.py:1263-1385`), which runs before
//! the streaming fallback and calls `completed_activity_for_turn`
//! (`app/services/project_chat/execution_snapshot.py:37`) first.
//!
//! The recorded Source sequence for one event is: the `runtime_turn_id`
//! discovery, its `trigger_message_id` fallback, the reconciled-activity
//! fallback (`loop_item_executions/service.py:2029`), and only then the
//! streaming read. Restored text also refreshes the loop item’s change-request index.

use brz_mysql::{FromMysqlRow, MysqlResult, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};
use serde_json::{Map, Value, json};

use crate::background_jobs::project::completion::Message;
use crate::loop_tasks::loop_columns::CLOUD_CONTEXT_COLUMNS;
use crate::loop_tasks::loop_repository::EXECUTION_COLUMNS;
use crate::sql_support::StatementArg;

use super::{
    ExecutionRow, Projected, RuntimeIdentity, UNSET_DELETED_AT, event_seq,
    execution_runtime_task_id, final_text, projected_view,
};

#[path = "activity_accepted.rs"]
mod accepted;
pub(in crate::socketio) use accepted::open_accepted_activity;

/// The Source's full `project_chat_messages` projection (22 columns, Source
/// order) that `db.query(ProjectChatMessage)` renders for
/// `completed_activity_for_turn` and `_linked_activity`.
///
/// The strict matcher compares the explicit projection, so this must stay a
/// column list, not `SELECT *`, and keep the Source's column order. Two
/// columns (`runtime_activity_key`, `deleted_at`) are projected by the Source
/// but are not modeled by [`Message`]; [`ActivityRow`] reads the other twenty.
pub(super) const ACTIVITY_COLUMNS: &str = "project_chat_messages.id AS project_chat_messages_id, \
     project_chat_messages.message_id AS project_chat_messages_message_id, \
     project_chat_messages.client_message_id AS project_chat_messages_client_message_id, \
     project_chat_messages.project_id AS project_chat_messages_project_id, \
     project_chat_messages.task_id AS project_chat_messages_task_id, \
     project_chat_messages.sender_type AS project_chat_messages_sender_type, \
     project_chat_messages.sender_id AS project_chat_messages_sender_id, \
     project_chat_messages.sender_name AS project_chat_messages_sender_name, \
     project_chat_messages.message_type AS project_chat_messages_message_type, \
     project_chat_messages.content AS project_chat_messages_content, \
     project_chat_messages.metadata AS project_chat_messages_metadata, \
     project_chat_messages.trigger_message_id AS project_chat_messages_trigger_message_id, \
     project_chat_messages.reply_to_message_id AS project_chat_messages_reply_to_message_id, \
     project_chat_messages.thread_root_message_id AS project_chat_messages_thread_root_message_id, \
     project_chat_messages.agent_id AS project_chat_messages_agent_id, \
     project_chat_messages.runtime_device_id AS project_chat_messages_runtime_device_id, \
     project_chat_messages.runtime_task_id AS project_chat_messages_runtime_task_id, \
     project_chat_messages.runtime_activity_key AS project_chat_messages_runtime_activity_key, \
     project_chat_messages.status AS project_chat_messages_status, \
     project_chat_messages.created_at AS project_chat_messages_created_at, \
     project_chat_messages.updated_at AS project_chat_messages_updated_at, \
     project_chat_messages.deleted_at AS project_chat_messages_deleted_at";

/// The modeled columns of [`ACTIVITY_COLUMNS`]; the two Source-only columns
/// are selected for projection fidelity and ignored here.
#[derive(Debug, FromMysqlRow)]
struct ActivityRow {
    #[mysql(rename = "project_chat_messages_id")]
    id: i64,
    #[mysql(rename = "project_chat_messages_message_id")]
    message_id: String,
    #[mysql(rename = "project_chat_messages_client_message_id")]
    client_message_id: String,
    #[mysql(rename = "project_chat_messages_project_id")]
    project_id: String,
    #[mysql(rename = "project_chat_messages_task_id")]
    task_id: String,
    #[mysql(rename = "project_chat_messages_sender_type")]
    sender_type: String,
    #[mysql(rename = "project_chat_messages_sender_id")]
    sender_id: String,
    #[mysql(rename = "project_chat_messages_sender_name")]
    sender_name: String,
    #[mysql(rename = "project_chat_messages_message_type")]
    message_type: String,
    #[mysql(rename = "project_chat_messages_content")]
    content: String,
    #[mysql(rename = "project_chat_messages_metadata")]
    metadata: brz_mysql::Json<Value>,
    #[mysql(rename = "project_chat_messages_trigger_message_id")]
    trigger_message_id: String,
    #[mysql(rename = "project_chat_messages_reply_to_message_id")]
    reply_to_message_id: String,
    #[mysql(rename = "project_chat_messages_thread_root_message_id")]
    thread_root_message_id: String,
    #[mysql(rename = "project_chat_messages_agent_id")]
    agent_id: String,
    #[mysql(rename = "project_chat_messages_runtime_device_id")]
    runtime_device_id: String,
    #[mysql(rename = "project_chat_messages_runtime_task_id")]
    runtime_task_id: String,
    #[mysql(rename = "project_chat_messages_status")]
    status: String,
    #[mysql(rename = "project_chat_messages_created_at")]
    created_at: NaiveDateTime,
    #[mysql(rename = "project_chat_messages_updated_at")]
    updated_at: NaiveDateTime,
}

impl ActivityRow {
    fn into_message(self) -> Message {
        Message {
            id: self.id,
            message_id: self.message_id,
            client_message_id: self.client_message_id,
            project_id: self.project_id,
            task_id: self.task_id,
            sender_type: self.sender_type,
            sender_id: self.sender_id,
            sender_name: self.sender_name,
            message_type: self.message_type,
            content: self.content,
            metadata: self.metadata,
            trigger_message_id: self.trigger_message_id,
            reply_to_message_id: self.reply_to_message_id,
            thread_root_message_id: self.thread_root_message_id,
            agent_id: self.agent_id,
            runtime_device_id: self.runtime_device_id,
            runtime_task_id: self.runtime_task_id,
            status: self.status,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

/// `ProjectChatMessage.metadata_json["runtime_turn_id"]` compared as a string
/// (`execution_snapshot.py:61`). The Source driver renders the escaped path
/// quotes, exactly like the streaming candidate's `kind` predicate.
const RUNTIME_TURN_MATCH: &str = r#"CASE JSON_EXTRACT(project_chat_messages.metadata, '$.\"runtime_turn_id\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(project_chat_messages.metadata, '$.\"runtime_turn_id\"')) END"#;

/// What the completed-activity discovery settled.
pub(super) enum Discovery {
    /// A completion row was discovered; the Source branch returns here and
    /// never reaches the streaming fallback.
    Found(Option<Projected>),
    /// Nothing was discovered; the caller continues with the streaming read.
    Absent,
}

/// `completed_activity_for_turn`'s shared SELECT body.
pub(super) fn activity_statement(
    device_count: usize,
    predicate: &str,
    completed_only: bool,
    lock: bool,
) -> String {
    let placeholders = vec!["?"; device_count].join(", ");
    let mut statement = format!(
        "SELECT {ACTIVITY_COLUMNS} FROM project_chat_messages \
         WHERE project_chat_messages.runtime_device_id IN ({placeholders}) \
         AND project_chat_messages.runtime_task_id = ? \
         AND project_chat_messages.sender_type = 'agent' \
         AND {UNSET_DELETED_AT}"
    );
    if completed_only {
        statement.push_str(" AND project_chat_messages.status = 'completed'");
    }
    statement.push_str(&format!(" AND {predicate} = ?"));
    if lock {
        statement.push_str(" FOR UPDATE");
    }
    statement
}

fn activity_args(device_ids: &[String], task_id: &str, value: &str) -> Vec<StatementArg> {
    let mut args: Vec<StatementArg> = device_ids.iter().cloned().map(StatementArg::Str).collect();
    args.push(StatementArg::Str(task_id.to_owned()));
    args.push(StatementArg::Str(value.to_owned()));
    args
}

/// `_runtime_turn_id` (`project_chat/service.py:1804`).
fn runtime_turn_id(payload: &Value) -> Option<&str> {
    payload
        .get("subtaskId")
        .or_else(|| payload.get("subtask_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// `runtime_event_client_message_id` (`execution_snapshot.py:77`).
pub(super) fn client_message_id(payload: &Value) -> Option<&str> {
    payload
        .get("clientUserMessageId")
        .or_else(|| payload.get("client_user_message_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Python `int(value)` for the metadata `execution_id`.
fn coerce_execution_id(value: &Value) -> Option<i64> {
    if value.is_boolean() {
        return None;
    }
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|number| number as i64))
        .or_else(|| {
            value
                .as_str()
                .and_then(|text| text.trim().parse::<i64>().ok())
        })
}

/// `str(metadata["execution_id"]) == str(execution.id)`.
fn metadata_execution_matches(activity: &Message, execution_id: i64) -> bool {
    activity
        .metadata
        .0
        .get("execution_id")
        .and_then(coerce_execution_id)
        == Some(execution_id)
}

/// `"execution_id" in (activity.metadata_json or {})`.
fn has_execution_id(activity: &Message) -> bool {
    activity.metadata.0.get("execution_id").is_some()
}

/// `_matches_completion_identity` (`execution_snapshot.py:82`).
pub(super) fn completion_identity_matches(
    row: &Message,
    turn_id: Option<&str>,
    client: Option<&str>,
    request_turn_id: Option<&str>,
) -> bool {
    let Some(turn_id) = turn_id else {
        return false;
    };
    if row.status != "completed" {
        return false;
    }
    let metadata = row.metadata.0.as_object();
    let binding = metadata
        .and_then(|metadata| metadata.get("runtime_turn_id"))
        .and_then(Value::as_str);
    if binding == Some(turn_id) {
        return true;
    }
    if !matches!(binding, None | Some("")) {
        return false;
    }
    if request_turn_id == Some(turn_id) {
        return true;
    }
    let Some(client) = client else {
        return false;
    };
    row.trigger_message_id == client
        && metadata.is_some_and(|metadata| {
            metadata.get("execution_id").is_some()
                && metadata.contains_key("runtime_completed_at")
                && metadata.get("kind").and_then(Value::as_str) != Some("task_ai_subagent")
        })
}

/// `completed_activity_for_turn` (`execution_snapshot.py:37`).
async fn completed_activity_for_turn<T: MysqlTransaction>(
    transaction: &mut T,
    device_ids: &[String],
    task_id: &str,
    turn_id: Option<&str>,
    client: Option<&str>,
    lock: bool,
    completed_only: bool,
) -> MysqlResult<Option<Message>> {
    let Some(turn_id) = turn_id else {
        return Ok(None);
    };
    let statement = activity_statement(device_ids.len(), RUNTIME_TURN_MATCH, completed_only, lock);
    let args = activity_args(device_ids, task_id, turn_id);
    let bound: Option<ActivityRow> = transaction.fetch_optional(statement, args).await?;
    let bound = bound.map(ActivityRow::into_message);
    if bound.is_some() || client.is_none() {
        return Ok(bound);
    }
    let statement = activity_statement(
        device_ids.len(),
        "project_chat_messages.trigger_message_id",
        completed_only,
        lock,
    );
    let args = activity_args(device_ids, task_id, client.unwrap_or_default());
    let candidates: Vec<ActivityRow> = transaction.fetch_all(statement, args).await?;
    let matches: Vec<Message> = candidates
        .into_iter()
        .map(ActivityRow::into_message)
        .filter(|row| {
            !completed_only || completion_identity_matches(row, Some(turn_id), client, None)
        })
        .collect();
    Ok(if matches.len() == 1 {
        matches.into_iter().next()
    } else {
        None
    })
}

/// `db.refresh(row, with_for_update=True)`: re-read one activity by primary key.
pub(super) async fn reload_activity<T: MysqlTransaction>(
    transaction: &mut T,
    activity_id: i64,
) -> MysqlResult<Option<Message>> {
    let row: Option<ActivityRow> = transaction
        .fetch_optional(
            format!(
                "SELECT {ACTIVITY_COLUMNS} FROM project_chat_messages \
                     WHERE project_chat_messages.id = ? FOR UPDATE"
            ),
            (activity_id,),
        )
        .await?;
    Ok(row.map(ActivityRow::into_message))
}

/// `db.refresh(execution, with_for_update=True)`.
pub(in crate::socketio) async fn reload_execution<T: MysqlTransaction>(
    transaction: &mut T,
    execution_id: i64,
) -> MysqlResult<Option<ExecutionRow>> {
    let statement = format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
         WHERE loop_item_executions.id = ? FOR UPDATE"
    );
    transaction.fetch_optional(statement, (execution_id,)).await
}

/// `_execution_for_completed_activity` (`project_chat/service.py:1529`).
async fn execution_for_completed_activity<T: MysqlTransaction>(
    transaction: &mut T,
    activity: &Message,
) -> MysqlResult<Option<ExecutionRow>> {
    let Some(raw) = activity.metadata.0.get("execution_id") else {
        return Ok(None);
    };
    let Some(execution_id) = coerce_execution_id(raw) else {
        return Ok(None);
    };
    reload_execution(transaction, execution_id).await
}

/// `execution_runtime_turn_id` (`loop_item_executions/runtime_identity.py:46`).
fn execution_runtime_turn_id(row: &ExecutionRow) -> String {
    let task_id = match row.runtime_task_id.as_deref() {
        Some(task) if !task.is_empty() => task.to_owned(),
        _ => execution_runtime_task_id(row),
    };
    format!("{task_id}-execution-{}", row.id)
}

/// `can_restore_reconciled_completion` (`execution_snapshot.py:124`).
async fn can_restore_reconciled_completion<T: MysqlTransaction>(
    transaction: &mut T,
    execution: &ExecutionRow,
    identity: &RuntimeIdentity<'_>,
    activity: &Message,
) -> MysqlResult<bool> {
    if identity.event_name != "response.completed" {
        return Ok(false);
    }
    let Some(sequence) = event_seq(identity.payload) else {
        return Ok(false);
    };
    let Some(current) = reload_execution(transaction, execution.id).await? else {
        return Ok(false);
    };
    if current.status_or_empty() != "completed" || sequence <= current.last_event_seq.unwrap_or(0) {
        return Ok(false);
    }
    let client = if current.attempt_no.unwrap_or(0) == 1 {
        client_message_id(identity.payload)
    } else {
        None
    };
    let Some(activity) = reload_activity(transaction, activity.id).await? else {
        return Ok(false);
    };
    Ok(completion_identity_matches(
        &activity,
        runtime_turn_id(identity.payload),
        client,
        Some(&execution_runtime_turn_id(&current)),
    ) && metadata_execution_matches(&activity, current.id)
        && activity.metadata.0.get("runtime_completed_at").is_some()
        && current.cloud_project_id.as_deref() == Some(activity.project_id.as_str())
        && current.loop_item_id.as_deref() == Some(activity.task_id.as_str()))
}

pub(super) async fn restore_reconciled_completion<T: MysqlTransaction>(
    transaction: &mut T,
    execution: &ExecutionRow,
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<Option<Projected>> {
    let Some(sequence) = event_seq(identity.payload) else {
        return Ok(None);
    };
    let Some(execution) = reload_execution(transaction, execution.id).await? else {
        return Ok(None);
    };
    if execution.status_or_empty() != "completed"
        || sequence <= execution.last_event_seq.unwrap_or(0)
    {
        return Ok(None);
    }
    let Some(device_id) = execution.runtime_device_id.clone() else {
        return Ok(None);
    };
    let device_ids = [device_id];
    let client = (execution.attempt_no == Some(1))
        .then(|| client_message_id(identity.payload))
        .flatten();
    let task_id = &identity.runtime_task_id;
    // A concurrent snapshot may have completed the activity after our first read.
    let Some(activity) = completed_activity_for_turn(
        transaction,
        &device_ids,
        task_id,
        runtime_turn_id(identity.payload),
        client,
        true,
        true,
    )
    .await?
    else {
        return Ok(None);
    };
    restore_discovered_activity(
        transaction,
        &device_ids,
        task_id,
        identity,
        false,
        activity,
        Some(execution),
    )
    .await
}

/// `_runtime_event_is_stale` (`project_chat/service.py:1495`).
pub(super) fn runtime_event_is_stale(
    activity: &Message,
    sequence: Option<i64>,
    allow_equal: bool,
) -> bool {
    let previous = activity
        .metadata
        .0
        .get("runtime_event_sequence")
        .and_then(|value| {
            if value.is_boolean() {
                return None;
            }
            value
                .as_i64()
                .or_else(|| value.as_f64().map(|number| number as i64))
                .or_else(|| {
                    value
                        .as_str()
                        .and_then(|text| text.trim().parse::<i64>().ok())
                })
        })
        .filter(|value| *value > 0);
    match (sequence, previous) {
        (Some(sequence), Some(previous)) => {
            sequence < previous || (sequence == previous && !allow_equal)
        }
        _ => false,
    }
}

/// `_record_runtime_sequence`: returns whether the metadata changed.
///
/// The Source calls `_runtime_event_is_stale` with its default
/// `allow_equal=False` here, independent of `accepted_terminal`.
pub(super) fn record_runtime_sequence(activity: &mut Message, sequence: Option<i64>) -> bool {
    let Some(sequence) = sequence.filter(|value| *value > 0) else {
        return false;
    };
    if runtime_event_is_stale(activity, Some(sequence), false) {
        return false;
    }
    let mut metadata = activity.metadata.0.as_object().cloned().unwrap_or_default();
    metadata.insert(
        "runtime_event_sequence".into(),
        Value::String(sequence.to_string()),
    );
    activity.metadata = brz_mysql::Json(Value::Object(metadata));
    true
}

/// The Source branch's restore half after a completion row was discovered.
async fn restore_discovered_activity<T: MysqlTransaction>(
    transaction: &mut T,
    device_ids: &[String],
    task_id: &str,
    identity: &RuntimeIdentity<'_>,
    accepted_terminal: bool,
    mut activity: Message,
    mut execution: Option<ExecutionRow>,
) -> MysqlResult<Option<Projected>> {
    if has_execution_id(&activity) && execution.is_none() {
        return Ok(None);
    }
    if let Some(current) = execution.as_ref()
        && !accepted_terminal
        && !can_restore_reconciled_completion(transaction, current, identity, &activity).await?
    {
        return Ok(None);
    }
    if execution.is_none() || accepted_terminal {
        if let Some(current) = execution.as_ref() {
            execution = reload_execution(transaction, current.id).await?;
        }
        let current = completed_activity_for_turn(
            transaction,
            device_ids,
            task_id,
            runtime_turn_id(identity.payload),
            client_message_id(identity.payload),
            true,
            true,
        )
        .await?;
        let Some(current) = current else {
            return Ok(None);
        };
        if current.id != activity.id {
            return Ok(None);
        }
        activity = current;
    }
    let sequence = event_seq(identity.payload);
    if runtime_event_is_stale(&activity, sequence, accepted_terminal) {
        return Ok(None);
    }
    let content = final_text(identity.payload);
    let mut changed = false;
    if let Some(text) = content.as_deref() {
        activity.content = text.to_owned();
        changed = true;
        if let Some(turn_id) = runtime_turn_id(identity.payload) {
            let mut metadata = activity.metadata.0.as_object().cloned().unwrap_or_default();
            metadata.insert("runtime_turn_id".into(), json!(turn_id));
            activity.metadata = brz_mysql::Json(Value::Object(metadata));
        }
    } else if execution.is_some() && !accepted_terminal {
        return Ok(None);
    }
    if let (Some(row), Some(sequence)) = (execution.as_mut(), sequence)
        && sequence > row.last_event_seq.unwrap_or(0)
    {
        row.last_event_seq = Some(sequence);
        transaction
            .execute(
                "UPDATE loop_item_executions SET last_event_seq=? \
                 WHERE loop_item_executions.id=?",
                (sequence, row.id),
            )
            .await?;
    }
    changed |= record_runtime_sequence(&mut activity, sequence);
    if changed || accepted_terminal {
        activity.updated_at = Utc::now().naive_utc();
        if accepted_terminal {
            activity.metadata.0["activity_at"] = json!(activity.updated_at.and_utc().to_rfc3339());
        }
        transaction
            .execute(
                "UPDATE project_chat_messages SET content=?, metadata=?, updated_at=? \
                 WHERE project_chat_messages.id=?",
                (
                    activity.content.as_str(),
                    brz_mysql::Json(activity.metadata.0.clone()),
                    activity.updated_at,
                    activity.id,
                ),
            )
            .await?;
    }
    Ok(Some(Projected {
        message: projected_view(&activity),
        delta: false,
        terminal_activity: (accepted_terminal || content.is_some())
            .then(|| (Box::new(activity), accepted_terminal)),
    }))
}

/// The `response.completed` branch: discover the bound activity (or its
/// unique `trigger_message_id` fallback), then the reconciled-activity
/// fallback (`project_chat/service.py:1299`), before the streaming read.
pub(super) async fn project_completed<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    device_ids: &[String],
    task_id: &str,
    identity: &RuntimeIdentity<'_>,
    accepted_terminal: bool,
) -> MysqlResult<Discovery> {
    let mut activity = completed_activity_for_turn(
        transaction,
        device_ids,
        task_id,
        runtime_turn_id(identity.payload),
        client_message_id(identity.payload),
        false,
        false,
    )
    .await?;
    let mut execution = None;
    if let Some(found) = activity.as_ref() {
        execution = execution_for_completed_activity(transaction, found).await?;
        if has_execution_id(found) && execution.is_none() {
            return Ok(Discovery::Found(None));
        }
        // `db.refresh(completed, with_for_update=True)`; a row that is no
        // longer completed leaves the Source branch for the reconciled read.
        activity = reload_activity(transaction, found.id)
            .await?
            .filter(|row| row.status == "completed");
    }
    if activity.is_none() {
        // Both completed-activity queries missed; the Source reads the
        // reconciled activity before it falls back to the streaming row.
        activity = reconciled_activity_for_runtime(
            transaction,
            user_id,
            device_id,
            task_id,
            runtime_turn_id(identity.payload),
        )
        .await?;
        if let Some(found) = activity.as_ref() {
            execution = execution_for_completed_activity(transaction, found).await?;
        }
    }
    let Some(activity) = activity else {
        return Ok(Discovery::Absent);
    };
    if has_execution_id(&activity) && execution.is_none() {
        return Ok(Discovery::Found(None));
    }
    let projected = restore_discovered_activity(
        transaction,
        device_ids,
        task_id,
        identity,
        accepted_terminal,
        activity,
        execution,
    )
    .await?;
    Ok(Discovery::Found(projected))
}

/// `_is_subagent_activity` (`loop_item_executions/service.py:3105`).
pub(super) fn is_subagent_activity(activity: &Message) -> bool {
    activity.metadata.0.get("kind").and_then(Value::as_str) == Some("task_ai_subagent")
}

/// Python `metadata.get("execution_id") == execution.id`: `_linked_activity`
/// uses raw equality, not the `str()` comparison of
/// `can_restore_reconciled_completion`.
pub(super) fn raw_execution_id_matches(activity: &Message, execution_id: i64) -> bool {
    match activity.metadata.0.get("execution_id") {
        Some(Value::Number(number)) => {
            number.as_i64() == Some(execution_id) || number.as_f64() == Some(execution_id as f64)
        }
        _ => false,
    }
}

/// `LoopItemExecution.runtime_origin_context` (`models/loop_item_execution.py:290`).
pub(super) fn execution_origin_context(row: &ExecutionRow) -> Map<String, Value> {
    match super::execution_intent(row).get("origin_context") {
        Some(Value::Object(context)) => context.clone(),
        _ => Map::new(),
    }
}

#[derive(brz_mysql::FromMysqlRow)]
struct AutomationRunRow {
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<brz_mysql::Json<Value>>,
}

/// `_automation_activity_message_id` (`loop_item_executions/service.py:2995`):
/// the run row's `metadata.activity_message_id`, or the empty string.
async fn automation_activity_message_id<T: MysqlTransaction>(
    transaction: &mut T,
    execution: &ExecutionRow,
) -> MysqlResult<String> {
    let Some(run_id) = execution
        .automation_run_id
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return Ok(String::new());
    };
    // `db.get(ProjectAutomationRun, id)`: the full mapped `loop_items`
    // projection under a primary-key filter.
    let run: Option<AutomationRunRow> = transaction
        .fetch_optional(
            format!("SELECT {CLOUD_CONTEXT_COLUMNS} FROM loop_items WHERE loop_items.id = ?"),
            (run_id,),
        )
        .await?;
    Ok(run
        .and_then(|row| row.metadata)
        .and_then(|metadata| {
            metadata
                .0
                .get("activity_message_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default())
}

/// First runtime row that is not a subagent activity (`_linked_activity`).
fn first_non_subagent(rows: Vec<Message>) -> Option<Message> {
    rows.into_iter().find(|row| !is_subagent_activity(row))
}

/// `_linked_activity` (`loop_item_executions/service.py:3019`).
pub(super) async fn linked_activity<T: MysqlTransaction>(
    transaction: &mut T,
    execution: &ExecutionRow,
) -> MysqlResult<Option<Message>> {
    let origin = execution_origin_context(execution);
    if let Some(trigger) = origin
        .get("comment_trigger_message_id")
        .filter(|value| crate::json_compat::python_truthy(value))
    {
        let trigger = crate::json_compat::python_str(trigger);
        let statement = format!(
            "SELECT {ACTIVITY_COLUMNS} FROM project_chat_messages \
             WHERE project_chat_messages.project_id = ? \
             AND project_chat_messages.task_id = ? \
             AND project_chat_messages.trigger_message_id = ? \
             AND project_chat_messages.sender_type = 'agent' \
             AND {UNSET_DELETED_AT} LIMIT 1"
        );
        let row: Option<ActivityRow> = transaction
            .fetch_optional(
                statement,
                (
                    execution.cloud_project_id.as_deref().unwrap_or(""),
                    execution.loop_item_id.as_deref().unwrap_or(""),
                    trigger.as_str(),
                ),
            )
            .await?;
        return Ok(row.map(ActivityRow::into_message));
    }
    let activity_message_id = automation_activity_message_id(transaction, execution).await?;
    if !activity_message_id.is_empty() {
        let statement = format!(
            "SELECT {ACTIVITY_COLUMNS} FROM project_chat_messages \
             WHERE project_chat_messages.message_id = ? \
             AND project_chat_messages.project_id = ? \
             AND {UNSET_DELETED_AT} LIMIT 1"
        );
        let row: Option<ActivityRow> = transaction
            .fetch_optional(
                statement,
                (
                    activity_message_id.as_str(),
                    execution.cloud_project_id.as_deref().unwrap_or(""),
                ),
            )
            .await?;
        let row = row.map(ActivityRow::into_message);
        if let Some(row) = row
            && raw_execution_id_matches(&row, execution.id)
        {
            return Ok(Some(row));
        }
    }
    let runtime_row = if execution
        .runtime_device_id
        .as_deref()
        .is_some_and(|value| !value.is_empty())
        && execution
            .runtime_task_id
            .as_deref()
            .is_some_and(|value| !value.is_empty())
    {
        let conversation = super::execution_conversation_task_id(execution);
        let statement = format!(
            "SELECT {ACTIVITY_COLUMNS} FROM project_chat_messages \
             WHERE project_chat_messages.runtime_device_id = ? \
             AND project_chat_messages.runtime_task_id = ? \
             AND project_chat_messages.sender_type = 'agent' \
             AND {UNSET_DELETED_AT} \
             ORDER BY project_chat_messages.id DESC"
        );
        let rows: Vec<ActivityRow> = transaction
            .fetch_all(
                statement,
                (
                    execution.runtime_device_id.as_deref().unwrap_or(""),
                    conversation.as_str(),
                ),
            )
            .await?;
        first_non_subagent(rows.into_iter().map(ActivityRow::into_message).collect())
    } else {
        None
    };
    if let Some(row) = runtime_row {
        return Ok(Some(row));
    }
    let statement = format!(
        "SELECT {ACTIVITY_COLUMNS} FROM project_chat_messages \
         WHERE project_chat_messages.project_id = ? \
         AND project_chat_messages.task_id = ? \
         AND {UNSET_DELETED_AT} \
         ORDER BY project_chat_messages.id DESC LIMIT 20"
    );
    let candidates: Vec<ActivityRow> = transaction
        .fetch_all(
            statement,
            (
                execution.cloud_project_id.as_deref().unwrap_or(""),
                execution.loop_item_id.as_deref().unwrap_or(""),
            ),
        )
        .await?;
    Ok(candidates
        .into_iter()
        .map(ActivityRow::into_message)
        .find(|row| raw_execution_id_matches(row, execution.id)))
}

/// The per-execution decision inside `reconciled_activity_for_runtime`.
pub(super) fn reconciled_candidate(
    activity: Option<Message>,
    execution: &ExecutionRow,
    turn_id: &str,
) -> Option<Message> {
    let activity = activity?;
    if activity.status != "completed" {
        return None;
    }
    let content = activity.content.trim();
    if !(content.is_empty() || content == "Runtime reconciled") {
        return None;
    }
    let bound = activity
        .metadata
        .0
        .get("runtime_turn_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if let Some(bound) = bound {
        return (bound == turn_id).then_some(activity);
    }
    (execution_runtime_turn_id(execution) == turn_id).then_some(activity)
}

/// `reconciled_activity_for_runtime` (`loop_item_executions/service.py:2029`).
async fn reconciled_activity_for_runtime<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    task_id: &str,
    turn_id: Option<&str>,
) -> MysqlResult<Option<Message>> {
    let Some(turn_id) = turn_id else {
        return Ok(None);
    };
    let device_ids = super::owned_identity_ids(transaction, user_id, device_id).await?;
    if device_ids.is_empty() {
        return Ok(None);
    }
    let placeholders = vec!["?"; device_ids.len()].join(", ");
    let statement = format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
         WHERE loop_item_executions.runtime_device_id IN ({placeholders}) \
         AND loop_item_executions.runtime_task_id = ? \
         AND loop_item_executions.status = 'completed' \
         AND loop_item_executions.executor_owner_user_id = ? \
         ORDER BY loop_item_executions.id DESC"
    );
    let mut args: Vec<StatementArg> = device_ids.iter().cloned().map(StatementArg::Str).collect();
    args.push(StatementArg::Str(task_id.to_owned()));
    args.push(StatementArg::Int(user_id));
    let executions: Vec<ExecutionRow> = transaction.fetch_all(statement, args).await?;
    for execution in executions {
        let activity = linked_activity(transaction, &execution).await?;
        if let Some(found) = reconciled_candidate(activity, &execution, turn_id) {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/// Close the current execution's parent and still-open children using the
/// same terminal Issue projection as the robot worker.
pub(super) async fn finish_runtime_activity(
    tx: &mut impl MysqlTransaction,
    execution: &ExecutionRow,
    status: &str,
    detail: &str,
    sequence: Option<i64>,
) -> MysqlResult<Vec<Message>> {
    let Some(candidate) = linked_activity(tx, execution).await? else {
        return Ok(vec![]);
    };
    let Some(mut parent) = reload_activity(tx, candidate.id).await? else {
        return Ok(vec![]);
    };
    if !matches!(parent.status.as_str(), "pending" | "streaming") {
        return Ok(vec![]);
    }
    record_runtime_sequence(&mut parent, sequence);
    crate::background_jobs::robot::finish_runtime_activity(tx, &mut parent, status, detail).await?;
    update_terminal_row(tx, &parent).await?;
    let children: Vec<ActivityRow> = tx.fetch_all(
        format!("SELECT {ACTIVITY_COLUMNS} FROM project_chat_messages WHERE project_id=? AND task_id=? AND trigger_message_id=? AND sender_type='agent' AND JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.kind'))='task_ai_subagent' AND status IN ('pending','streaming') AND {UNSET_DELETED_AT} FOR UPDATE"),
        (parent.project_id.as_str(), parent.task_id.as_str(), parent.message_id.as_str()),
    ).await?;
    let mut messages = vec![parent];
    for child in children {
        let mut child = child.into_message();
        record_runtime_sequence(&mut child, sequence);
        child.status = status.into();
        child.message_type = "text".into();
        child.metadata.0["subagent_status"] = json!(status);
        child.metadata.0["run_status"] = json!(status);
        update_terminal_row(tx, &child).await?;
        messages.push(child);
    }
    Ok(messages)
}

async fn update_terminal_row(tx: &mut impl MysqlTransaction, message: &Message) -> MysqlResult<()> {
    tx.execute(
        "UPDATE project_chat_messages SET content=?, status=?, message_type=?, metadata=?, updated_at=UTC_TIMESTAMP(6) WHERE id=?",
        (message.content.as_str(), message.status.as_str(), message.message_type.as_str(), brz_mysql::Json(message.metadata.0.clone()), message.id),
    ).await?;
    Ok(())
}

pub(super) async fn open_runtime_activity(
    tx: &mut impl MysqlTransaction,
    row: &ExecutionRow,
) -> MysqlResult<Option<Message>> {
    let status = row.status_or_empty();
    if !matches!(status, "claimed" | "running" | "cancel_requested")
        || row.runtime_device_id.as_deref().is_none_or(str::is_empty)
        || row.runtime_task_id.as_deref().is_none_or(str::is_empty)
    {
        return Ok(None);
    }
    let Some(_) = open_accepted_activity(tx, row.id, status == "running").await? else {
        return Ok(None);
    };
    let Some(mut message) = linked_activity(tx, row).await? else {
        return Ok(None);
    };
    if status == "running" && message.status == "streaming" {
        crate::background_jobs::robot::start_runtime_activity(
            tx,
            &mut message,
            row.executor_owner_user_id,
        )
        .await?;
    }
    Ok(Some(message))
}
