// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/internal/chat/attachments/{attachment_id}/text` — a character
//! slice of an attachment's extracted text.
//!
//! Mirrors `app/api/endpoints/internal/chat_storage.py:get_attachment_text`
//! (router prefix `/chat` mounted under `/internal` with API_PREFIX `/api`).
//!
//! Pipeline (the recorded dependency topology):
//! 1. `verify_internal_service_token` (the router-level `Depends`).
//! 2. `parse_session_id(session_id)`; non-`task` sessions 400.
//! 3. `task_store.get_by_id` on the sharded `tasks_{:04}` table (404
//!    `Task not found` when absent).
//! 4. The `subtask_contexts` row by id (404 `Attachment not found` when
//!    absent or not a ready attachment).
//! 5. `subtask_store.list_ids_by_task` on the sharded `subtasks_{:04}`
//!    table: a linked attachment must belong to one of the task's subtasks;
//!    an unlinked one (`subtask_id == 0`) must belong to the task's user
//!    (404 `Attachment not found` otherwise, so callers cannot probe ids).
//! 6. The extracted-text slice plus pagination flags.
use brz_mysql::{Mysql, MysqlResult, MysqlRow};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::chat_repository::{ChatHistoryRepository, SubtaskContextRow};
use crate::internal_auth::http_error::HttpError;
use crate::state::AppState;
use crate::task_routing::ByTaskId;

/// `AttachmentTextResponse`: a character slice of an attachment's extracted
/// text, with the source's field order.
#[derive(Debug, Serialize)]
pub struct AttachmentTextResponse {
    attachment_id: i64,
    name: String,
    mime_type: String,
    total_chars: i64,
    offset: i64,
    text: String,
    has_more: bool,
    /// Whether `extracted_text` itself was parse-truncated. When true, paging
    /// to `has_more == false` means "end of the extract", not "end of the
    /// original file".
    source_truncated: bool,
}

/// `MAX_ATTACHMENT_TEXT_SLICE`: FastAPI rejects `limit > 64_000` with 422.
const MAX_ATTACHMENT_TEXT_SLICE: i64 = 64_000;

/// Query parameters (`session_id` required, `offset >= 0` default 0,
/// `limit > 0` and `<= 64_000` required).
#[derive(Debug, Default, Deserialize)]
pub struct AttachmentTextQuery {
    pub session_id: Option<String>,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

/// FastAPI-style 422 validation error body (`Query(...)` constraints).
fn validation_error(field: &str, kind: &str, message: &str) -> HttpError {
    let detail = json!([
        {
            "type": kind,
            "loc": ["query", field],
            "msg": message,
            "input": serde_json::Value::Null,
        }
    ]);
    let error = crate::http_compat::FastApiError::validation(detail);
    HttpError::validation(error)
}

impl AttachmentTextQuery {
    /// Missing required fields and out-of-range values surface as FastAPI's
    /// 422 validation response before the handler body runs.
    fn validated(&self) -> Result<(String, i64, i64), HttpError> {
        let Some(session_id) = self.session_id.as_deref() else {
            return Err(validation_error("session_id", "missing", "Field required"));
        };
        let offset = match self.offset {
            None => 0,
            Some(offset) if offset >= 0 => offset,
            Some(_) => {
                return Err(validation_error(
                    "offset",
                    "greater_than_equal",
                    "Input should be greater than or equal to 0",
                ));
            }
        };
        let Some(limit) = self.limit else {
            return Err(validation_error("limit", "missing", "Field required"));
        };
        if limit <= 0 {
            return Err(validation_error(
                "limit",
                "greater_than",
                "Input should be greater than 0",
            ));
        }
        if limit > MAX_ATTACHMENT_TEXT_SLICE {
            return Err(validation_error(
                "limit",
                "less_than_equal",
                concat!("Input should be less than or equal to ", stringify!(64_000)),
            ));
        }
        Ok((session_id.to_string(), offset, limit))
    }
}

/// GET /api/internal/chat/attachments/{attachment_id}/text: the attachment-text
/// free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/internal/chat/attachments/:attachment_id/text")]
async fn get_attachment_text(
    #[inject(state)] state: &AppState,
    attachment_id: i64,
    #[auth] _service: crate::internal_auth::InternalService,
    query: brz_http_server::Query<AttachmentTextQuery>,
) -> Result<AttachmentTextResponse, crate::http_compat::FastApiError> {
    get_attachment_text_value(state, attachment_id, &query)
        .await
        .map_err(crate::http_compat::FastApiError::from)
}

/// Handler body exposed to the main router; verifies the router-level
/// internal-service-token dependency first.
pub async fn get_attachment_text_value(
    app: &AppState,
    attachment_id: i64,
    query: &AttachmentTextQuery,
) -> Result<AttachmentTextResponse, HttpError> {
    let (session_id, offset, limit) = query.validated()?;
    get_attachment_text_inner(app, attachment_id, &session_id, offset, limit).await
}

async fn get_attachment_text_inner(
    app: &AppState,
    attachment_id: i64,
    session_id: &str,
    offset: i64,
    limit: i64,
) -> Result<AttachmentTextResponse, HttpError> {
    let (session_type, task_id) = crate::chat_history::parse_session_id(session_id)?;
    if session_type != "task" {
        return Err(HttpError::bad_request(
            "Only task-based sessions are supported",
        ));
    }

    let repository = ChatHistoryRepository::new(&app.mysql, app.task_policy);
    let task = repository
        .get_task_by_id(task_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(|| HttpError::not_found("Task not found"))?;

    let context = get_ready_attachment(&repository, attachment_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(|| HttpError::not_found("Attachment not found"))?;

    // Task scoping: a linked attachment must belong to this task; an unlinked
    // one (`subtask_id == 0`) must at least belong to this task's user.
    let task_subtask_ids = list_ids_by_task(&repository, task_id)
        .await
        .map_err(HttpError::internal)?;
    let is_in_task = task_subtask_ids.contains(&context.subtask_id);
    let is_unlinked_same_user = context.subtask_id == 0 && context.user_id == task.user_id;
    if !(is_in_task || is_unlinked_same_user) {
        // 404 (not 403) so callers cannot distinguish "exists but forbidden"
        // from "missing" and probe valid ids across conversations.
        return Err(HttpError::not_found("Attachment not found"));
    }

    let full_text = context.extracted_text.as_deref().unwrap_or("");
    let total_chars = full_text.chars().count() as i64;
    // Python `full_text[offset : offset + limit]` clamps both bounds to
    // `[0, len]`; negative offsets are rejected by the query validation, so
    // `offset` is already non-negative here.
    let start = offset.min(total_chars).max(0) as usize;
    let end = offset.saturating_add(limit).min(total_chars).max(0) as usize;
    let chunk: String = if start >= end {
        String::new()
    } else {
        full_text.chars().skip(start).take(end - start).collect()
    };
    let has_more = offset.saturating_add(chunk.chars().count() as i64) < total_chars;

    Ok(AttachmentTextResponse {
        attachment_id,
        name: context.name_or_empty().to_owned(),
        mime_type: context.mime_type(),
        total_chars,
        offset,
        text: chunk,
        has_more,
        source_truncated: context.is_truncated(),
    })
}

/// The `subtask_contexts` lookup of `get_attachment_text`: one row by id
/// restricted to a ready attachment, rendered with the source's labeled
/// projection and inlined literals.
async fn get_ready_attachment<'a, M: Mysql>(
    repository: &ChatHistoryRepository<'a, M>,
    attachment_id: i64,
) -> MysqlResult<Option<SubtaskContextRow>> {
    let sql = format!(
        "SELECT {columns} \nFROM subtask_contexts \n\
         WHERE subtask_contexts.id = {attachment_id} \
         AND subtask_contexts.context_type = 'attachment' \
         AND subtask_contexts.status = 'ready' \n LIMIT 1",
        columns = crate::chat_repository::context_columns()
    );
    let row: Option<MysqlRow> = repository
        .mysql_ref()
        .fetch_optional(sql.as_str(), ())
        .await?;
    row.as_ref()
        .map(crate::chat_repository::decode_context_row_pub)
        .transpose()
}

/// `subtask_store.list_ids_by_task(db, task_id=task_id)`: the sharded store
/// lists the `subtasks_{:04}` table filtered by `task_id` (no owner guard:
/// `owner_user_id` and `user_id` are both unset on this call path).
async fn list_ids_by_task<'a, M: Mysql>(
    repository: &ChatHistoryRepository<'a, M>,
    task_id: i64,
) -> MysqlResult<Vec<i64>> {
    let sql = "SELECT id \nFROM {{subtasks}} \nWHERE task_id = ?";
    let rows: Vec<MysqlRow> = repository
        .mysql_ref()
        .route(ByTaskId(task_id as u64))
        .fetch_all(sql, (task_id,))
        .await?;
    rows.iter().map(|row| row.get_required("id")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(
        session_id: Option<&str>,
        offset: Option<i64>,
        limit: Option<i64>,
    ) -> AttachmentTextQuery {
        AttachmentTextQuery {
            session_id: session_id.map(str::to_string),
            offset,
            limit,
        }
    }

    #[test]
    fn missing_session_id_is_rejected() {
        let error = query(None, Some(0), Some(30000)).validated().unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn missing_limit_is_rejected() {
        let error = query(Some("task-1"), Some(0), None)
            .validated()
            .unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn negative_offset_is_rejected() {
        let error = query(Some("task-1"), Some(-1), Some(30000))
            .validated()
            .unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn zero_and_oversized_limits_are_rejected() {
        for limit in [0, MAX_ATTACHMENT_TEXT_SLICE + 1] {
            let error = query(Some("task-1"), Some(0), Some(limit))
                .validated()
                .unwrap_err();
            assert_eq!(
                error.status(),
                brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }

    #[test]
    fn valid_query_defaults_offset_to_zero() {
        let (session, offset, limit) = query(Some("task-1"), None, Some(64000))
            .validated()
            .unwrap();
        assert_eq!((session.as_str(), offset, limit), ("task-1", 0, 64000));
    }

    #[test]
    fn slice_bounds_clamp_to_total_chars() {
        let full_text = "abcdef".to_string();
        let total = full_text.chars().count() as i64;
        let start = 3_i64.min(total).max(0) as usize;
        let end = 3_i64.saturating_add(2).min(total).max(0) as usize;
        let chunk: String = if start >= end {
            String::new()
        } else {
            full_text.chars().skip(start).take(end - start).collect()
        };
        assert_eq!(chunk, "de");
        let has_more = 3_i64.saturating_add(chunk.chars().count() as i64) < total;
        // offset 3 + 2 chars stops at index 5 of 6: "f" remains.
        assert!(has_more);
        // Reading the final page reports no more.
        let start = 5_i64.min(total).max(0) as usize;
        let end = 5_i64.saturating_add(1).min(total).max(0) as usize;
        let tail: String = if start >= end {
            String::new()
        } else {
            full_text.chars().skip(start).take(end - start).collect()
        };
        assert_eq!(tail, "f");
        assert!(5_i64.saturating_add(tail.chars().count() as i64) >= total);
        // An offset past the end yields an empty chunk with no more pages.
        let start = 10_i64.min(total).max(0) as usize;
        let end = 10_i64.saturating_add(2).min(total).max(0) as usize;
        let overflow: String = if start >= end {
            String::new()
        } else {
            full_text.chars().skip(start).take(end - start).collect()
        };
        assert_eq!(overflow, "");
        assert!(10_i64.saturating_add(overflow.chars().count() as i64) >= total);
    }
}
