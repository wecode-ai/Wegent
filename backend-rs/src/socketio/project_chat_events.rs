// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/wework-runtime` project-chat events.
//!
//! Source: `app/api/ws/wework_runtime_namespace.py` (`on_project_chat_subscribe`,
//! `on_project_chat_unsubscribe`, `on_project_chat_message_send`,
//! `on_project_chat_agent_start`, `on_project_chat_agent_failed`,
//! `on_project_chat_comment_execute`) and `app/services/project_chat/service.py`
//! (`subscribe`, `send`, `start_agent_response`, `fail_agent_response`,
//! `_require_scope`).
//!
//! `comment:execute`'s migration stops at the scope check: the recorded case
//! targets a missing project task, and the AI comment-execution pipeline
//! (loop item assignments, robot queue) remains a documented remainder.
//!
//! Additional remainders, none exercised by the recorded case: mention
//! validation/notification rows for non-empty `mentions`, loop-item
//! `change_request`/`ai_state` side effects for task-thread messages, the
//! subscribe catch-up pagination loop, and `_reconcile_ai_run_projection`.

use std::sync::Arc;

use brz_mysql::MysqlTransaction;
use brz_socket_io::{ClientError, Reply};
use serde_json::{Map, Value, json};

use super::project_chat_mentions::{self, Mention};
use super::project_chat_messages::{
    InsertMessage, existing_agent_response, existing_client_message, insert_message,
    load_active_agent_response, load_agent, load_message_by_id, load_message_by_message_id,
    load_messages, load_trigger, load_user_message, message_view, metadata_map,
    project_task_exists, runtime_activity_key, update_message, utc_isoformat_micros, uuid4,
    validate_agent,
};
use crate::background_jobs::project::notifications;
use crate::board_snapshot::repository::{BoardSnapshotRepository, ProjectAccess, has_permission};
use crate::loop_item_pages::PageIssue;
use crate::loop_tasks::{assignment_repository, assignments, loop_repository::LoopItemRepository};
use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::device_runtime_event::{
    PROJECT_CHAT_CREATED_EVENT, RUNTIME_NAMESPACE, project_chat_room,
};
use crate::socketio::runtime::SocketRuntime;
use crate::state::AppState;

#[path = "project_chat_send.rs"]
mod message_send;
use message_send::send_message;

/// `PROJECT_CHAT_SEND`'s defaults and bounds.
const CONTENT_MAX: usize = 100_000;
const IDENTIFIER_MAX: usize = 64;
const DEFAULT_LIMIT: i64 = 200;
const LIMIT_MAX: i64 = 500;
/// The normalized camelCase payload (`project_chat_payload`).
fn payload(data: &Value) -> Map<String, Value> {
    let aliases = [
        ("clientMessageId", "client_message_id"),
        ("projectId", "project_id"),
        ("taskId", "task_id"),
        ("replyToMessageId", "reply_to_message_id"),
        ("triggerMessageId", "trigger_message_id"),
        ("afterSequence", "after_sequence"),
    ];
    let mut out = Map::new();
    let Some(object) = data.as_object() else {
        return out;
    };
    for (key, value) in object {
        let key = aliases
            .iter()
            .find(|(alias, _)| alias == key)
            .map_or(key.clone(), |(_, name)| (*name).to_string());
        out.insert(key, value.clone());
    }
    out
}

/// `project_chat_error` / `project_chat_exception_ack`'s ACK shape.
pub(crate) fn ack_error(code: &str, message: &str) -> Value {
    json!({"ok": false, "error": {"code": code, "message": message}})
}

/// The source `HTTPException`/validation mapping for one scope failure.
pub(super) enum ScopeError {
    NotFound(&'static str),
    Forbidden(&'static str),
    Invalid(String),
}

impl ScopeError {
    pub(super) fn ack(&self) -> Value {
        match self {
            Self::NotFound(message) => ack_error("SCOPE_NOT_FOUND", message),
            Self::Forbidden(message) => ack_error("SCOPE_FORBIDDEN", message),
            Self::Invalid(message) => ack_error("INVALID_MESSAGE", message),
        }
    }
}

/// Authorize the project and, for a task thread, the issue in that same project.
pub(super) async fn require_scope(
    state: &AppState,
    user_id: i64,
    project_id: &str,
    task_id: Option<&str>,
    developer: bool,
) -> Result<(ProjectAccess, Option<PageIssue>), ScopeError> {
    let project_id = project_id
        .parse::<i64>()
        .map_err(|_| ScopeError::Invalid("project_id: Input should be a valid integer".into()))?;
    let access = BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(project_id, user_id as i32)
        .await
        .map_err(|error| {
            tracing::error!(%error, project_id, "project chat scope read failed");
            ScopeError::NotFound("Cloud project not found")
        })?
        .ok_or(ScopeError::NotFound("Cloud project not found"))?;
    if !has_permission(&access.role, "Viewer") {
        return Err(ScopeError::Forbidden("Insufficient permission"));
    }
    let mut external_issue = None;
    if let Some(task_id) = task_id {
        let missing = || ScopeError::NotFound("Project task not found");
        if matches!(access.project.task_provider().as_str(), "github" | "gitlab") {
            let missing_issue = || ScopeError::NotFound("TODO not found");
            let issue_project = LoopItemRepository::new(&state.mysql)
                .find_external_project(task_id)
                .await
                .map_err(|_| missing_issue())?
                .ok_or_else(missing_issue)?;
            if issue_project.id != access.project.id {
                return Err(missing());
            }
            external_issue = Some(
                assignments::require_provider_issue_view(state, &access, task_id, user_id as i32)
                    .await
                    .map_err(|_| missing_issue())?,
            );
        } else {
            if !project_task_exists(state, &access.project.id, task_id).await {
                return Err(missing());
            }
            let item = assignment_repository::loop_item_access(&state.mysql, task_id)
                .await
                .map_err(|_| missing())?
                .filter(|item| item.cloud_project_id == access.project.id)
                .ok_or_else(missing)?;
            if !assignments::can_view_item(state, &access, &item, user_id as i32)
                .await
                .map_err(|_| missing())?
            {
                return Err(missing());
            }
        }
    }
    if developer && !has_permission(&access.role, "Developer") {
        return Err(ScopeError::Forbidden("Insufficient permission"));
    }
    Ok((access, external_issue))
}

/// `on_project_chat_subscribe`.
pub(crate) async fn subscribe(
    state: &AppState,
    user_id: i64,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let request = match SubscribeRequest::parse(&payload(&data)) {
        Ok(request) => request,
        Err(message) => return Ok(Reply::payload(ack_error("INVALID_MESSAGE", &message))),
    };
    if let Err(scope) = require_scope(
        state,
        user_id,
        &request.project_id,
        request.task_id.as_deref(),
        false,
    )
    .await
    {
        return Ok(Reply::payload(scope.ack()));
    }
    let messages = match load_messages(
        state,
        &request.project_id,
        request.task_id.as_deref(),
        request.after_sequence,
        request.limit,
    )
    .await
    {
        Ok(messages) => messages,
        Err(failure) => return Ok(Reply::payload(failure)),
    };
    let latest_sequence = messages
        .last()
        .and_then(|message| message.get("sequenceNumber"))
        .and_then(Value::as_i64)
        .unwrap_or(request.after_sequence);
    let room = project_chat_room(&request.project_id, request.task_id.as_deref());
    Ok(Reply::payload(json!({
        "ok": true,
        "result": {
            "messages": messages,
            "currentUserId": user_id.to_string(),
            "latestSequence": latest_sequence,
        },
    }))
    .join(room))
}

/// `ProjectChatSubscribe`.
struct SubscribeRequest {
    project_id: String,
    task_id: Option<String>,
    after_sequence: i64,
    limit: i64,
}

impl SubscribeRequest {
    fn parse(payload: &Map<String, Value>) -> Result<Self, String> {
        Ok(Self {
            project_id: required_identifier(payload, "project_id")?,
            task_id: optional_identifier(payload, "task_id")?,
            after_sequence: optional_i64(payload, "after_sequence").unwrap_or(0).max(0),
            limit: optional_i64(payload, "limit")
                .unwrap_or(DEFAULT_LIMIT)
                .clamp(1, LIMIT_MAX),
        })
    }
}

/// `on_project_chat_unsubscribe`.
pub(crate) async fn unsubscribe(data: Value) -> Result<Reply<Value>, ClientError> {
    let payload = payload(&data);
    let (Ok(project_id), task_id) = (
        required_identifier(&payload, "project_id"),
        optional_identifier(&payload, "task_id").unwrap_or(None),
    ) else {
        return Ok(Reply::payload(ack_error("INVALID_MESSAGE", "project_id")));
    };
    Ok(Reply::payload(json!({"ok": true}))
        .leave(project_chat_room(&project_id, task_id.as_deref())))
}

/// `on_project_chat_message_send`.
pub(crate) async fn send(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    user_id: i64,
    user_name: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let request = match SendRequest::parse(&payload(&data)) {
        Ok(request) => request,
        Err(message) => return Ok(Reply::payload(ack_error("INVALID_MESSAGE", &message))),
    };
    let (access, _) = match require_scope(
        state,
        user_id,
        &request.project_id,
        request.task_id.as_deref(),
        true,
    )
    .await
    {
        Ok(scope) => scope,
        Err(scope) => return Ok(Reply::payload(scope.ack())),
    };
    match send_message(state, user_id, user_name, &request, &access).await {
        Ok((view, created)) => {
            if created {
                emit_created(state, runtime, &view).await;
                if let Some(item_id) = request.task_id.as_deref() {
                    super::project_chat_snapshot::publish_item_change(
                        state, runtime, item_id, user_id,
                    )
                    .await;
                }
            }
            Ok(Reply::payload(json!({
                "ok": true,
                "created": created,
                "clientMessageId": request.client_message_id,
                "result": view,
            })))
        }
        Err(ack) => Ok(Reply::payload(ack)),
    }
}

/// `ProjectChatSend`.
struct SendRequest {
    client_message_id: String,
    project_id: String,
    task_id: Option<String>,
    content: String,
    reply_to_message_id: Option<String>,
    model: Option<String>,
    mentions: Vec<Mention>,
}

impl SendRequest {
    fn parse(payload: &Map<String, Value>) -> Result<Self, String> {
        let content = required_string(payload, "content")?;
        if content.len() > CONTENT_MAX {
            return Err("content: String should have at most 100000 characters".into());
        }
        Ok(Self {
            client_message_id: required_identifier(payload, "client_message_id")?,
            project_id: required_identifier(payload, "project_id")?,
            task_id: optional_identifier(payload, "task_id")?,
            content,
            reply_to_message_id: optional_identifier(payload, "reply_to_message_id")?,
            model: optional_string(payload, "model"),
            mentions: Mention::parse(payload.get("mentions"))?,
        })
    }
}

/// `on_project_chat_agent_start`.
pub(crate) async fn agent_start(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    user_id: i64,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let request = match AgentStartRequest::parse(&payload(&data)) {
        Ok(request) => request,
        Err(message) => return Ok(Reply::payload(ack_error("INVALID_MESSAGE", &message))),
    };
    if let Err(scope) = require_scope(
        state,
        user_id,
        &request.project_id,
        request.task_id.as_deref(),
        true,
    )
    .await
    {
        return Ok(Reply::payload(scope.ack()));
    }
    match start_agent(state, user_id, &request).await {
        Ok(view) => {
            emit_created(state, runtime, &view).await;
            Ok(Reply::payload(json!({"ok": true, "result": view})))
        }
        Err(ack) => Ok(Reply::payload(ack)),
    }
}

/// `ProjectChatAgentStart`.
pub(crate) struct AgentStartRequest {
    pub(crate) project_id: String,
    pub(crate) task_id: Option<String>,
    pub(crate) trigger_message_id: Option<String>,
    pub(crate) agent_id: String,
    pub(crate) runtime_device_id: String,
    pub(crate) runtime_task_id: String,
    pub(crate) _prompt: Option<String>,
    pub(crate) auto_retry: bool,
    pub(crate) model: Option<String>,
}

impl AgentStartRequest {
    fn parse(payload: &Map<String, Value>) -> Result<Self, String> {
        Ok(Self {
            project_id: required_identifier(payload, "project_id")?,
            task_id: optional_identifier(payload, "task_id")?,
            trigger_message_id: optional_identifier(payload, "trigger_message_id")?,
            agent_id: required_bounded(payload, "agent_id", 1, 128)?,
            runtime_device_id: required_bounded(payload, "runtime_device_id", 1, 255)?,
            runtime_task_id: required_bounded(payload, "runtime_task_id", 1, 255)?,
            _prompt: optional_string(payload, "prompt"),
            auto_retry: payload
                .get("auto_retry")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            model: optional_string(payload, "model"),
        })
    }
}

/// `start_agent_response`.
async fn start_agent(
    state: &AppState,
    user_id: i64,
    request: &AgentStartRequest,
) -> Result<Value, Value> {
    let agent = load_agent(state, &request.agent_id).await?;
    validate_agent(&agent, &request.project_id, user_id)?;
    let trigger = match &request.trigger_message_id {
        Some(trigger_id) => {
            let found = load_trigger(
                state,
                &request.project_id,
                request.task_id.as_deref(),
                trigger_id,
            )
            .await?;
            if found.is_none() {
                return Err(ack_error(
                    "MESSAGE_CONFLICT",
                    "AI response must be attached to its project chat message",
                ));
            }
            found
        }
        None => None,
    };
    if let Some(existing) = existing_agent_response(state, request).await? {
        if existing.status == "streaming" {
            let mut metadata = metadata_map(&existing);
            metadata.insert("run_status".into(), Value::String("running".into()));
            update_message(
                state,
                &existing,
                existing.message_type.as_str(),
                None,
                &metadata,
                Value::String("streaming".into()),
            )
            .await?;
            let refreshed = load_message_by_id(state, existing.id)
                .await?
                .ok_or_else(|| ack_error("INVALID_MESSAGE", "message refresh lost the row"))?;
            return Ok(message_view(&refreshed));
        }
        return Ok(message_view(&existing));
    }
    let message_id = uuid4();
    let run_id = uuid4();
    let mut metadata = Map::new();
    metadata.insert("run_id".into(), Value::String(run_id));
    metadata.insert("run_status".into(), Value::String("running".into()));
    metadata.insert("auto_retry".into(), Value::Bool(request.auto_retry));
    metadata.insert("started_by_user_id".into(), Value::from(user_id));
    if let Some(model) = &request.model {
        metadata.insert("model".into(), Value::String(model.clone()));
    }
    let trigger_id = request.trigger_message_id.as_deref().unwrap_or_default();
    let reply_to = trigger
        .as_ref()
        .map(|row| row.message_id.clone())
        .unwrap_or_default();
    let root = trigger
        .as_ref()
        .map(|row| {
            if row.thread_root_message_id.is_empty() {
                row.message_id.clone()
            } else {
                row.thread_root_message_id.clone()
            }
        })
        .unwrap_or_default();
    let activity_key = runtime_activity_key(
        &request.runtime_device_id,
        &request.runtime_task_id,
        trigger_id,
    );
    let id = insert_message(
        state,
        &InsertMessage {
            message_id: &message_id,
            client_message_id: &message_id,
            project_id: &request.project_id,
            task_id: request.task_id.as_deref().unwrap_or_default(),
            sender_type: "agent",
            sender_id: &agent.id,
            sender_name: &agent.sender_name(),
            message_type: "agent_chunk",
            content: "",
            metadata: Value::Object(metadata),
            trigger_message_id: trigger_id,
            reply_to_message_id: &reply_to,
            thread_root_message_id: &root,
            agent_id: &request.agent_id,
            runtime_device_id: &request.runtime_device_id,
            runtime_task_id: &request.runtime_task_id,
            runtime_activity_key: activity_key.as_deref().unwrap_or_default(),
            status: "streaming",
        },
    )
    .await?;
    let row = load_message_by_id(state, id)
        .await?
        .ok_or_else(|| ack_error("INVALID_MESSAGE", "message refresh lost the row"))?;
    Ok(message_view(&row))
}

/// `on_project_chat_agent_failed`.
pub(crate) async fn agent_failed(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    user_id: i64,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let request = match AgentFailureRequest::parse(&payload(&data)) {
        Ok(request) => request,
        Err(message) => return Ok(Reply::payload(ack_error("INVALID_MESSAGE", &message))),
    };
    if let Err(scope) = require_scope(
        state,
        user_id,
        &request.project_id,
        request.task_id.as_deref(),
        true,
    )
    .await
    {
        return Ok(Reply::payload(scope.ack()));
    }
    match fail_agent(state, user_id, &request).await {
        Ok(view) => {
            emit_created(state, runtime, &view).await;
            Ok(Reply::payload(json!({"ok": true, "result": view})))
        }
        Err(ack) => Ok(Reply::payload(ack)),
    }
}

/// `ProjectChatAgentFailure`.
pub(crate) struct AgentFailureRequest {
    pub(crate) project_id: String,
    pub(crate) task_id: Option<String>,
    pub(crate) message_id: String,
    pub(crate) error: Option<String>,
}

impl AgentFailureRequest {
    fn parse(payload: &Map<String, Value>) -> Result<Self, String> {
        Ok(Self {
            project_id: required_identifier(payload, "project_id")?,
            task_id: optional_identifier(payload, "task_id")?,
            message_id: required_identifier(payload, "message_id")?,
            error: optional_string(payload, "error"),
        })
    }
}

/// `fail_agent_response`.
async fn fail_agent(
    state: &AppState,
    user_id: i64,
    request: &AgentFailureRequest,
) -> Result<Value, Value> {
    let Some(row) = load_active_agent_response(state, request).await? else {
        return Err(ack_error("SCOPE_NOT_FOUND", "Active AI response not found"));
    };
    let trigger = if row.trigger_message_id.is_empty() {
        None
    } else {
        load_user_message(state, &row.trigger_message_id, user_id).await?
    };
    let started_by_user = row.trigger_message_id.is_empty()
        && row
            .metadata()
            .get("started_by_user_id")
            .and_then(Value::as_i64)
            == Some(user_id);
    if trigger.is_none() && !started_by_user {
        return Err(ack_error(
            "SCOPE_FORBIDDEN",
            "Only the sender can fail this AI response",
        ));
    }
    let message = request.error.clone().unwrap_or_default();
    let content = if row.content.is_empty() && !message.is_empty() {
        Some(message.as_str())
    } else {
        None
    };
    let mut metadata = metadata_map(&row);
    metadata.insert("run_status".into(), Value::String("failed".into()));
    metadata.insert("activity_at".into(), Value::String(utc_isoformat_micros()));
    update_message(
        state,
        &row,
        "text",
        content,
        &metadata,
        Value::String("failed".into()),
    )
    .await?;
    let refreshed = load_message_by_id(state, row.id)
        .await?
        .ok_or_else(|| ack_error("INVALID_MESSAGE", "message refresh lost the row"))?;
    Ok(message_view(&refreshed))
}

/// `on_project_chat_comment_execute`'s migrated scope check.
pub(crate) async fn comment_execute(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    user_id: i64,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let payload = payload(&data);
    let (Ok(project_id), Ok(task_id), Ok(trigger_id)) = (
        required_identifier(&payload, "project_id"),
        required_identifier(&payload, "task_id"),
        required_identifier(&payload, "trigger_message_id"),
    ) else {
        return Ok(Reply::payload(ack_error(
            "INVALID_MESSAGE",
            "invalid payload",
        )));
    };
    if let Err(scope) = require_scope(state, user_id, &project_id, Some(&task_id), true).await {
        return Ok(Reply::payload(scope.ack()));
    }
    let trigger = match super::project_chat_messages::load_comment_trigger(
        state,
        &project_id,
        &task_id,
        &trigger_id,
        user_id,
    )
    .await
    {
        Ok(Some(trigger)) => trigger,
        Ok(None) => {
            return Ok(Reply::payload(ack_error(
                "SCOPE_NOT_FOUND",
                "The saved comment was not found",
            )));
        }
        Err(ack) => return Ok(Reply::payload(ack)),
    };
    if trigger.metadata()["execution_dispatch"] == "comment_only" {
        return Ok(Reply::payload(json!({"ok": true, "result": []})));
    }
    match super::project_chat_comment::enqueue_root(state, user_id, &trigger, &payload).await {
        Ok((result, created)) => {
            if created {
                for message in &result {
                    emit_created(state, runtime, message).await;
                }
            }
            Ok(Reply::payload(json!({"ok": true, "result": result})))
        }
        Err(ack) => {
            tracing::warn!(
                task_id,
                trigger_id,
                user_id,
                error_code = ack["error"]["code"].as_str().unwrap_or("unknown"),
                "Project chat comment execution was rejected"
            );
            Ok(Reply::payload(ack))
        }
    }
}

/// `sio.emit(PROJECT_CHAT_CREATED_EVENT, message, room=...)`.
async fn emit_created(state: &AppState, runtime: &Arc<SocketRuntime>, view: &Value) {
    let project_id = view
        .get("projectId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let task_id = view.get("taskId").and_then(Value::as_str);
    let room = project_chat_room(project_id, task_id);
    if let Err(error) = runtime
        .emitters()
        .project_chat_message(&room, false, view)
        .await
    {
        tracing::warn!(%error, room, "project chat local delivery failed");
    }
    publish_room_event(
        state,
        PROJECT_CHAT_CREATED_EVENT,
        view,
        RUNTIME_NAMESPACE,
        &room,
    )
    .await;
}

/// A required bounded identifier field.
pub(crate) fn required_identifier(
    payload: &Map<String, Value>,
    key: &str,
) -> Result<String, String> {
    required_bounded(payload, key, 1, IDENTIFIER_MAX)
}

/// An optional bounded identifier field.
pub(crate) fn optional_identifier(
    payload: &Map<String, Value>,
    key: &str,
) -> Result<Option<String>, String> {
    match payload.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.len() <= IDENTIFIER_MAX => Ok(Some(value.clone())),
        Some(_) => Err(format!("{key}: invalid identifier")),
    }
}

/// A required bounded string field.
pub(crate) fn required_bounded(
    payload: &Map<String, Value>,
    key: &str,
    min: usize,
    max: usize,
) -> Result<String, String> {
    match payload.get(key).and_then(Value::as_str) {
        Some(value) if value.len() >= min && value.len() <= max => Ok(value.to_string()),
        _ => Err(format!("{key}: Field required")),
    }
}

/// A required free string field with the content bound.
pub(crate) fn required_string(payload: &Map<String, Value>, key: &str) -> Result<String, String> {
    match payload.get(key).and_then(Value::as_str) {
        Some(value) if !value.is_empty() => Ok(value.to_string()),
        _ => Err(format!("{key}: Field required")),
    }
}

/// An optional free string field.
pub(crate) fn optional_string(payload: &Map<String, Value>, key: &str) -> Option<String> {
    payload.get(key).and_then(Value::as_str).map(str::to_string)
}

/// An optional SQL integer.
pub(crate) fn optional_i64(payload: &Map<String, Value>, key: &str) -> Option<i64> {
    match payload.get(key)? {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::socketio::project_chat_messages::MessageRow;

    #[test]
    fn payload_aliases_normalize_the_public_shape() {
        let normalized = payload(&json!({
            "projectId": "p",
            "clientMessageId": "c",
            "taskId": "t",
            "afterSequence": 4
        }));
        assert_eq!(normalized.get("project_id"), Some(&json!("p")));
        assert_eq!(normalized.get("client_message_id"), Some(&json!("c")));
        assert_eq!(normalized.get("task_id"), Some(&json!("t")));
        assert_eq!(normalized.get("after_sequence"), Some(&json!(4)));
    }

    #[test]
    fn the_view_renders_empty_columns_as_null() {
        let row = MessageRow {
            id: 1345,
            message_id: "m".into(),
            client_message_id: String::new(),
            project_id: "1562781927862537980".into(),
            task_id: String::new(),
            sender_type: "user".into(),
            sender_id: "157".into(),
            sender_name: "sifang".into(),
            message_type: "text".into(),
            content: "hi".into(),
            metadata: None,
            trigger_message_id: String::new(),
            reply_to_message_id: String::new(),
            thread_root_message_id: String::new(),
            agent_id: String::new(),
            runtime_device_id: String::new(),
            runtime_task_id: String::new(),
            status: "completed".into(),
            created_at: chrono::NaiveDate::from_ymd_opt(2026, 11, 9)
                .unwrap()
                .and_hms_opt(13, 13, 8)
                .unwrap(),
            updated_at: chrono::NaiveDate::from_ymd_opt(2026, 11, 9)
                .unwrap()
                .and_hms_opt(13, 13, 8)
                .unwrap(),
        };
        let view = message_view(&row);
        assert_eq!(view["clientMessageId"], Value::Null);
        assert_eq!(view["taskId"], Value::Null);
        assert_eq!(view["createdAt"], json!("2026-11-09T05:13:08+00:00"));
        assert_eq!(view["metadata"], json!({}));
    }

    #[test]
    fn activity_keys_match_the_source_sha256() {
        let key = runtime_activity_key("d", "t", "m").expect("identity");
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(runtime_activity_key("", "t", "m").is_none());
    }
}
