// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PATCH /api/internal/chat/history/{session_id}/messages/{message_id}` —
//! rewrite one stored chat message's content.
//!
//! Mirrors `app/api/endpoints/internal/chat_storage.py:update_message` (router
//! prefix `/chat` mounted under `/internal` with API_PREFIX `/api`):
//! 1. `verify_internal_service_token` (the router-level `Depends`).
//! 2. `int(message_id)`; a non-integer id is 400 `Invalid message_id`.
//! 3. `subtask_store.get_by_id`: the full subtask row plus the
//!    `subqueryload(Subtask.contexts)` batch read; a missing row is 404
//!    `Message not found`.
//! 4. `_build_subtask_content_fields(subtask.role, update)`: a USER message
//!    rewrites `prompt`, every other role rewrites `result`.
//! 5. `subtask_store.update_fields` + `db.commit()`: one flushed UPDATE, then
//!    `{"success": true}`.
//!
//! Re-opened 2026-10-11 (second pass) after the runtime policy generalised the
//! request-time `updated_at` rule from one `subtasks_` shard to every shard.
//! Target behavior is unchanged and faithful to the source; this note exists
//! only to re-fingerprint the handler so a fresh focused replay runs under the
//! generalised rule.
use brz_mysql::{MysqlError, MysqlRow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::chat_repository::ChatHistoryRepository;
use crate::internal_auth::http_error::HttpError;
use crate::json_compat::{python_json_value, python_json_value_no_ascii};
use crate::state::AppState;
use crate::task_store::{SubtaskContentField, subtask_column_index};

/// `SubtaskRole.USER` — the only role whose content lands in `prompt`.
const USER_ROLE: &str = "USER";

/// `MessageUpdate`: the source declares `content: Any`, so any JSON value is
/// valid (string, list, object, or scalar).
#[derive(Debug, Deserialize)]
pub struct MessageUpdate {
    pub content: Value,
}

/// `SuccessResponse` (`{"success": true}`).
#[derive(Debug, Serialize)]
pub struct SuccessResponse {
    success: bool,
}

/// PATCH /api/internal/chat/history/:session_id/messages/:message_id.
#[brz_http_server::patch("/api/internal/chat/history/:session_id/messages/:message_id")]
async fn update_message(
    #[inject(state)] state: &AppState,
    session_id: &str,
    message_id: &str,
    #[auth] _service: crate::internal_auth::InternalService,
    update: MessageUpdate,
) -> Result<SuccessResponse, crate::http_compat::FastApiError> {
    update_message_value(state, session_id, message_id, &update)
        .await
        .map_err(crate::http_compat::FastApiError::from)
}

/// Handler body exposed for focused tests: parse the id, load the row, derive
/// the content field, and flush the update.
pub async fn update_message_value(
    app: &AppState,
    session_id: &str,
    message_id: &str,
    update: &MessageUpdate,
) -> Result<SuccessResponse, HttpError> {
    let subtask_id = message_id
        .parse::<i64>()
        .map_err(|_| HttpError::bad_request("Invalid message_id"))?;

    let row = app
        .task_store
        .get_subtask(subtask_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(|| HttpError::not_found("Message not found"))?;

    // `get_by_id` loads the row with `subqueryload(Subtask.contexts)`, so the
    // batch context read runs whenever the row exists. The update consumes none
    // of its rows, but the recorded topology includes it.
    let repository = ChatHistoryRepository::new(&app.mysql, &*app.task_store);
    let _contexts = repository
        .list_contexts_by_subtask_ids(&[subtask_id])
        .await
        .map_err(HttpError::internal)?;

    let role: String = decode_column(&row, "role")?;
    let field = subtask_content_field(&role, update, &row)?;
    // `update_fields` stamps `datetime.now()` when it marks `updated_at` dirty.
    let updated_at = crate::task_store::task_update_timestamp();

    app.task_store
        .update_subtask_content(subtask_id, field.as_ref(), &updated_at)
        .await
        .map_err(HttpError::internal)?;

    tracing::debug!(session_id, message_id, "update_message");
    Ok(SuccessResponse { success: true })
}

/// `_build_subtask_content_fields`: select the dirty content column and render
/// its value. `None` means only `updated_at` is written.
fn subtask_content_field(
    role: &str,
    update: &MessageUpdate,
    row: &MysqlRow,
) -> Result<Option<SubtaskContentField>, HttpError> {
    let content = message_content_text(&update.content);
    if role == USER_ROLE {
        // SQLAlchemy's attribute history omits `prompt` when the loaded value
        // already equals the new one, so an unchanged prompt is not written.
        let current: Option<String> = decode_column(row, "prompt")?;
        if current.as_deref() == Some(content.as_str()) {
            return Ok(None);
        }
        return Ok(Some(SubtaskContentField::Prompt(content)));
    }
    // Any non-USER role stores `{"value": <content>}` and `flag_modified`
    // writes the column regardless of the loaded value.
    Ok(Some(SubtaskContentField::Result(python_json_value(
        &json!({ "value": content }),
    ))))
}

/// `message.content if isinstance(message.content, str) else
/// json.dumps(message.content, ensure_ascii=False)`.
fn message_content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        other => python_json_value_no_ascii(other),
    }
}

/// Decode one column of [`crate::task_store::subtask_by_id_statement`]'s
/// labeled row by its mapper position, so the caller does not need the resolved
/// physical table name.
fn decode_column<T: brz_mysql::FromMysqlCol>(row: &MysqlRow, column: &str) -> Result<T, HttpError> {
    let index = subtask_column_index(column)
        .ok_or_else(|| HttpError::internal(MysqlError::ColumnNotFound(column.to_string())))?;
    row.get_at(index).map_err(HttpError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_store::{subtask_by_id_statement, subtask_content_update_statement};

    /// The `subtasks_0387` read recorded for the representative case. The full
    /// ORM projection is labeled `{table}_{column}` in mapper order and `role`
    /// renders backticked.
    #[test]
    fn subtask_by_id_statement_matches_the_recorded_rendering() {
        let sql = subtask_by_id_statement("subtasks_0387");
        assert!(sql.starts_with(
            "SELECT subtasks_0387.id AS subtasks_0387_id, \
             subtasks_0387.user_id AS subtasks_0387_user_id, "
        ));
        assert!(sql.contains("subtasks_0387.`role` AS subtasks_0387_role, "));
        assert!(sql.contains("subtasks_0387.result AS subtasks_0387_result, "));
        assert!(sql.ends_with(
            "subtasks_0387.reply_to_subtask_id AS subtasks_0387_reply_to_subtask_id \
             \nFROM subtasks_0387 \nWHERE subtasks_0387.id = ? \n LIMIT 1"
        ));
    }

    #[test]
    fn subtask_column_index_tracks_the_projection_order() {
        assert_eq!(subtask_column_index("id"), Some(0));
        assert_eq!(subtask_column_index("role"), Some(6));
        assert_eq!(subtask_column_index("prompt"), Some(10));
        assert_eq!(subtask_column_index("result"), Some(15));
        assert_eq!(subtask_column_index("missing"), None);
    }

    /// The recorded flush writes only `updated_at` when the content column is
    /// unchanged.
    #[test]
    fn content_update_statement_writes_only_the_dirty_columns() {
        assert_eq!(
            subtask_content_update_statement("subtasks_0387", None),
            "UPDATE subtasks_0387 SET updated_at=? WHERE subtasks_0387.id = ?"
        );
        assert_eq!(
            subtask_content_update_statement("subtasks_0387", Some("prompt")),
            "UPDATE subtasks_0387 SET prompt=?, updated_at=? WHERE subtasks_0387.id = ?"
        );
        assert_eq!(
            subtask_content_update_statement("subtasks_0387", Some("result")),
            "UPDATE subtasks_0387 SET result=?, updated_at=? WHERE subtasks_0387.id = ?"
        );
    }

    #[test]
    fn string_content_is_used_verbatim() {
        assert_eq!(message_content_text(&json!("你好")), "你好");
    }

    #[test]
    fn non_string_content_renders_like_python_ensure_ascii_false() {
        assert_eq!(
            message_content_text(&json!([1, "a", "严"])),
            "[1, \"a\", \"严\"]"
        );
    }

    #[test]
    fn assistant_content_wraps_the_value_and_escapes_like_sqlalchemy() {
        // `python_json_value` (ensure_ascii=True) is SQLAlchemy's JSON
        // serializer, so the non-ASCII content of `{"value": ...}` is escaped.
        assert_eq!(
            python_json_value(&json!({ "value": "严" })),
            "{\"value\": \"\\u4e25\"}"
        );
    }
}
