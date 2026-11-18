//! Native Web Chat execution remains owned by the Python evidence lifecycle.

use serde_json::{Value, json};

use crate::{http_compat::FastApiError, state::AppState};

use super::chat_trigger::ChatTurn;

/// Capture cancellation ownership from the persisted identity, not a client hint.
/// This selects the execution owner; it does not enable evidence generation.
pub(super) async fn captured_generation(
    state: &AppState,
    task_id: i64,
    answer_id: i64,
) -> Result<Option<String>, FastApiError> {
    let tables = crate::internal_callback::tables(state);
    let row: Option<brz_mysql::MysqlRow> = state
        .mysql
        .route(crate::task_routing::ByTaskId(task_id as u64))
        .fetch_optional(
            format!(
                "SELECT answer_generation_id FROM {} WHERE id = ? AND task_id = ?",
                tables.subtasks
            ),
            (answer_id, task_id),
        )
        .await
        .map_err(|_| FastApiError::internal())?;
    match row {
        Some(row) => row
            .get::<String>("answer_generation_id")
            .map_err(|_| FastApiError::internal()),
        None => Ok(None),
    }
}

/// Use an exact private Python URL; a failed RPC never selects the Rust writer.
pub(super) async fn operation(
    state: &AppState,
    body: &Value,
) -> Result<Option<Value>, FastApiError> {
    let origin = crate::config::env_or_dotenv("WEGENT_PYTHON_UPSTREAM_URL")
        .unwrap_or_else(|| crate::hybrid::DEFAULT_PYTHON_UPSTREAM.to_owned());
    let token = crate::config::env_or_dotenv("INTERNAL_SERVICE_TOKEN").unwrap_or_default();
    let url = format!(
        "{}/_runtime/chat-shell/v1/answer-execution",
        origin.trim_end_matches('/')
    );
    let response = state
        .attachment_http
        .post(&url)
        .map_err(|_| FastApiError::internal())?
        .bearer_auth(token.trim())
        .json(body)
        .send()
        .await
        .map_err(|_| FastApiError::internal())?;
    if !response.status().is_success() {
        tracing::error!(
            status = response.status().as_u16(),
            "Python answer lifecycle unavailable"
        );
        return Err(FastApiError::internal());
    }
    let mut value = response
        .json::<Value>()
        .await
        .map_err(|_| FastApiError::internal())?;
    match value.get("handled").and_then(Value::as_bool) {
        Some(false) => Ok(None),
        Some(true) => {
            if let Some(fields) = value.as_object_mut() {
                fields.remove("handled");
            }
            Ok(Some(value))
        }
        None => Err(FastApiError::internal()),
    }
}

pub(super) async fn start(
    state: &AppState,
    turn: &ChatTurn,
    actor_id: i64,
) -> Result<bool, FastApiError> {
    if turn.device_id.is_some()
        || turn.client_origin != "frontend"
        || turn.options.generation.is_some()
    {
        return Ok(false);
    }
    let result = operation(
        state,
        &json!({
            "action": "start", "task_id": turn.task_id, "answer_id": turn.assistant_subtask_id,
            "actor_id": actor_id, "user_subtask_id": turn.user_subtask_id, "message": turn.message,
            "additional_skills": turn.additional_skills,
            "interactive_form_answer": turn.interactive_form_answer,
            "options": {"enable_deep_thinking": turn.options.enable_deep_thinking,
                "enable_web_search": turn.options.enable_web_search,
                "enable_clarification": turn.options.enable_clarification,
                "model_options": turn.options.model_options}
        }),
    )
    .await?;
    match result {
        Some(value) if value["success"] == true => Ok(true),
        Some(_) => Err(FastApiError::internal()),
        None => Ok(false),
    }
}
