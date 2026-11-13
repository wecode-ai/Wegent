// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/chat` `chat:retry`.
//!
//! Source: `app/api/ws/chat_namespace.py::on_chat_retry` and
//! `_prepare_chat_retry_dispatch`, `app/services/chat/operations/retry.py`
//! (`fetch_retry_context`, `reset_subtask_for_retry`,
//! `extract_model_override_info`), then `trigger_ai_response_unified`.
//!
//! The Same-ID retry reuses the failed assistant subtask, resets it to
//! PENDING, applies the model override labels, and dispatches the same
//! execution request as `chat:send` (built by [`super::chat_trigger`]).

use std::sync::Arc;

use brz_json::OpaqueJson;
use brz_mysql::{Json, MysqlTransaction as _};
use brz_redis::Redis as _;
use brz_socket_io::{ClientError, Reply};
use serde_json::{Map, Value, json};

use crate::json_compat::python_json_value;
use crate::request_sql::{RouteKey, fetch_optional_as};
use crate::socketio::chat_session::ChatSession;
use crate::socketio::chat_trigger::ChatTurn;
use crate::sql_support::StatementArg;
use crate::state::AppState;
use crate::task_detail_api::assembly::extract_display_prompt;
use crate::task_store::task_update_timestamp;

use super::chat_support::{access_denied, error_ack, expired, internal_error};

/// The terminal statuses a failed assistant subtask may be retried from.
const RETRYABLE_STATUSES: [&str; 2] = ["FAILED", "CANCELLED"];
/// `_is_code_wiki_task`'s generation-bound label.
const CODE_WIKI_SOURCE: &str = "code_wiki";

/// `on_chat_retry`.
pub(crate) async fn retry(
    state: &Arc<AppState>,
    runtime: &Arc<crate::socketio::runtime::SocketRuntime>,
    session: &ChatSession,
    socket_id: &str,
    data: Value,
) -> Result<Reply<Value>, ClientError> {
    let Some(payload) = RetryPayload::parse(&data) else {
        return Ok(Reply::payload(error_ack("Invalid payload")));
    };
    if let Some(pending) = expired(session, state, runtime, socket_id) {
        return Ok(Reply::payload(pending.await));
    }
    let user_id = session.user_id();
    if user_id == 0 {
        return Ok(Reply::payload(error_ack("Not authenticated")));
    }
    if let Some(ack) = access_denied(state, session, payload.task_id, "chat:retry").await? {
        return Ok(Reply::payload(ack));
    }
    let prepared = match prepare_retry(state, user_id, &payload).await {
        Ok(prepared) => prepared,
        Err(RetryFailure::Ack(ack)) => return Ok(Reply::payload(ack)),
        Err(RetryFailure::Internal) => return Err(internal_error()),
    };
    match super::chat_trigger::trigger_existing(state, &prepared.turn, user_id).await {
        Ok(()) => Ok(Reply::payload(json!({"success": true}))),
        Err(error) => {
            tracing::error!(
                ?error,
                task_id = payload.task_id,
                subtask_id = payload.subtask_id,
                "chat:retry trigger failed"
            );
            Ok(Reply::payload(error_ack("Internal server error")))
        }
    }
}

/// `ChatRetryPayload`.
struct RetryPayload {
    task_id: i64,
    subtask_id: i64,
    force_override_bot_model: Option<String>,
    force_override_bot_model_type: Option<String>,
    use_model_override: bool,
}

impl RetryPayload {
    fn parse(data: &Value) -> Option<Self> {
        Some(Self {
            task_id: data.get("task_id").and_then(Value::as_i64)?,
            subtask_id: data.get("subtask_id").and_then(Value::as_i64)?,
            force_override_bot_model: data
                .get("force_override_bot_model")
                .and_then(Value::as_str)
                .map(str::to_string),
            force_override_bot_model_type: data
                .get("force_override_bot_model_type")
                .and_then(Value::as_str)
                .map(str::to_string),
            use_model_override: data
                .get("use_model_override")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }
}

/// Why retry preparation stopped.
enum RetryFailure {
    /// The source returns this error dict to the client.
    Ack(Value),
    /// A dependency read or write failed.
    Internal,
}

/// The trigger input after the reset.
struct PreparedRetry {
    turn: ChatTurn,
}

/// One failed assistant subtask (`fetch_retry_context`).
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct FailedSubtask {
    #[mysql(rename = "id")]
    id: i64,
    #[mysql(rename = "team_id")]
    team_id: i64,
    #[mysql(rename = "parent_id")]
    parent_id: Option<i64>,
    #[mysql(rename = "status")]
    status: String,
    #[mysql(rename = "message_id")]
    message_id: i64,
    #[mysql(rename = "executor_name")]
    executor_name: Option<String>,
    #[mysql(rename = "executor_namespace")]
    executor_namespace: Option<String>,
    #[mysql(rename = "created_at")]
    created_at: Option<chrono::NaiveDateTime>,
}

/// One user subtask (`get_user_by_task_message_id`).
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct UserSubtask {
    #[mysql(rename = "id")]
    id: i64,
    #[mysql(rename = "prompt")]
    prompt: Option<String>,
    #[mysql(rename = "result")]
    result: Option<Json<OpaqueJson>>,
}

/// One task row (`get_non_deleted_task`).
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct TaskRow {
    #[mysql(rename = "user_id")]
    user_id: i32,
    #[mysql(rename = "json")]
    json: Json<OpaqueJson>,
}

/// `_prepare_chat_retry_dispatch`.
async fn prepare_retry(
    state: &Arc<AppState>,
    user_id: i64,
    payload: &RetryPayload,
) -> Result<PreparedRetry, RetryFailure> {
    let tables = state
        .task_store
        .message_edit_tables(payload.task_id)
        .await
        .map_err(|_| RetryFailure::Internal)?;
    let failed = fetch_failed_subtask(state, &tables.subtasks, payload).await?;
    let Some(failed) = failed else {
        return Err(RetryFailure::Ack(error_ack("AI subtask not found")));
    };
    let task = fetch_task(state, &tables.tasks, payload.task_id).await?;
    let Some(task) = task else {
        return Err(RetryFailure::Ack(error_ack("Task not found")));
    };
    let task_owner = i64::from(task.user_id);
    let team = crate::responses::create::resolution::team_by_id(&state.mysql, failed.team_id)
        .await
        .map_err(|_| RetryFailure::Internal)?;
    let Some(team) = team else {
        return Err(RetryFailure::Ack(error_ack("Team not found")));
    };
    let user_subtask = match failed.parent_id {
        Some(parent_id) => {
            fetch_user_subtask(state, &tables.subtasks, payload.task_id, parent_id).await?
        }
        None => None,
    };
    let Some(user_subtask) = user_subtask else {
        return Err(RetryFailure::Ack(error_ack("User message not found")));
    };
    let mut task_json = task.json.0.to_value();
    if is_code_wiki_task(&task_json) {
        tracing::info!(
            task_id = payload.task_id,
            "chat:retry rejected for Code Wiki task"
        );
        return Err(RetryFailure::Ack(error_ack(
            "Code Wiki task retry is not supported. Start a new Code Wiki generation.",
        )));
    }
    if !RETRYABLE_STATUSES.contains(&failed.status.as_str()) {
        return Err(RetryFailure::Ack(error_ack(&format!(
            "Cannot retry subtask in {} state",
            failed.status
        ))));
    }
    reset_subtask_for_retry(
        state,
        &tables,
        payload,
        &failed.status,
        task_owner,
        &mut task_json,
    )
    .await?;
    let user = crate::user_reader::user_entity_by_id(&state.mysql, user_id)
        .await
        .map_err(|_| RetryFailure::Internal)?;
    let Some(_user) = user else {
        return Err(RetryFailure::Ack(error_ack("User not found")));
    };
    apply_model_override(state, &tables.tasks, payload, task_owner, &mut task_json).await?;
    let bot_ids = team_bot_ids(state, &team).await?;
    let message = extract_display_prompt(user_subtask.prompt.as_deref()).unwrap_or_default();
    // Follow-ups reuse the device bound to the Task (`extract_task_device_id`).
    let device_id = task_json
        .pointer("/spec/device_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(PreparedRetry {
        turn: ChatTurn {
            task_id: payload.task_id,
            user_subtask_id: user_subtask.id,
            assistant_subtask_id: failed.id,
            user_message_id: failed.parent_id.unwrap_or_default(),
            assistant_message_id: failed.message_id,
            team_id: team.id,
            bot_ids,
            new_session: false,
            message,
            interactive_form_answer: None,
            additional_skills: Vec::new(),
            options: super::chat_trigger::ChatTurnOptions {
                generation: user_subtask
                    .result
                    .as_ref()
                    .and_then(|result| retry_image_generation(&result.0.to_value())),
                ..Default::default()
            },
            is_group_chat: task_json
                .pointer("/spec/is_group_chat")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            project_id: 0,
            client_origin: "frontend".to_string(),
            device_id,
            task_json,
            created_git_repository: None,
            executor_name: failed.executor_name.unwrap_or_default(),
            executor_namespace: failed.executor_namespace.unwrap_or_default(),
            assistant_created_at: failed.created_at,
            user_created_at: String::new(),
            existing_history: Vec::new(),
            existing_subtask_ids: Vec::new(),
            has_conversation_references: true,
        },
    })
}

/// `subtask_store.get_retry_assistant`.
async fn fetch_failed_subtask(
    state: &AppState,
    table: &str,
    payload: &RetryPayload,
) -> Result<Option<FailedSubtask>, RetryFailure> {
    let statement = format!(
        "SELECT id, task_id, team_id, parent_id, status, message_id, executor_name, \
         executor_namespace, created_at FROM `{table}` WHERE id = ? AND task_id = ? \
         AND `role` = 'ASSISTANT' LIMIT 1"
    );
    let mut handle = &state.mysql;
    fetch_optional_as(
        &mut handle,
        RouteKey::None,
        &statement,
        vec![
            StatementArg::Int(payload.subtask_id),
            StatementArg::Int(payload.task_id),
        ],
    )
    .await
    .map_err(|_| RetryFailure::Internal)
}

/// `task_store.get_non_deleted_task`.
async fn fetch_task(
    state: &AppState,
    table: &str,
    task_id: i64,
) -> Result<Option<TaskRow>, RetryFailure> {
    let statement = format!(
        "SELECT user_id, json FROM `{table}` WHERE id = ? AND kind = 'Task' \
         AND is_active != 0 LIMIT 1"
    );
    let mut handle = &state.mysql;
    fetch_optional_as(
        &mut handle,
        RouteKey::None,
        &statement,
        vec![StatementArg::Int(task_id)],
    )
    .await
    .map_err(|_| RetryFailure::Internal)
}

/// `subtask_store.get_user_by_task_message_id`.
async fn fetch_user_subtask(
    state: &AppState,
    table: &str,
    task_id: i64,
    message_id: i64,
) -> Result<Option<UserSubtask>, RetryFailure> {
    let statement = format!(
        "SELECT id, prompt, result FROM `{table}` WHERE task_id = ? AND message_id = ? \
         AND `role` = 'USER' LIMIT 1"
    );
    let mut handle = &state.mysql;
    fetch_optional_as(
        &mut handle,
        RouteKey::None,
        &statement,
        vec![StatementArg::Int(task_id), StatementArg::Int(message_id)],
    )
    .await
    .map_err(|_| RetryFailure::Internal)
}

fn retry_image_generation(result: &Value) -> Option<Value> {
    let size = result.pointer("/image_config/size")?.as_str()?;
    Some(json!({ "size": size }))
}

/// `_is_code_wiki_task`.
fn is_code_wiki_task(task_json: &Value) -> bool {
    task_json
        .pointer("/metadata/labels/source")
        .and_then(Value::as_str)
        == Some(CODE_WIKI_SOURCE)
}

/// `reset_subtask_for_retry`: reset the subtask and mark the task PENDING on
/// one transaction, then refresh both rows.
async fn reset_subtask_for_retry(
    state: &AppState,
    tables: &crate::task_store::MessageEditTables,
    payload: &RetryPayload,
    previous_status: &str,
    task_owner: i64,
    task_json: &mut Value,
) -> Result<(), RetryFailure> {
    let subtasks = tables.subtasks.clone();
    let task_table = tables.tasks.clone();
    let now = local_isoformat();
    let row_now = task_update_timestamp();
    let mut pending = task_json.clone();
    crate::responses::create::continuation::mark_pending(&mut pending, &local_isoformat());
    let task_payload = python_json_value(&pending);
    let reset = state
        .mysql
        .with_transaction(async |transaction| {
            let updated = transaction
                .execute(
                    &format!(
                        "UPDATE {subtasks} SET status=?, progress=?, result=?, \
                         error_message=?, updated_at=? WHERE {subtasks}.id = ? AND status = ?"
                    ),
                    (
                        "PENDING".to_string(),
                        0_i64,
                        None::<String>,
                        String::new(),
                        now.clone(),
                        payload.subtask_id,
                        previous_status,
                    ),
                )
                .await?;
            if updated.rows_affected == 0 {
                return Ok(false);
            }
            // Clear stale cancellation while the reset is still private to this
            // transaction. A cancel for the new attempt can only see PENDING
            // after commit, and a concurrent retry cannot clear its flag.
            if let Some(redis) = state.redis.as_ref() {
                let key = super::chat_control::cancel_key(payload.subtask_id);
                redis.del(key.as_str()).await.map_err(|error| {
                    tracing::warn!(%error, subtask_id = payload.subtask_id, "retry cancel cleanup failed");
                    brz_mysql::MysqlError::InvalidQuery {
                        reason: "could not clear previous cancellation".to_string(),
                    }
                })?;
            }
            transaction
                .execute(
                    &format!(
                        "UPDATE {task_table} SET json=?, updated_at=? WHERE {task_table}.id = ?"
                    ),
                    (task_payload.clone(), row_now.clone(), payload.task_id),
                )
                .await?;
            Ok(true)
        })
        .await
        .map_err(|_| RetryFailure::Internal)?;
    if !reset {
        return Err(RetryFailure::Ack(error_ack(
            "Subtask state changed before retry",
        )));
    }
    *task_json = pending;
    let _ = state
        .task_store
        .refresh_subtask(payload.task_id, payload.subtask_id)
        .await;
    let _ = state
        .task_store
        .refresh_task(payload.task_id, task_owner)
        .await;
    Ok(())
}

/// `extract_model_override_info` + the label rewrite.
async fn apply_model_override(
    state: &AppState,
    _task_table: &str,
    payload: &RetryPayload,
    task_owner: i64,
    task_json: &mut Value,
) -> Result<(), RetryFailure> {
    let (model_id, model_type) = if payload.use_model_override {
        (
            payload.force_override_bot_model.clone(),
            payload.force_override_bot_model_type.clone(),
        )
    } else {
        extract_model_override_info(task_json)
    };
    let changed = if let Some(model_id) = model_id {
        let labels = labels_mut(task_json);
        labels.insert("modelId".into(), Value::String(model_id));
        labels.insert("forceOverrideBotModel".into(), Value::String("true".into()));
        match model_type {
            Some(model_type) => {
                labels.insert(
                    "forceOverrideBotModelType".into(),
                    Value::String(model_type),
                );
            }
            None => {
                labels.remove("forceOverrideBotModelType");
            }
        }
        true
    } else if payload.use_model_override {
        let labels = labels_mut(task_json);
        let mut changed = false;
        for key in [
            "modelId",
            "forceOverrideBotModel",
            "forceOverrideBotModelType",
        ] {
            changed |= labels.remove(key).is_some();
        }
        changed
    } else {
        false
    };
    if !changed {
        return Ok(());
    }
    let json = python_json_value(task_json);
    state
        .task_store
        .update_task_json(payload.task_id, task_owner, &json, &task_update_timestamp())
        .await
        .map_err(|_| RetryFailure::Internal)?;
    let _ = state
        .task_store
        .refresh_task(payload.task_id, task_owner)
        .await;
    Ok(())
}

/// `Task.metadata.labels` (`setdefault` chains).
fn labels_mut(task_json: &mut Value) -> &mut Map<String, Value> {
    let root = task_json.as_object_mut().expect("task JSON is an object");
    let metadata = root
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let metadata = metadata.as_object_mut().expect("metadata is an object");
    metadata
        .entry("labels".to_string())
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .expect("labels is an object")
}

/// `extract_model_override_info`: `(model_id, force_override)`.
fn extract_model_override_info(task_json: &Value) -> (Option<String>, Option<String>) {
    let labels = task_json.pointer("/metadata/labels");
    let spec = task_json.get("spec");
    let model_id = labels
        .and_then(|labels| labels.get("modelId"))
        .and_then(Value::as_str)
        .or_else(|| {
            spec.and_then(|spec| spec.get("modelId"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let force = labels
        .and_then(|labels| labels.get("forceOverrideBotModel"))
        .and_then(Value::as_str)
        == Some("true")
        || spec
            .and_then(|spec| spec.get("forceOverrideBotModel"))
            .and_then(Value::as_str)
            == Some("true");
    let model_type = labels
        .and_then(|labels| labels.get("forceOverrideBotModelType"))
        .and_then(Value::as_str)
        .map(str::to_string);
    (if force { model_id } else { None }, model_type)
}

/// The team's member bot ids (`get_bot_ids_from_team`).
async fn team_bot_ids(
    state: &AppState,
    team: &crate::responses::create::resolution::KindRow,
) -> Result<Vec<i64>, RetryFailure> {
    let cache = crate::task_skills::kinds::KindCacheStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
        erp: Some(state.erp.as_ref()),
        resolvers: Some(&state.entity_resolvers),
    };
    let bots =
        crate::responses::create::resolution::resolve_team_bots(&cache, team.user_id, &team.json.0)
            .await
            .map_err(|_| RetryFailure::Internal)?;
    Ok(bots.bot_ids)
}

/// `datetime.now().isoformat()`.
fn local_isoformat() -> String {
    chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%dT%H:%M:%S%.6f")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_restores_image_size_from_the_user_turn() {
        assert_eq!(
            retry_image_generation(&json!({
                "image_config": {"model": "gpt-image-e2e", "size": "1536x1024"}
            })),
            Some(json!({ "size": "1536x1024" }))
        );
        assert_eq!(retry_image_generation(&Value::Null), None);
        assert_eq!(
            retry_image_generation(&json!({"image_config": {"size": null}})),
            None
        );
    }
}
