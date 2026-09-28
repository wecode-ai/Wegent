// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/attachments/task/{task_id}/all`
//! (`app.api.endpoints.adapter.attachments.get_all_task_attachments`).
//!
//! Dependency sequence (the recorded path):
//! 1. `get_current_user_jwt_apikey_tasktoken` (task token: the full
//!    `users` row by id);
//! 2. `task_store.get_by_id` on the configured task table (404 `Task not found`
//!    when absent);
//! 3. owner check, else the inline approved-`resource_members` membership
//!    query (403 `Access denied`);
//! 4. `subtask_store.list_by_task_unfiltered` on the configured task table;
//! 5. `context_service.get_attachments_by_task` (empty subtask list
//!    short-circuits to `[]`);
//! 6. the `AttachmentDetailResponse` list
//!    (`AttachmentDetailResponse.from_context`).
use crate::attachments::detail_response::AttachmentDetailResponse;
#[cfg(test)]
use serde_json::{Value, json};

use super::auth;
use super::auth_error::HttpError;
use super::repository::{self, ContextRow};
use crate::state::AppState;

/// GET /api/attachments/task/{task_id}/all: the task-attachments free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/attachments/task/:task_id/all")]
async fn get_all_task_attachments(
    #[inject(state)] state: &AppState,
    task_id: i64,
    #[auth] user: auth::AuthenticatedUser,
) -> Result<Vec<AttachmentDetailResponse>, HttpError> {
    run(state, task_id, user.id).await
}

/// The endpoint flow after authentication.
async fn run(
    state: &AppState,
    task_id: i64,
    user_id: i64,
) -> Result<Vec<AttachmentDetailResponse>, HttpError> {
    // `task_store.get_by_id`.
    let Some(task) = repository::get_task_by_id(&state.mysql, task_id)
        .await
        .map_err(HttpError::dependency)?
    else {
        return Err(HttpError::task_not_found());
    };

    // Owner or approved member. The source evaluates the membership query
    // unconditionally — Python evaluates `is_owner` first but the member
    // query still runs before the `not is_owner and not is_member` check.
    let is_owner = i64::from(task.user_id) == user_id;
    let is_member = repository::is_task_member(&state.mysql, task_id, user_id)
        .await
        .map_err(HttpError::dependency)?;
    if !is_owner && !is_member {
        return Err(HttpError::access_denied());
    }

    // `subtask_store.list_by_task_unfiltered`.
    let subtasks = repository::list_subtask_ids_by_task(&state.mysql, task_id)
        .await
        .map_err(HttpError::dependency)?;
    let subtask_ids = subtasks
        .iter()
        .map(|subtask| subtask.id)
        .collect::<Vec<_>>();

    // `context_service.get_attachments_by_task`.
    let attachments = repository::get_attachments_by_task(&state.mysql, &subtask_ids)
        .await
        .map_err(HttpError::dependency)?;

    // `AttachmentDetailResponse.from_context` list, in declaration order.
    Ok(attachments.iter().map(attachment_detail_response).collect())
}

/// `AttachmentDetailResponse.from_context` for `context_type ==
/// 'attachment'`: `_build_attachment_fields(type_data)` supplies
/// `file_extension`/`file_size`/`mime_type`, `filename` is
/// `type_data.original_filename` else the row `name`, and `subtask_id` is
/// `None` for unlinked (`subtask_id <= 0`) contexts.
fn attachment_detail_response(context: &ContextRow) -> AttachmentDetailResponse {
    #[derive(Default, serde::Deserialize)]
    #[serde(default)]
    struct AttachmentTypeData {
        file_size: Option<i64>,
        mime_type: Option<String>,
        file_extension: Option<String>,
        original_filename: Option<String>,
    }
    let type_data = context
        .type_data
        .as_ref()
        .and_then(|data| data.0.project::<AttachmentTypeData>())
        .unwrap_or_default();
    let filename = type_data
        .original_filename
        .unwrap_or_else(|| context.name.clone());
    AttachmentDetailResponse {
        id: context.id,
        filename,
        file_size: type_data.file_size.unwrap_or(0),
        mime_type: type_data.mime_type.unwrap_or_default(),
        status: context.status.clone(),
        file_extension: type_data.file_extension.unwrap_or_default(),
        text_length: Some(i64::from(context.text_length)),
        error_message: Some(context.error_message.clone()),
        error_code: None,
        truncation_info: None,
        created_at: context
            .created_at
            .map(|at| at.format("%Y-%m-%dT%H:%M:%S").to_string()),
        external_media_type: None,
        text_count: None,
        video_count: None,
        image_count: None,
        comment_count: None,
        fetched_comment_count: None,
        site: None,
        source_url: None,
        cover_url: None,
        subtask_id: (context.subtask_id > 0).then_some(context.subtask_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn attachment_detail_response(context: &ContextRow) -> Value {
        crate::json_contract_tests::serialized(super::attachment_detail_response(context)).unwrap()
    }
    use brz_mysql::Json;
    use chrono::NaiveDateTime;

    fn context_row(type_data: Value, subtask_id: i64, name: &str) -> ContextRow {
        // Build through the same fields the FromMysqlRow derive decodes.
        ContextRow {
            id: 1281251,
            subtask_id,
            context_type: "attachment".to_string(),
            name: name.to_string(),
            status: "ready".to_string(),
            error_message: String::new(),
            text_length: 58,
            type_data: Some(Json(type_data.into())),
            created_at: NaiveDateTime::parse_from_str("2026-09-06 20:51:28", "%Y-%m-%d %H:%M:%S")
                .ok(),
        }
    }

    #[test]
    fn response_matches_recorded_shape_and_order() {
        let row = context_row(
            json!({
                "file_size": 586530, "mime_type": "image/png",
                "file_extension": ".png",
                "original_filename": "9a366ffa-2aa9-4750-b213-7cd22e4fd550.png"
            }),
            881_396_008_766_237,
            "unused-name",
        );
        let body = attachment_detail_response(&row);
        let text = body.to_string();
        // Field order follows the model declaration order.
        let expected_prefix = "{\"id\":1281251,\"filename\":\
             \"9a366ffa-2aa9-4750-b213-7cd22e4fd550.png\",\"file_size\":586530,\
             \"mime_type\":\"image/png\",\"status\":\"ready\",\
             \"file_extension\":\".png\",\"text_length\":58,\"error_message\":\"\",\
             \"error_code\":null,\"truncation_info\":null,\
             \"created_at\":\"2026-09-06T20:51:28\",\
             \"external_media_type\":null,\"text_count\":null,\"video_count\":null,\
             \"image_count\":null,\"comment_count\":null,\
             \"fetched_comment_count\":null,\"site\":null,\"source_url\":null,\
             \"cover_url\":null,\"subtask_id\":881396008766237}";
        assert_eq!(text, expected_prefix);
    }

    #[test]
    fn missing_type_data_falls_back_like_source() {
        let row = context_row(json!({}), 0, "fallback.png");
        let body = attachment_detail_response(&row);
        assert_eq!(body["filename"], "fallback.png");
        assert_eq!(body["file_size"], 0);
        assert_eq!(body["mime_type"], "");
        assert_eq!(body["file_extension"], "");
        // Unlinked attachments serialize `subtask_id` as null.
        assert!(body["subtask_id"].is_null());
    }
}
