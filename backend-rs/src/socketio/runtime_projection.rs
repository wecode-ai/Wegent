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
    DeviceKindRow, KINDS_DEVICE_QUERY, device_identity_ids, is_app_device, record_id_from_route,
    unambiguous_device_identity_ids,
};
use crate::loop_tasks::loop_repository::EXECUTION_COLUMNS;
use crate::sql_support::StatementArg;
use crate::state::AppState;

use super::execution_aggregate::{
    CAPACITY_STATUSES, ERROR_LIMIT, ExecutionRow, TERMINAL_RUN_STATUSES, accept_observation,
    bind_activity_runtime_turn, set_automation_run_status, transition_terminal,
};

/// `loop_datetime_is_unset` for `project_chat_messages.deleted_at`.
const UNSET_DELETED_AT: &str = "(project_chat_messages.deleted_at IS NULL OR project_chat_messages.deleted_at IN \
     ('1970-01-01 00:00:00', '1970-01-01 00:00:01'))";
/// `_streaming_activity_for_runtime`'s `metadata_json["kind"]` filter
/// (`project_chat/service.py:1610-1614`): the stored kind is unset, or it is
/// not `task_ai_subagent`. MySQL renders `as_string().is_(None)` through the
/// `CASE ... WHEN 'null' THEN NULL` form, which keeps a JSON string `"null"`
/// distinct from a stored JSON `null` while both count as unset. The recorded
/// SQL keeps the escaped path quotes (`'$.\"kind\"'`), so the text matches the
/// Source driver's render byte for byte.
const STREAMING_METADATA_KIND: &str = r#"(CASE JSON_EXTRACT(project_chat_messages.metadata, '$.\"kind\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(project_chat_messages.metadata, '$.\"kind\"')) END IS NULL OR CASE JSON_EXTRACT(project_chat_messages.metadata, '$.\"kind\"') WHEN 'null' THEN NULL ELSE JSON_UNQUOTE(JSON_EXTRACT(project_chat_messages.metadata, '$.\"kind\"')) END != 'task_ai_subagent')"#;
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
/// and the task ids are bound parameters; only the placeholder counts are
/// structural.
///
/// Source always binds `runtime_task_id.in_(task_ids)` — a set, even for a
/// single id — and drops the `LIMIT 1` only for the
/// `include_initial_manager` variant, which reads every candidate with
/// `query.all()` and picks the matching conversation identity in Rust
/// (`app/services/loop_item_executions/service.py:1983-2003`).
fn execution_statement(device_count: usize, task_count: usize, owner: bool, limit: bool) -> String {
    let device_placeholders = vec!["?"; device_count].join(", ");
    let task_placeholders = vec!["?"; task_count].join(", ");
    let owner = if owner {
        " AND loop_item_executions.executor_owner_user_id = ?"
    } else {
        ""
    };
    let limit = if limit { " \n LIMIT 1" } else { "" };
    format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM loop_item_executions \n\
         WHERE loop_item_executions.runtime_device_id IN ({device_placeholders}) \
         AND loop_item_executions.runtime_task_id IN ({task_placeholders}) \
         AND loop_item_executions.status IN ({CAPACITY_STATUSES}){owner} \
         ORDER BY loop_item_executions.id DESC{limit}"
    )
}

fn execution_args(
    device_ids: &[String],
    task_ids: &[String],
    owner: Option<i64>,
) -> Vec<StatementArg> {
    let mut args = device_ids
        .iter()
        .cloned()
        .map(StatementArg::Str)
        .collect::<Vec<_>>();
    args.extend(task_ids.iter().cloned().map(StatementArg::Str));
    if let Some(owner) = owner {
        args.push(StatementArg::Int(owner));
    }
    args
}

/// `LoopItemExecution.execution_intent`: the decoded intent envelope
/// (`runtime_work_transcript_access` mirrors the same property).
fn execution_intent(row: &ExecutionRow) -> Value {
    let payload = row.execution_payload.as_deref().unwrap_or("");
    if payload.is_empty() {
        return Value::Object(Map::new());
    }
    serde_json::from_str::<Value>(payload)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// `LoopItemExecution.runtime_selection`.
fn execution_runtime_selection(row: &ExecutionRow) -> Value {
    let intent = execution_intent(row);
    match intent.get("runtime_selection") {
        Some(Value::Object(_)) => intent["runtime_selection"].clone(),
        _ => intent,
    }
}

/// `LoopItemExecution.executor_type`.
fn execution_executor_type(row: &ExecutionRow) -> &'static str {
    let selection = execution_runtime_selection(row);
    if let Some(configured) = selection.get("executor_kind").and_then(Value::as_str)
        && matches!(configured, "generic_robot" | "collaboration_group_dispatch")
    {
        return if configured == "collaboration_group_dispatch" {
            "collaboration_group_dispatch"
        } else {
            "generic_robot"
        };
    }
    let has_agent = row
        .agent_id
        .as_deref()
        .is_some_and(|agent| !agent.is_empty());
    if has_agent {
        return "project_robot";
    }
    if row.team_id.is_some_and(|team| team != 0) {
        "wegent_team"
    } else {
        "generic_robot"
    }
}

/// `execution_runtime_task_id`.
fn execution_runtime_task_id(row: &ExecutionRow) -> String {
    let intent = execution_intent(row);
    if let Some(continue_id) = intent
        .get("origin_context")
        .and_then(|context| context.get("comment_continue_task_id"))
        .filter(|value| crate::json_compat::python_truthy(value))
    {
        return crate::json_compat::python_str(continue_id);
    }
    format!("codex-queue-{}", row.id)
}

/// `execution_conversation_task_id`.
fn execution_conversation_task_id(row: &ExecutionRow) -> String {
    let base = match row.runtime_task_id.as_deref() {
        Some(task) if !task.is_empty() => task.to_owned(),
        _ => execution_runtime_task_id(row),
    };
    if execution_executor_type(row) == "collaboration_group_dispatch" {
        return format!("{base}-manager-initial");
    }
    base
}

/// `task_ids = {runtime_task_id}` plus the manager base id when the
/// `include_initial_manager` variant sees a `-manager-initial` identity
/// (`service.py:1980-1982`).
fn runtime_task_ids(task_id: &str, include_initial_manager: bool) -> Vec<String> {
    let mut task_ids = vec![task_id.to_owned()];
    if include_initial_manager && let Some(base) = task_id.strip_suffix("-manager-initial") {
        task_ids.push(base.to_owned());
    }
    task_ids
}

/// `request.local_task_id in {runtime_task_id, execution_conversation_task_id}`.
fn execution_matches_runtime_task(row: &ExecutionRow, runtime_task_id: &str) -> bool {
    row.runtime_task_id.as_deref() == Some(runtime_task_id)
        || execution_conversation_task_id(row) == runtime_task_id
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
         AND {STREAMING_METADATA_KIND} \
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
///
/// Source resolves the device through `resolve_owned_device_alias`, which for
/// an App record route appends `AND kinds.id = ?` to the owned-Device query
/// (`app/services/device/identity.py:136`); only a legacy alias falls back to
/// the full per-user scan. The resulting list is `[submitted, *aliases]` with
/// first-occurrence order.
pub(super) async fn owned_identity_ids<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
) -> MysqlResult<Vec<String>> {
    let submitted = device_id.trim();
    if submitted.is_empty() {
        return Ok(Vec::new());
    }
    if let Some(record_id) = record_id_from_route(submitted) {
        let sql = format!("{KINDS_DEVICE_QUERY} AND kinds.id = ?");
        let row: Option<DeviceKindRow> = transaction
            .fetch_optional(sql, (user_id, record_id))
            .await?;
        let device = row.filter(is_app_device);
        let Some(device) = device else {
            return Ok(vec![submitted.to_owned()]);
        };
        return Ok(record_route_aliases(&device, submitted));
    }
    let devices: Vec<DeviceKindRow> = transaction
        .fetch_all(KINDS_DEVICE_QUERY, (user_id,))
        .await?;
    Ok(unambiguous_device_identity_ids(&devices, submitted))
}

/// `project_chat/service.py:1252-1262`'s identity resolution for a record
/// route.
///
/// The chat projection resolves the owned device through
/// `resolve_owned_device_alias` and uses `device_identity_ids(device)`; when
/// the record row is missing the projection returns `None` before any
/// streaming read. This is a different path from
/// `runtime_device_identity_ids` ([`owned_identity_ids`]), which falls back to
/// the submitted id for the execution helper and must not be merged with it.
async fn project_runtime_identity_ids<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    record_id: i64,
) -> MysqlResult<Option<Vec<String>>> {
    // `resolve_owned_device_alias`: `query.filter_by(id=record_id).one_or_none()`
    // plus the App filter (`device/identity.py:136`).
    let sql = format!("{KINDS_DEVICE_QUERY} AND kinds.id = ?");
    let row: Option<DeviceKindRow> = transaction
        .fetch_optional(sql, (user_id, record_id))
        .await?;
    let Some(device) = row.filter(is_app_device) else {
        return Ok(None);
    };
    Ok(Some(device_identity_ids(&device)))
}

/// `runtime_device_identity_ids`'s resolved branch:
/// `list(dict.fromkeys([submitted, *device_identity_ids(device)]))`.
fn record_route_aliases(device: &DeviceKindRow, submitted: &str) -> Vec<String> {
    let mut aliases = vec![submitted.to_owned()];
    for alias in device_identity_ids(device) {
        if !aliases.contains(&alias) {
            aliases.push(alias);
        }
    }
    aliases
}

pub(super) async fn execution_for_runtime<T: MysqlTransaction>(
    transaction: &mut T,
    device_ids: &[String],
    task_id: &str,
    owner: Option<i64>,
    include_initial_manager: bool,
) -> MysqlResult<Option<ExecutionRow>> {
    let task_ids = runtime_task_ids(task_id, include_initial_manager);
    let statement = execution_statement(
        device_ids.len(),
        task_ids.len(),
        owner.is_some(),
        !include_initial_manager,
    );
    let args = execution_args(device_ids, &task_ids, owner);
    if !include_initial_manager {
        return transaction.fetch_optional(statement, args).await;
    }
    // `include_initial_manager`: `query.all()` keeps every candidate and the
    // Source picks the first row whose runtime or conversation identity is the
    // requested task (`service.py:1995-2003`).
    let rows: Vec<ExecutionRow> = transaction.fetch_all(statement, args).await?;
    Ok(rows
        .into_iter()
        .find(|row| execution_matches_runtime_task(row, task_id)))
}

/// Thread metadata, Goal and lifecycle notifications never bind the execution
/// aggregate (`service.py:3243-3248`).
pub(super) fn non_binding_runtime_event(event_name: &str) -> bool {
    event_name.starts_with("runtime.goal.")
        || event_name.starts_with("thread/")
        || event_name == "runtime.turn.updated"
}

/// `handle_runtime_event`: the execution aggregate's acceptance rules and
/// transitions. Returns the elected row when the event was accepted.
pub(super) async fn handle_runtime_event<T: MysqlTransaction>(
    transaction: &mut T,
    row: ExecutionRow,
    identity: &RuntimeIdentity<'_>,
    messages: &mut Vec<Message>,
) -> MysqlResult<Option<ExecutionRow>> {
    // `handle_runtime_event`'s first rule (`service.py:3243-3248`): thread
    // metadata, Goal and lifecycle notifications can retain the previous
    // request's turn identity while a continuation starts, so they never bind
    // the execution aggregate — even with a valid sequence.
    if non_binding_runtime_event(identity.event_name) {
        return Ok(None);
    }
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
        Some("failed") if row.status_or_empty() != "cancel_requested" => {
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
            let origin = activity::execution_origin_context(&row);
            let answer = origin
                .get("human_request_id")
                .and_then(Value::as_str)
                .zip(
                    origin
                        .get("comment_trigger_message_id")
                        .and_then(Value::as_str),
                )
                .filter(|(_, message)| {
                    activity::client_message_id(identity.payload) == Some(*message)
                });
            let locked_issue = if answer.is_some() {
                if let Some(issue_id) = row.loop_item_id.as_deref() {
                    crate::background_jobs::project::store::locked(transaction, "task", issue_id)
                        .await?
                } else {
                    None
                }
            } else {
                None
            };
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
            if let Some((request, message)) = answer
                && let Some(issue) = locked_issue.filter(|issue| {
                    Some(issue.cloud_project_id.as_str()) == row.cloud_project_id.as_deref()
                })
            {
                super::project_chat_comment::settle_human_reply(
                    transaction,
                    issue,
                    request,
                    message,
                )
                .await?;
            }
            return Ok(Some(ExecutionRow {
                status: Some(if row.status_or_empty() == "cancel_requested" {
                    "cancel_requested".to_owned()
                } else {
                    "running".to_owned()
                }),
                version: row.version.map(|version| version + 1),
                last_event_seq: seq,
                started_at: Some(row.observed_start(now)),
                ..row
            }));
        }
    };
    let Some(locked) = reload_execution(transaction, row.id).await? else {
        return Ok(None);
    };
    if locked.status != row.status
        || locked.version != row.version
        || locked.last_event_seq != row.last_event_seq
    {
        return Ok(None);
    }
    if activity::linked_activity(transaction, &row)
        .await?
        .is_none()
    {
        activity::open_runtime_activity(transaction, &row).await?;
    }
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
    *messages = activity::finish_runtime_activity(
        transaction,
        &row,
        status,
        note.as_deref().unwrap_or(&error),
        seq,
        None,
    )
    .await?;
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
    pub(super) terminal_activity: Option<(Box<Message>, bool)>,
}

/// `project_runtime_event`: the streaming chat projection.
async fn project_runtime_event<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    identity: &RuntimeIdentity<'_>,
    accepted_terminal: bool,
    messages: &mut Vec<Message>,
) -> MysqlResult<Option<Projected>> {
    // `project_runtime_event` expands aliases only for an App record route;
    // every other transport identity queries the submitted id alone.
    let device_ids = match record_id_from_route(device_id) {
        Some(record_id) => {
            match project_runtime_identity_ids(transaction, user_id, record_id).await? {
                Some(ids) => ids,
                // `project_runtime_event` returns `None` when the record route
                // resolves no owned App device; it never falls back to the
                // submitted id the way the execution helper does
                // (`project_chat/service.py:1257-1259`).
                None => return Ok(None),
            }
        }
        None => vec![device_id.to_owned()],
    };
    // `project_runtime_event`'s completed-activity restore runs before the
    // streaming read (`project_chat/service.py:1263-1385`); a discovered row
    // settles the event there and never reaches the streaming fallback.
    if identity.event_name == "response.completed" {
        match activity::project_completed(
            transaction,
            user_id,
            device_id,
            &device_ids,
            &identity.runtime_task_id,
            identity,
            accepted_terminal,
        )
        .await?
        {
            activity::Discovery::Found(projected) => return Ok(projected),
            activity::Discovery::Absent => {}
        }
    }
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
    let mut candidate_id = candidate
        .map(|row| row.get_required::<i64>("project_chat_messages_id"))
        .transpose()?;
    if candidate_id.is_none() {
        // No open activity: `project_runtime_event` falls back to
        // `_open_activity_from_execution` (`project_chat/service.py:1637`).
        // The socket call passes the current user as `owner_user_id`
        // (`:1384`, `:987`), so the device aliases are expanded for that owner
        // and the execution read carries the owner predicate — the recorded
        // `include_initial_manager` queries bind the owner and every alias.
        let owner_ids = owned_identity_ids(transaction, user_id, device_id).await?;
        let fallback_execution = execution_for_runtime(
            transaction,
            &owner_ids,
            &identity.runtime_task_id,
            Some(user_id),
            true,
        )
        .await?;
        if let Some(execution) = fallback_execution
            && let Some(opened) = activity::open_runtime_activity(transaction, &execution).await?
            && matches!(opened.status.as_str(), "pending" | "streaming")
            && opened.runtime_task_id == identity.runtime_task_id
            && device_ids.contains(&opened.runtime_device_id)
        {
            candidate_id = Some(opened.id);
            messages.push(opened);
        }
    }
    let Some(candidate_id) = candidate_id else {
        return Ok(None);
    };
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
        return subagent::project(transaction, &message, data, event_seq(identity.payload)).await;
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
                terminal_activity: None,
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
    if terminal == Some("completed") {
        metadata.insert("activity_at".into(), json!(now.and_utc().to_rfc3339()));
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
        terminal_activity: (terminal == Some("completed")).then(|| (Box::new(message), true)),
    }))
}

/// `_execution_runtime_event_sync` (`device_namespace.py:1011`): project one
/// `/local-executor` Responses event onto the matching robot execution.
mod write_back;

pub(super) use write_back::write_back_execution_event;

/// `_project_chat_runtime_event_sync`: the execution projection then the chat
/// projection, both inside the source's single request transaction.
pub(super) async fn project(
    state: &AppState,
    runtime: &super::runtime::SocketRuntime,
    user_id: i64,
    device_id: &str,
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<Option<Projected>> {
    let device_id = device_id.to_owned();
    let (projected, effects) = state
        .mysql
        .with_transaction(async |transaction| {
            project_in_transaction(transaction, user_id, &device_id, identity).await
        })
        .await?;
    effects.deliver(state, runtime).await;
    Ok(projected)
}

/// The statement sequence `_project_chat_runtime_event_sync` issues inside its
/// request transaction.
async fn project_in_transaction<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    device_id: &str,
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<(Option<Projected>, lifecycle::Effects)> {
    let task_id = identity.runtime_task_id.clone();
    let event_name = identity.event_name.to_owned();
    // `_project_chat_runtime_event_sync` resolves the execution itself before
    // handing the event to `handle_runtime_event`.
    let ids = owned_identity_ids(transaction, user_id, device_id).await?;
    let execution =
        execution_for_runtime(transaction, &ids, &task_id, Some(user_id), false).await?;
    let previous_version = lifecycle::item_version(transaction, execution.as_ref()).await?;
    // Source `handle_runtime_event` dismisses thread metadata, Goal and
    // lifecycle notifications before it re-resolves the device and re-reads
    // the execution (`service.py:3243-3248`). The first read above stays, the
    // second pair is skipped entirely for those events.
    let non_binding = non_binding_runtime_event(&event_name);
    let handle_row = if non_binding {
        None
    } else {
        // `handle_runtime_event` re-resolves the device and re-reads the same
        // execution; both reads are observable Source dependencies.
        let handle_ids = owned_identity_ids(transaction, user_id, device_id).await?;
        execution_for_runtime(transaction, &handle_ids, &task_id, Some(user_id), false).await?
    };
    let mut messages = Vec::new();
    let matched = match handle_row {
        Some(row) => handle_runtime_event(transaction, row, identity, &mut messages).await?,
        None => None,
    };
    let projected =
        if !non_binding && let (Some(execution), None) = (execution.as_ref(), matched.as_ref()) {
            if event_name == "response.completed" {
                activity::restore_reconciled_completion(transaction, execution, identity).await?
            } else {
                tracing::info!(
                    user_id,
                    device_id,
                    task_id,
                    event = event_name,
                    "Runtime event projection rejected by execution truth"
                );
                None
            }
        } else {
            let accepted_terminal = matched
                .as_ref()
                .is_some_and(|row| row.status_or_empty() == "completed");
            project_runtime_event(
                transaction,
                user_id,
                device_id,
                identity,
                accepted_terminal,
                &mut messages,
            )
            .await?
        };
    if let Some(projected) = projected.as_ref().filter(|projected| !projected.delta) {
        messages.retain(|message| projected.message["messageId"] != message.message_id);
    }
    let effects =
        lifecycle_effects(transaction, matched, previous_version, identity, messages).await?;
    Ok((projected, effects))
}

async fn lifecycle_effects(
    tx: &mut impl MysqlTransaction,
    matched: Option<ExecutionRow>,
    previous_version: Option<i64>,
    identity: &RuntimeIdentity<'_>,
    messages: Vec<Message>,
) -> MysqlResult<lifecycle::Effects> {
    let changed = previous_version.is_some()
        && lifecycle::item_version(tx, matched.as_ref())
            .await?
            .zip(previous_version)
            .is_some_and(|(current, previous)| current != previous);
    let detail = final_text(identity.payload)
        .or_else(|| {
            identity
                .payload
                .get("error")
                .or_else(|| event_data(identity.payload)?.get("error"))
                .map(error_text)
        })
        .unwrap_or_default();
    Ok(lifecycle::Effects {
        matched,
        changed,
        detail,
        messages,
    })
}

mod activity;
pub(super) mod lifecycle;
pub(super) use activity::{finish_runtime_activity, linked_activity, open_runtime_activity};
mod subagent;
pub(super) use activity::{open_accepted_activity, reload_execution};

#[cfg(test)]
mod tests;
