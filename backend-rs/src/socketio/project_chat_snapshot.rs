// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/wework-runtime` `wework:project_chat:execution:snapshot`.
//!
//! Source: `app/api/ws/wework_runtime_namespace.py::on_project_chat_execution_snapshot`
//! and `app/services/project_chat/execution_snapshot.py::reconcile_execution_snapshot`.
//! The handler validates one compact execution report, reconciles only outcomes
//! whose terminal turn matches a forwarded activity row, and returns the changed
//! activity views. Nothing in the report is trusted beyond identity + outcome.

use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde_json::{Map, Value, json};

use crate::background_jobs::project::completion::Message;
use crate::device_identity::{device_identity_ids, resolve_owned_device_alias_on};
use crate::runtime_work_transcript_access::require_project_chat_scope;

use super::device_reconcile::apply_snapshot;
use super::execution_aggregate::ExecutionRow;
use super::runtime_projection::{execution_for_runtime, owned_identity_ids, reload_execution};

/// Snapshot turn statuses accepted by the schema.
const TURN_STATUSES: [&str; 5] = ["done", "failed", "cancelled", "running", "unknown"];
/// `TASK_AI_STATE_KEY`.
const TASK_AI_STATE_KEY: &str = "ai_state";
/// `EXECUTION_STATE_KEY`.
const EXECUTION_STATE_KEY: &str = "execution_state";
/// `EXECUTION_UPDATED_AT_KEY`.
const EXECUTION_UPDATED_AT_KEY: &str = "execution_updated_at";
/// `CONTENT_REVISION_KEY` / `READ_REVISIONS_KEY`.
const CONTENT_REVISION_KEY: &str = "content_revision";
const READ_REVISIONS_KEY: &str = "read_revisions";
/// `INITIAL_CONTENT_REVISION`.
const INITIAL_CONTENT_REVISION: i64 = 1;
/// `_EXECUTION_STATE_FROM_AI_STATUS`.
const EXECUTION_STATE_FROM_AI_STATUS: [(&str, &str); 5] = [
    ("running", "running"),
    ("completed", "completed"),
    ("failed", "failed"),
    ("cancelled", "cancelled"),
    ("canceled", "cancelled"),
];
/// `MYSQL_SESSION_TIMEZONE` (`app.db.timezone`): naive DB datetimes are UTC+8.
const DB_SESSION_OFFSET_SECONDS: i32 = 8 * 3600;

/// One `RuntimeExecutionSnapshot`.
#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    pub(crate) device_id: String,
    pub(crate) task_id: String,
    pub(crate) running: Option<bool>,
    pub(crate) complete_history: bool,
    pub(crate) turns: Vec<TurnSnapshot>,
}

/// One `RuntimeExecutionTurnSnapshot`.
#[derive(Debug, Clone)]
pub(crate) struct TurnSnapshot {
    pub(crate) id: String,
    pub(crate) user_message_ids: Vec<String>,
    pub(crate) status: String,
    pub(crate) completed_at: Option<Value>,
}

/// One snapshot ACK failure.
#[derive(Debug)]
pub(crate) enum SnapshotError {
    /// Pydantic validation failure (`INVALID_MESSAGE`).
    Invalid(String),
    /// An `HTTPException` with its status code and detail text.
    Http(i64, String),
}

impl SnapshotError {
    /// `project_chat_exception_ack`: status -> stable error code.
    pub(crate) fn ack(&self) -> Value {
        let (code, message) = match self {
            Self::Invalid(message) => ("INVALID_MESSAGE", message.clone()),
            Self::Http(status, detail) => {
                let code = match status {
                    403 => "SCOPE_FORBIDDEN",
                    404 => "SCOPE_NOT_FOUND",
                    409 => "MESSAGE_CONFLICT",
                    _ => "INVALID_MESSAGE",
                };
                (code, detail.clone())
            }
        };
        json!({"ok": false, "error": {"code": code, "message": message}})
    }
}

fn scope_error((status, detail): (i64, String)) -> SnapshotError {
    SnapshotError::Http(status, detail)
}

fn invalid(message: impl Into<String>) -> SnapshotError {
    SnapshotError::Invalid(message.into())
}

/// `project_chat_payload`'s public camelCase aliases.
fn payload_map(data: &Value) -> Option<&Map<String, Value>> {
    data.as_object()
}

/// `RuntimeExecutionSnapshot.model_validate(project_chat_payload(data))`.
pub(crate) fn parse_snapshot(data: &Value) -> Result<Snapshot, SnapshotError> {
    let object = payload_map(data).ok_or_else(|| invalid("Input should be a valid dictionary"))?;
    let field = |camel: &str, snake: &str| object.get(camel).or_else(|| object.get(snake));
    let device_id = bounded_string(field("deviceId", "device_id"), "deviceId")?;
    let task_id = bounded_string(field("taskId", "task_id"), "taskId")?;
    let running = match field("running", "running") {
        None | Some(Value::Null) => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => return Err(invalid("running: Input should be a valid boolean")),
    };
    let complete_history = match field("completeHistory", "complete_history") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            return Err(invalid("completeHistory: Input should be a valid boolean"));
        }
    };
    let turns_value = field("turns", "turns").ok_or_else(|| invalid("turns: Field required"))?;
    let turns = turns_value
        .as_array()
        .ok_or_else(|| invalid("turns: Input should be a valid list"))?;
    if turns.len() > 1000 {
        return Err(invalid("turns: List should have at most 1000 items"));
    }
    let mut parsed = Vec::with_capacity(turns.len());
    for turn in turns {
        parsed.push(parse_turn(turn)?);
    }
    Ok(Snapshot {
        device_id,
        task_id,
        running,
        complete_history,
        turns: parsed,
    })
}

fn parse_turn(value: &Value) -> Result<TurnSnapshot, SnapshotError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("turns: Input should be a valid dictionary"))?;
    let id = bounded_string(object.get("id"), "turns.id")?;
    let ids = match object
        .get("userMessageIds")
        .or_else(|| object.get("user_message_ids"))
    {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => {
            if values.len() > 100 {
                return Err(invalid(
                    "turns.userMessageIds: List should have at most 100 items",
                ));
            }
            let mut ids = Vec::with_capacity(values.len());
            for value in values {
                ids.push(
                    value
                        .as_str()
                        .ok_or_else(|| invalid("turns.userMessageIds: Input should be a string"))?
                        .to_owned(),
                );
            }
            ids
        }
        Some(_) => {
            return Err(invalid(
                "turns.userMessageIds: Input should be a valid list",
            ));
        }
    };
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("turns.status: Input should be a string"))?
        .to_owned();
    if !TURN_STATUSES.contains(&status.as_str()) {
        return Err(invalid("turns.status: Input should be a valid enum value"));
    }
    let completed_at = match object
        .get("completedAt")
        .or_else(|| object.get("completed_at"))
    {
        None | Some(Value::Null) => None,
        Some(Value::String(_)) => Some(
            object
                .get("completedAt")
                .or_else(|| object.get("completed_at"))
                .expect("present")
                .clone(),
        ),
        Some(Value::Number(number)) if number.is_i64() || number.is_u64() => Some(
            object
                .get("completedAt")
                .or_else(|| object.get("completed_at"))
                .expect("present")
                .clone(),
        ),
        Some(_) => {
            return Err(invalid(
                "turns.completedAt: Input should be a valid string or number",
            ));
        }
    };
    Ok(TurnSnapshot {
        id,
        user_message_ids: ids,
        status,
        completed_at,
    })
}

fn bounded_string(value: Option<&Value>, field: &str) -> Result<String, SnapshotError> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{field}: Input should be a string")))?;
    if value.is_empty() || value.chars().count() > 255 {
        return Err(invalid(format!(
            "{field}: String should have at least 1 character and at most 255 characters"
        )));
    }
    Ok(value.to_owned())
}

/// `_match_turn`: the single snapshot turn bound to one forwarded activity.
fn match_turn<'a>(
    row: &Message,
    snapshot: &'a Snapshot,
    single_execution: bool,
) -> Option<&'a TurnSnapshot> {
    let metadata = row.metadata.0.as_object();
    let raw_binding = metadata.and_then(|metadata| metadata.get("runtime_turn_id"));
    let binding = match raw_binding {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.is_empty() => None,
        Some(Value::String(value)) => Some(value.as_str()),
        // A truthy non-string binding matches no string turn id and stops the
        // identity walk, like the source's `if identity == binding: return None`.
        Some(_) => return None,
    };
    for identity in [
        binding,
        Some(row.message_id.as_str()),
        Some(row.trigger_message_id.as_str()),
    ]
    .into_iter()
    .flatten()
    .filter(|value| !value.is_empty())
    {
        let matches: Vec<&TurnSnapshot> = snapshot
            .turns
            .iter()
            .filter(|turn| {
                if Some(identity) == binding {
                    turn.id == identity
                } else {
                    turn.user_message_ids.iter().any(|id| id == identity)
                }
            })
            .collect();
        if !matches.is_empty() {
            return (matches.len() == 1).then_some(matches[0]);
        }
        if Some(identity) == binding {
            return None;
        }
    }
    if single_execution
        && snapshot.complete_history
        && snapshot.running == Some(false)
        && snapshot.turns.len() == 1
    {
        let turn = &snapshot.turns[0];
        let completed_at = completion_time(turn.completed_at.as_ref());
        let created_at = row.created_at - Duration::seconds(i64::from(DB_SESSION_OFFSET_SECONDS));
        if completed_at.is_some_and(|completed| completed >= created_at) {
            return Some(turn);
        }
    }
    None
}

/// `_completion_time`: milliseconds since epoch or an ISO timestamp.
fn completion_time(value: Option<&Value>) -> Option<NaiveDateTime> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return DateTime::<Utc>::from_timestamp_millis(number).map(|time| time.naive_utc());
    }
    if let Some(number) = value.as_f64() {
        return DateTime::<Utc>::from_timestamp_millis(number as i64).map(|time| time.naive_utc());
    }
    let text = value.as_str()?;
    if let Ok(parsed) = DateTime::parse_from_rfc3339(text) {
        return Some(parsed.naive_utc());
    }
    DateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f%z")
        .map(|parsed| parsed.naive_utc())
        .ok()
        .or_else(|| NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f").ok())
}

/// `TERMINAL_STATUSES[turn.status]`.
fn terminal_status(turn: &TurnSnapshot) -> Option<&'static str> {
    match turn.status.as_str() {
        "done" => Some("completed"),
        "failed" => Some("failed"),
        "cancelled" => Some("cancelled"),
        _ => None,
    }
}

/// One row returned to the handler: the changed activity views plus the loop
/// items whose change event is published after the transaction commits.
pub(crate) struct Reconciled {
    pub(crate) messages: Vec<Value>,
    pub(crate) changed_items: Vec<String>,
    effects: Vec<super::runtime_projection::lifecycle::Effects>,
}

/// `reconcile_execution_snapshot`.
pub(crate) async fn reconcile<T: MysqlTransaction>(
    state: &crate::state::AppState,
    transaction: &mut T,
    user_id: i64,
    snapshot: &Snapshot,
) -> Result<Reconciled, SnapshotError> {
    let mut session = &mut *transaction;
    let device = resolve_owned_device_alias_on(&mut session, user_id, &snapshot.device_id)
        .await
        .map_err(mysql_error)?;
    let Some(device) = device else {
        return Err(SnapshotError::Http(
            403,
            "Runtime device is not owned by the current user".into(),
        ));
    };
    let device_ids = device_identity_ids(&device);
    let mut rows = chat_rows(transaction, &device_ids, &snapshot.task_id)
        .await
        .map_err(mysql_error)?;
    rows.retain(|row| {
        row.metadata.0.get("kind").and_then(Value::as_str) != Some("task_ai_subagent")
    });
    let single_execution = rows.len() == 1;
    let mut candidates = Vec::new();
    for row in &rows {
        if !matches!(row.status.as_str(), "pending" | "streaming") {
            continue;
        }
        let Some(turn) = match_turn(row, snapshot, single_execution) else {
            continue;
        };
        if terminal_status(turn).is_none() {
            continue;
        }
        require_project_chat_scope(
            &state.mysql,
            user_id,
            &row.project_id,
            Some(row.task_id.as_str()).filter(|value| !value.is_empty()),
            "Developer",
        )
        .await
        .map_err(scope_error)?;
        candidates.push((row.clone(), turn.clone()));
    }
    let mut changed = Vec::new();
    let mut changed_items = Vec::new();
    let mut effects = Vec::new();
    for (candidate, turn) in candidates {
        if let Some(message) = persist_outcome(
            transaction,
            user_id,
            &candidate,
            &turn,
            &device_ids,
            &mut effects,
        )
        .await
        .map_err(mysql_error)?
        {
            if !message.task_id.is_empty() && !changed_items.contains(&message.task_id) {
                changed_items.push(message.task_id.clone());
            }
            changed.push(message.view());
        }
    }
    Ok(Reconciled {
        messages: changed,
        changed_items,
        effects,
    })
}

/// The activity projection without table aliases: the engine maps the single
/// table's direct columns onto the recorded SQLAlchemy labels, but it never
/// accepts a `SELECT *` without a schema-shape proof.
const MESSAGE_COLUMNS: &str = "project_chat_messages.id, \
     project_chat_messages.message_id, project_chat_messages.client_message_id, \
     project_chat_messages.project_id, project_chat_messages.task_id, \
     project_chat_messages.sender_type, project_chat_messages.sender_id, \
     project_chat_messages.sender_name, project_chat_messages.message_type, \
     project_chat_messages.content, project_chat_messages.metadata, \
     project_chat_messages.trigger_message_id, project_chat_messages.reply_to_message_id, \
     project_chat_messages.thread_root_message_id, project_chat_messages.agent_id, \
     project_chat_messages.runtime_device_id, project_chat_messages.runtime_task_id, \
     project_chat_messages.runtime_activity_key, project_chat_messages.status, \
     project_chat_messages.created_at, project_chat_messages.updated_at, \
     project_chat_messages.deleted_at";

/// The snapshot's activity read: every agent message for the runtime task.
fn chat_statement(device_count: usize) -> String {
    let placeholders = vec!["?"; device_count].join(", ");
    format!(
        "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages \
         WHERE project_chat_messages.runtime_device_id IN ({placeholders}) \
         AND project_chat_messages.runtime_task_id = ? \
         AND project_chat_messages.sender_type = 'agent' \
         AND (project_chat_messages.deleted_at IS NULL OR project_chat_messages.deleted_at IN \
         ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         ORDER BY project_chat_messages.id"
    )
}

async fn chat_rows<T: MysqlTransaction>(
    transaction: &mut T,
    device_ids: &[String],
    task_id: &str,
) -> MysqlResult<Vec<Message>> {
    let mut args = device_ids
        .iter()
        .cloned()
        .map(crate::sql_support::StatementArg::Str)
        .collect::<Vec<_>>();
    args.push(crate::sql_support::StatementArg::Str(task_id.to_owned()));
    transaction
        .fetch_all(chat_statement(device_ids.len()), args)
        .await
}

/// One `_persist_outcome` call: the execution root, the locked activity and
/// its task AI state are updated together.
async fn persist_outcome<T: MysqlTransaction>(
    transaction: &mut T,
    user_id: i64,
    current: &Message,
    turn: &TurnSnapshot,
    device_ids: &[String],
    effects: &mut Vec<super::runtime_projection::lifecycle::Effects>,
) -> MysqlResult<Option<Message>> {
    let turn_status = turn.status.as_str();
    let Some(status) = terminal_status(turn) else {
        return Ok(None);
    };
    let row_id = current.id;
    let metadata = current.metadata.0.clone();
    let execution_id = execution_identity(metadata.get("execution_id"));
    // Use the same aggregate-before-activity lock order as Runtime events.
    let execution: Option<ExecutionRow> = match execution_id {
        Some(execution_id) => reload_execution(transaction, execution_id).await?,
        None if metadata
            .get("execution_id")
            .is_some_and(|value| !value.is_null()) =>
        {
            return Ok(None);
        }
        None => {
            let ids = owned_identity_ids(transaction, user_id, &current.runtime_device_id).await?;
            let candidate = execution_for_runtime(
                transaction,
                &ids,
                &current.runtime_task_id,
                Some(user_id),
                false,
            )
            .await?;
            match candidate {
                Some(execution) => reload_execution(transaction, execution.id).await?,
                None => None,
            }
        }
    };
    if execution_id.is_some() && execution.is_none() {
        return Ok(None);
    }
    if let Some(execution) = &execution {
        let mismatched = execution_id.is_some_and(|id| id != execution.id)
            || execution.executor_owner_user_id != Some(user_id)
            || execution.runtime_task_id.as_deref() != Some(current.runtime_task_id.as_str())
            || !execution
                .runtime_device_id
                .as_deref()
                .is_some_and(|device| device_ids.iter().any(|id| id == device))
            || execution.cloud_project_id.as_deref() != Some(current.project_id.as_str())
            || execution.loop_item_id.as_deref() != Some(current.task_id.as_str());
        if mismatched {
            return Ok(None);
        }
    }
    let Some(mut row) = reload_message(transaction, row_id).await? else {
        return Ok(None);
    };
    if !matches!(row.status.as_str(), "pending" | "streaming") {
        return Ok(None);
    }
    let mut metadata = row.metadata.0.clone();
    if let Some(execution) = &execution {
        if execution.status.as_deref() != Some(status)
            && !execution
                .status
                .as_deref()
                .is_some_and(|value| matches!(value, "running" | "claimed" | "cancel_requested"))
        {
            return Ok(None);
        }
        set_metadata(&mut metadata, "runtime_turn_id", json!(turn.id));
        set_metadata(
            &mut metadata,
            "runtime_completed_at",
            turn.completed_at.clone().unwrap_or(Value::Null),
        );
        write_message(transaction, &row, &metadata).await?;
        if let Some(mut effect) =
            apply_snapshot(transaction, execution, status, false, Some(turn_status)).await?
        {
            effect.messages.retain(|message| message.id != row_id);
            effect.changed = false; // The snapshot publishes this Issue below.
            effects.push(effect);
        }
        let Some(reconciled) = reload_execution(transaction, execution.id).await? else {
            return Ok(None);
        };
        if reconciled.status.as_deref() != Some(status) {
            return Ok(None);
        }
        row = reload_message(transaction, row_id).await?.ok_or_else(|| {
            brz_mysql::MysqlError::InvalidQuery {
                reason: "message disappeared".into(),
            }
        })?;
        metadata = row.metadata.0.clone();
    }
    row.status = status.to_owned();
    set_metadata(&mut metadata, "run_status", json!(status));
    set_metadata(&mut metadata, "runtime_turn_id", json!(turn.id));
    set_metadata(
        &mut metadata,
        "runtime_completed_at",
        turn.completed_at.clone().unwrap_or(Value::Null),
    );
    write_message(transaction, &row, &metadata).await?;
    if let Some(task) = task_row(transaction, &row.task_id, &row.project_id).await? {
        let ai_state = task
            .metadata
            .as_ref()
            .and_then(|metadata| metadata.0.get(TASK_AI_STATE_KEY))
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let owns = ai_state
            .get("project_chat_message_id")
            .and_then(Value::as_str)
            == Some(row.message_id.as_str())
            && ai_state.get("run_id") == metadata.get("run_id")
            && matches!(
                ai_state.get("status").and_then(Value::as_str),
                Some("running" | "pending" | "queued")
            );
        if owns {
            update_task_ai_state(transaction, &task, &row, &mut metadata, status).await?;
            write_message(transaction, &row, &metadata).await?;
        }
    }
    Ok(Some(row))
}

fn set_metadata(metadata: &mut Value, key: &str, value: Value) {
    if let Value::Object(object) = metadata {
        object.insert(key.to_owned(), value);
    }
}

fn execution_identity(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    value.as_str()?.parse().ok()
}

const MESSAGE_UPDATE_QUERY: &str = "UPDATE project_chat_messages SET status=?, metadata=?, updated_at=? \
     WHERE project_chat_messages.id = ?";

async fn reload_message<T: MysqlTransaction>(
    transaction: &mut T,
    row_id: i64,
) -> MysqlResult<Option<Message>> {
    transaction
        .fetch_optional(
            format!(
                "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages \
                 WHERE project_chat_messages.id = ? FOR UPDATE"
            ),
            (row_id,),
        )
        .await
}

async fn write_message<T: MysqlTransaction>(
    transaction: &mut T,
    row: &Message,
    metadata: &Value,
) -> MysqlResult<()> {
    transaction
        .execute(
            MESSAGE_UPDATE_QUERY,
            (
                row.status.as_str(),
                Json(metadata.clone()),
                Utc::now().naive_utc(),
                row.id,
            ),
        )
        .await
        .map(|_| ())
}

#[derive(Debug, FromMysqlRow)]
struct TaskRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<Value>>,
}

async fn task_row<T: MysqlTransaction>(
    transaction: &mut T,
    task_id: &str,
    project_id: &str,
) -> MysqlResult<Option<TaskRow>> {
    if task_id.is_empty() {
        return Ok(None);
    }
    transaction
        .fetch_optional(
            "SELECT loop_items.id AS loop_items_id, loop_items.metadata AS loop_items_metadata \
             FROM loop_items \
             WHERE loop_items.id = ? AND loop_items.cloud_project_id = ? \
             AND loop_items.resource_type = 'task' FOR UPDATE",
            (task_id, project_id),
        )
        .await
}

/// `_set_task_ai_state` for a terminal snapshot outcome.
async fn update_task_ai_state<T: MysqlTransaction>(
    transaction: &mut T,
    task: &TaskRow,
    row: &Message,
    metadata: &mut Value,
    status: &str,
) -> MysqlResult<()> {
    let now = Utc::now().naive_utc();
    let mut task_metadata = task
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.0.as_object().cloned())
        .unwrap_or_default();
    let previous = task_metadata
        .get(TASK_AI_STATE_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let run_id = metadata
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(random_uuid_v4);
    let mut next = previous.clone();
    next.insert("run_id".into(), json!(run_id));
    next.insert("status".into(), json!(status));
    next.insert("agent_id".into(), json!(&row.agent_id));
    next.insert("agent_name".into(), json!(&row.sender_name));
    next.insert(
        "trigger_message_id".into(),
        if row.trigger_message_id.is_empty() {
            Value::Null
        } else {
            json!(row.trigger_message_id)
        },
    );
    next.insert("project_chat_message_id".into(), json!(row.message_id));
    next.insert(
        "runtime_device_id".into(),
        if row.runtime_device_id.is_empty() {
            Value::Null
        } else {
            json!(row.runtime_device_id)
        },
    );
    next.insert(
        "runtime_task_id".into(),
        if row.runtime_task_id.is_empty() {
            Value::Null
        } else {
            json!(row.runtime_task_id)
        },
    );
    next.insert(
        "updated_at".into(),
        json!(now.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()),
    );
    next.insert(
        "auto_retry".into(),
        json!(metadata.get("auto_retry") == Some(&Value::Bool(true))),
    );
    next.insert(
        "completed_at".into(),
        json!(now.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()),
    );
    next.insert("heartbeat_at".into(), Value::Null);
    next.insert("lease_expires_at".into(), Value::Null);
    if status == "failed" && next.get("auto_retry") == Some(&Value::Bool(true)) {
        let previous_attempts = previous
            .get("auto_retry_count")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        next.insert("auto_retry_count".into(), json!(previous_attempts + 1));
    }
    if let Some((_, execution_state)) = EXECUTION_STATE_FROM_AI_STATUS
        .iter()
        .find(|(key, _)| *key == status)
    {
        task_metadata.insert(EXECUTION_STATE_KEY.into(), json!(execution_state));
        task_metadata.insert(
            EXECUTION_UPDATED_AT_KEY.into(),
            json!(now.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()),
        );
    }
    if previous.get("status").and_then(Value::as_str) != Some(status) {
        advance_content_revision(&mut task_metadata, 0);
    }
    task_metadata.insert(TASK_AI_STATE_KEY.into(), Value::Object(next));
    set_metadata(metadata, "run_id", json!(run_id));
    set_metadata(metadata, "run_status", json!(status));
    transaction
        .execute(
            "UPDATE loop_items SET metadata=?, version=version+1, updated_at=? WHERE id=?",
            (Json(Value::Object(task_metadata)), now, task.id.as_str()),
        )
        .await
        .map(|_| ())
}

/// `str(uuid.uuid4())`-shaped random identity (`uuid.uuid7` is unavailable in
/// the source runtime this recording was made on).
fn random_uuid_v4() -> String {
    use std::fmt::Write as _;

    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let mut out = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) {
            out.push('-');
        }
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// `advance_content_revision` for a task metadata document.
pub(super) fn advance_content_revision(metadata: &mut Map<String, Value>, actor_user_id: i64) {
    let revision = metadata
        .get(CONTENT_REVISION_KEY)
        .and_then(Value::as_i64)
        .filter(|value| *value >= INITIAL_CONTENT_REVISION)
        .unwrap_or(INITIAL_CONTENT_REVISION)
        + 1;
    metadata.insert(CONTENT_REVISION_KEY.into(), json!(revision));
    let mut revisions = metadata
        .get(READ_REVISIONS_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    revisions.insert(actor_user_id.to_string(), json!(revision));
    metadata.insert(READ_REVISIONS_KEY.into(), Value::Object(revisions));
}

fn mysql_error(error: brz_mysql::MysqlError) -> SnapshotError {
    let _ = error;
    SnapshotError::Http(500, "Internal Server Error".into())
}

/// `_commit`'s post-commit `publish_loop_item_changed` recipients.
pub(crate) struct ChangeRecipients {
    pub(crate) project_id: String,
    pub(crate) version: i64,
    pub(crate) users: Vec<i64>,
}

pub(crate) async fn changed_item_recipients<T: MysqlTransaction>(
    transaction: &mut T,
    item_id: &str,
    actor_user_id: i64,
) -> MysqlResult<Option<ChangeRecipients>> {
    let row: Option<ChangeRow> = transaction
        .fetch_optional(
            "SELECT loop_items.cloud_project_id AS \
             loop_items_cloud_project_id, loop_items.version AS loop_items_version, \
             loop_items.created_by_user_id AS loop_items_created_by_user_id FROM loop_items \
             WHERE loop_items.id = ?",
            (item_id,),
        )
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let project_id = row.cloud_project_id.clone().unwrap_or_default();
    let kind: Option<(String,)> = transaction
        .fetch_optional(
            "SELECT resource_type FROM loop_items WHERE id=?",
            (project_id.as_str(),),
        )
        .await?;
    if kind.is_some_and(|kind| kind.0 == "chat_group") {
        let users: Vec<super::chat_audience::GroupRecipient> = transaction
            .fetch_all(
                super::chat_audience::GROUP_USERS_SQL,
                (project_id.as_str(), item_id, item_id),
            )
            .await?;
        return Ok(Some(ChangeRecipients {
            project_id,
            version: row.version.unwrap_or(0),
            users: users.into_iter().map(|row| row.id).collect(),
        }));
    }
    let collaborators: Vec<IdRow> = transaction
        .fetch_all(
            "SELECT loop_items.user_id AS id FROM loop_items \
             WHERE loop_items.resource_type = 'collaborator' AND loop_items.loop_item_id = ?",
            (item_id,),
        )
        .await?;
    let project_id = row.cloud_project_id.unwrap_or_default();
    let members: Vec<IdRow> = transaction
        .fetch_all(
            "SELECT resource_members.user_id AS id FROM resource_members \
             WHERE resource_members.resource_type IN ('CloudProject', 'CLOUD_PROJECT') \
             AND resource_members.resource_id = ? AND resource_members.entity_type = 'user' \
             AND resource_members.status IN ('approved', 'APPROVED')",
            (project_id.as_str(),),
        )
        .await?;
    let mut users = vec![actor_user_id, row.created_by_user_id.unwrap_or(0)];
    users.extend(collaborators.iter().filter_map(|row| row.id));
    users.extend(members.iter().filter_map(|row| row.id));
    users.retain(|id| *id != 0);
    users.sort_unstable();
    users.dedup();
    Ok(Some(ChangeRecipients {
        project_id,
        version: row.version.unwrap_or(0),
        users,
    }))
}

#[derive(Debug, FromMysqlRow)]
struct ChangeRow {
    #[mysql(rename = "loop_items_cloud_project_id")]
    cloud_project_id: Option<String>,
    #[mysql(rename = "loop_items_version")]
    version: Option<i64>,
    #[mysql(rename = "loop_items_created_by_user_id")]
    created_by_user_id: Option<i64>,
}

#[derive(Debug, FromMysqlRow)]
struct IdRow {
    id: Option<i64>,
}

/// Encode one business failure so the transaction rolls back and the handler
/// can rebuild the source's ACK.
fn as_mysql_error(error: SnapshotError) -> brz_mysql::MysqlError {
    let encoded = match error {
        SnapshotError::Invalid(message) => (422, message),
        SnapshotError::Http(status, message) => (status, message),
    };
    brz_mysql::MysqlError::InvalidQuery {
        reason: format!("snapshot:{}:{}", encoded.0, encoded.1),
    }
}

fn decode_snapshot_error(reason: &str) -> Option<SnapshotError> {
    let rest = reason.strip_prefix("snapshot:")?;
    let (status, message) = rest.split_once(':')?;
    let status = status.parse().ok()?;
    if status == 422 {
        return Some(SnapshotError::Invalid(message.to_owned()));
    }
    Some(SnapshotError::Http(status, message.to_owned()))
}

/// `on_project_chat_execution_snapshot`: validate, reconcile and answer.
pub(crate) async fn handle(
    state: &crate::state::AppState,
    runtime: &std::sync::Arc<super::runtime::SocketRuntime>,
    user_id: i64,
    data: &Value,
) -> Value {
    let snapshot = match parse_snapshot(data) {
        Ok(snapshot) => snapshot,
        Err(error) => return error.ack(),
    };
    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            reconcile(state, transaction, user_id, &snapshot)
                .await
                .map_err(as_mysql_error)
        })
        .await;
    let reconciled = match outcome {
        Ok(reconciled) => reconciled,
        Err(brz_mysql::MysqlError::InvalidQuery { reason }) => {
            return decode_snapshot_error(&reason)
                .map(|error| error.ack())
                .unwrap_or_else(|| SnapshotError::Http(500, "Internal Server Error".into()).ack());
        }
        Err(_) => return SnapshotError::Http(500, "Internal Server Error".into()).ack(),
    };
    for message in &reconciled.messages {
        let project_id = message
            .get("projectId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let task_id = message.get("taskId").and_then(Value::as_str);
        let rooms = match super::chat_audience::rooms(&state.mysql, project_id, task_id).await {
            Ok(rooms) => rooms,
            Err(error) => {
                tracing::warn!(?error, "Snapshot chat audience unavailable");
                continue;
            }
        };
        for room in rooms {
            if let Err(error) = runtime
                .emitters()
                .project_chat_message(&room, false, message)
                .await
            {
                tracing::warn!(%error, room, "project chat snapshot local delivery failed");
            }
            super::device_lifecycle::publish_room_event(
                state,
                super::device_runtime_event::PROJECT_CHAT_CREATED_EVENT,
                message,
                super::device_runtime_event::RUNTIME_NAMESPACE,
                &room,
            )
            .await;
        }
    }
    for item_id in &reconciled.changed_items {
        publish_item_change(state, runtime, item_id, 0).await;
    }
    for effect in reconciled.effects {
        effect.deliver(state, runtime).await;
    }
    json!({"ok": true, "result": reconciled.messages})
}

pub(super) async fn publish_item_change(
    state: &crate::state::AppState,
    runtime: &std::sync::Arc<super::runtime::SocketRuntime>,
    item_id: &str,
    actor_user_id: i64,
) {
    publish_item_change_with_reason(state, runtime, item_id, actor_user_id, "project_chat").await;
}

pub(super) async fn publish_item_change_with_reason(
    state: &crate::state::AppState,
    runtime: &super::runtime::SocketRuntime,
    item_id: &str,
    actor_user_id: i64,
    reason: &str,
) {
    let recipients = state
        .mysql
        .with_transaction(async |transaction| {
            changed_item_recipients(transaction, item_id, actor_user_id).await
        })
        .await;
    let Ok(Some(recipients)) = recipients else {
        return;
    };
    let payload = json!({
        "projectId": recipients.project_id,
        "itemId": item_id,
        "version": recipients.version,
        "reason": reason,
    });
    for user_id in recipients.users {
        let room = format!("wework-runtime:user:{user_id}");
        if let Err(error) = runtime
            .emitters()
            .loop_item_changed(user_id, &payload)
            .await
        {
            tracing::warn!(%error, room, "loop item changed local delivery failed");
        }
        super::device_lifecycle::publish_room_event(
            state,
            super::device_runtime_event::LOOP_ITEM_CHANGED_EVENT,
            &payload,
            super::device_runtime_event::RUNTIME_NAMESPACE,
            &room,
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_snapshot_parses_camel_case_fields() {
        let snapshot = parse_snapshot(&json!({
            "deviceId": "electron-22508b4b",
            "taskId": "runtime-140211547",
            "running": false,
            "completeHistory": false,
            "turns": [{
                "id": "01a1ac30-0e67-7470-856e-2fe9edeb6f02",
                "userMessageIds": [],
                "status": "done",
                "completedAt": 1793891317000i64
            }]
        }))
        .expect("the recorded snapshot validates");
        assert_eq!(snapshot.device_id, "electron-22508b4b");
        assert_eq!(snapshot.task_id, "runtime-140211547");
        assert_eq!(snapshot.turns[0].status, "done");
        assert_eq!(terminal_status(&snapshot.turns[0]), Some("completed"));
    }

    #[test]
    fn invalid_turns_are_rejected() {
        assert!(
            parse_snapshot(&json!({
                "deviceId": "d",
                "taskId": "t",
                "turns": [{"id": "x", "status": "mystery"}]
            }))
            .is_err()
        );
        assert!(
            parse_snapshot(&json!({
                "deviceId": "",
                "taskId": "t",
                "turns": []
            }))
            .is_err()
        );
        assert!(
            parse_snapshot(&json!({
                "deviceId": "d",
                "taskId": "t",
                "running": "no",
                "turns": []
            }))
            .is_err()
        );
    }

    #[test]
    fn the_chat_read_projects_explicit_unaliased_columns() {
        // Recording 20261105234003, dependencies.jsonl rows 58393/58395: the
        // source selects every modeled column with SQLAlchemy labels; the
        // engine maps the direct table columns but rejects `SELECT *`.
        let sql = chat_statement(3);
        assert!(sql.starts_with("SELECT project_chat_messages.id, "));
        assert!(!sql.contains("SELECT *"));
        assert!(!sql.contains(" AS project_chat_messages_"));
        for column in [
            "project_chat_messages.message_id",
            "project_chat_messages.metadata",
            "project_chat_messages.runtime_task_id",
            "project_chat_messages.status",
            "project_chat_messages.deleted_at",
        ] {
            assert!(sql.contains(column), "{column} is missing");
        }
        assert!(sql.contains("project_chat_messages.runtime_device_id IN (?, ?, ?)"));
        assert!(sql.contains("ORDER BY project_chat_messages.id"));
    }

    #[test]
    fn the_room_follows_the_project_and_task_identity() {
        use crate::socketio::device_runtime_event::project_chat_room;
        assert_eq!(
            project_chat_room("7", Some("task-1")),
            "wework-project-chat:task:7:task-1"
        );
        assert_eq!(
            project_chat_room("7", None),
            "wework-project-chat:project:7"
        );
    }
}
