// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/attachments/{attachment_id}` — attachment detail
//! (`app/api/endpoints/adapter/attachments.py:get_attachment`).
//!
//! JWT method (the recorded path): `get_current_user_optional` then
//! `_get_attachment_context` (`get_context_optional` SELECT, 404 when absent
//! or not the `attachment` context type, `_ensure_attachment_access`) and
//! `AttachmentDetailResponse.from_context` (a pure row projection; no
//! further dependency calls). Share-token access is a separate method that
//! the recorded case does not exercise.
use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_http_server::{Binary, HttpResponse};

use super::auth::{AttachmentUser, UserRow};
use super::context_store::{self};
use super::detail_response::AttachmentDetailResponse;
use crate::state::AppState;

/// `ContextType.ATTACHMENT`.
const CONTEXT_TYPE_ATTACHMENT: &str = "attachment";

fn error_response(status: StatusCode, detail: &str) -> crate::http_compat::FastApiError {
    crate::http_compat::FastApiError::detail(status, detail)
}

fn attachment_not_found() -> crate::http_compat::FastApiError {
    error_response(StatusCode::NOT_FOUND, "Attachment not found")
}

fn internal_error() -> crate::http_compat::FastApiError {
    error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// Handler body for `GET /api/attachments/{attachment_id}`.
async fn attachment_detail(
    state: &Arc<AppState>,
    attachment_id: i64,
    share_token: Option<&str>,
    user: Option<&UserRow>,
) -> Result<HttpResponse<Binary>, crate::http_compat::FastApiError> {
    if share_token.is_some() {
        // Share-token authentication: decode_share_token plus the task/
        // subtask ownership chain; the recorded case uses the JWT method.
        return Err(error_response(
            StatusCode::FORBIDDEN,
            "Share token access denied",
        ));
    }

    let Some(user) = user else {
        return Err(error_response(
            StatusCode::UNAUTHORIZED,
            "Authentication required",
        ));
    };

    let context = match context_store::get_context_optional(&state.mysql, attachment_id).await {
        Ok(context) => context,
        Err(error) => {
            tracing::error!(%error, "attachment context lookup failed");
            return Err(internal_error());
        }
    };
    let Some(context) = context else {
        return Err(attachment_not_found());
    };
    if context.context_type != CONTEXT_TYPE_ATTACHMENT {
        return Err(attachment_not_found());
    }
    let has_access = match context_store::ensure_attachment_access(
        &state.mysql,
        state.task_policy,
        &context,
        user,
    )
    .await
    {
        Ok(access) => access,
        Err(error) => {
            tracing::error!(%error, "attachment access check failed");
            return Err(internal_error());
        }
    };
    if !has_access {
        return Err(attachment_not_found());
    }

    Ok(HttpResponse::new(Binary::new(
        AttachmentDetailResponse::from_context(&context).to_json(),
    )))
}

/// GET /api/attachments/{attachment_id}: the attachment detail free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/attachments/:attachment_id", access = optional)]
async fn get_attachment(
    #[inject(state)] state: &Arc<AppState>,
    attachment_id: i64,
    share_token: Option<String>,
    #[auth] user: Option<AttachmentUser>,
) -> Result<HttpResponse<Binary>, crate::http_compat::FastApiError> {
    attachment_detail(
        state,
        attachment_id,
        share_token.as_deref(),
        user.as_deref(),
    )
    .await
}

/// GET /api/attachments/{attachment_id}/executor-download.
#[brz_http_server::get("/api/attachments/:attachment_id/executor-download")]
async fn executor_download_attachment(
    #[inject(state)] state: &Arc<AppState>,
    attachment_id: i64,
    #[auth] user: crate::attachments_task_all::auth::AuthenticatedUser,
) -> Result<HttpResponse<brz_http_server::Binary>, crate::http_compat::FastApiError> {
    super::executor_download::executor_download(state, attachment_id, &user).await
}

/// GET /api/attachments/{attachment_id}/download.
#[brz_http_server::get("/api/attachments/:attachment_id/download", access = optional)]
async fn download(
    #[inject(state)] state: &Arc<AppState>,
    attachment_id: i64,
    #[auth] user: Option<AttachmentUser>,
) -> Result<HttpResponse<brz_http_server::Binary>, crate::http_compat::FastApiError> {
    super::handler::download_attachment(state, attachment_id, user.as_deref()).await
}

/// GET /api/attachments/download/shared: the public share-link download
/// (`public_download_attachment`). The static route outranks the
/// `:attachment_id` captures (three literal segments vs. one).
#[brz_http_server::get("/api/attachments/download/shared", access = public)]
async fn download_shared(
    #[inject(state)] state: &Arc<AppState>,
    token: String,
) -> Result<HttpResponse<brz_http_server::Binary>, crate::http_compat::FastApiError> {
    super::shared_download::public_download_attachment(state, &token).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::context_store::SubtaskContextRow;
    use brz_mysql::Json;
    use chrono::NaiveDateTime;
    use serde_json::Value;
    use serde_json::json;

    fn context_row(context_type: &str, type_data: Value) -> SubtaskContextRow {
        SubtaskContextRow {
            id: 1281270,
            subtask_id: 521168511716528,
            user_id: 3792,
            context_type: context_type.to_string(),
            name: "SKILL_example-record.md".to_string(),
            status: "ready".to_string(),
            error_message: Some(String::new()),
            binary_data: Vec::new(),
            image_base64: None,
            extracted_text: None,
            text_length: 9985,
            type_data: Some(Json(type_data.into())),
            created_at: NaiveDateTime::parse_from_str("2026-09-06 21:00:00", "%Y-%m-%d %H:%M:%S")
                .ok(),
            updated_at: None,
        }
    }

    #[test]
    fn renders_expected_response_shape() {
        let context = context_row(
            "attachment",
            json!({
                "original_filename": "SKILL_example-record.md",
                "file_size": 23703,
                "mime_type": "text/markdown",
                "file_extension": ".md",
                "is_encrypted": false,
            }),
        );
        let rendered = AttachmentDetailResponse::from_context(&context).to_json();
        let value: Value = serde_json::from_str(&rendered).expect("valid json");
        assert_eq!(value["id"], 1281270);
        assert_eq!(value["filename"], "SKILL_example-record.md");
        assert_eq!(value["file_size"], 23703);
        assert_eq!(value["mime_type"], "text/markdown");
        assert_eq!(value["status"], "ready");
        assert_eq!(value["file_extension"], ".md");
        assert_eq!(value["text_length"], 9985);
        assert_eq!(value["error_message"], "");
        assert!(value["error_code"].is_null());
        assert!(value["truncation_info"].is_null());
        assert_eq!(value["created_at"], "2026-09-06T21:00:00");
        assert!(value["external_media_type"].is_null());
        assert!(value["text_count"].is_null());
        assert!(value["video_count"].is_null());
        assert!(value["image_count"].is_null());
        assert!(value["comment_count"].is_null());
        assert!(value["fetched_comment_count"].is_null());
        assert!(value["site"].is_null());
        assert!(value["source_url"].is_null());
        assert!(value["cover_url"].is_null());
        assert_eq!(value["subtask_id"], 521168511716528i64);
    }

    #[test]
    fn external_web_content_attachments_carry_display_fields() {
        let context = context_row(
            "attachment",
            json!({
                "source": "external_web_content",
                "external_media_type": "text",
                "site": "example.net",
                "external_source_url": "https://example.net/a",
            }),
        );
        let rendered = AttachmentDetailResponse::from_context(&context).to_json();
        let value: Value = serde_json::from_str(&rendered).expect("valid json");
        assert_eq!(value["external_media_type"], "text");
        assert_eq!(value["text_count"], 1);
        assert_eq!(value["site"], "example.net");
        assert_eq!(value["source_url"], "https://example.net/a");
    }

    #[test]
    fn zero_subtask_id_maps_to_null() {
        let mut context = context_row("attachment", json!({}));
        context.subtask_id = 0;
        let rendered = AttachmentDetailResponse::from_context(&context).to_json();
        let value: Value = serde_json::from_str(&rendered).expect("valid json");
        assert!(value["subtask_id"].is_null());
    }
}
