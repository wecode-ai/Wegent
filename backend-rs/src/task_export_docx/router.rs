// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Route and handler for `GET /api/tasks/{task_id}/export/docx`
//! (`app.api.endpoints.adapter.tasks.export_task_docx`) and
//! `POST /api/tasks/{task_id}/export/docx/download-url`
//! (`app.api.endpoints.adapter.tasks.create_task_docx_export_download_url`).

use brz_http_server::{Binary, HttpResponse, Response, StatusCode};
use serde::{Deserialize, Serialize};

use super::generator::{self, ExportInput};
use super::repository::{self, ContextRow};
use super::token;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// Query parameters (`message_ids`, `download_token`).
#[derive(Debug, Default, Deserialize)]
pub(crate) struct ExportQuery {
    pub message_ids: Option<String>,
    pub download_token: Option<String>,
}

/// Query parameters for the download-url endpoint (`message_ids`).
#[derive(Debug, Default, Deserialize)]
pub(crate) struct DownloadUrlQuery {
    pub message_ids: Option<String>,
}

/// The download-url response body (`{"download_url": ..., "expires_in": 300}`),
/// serialized in the source dict's key order.
#[derive(Debug, Serialize)]
struct DownloadUrlResponse {
    download_url: String,
    expires_in: u32,
}

/// GET /api/tasks/{task_id}/export/docx: the export free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/tasks/:task_id/export/docx", access = optional)]
pub(crate) async fn export_task_docx(
    #[inject(state)] state: &AppState,
    task_id: i64,
    #[auth] current_user: Option<crate::auth::OptionalSessionUser>,
    query: brz_http_server::Query<ExportQuery>,
) -> Result<HttpResponse<Binary>, FastApiError> {
    export(state, task_id, current_user.as_ref(), &query.0)
        .await
        .map(|(filename, body)| {
            let mut response = HttpResponse::new(Binary::new(body));
            response = response
                .header(
                    "content-type",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                )
                .map_err(|_| internal_error())?;
            response = response
                .header("content-disposition", &content_disposition(&filename))
                .map_err(|_| internal_error())?;
            Ok(response)
        })
        .map_err(|error| match error {
            ExportError::Fast(error) => error,
            ExportError::Internal => internal_error(),
        })?
}

/// POST /api/tasks/{task_id}/export/docx/download-url: mint a short-lived
/// token for a browser-native DOCX download and return the download URL
/// (`app.api.endpoints.adapter.tasks.create_task_docx_export_download_url`).
#[brz_http_server::post("/api/tasks/:task_id/export/docx/download-url")]
pub(crate) async fn create_task_docx_export_download_url(
    #[inject(state)] state: &AppState,
    task_id: i64,
    #[auth] current_user: crate::auth::SessionUser,
    query: brz_http_server::Query<DownloadUrlQuery>,
) -> Result<Response, FastApiError> {
    let message_ids = query.0.message_ids.as_deref();
    let user_id = i64::from(current_user.id);

    // `task_member_service.is_member`: the accessible task's owner or approved
    // member. A miss maps to the source's `404 {"detail": "Task not found"}`.
    let owner_id = state
        .task_store
        .get_task_owner_id(task_id)
        .await
        .map_err(|_| download_url_internal_error())?
        .and_then(|row| row.get_required::<i64>("user_id").ok());
    let is_member = match owner_id {
        Some(owner) if owner == user_id => true,
        Some(_) => repository::is_approved_member(&state.mysql, task_id, user_id)
            .await
            .map_err(|_| download_url_internal_error())?,
        None => false,
    };
    if !is_member {
        return Err(not_found());
    }

    // `task_store.get_task_by_states` with `TaskResource.is_active_query()`.
    if state
        .task_store
        .get_active_task(task_id)
        .await
        .map_err(|_| download_url_internal_error())?
        .is_none()
    {
        return Err(not_found());
    }

    // `create_docx_export_download_token` (5-minute expiry).
    let download_token = token::create_download_token(
        &state.auth,
        task_id,
        user_id,
        &current_user.user_name,
        message_ids,
        5,
    )
    .ok_or_else(download_url_internal_error)?;

    let mut download_url = format!(
        "/api/tasks/{task_id}/export/docx?download_token={}",
        quote_all(&download_token)
    );
    // `if message_ids:` appends the filter only for a non-empty value.
    if let Some(message_ids) = message_ids.filter(|value| !value.is_empty()) {
        download_url.push_str("&message_ids=");
        download_url.push_str(&quote_all(message_ids));
    }

    let body = serde_json::to_string(&DownloadUrlResponse {
        download_url,
        expires_in: 300,
    })
    .map_err(|_| download_url_internal_error())?;
    Ok(Response::owned_bytes(StatusCode::OK, body).content_type("application/json"))
}

/// `urllib.parse.quote(value, safe="")`: every byte outside the unreserved set
/// (`A-Za-z0-9` and `-._~`) becomes uppercase `%XX`.
fn quote_all(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xF) as usize] as char);
        }
    }
    out
}

/// `_build_content_disposition`: quoted ASCII filename or RFC 5987 encoding.
fn content_disposition(filename: &str) -> String {
    if filename.is_ascii() {
        let escaped = filename.replace('\\', "\\\\").replace('"', "\\\"");
        format!("attachment; filename=\"{escaped}\"")
    } else {
        let mut encoded = String::new();
        for byte in filename.bytes() {
            if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
                encoded.push(byte as char);
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        format!("attachment; filename*=UTF-8''{encoded}")
    }
}

/// Handler failure classification.
enum ExportError {
    Fast(FastApiError),
    Internal,
}

impl From<FastApiError> for ExportError {
    fn from(error: FastApiError) -> Self {
        Self::Fast(error)
    }
}

fn not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Task not found")
}

fn internal_error() -> FastApiError {
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Failed to generate DOCX document",
    )
}

/// An unhandled failure in the download-url handler. The source endpoint has no
/// `try/except`, so an exception reaches `python_exception_handler`
/// (`{"error_code": 500, "detail": "Internal server error"}`).
fn download_url_internal_error() -> FastApiError {
    FastApiError::unhandled()
}

/// The endpoint flow after parameter extraction.
async fn export(
    state: &AppState,
    task_id: i64,
    current_user: Option<&crate::auth::OptionalSessionUser>,
    params: &ExportQuery,
) -> Result<(String, Vec<u8>), ExportError> {
    // Authentication: download token first, then optional bearer session.
    let user_id = if let Some(download_token) = params.download_token.as_deref() {
        let Some(user_id) = token::verify_download_token(
            &state.auth,
            download_token,
            task_id,
            params.message_ids.as_deref(),
        ) else {
            return Err(FastApiError::unauthorized("Invalid download token").into());
        };
        let user = state
            .mysql
            .fetch_optional::<_, _, repository::UserRow>(repository::ACTIVE_USER_BY_ID, (user_id,))
            .await
            .map_err(|_| ExportError::Internal)?;
        match user {
            Some(_) => user_id,
            None => {
                return Err(FastApiError::unauthorized("Invalid download token").into());
            }
        }
    } else {
        // `get_current_user_optional` yields `None` when the request carries
        // no valid bearer session; the source maps that to
        // `401 {"detail": "Not authenticated"}` before any member check
        // (`app/api/endpoints/adapter/tasks.py`).
        let Some(user) = current_user else {
            return Err(FastApiError::unauthorized("Not authenticated").into());
        };
        i64::from(user.id)
    };

    // `task_member_service.is_member` (accessible task + owner/member check).
    let owner_id = state
        .task_store
        .get_task_owner_id(task_id)
        .await
        .map_err(|_| ExportError::Internal)?
        .and_then(|row| row.get_required::<i64>("user_id").ok());
    let is_member = match owner_id {
        Some(owner) if owner == user_id => true,
        Some(_) => repository::is_approved_member(&state.mysql, task_id, user_id)
            .await
            .map_err(|_| ExportError::Internal)?,
        None => false,
    };
    if !is_member {
        return Err(not_found().into());
    }

    // `task_store.get_task_by_states`.
    let task = state
        .task_store
        .get_active_task(task_id)
        .await
        .map_err(|_| ExportError::Internal)?
        .as_ref()
        .map(repository::decode_task_row)
        .transpose()
        .map_err(|_| ExportError::Internal)?;
    let Some(task) = task else {
        return Err(not_found().into());
    };

    // Parse `message_ids`.
    let filter_message_ids: Option<Vec<i64>> = match params.message_ids.as_deref() {
        Some(message_ids) if !message_ids.is_empty() => {
            let mut ids = Vec::new();
            for part in message_ids.split(',') {
                let part = part.trim();
                if part.is_empty() {
                    continue;
                }
                let id: i64 = part.parse().map_err(|_| {
                    FastApiError::detail(
                        StatusCode::BAD_REQUEST,
                        "Invalid message_ids format. Must be comma-separated integers.",
                    )
                })?;
                ids.push(id);
            }
            Some(ids)
        }
        _ => None,
    };

    // `subtask_store.list_by_task_ordered` + `_attach_contexts`.
    let subtasks = state
        .task_store
        .list_subtasks_ordered(task_id, filter_message_ids.as_deref())
        .await
        .map_err(|_| ExportError::Internal)?
        .iter()
        .map(repository::decode_subtask_row)
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()
        .map_err(|_| ExportError::Internal)?;
    let subtask_ids = subtasks.iter().map(|s| s.id).collect::<Vec<_>>();
    let contexts = repository::list_contexts(&state.mysql, &subtask_ids)
        .await
        .map_err(|_| ExportError::Internal)?;

    // Sender display names. `_add_task_content` loads the task owner once and
    // `_add_message` loads the actual sender for every `USER` message with a
    // positive `sender_user_id`. Each source lookup is a separate `.first()`
    // call with no caching, so a repeated sender id stays a repeated query and
    // the map keeps the last loaded name.
    let mut user_ids = vec![task.user_id];
    for subtask in &subtasks {
        let sender = subtask.sender_user_id.unwrap_or(0);
        if subtask.role == "USER" && sender > 0 {
            user_ids.push(sender);
        }
    }
    let mut users = std::collections::HashMap::new();
    for id in user_ids {
        if let Ok(Some(user)) = state
            .mysql
            .fetch_optional::<_, _, repository::UserRow>(repository::USER_BY_ID, (id,))
            .await
        {
            users.insert(id, user.user_name);
        }
    }

    // Attachment cards from the batched contexts.
    let attachments = contexts
        .iter()
        .filter(|context| context.context_type == "attachment")
        .map(|context| (context.subtask_id, attachment_card(context)))
        .collect::<Vec<_>>();

    let now = generator::now_local();
    let input = ExportInput {
        task: &task,
        subtasks: &subtasks,
        attachments,
        users,
    };
    let filename = generator::export_filename(&input, now);
    let body = generator::generate_docx(&input, now);
    Ok((filename, body))
}

/// `_add_file_attachment` card inputs from a context row's `type_data`.
fn attachment_card(context: &ContextRow) -> generator::AttachmentCardView {
    let type_data = context
        .type_data
        .as_ref()
        .map(|json| json.0.to_value())
        .unwrap_or_default();
    let file_extension = type_data
        .get("file_extension")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let file_size = type_data
        .get("file_size")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    generator::AttachmentCardView {
        file_type: super::markdown::file_type_label(file_extension).to_string(),
        name: super::markdown::sanitize_xml_text(context.name.as_deref().unwrap_or("")),
        size: super::markdown::format_file_size(file_size),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `urllib.parse.quote(value, safe="")` keeps only the unreserved set and
    /// encodes the rest as uppercase `%XX`.
    #[test]
    fn quote_all_matches_python_quote_without_safe_characters() {
        assert_eq!(quote_all("1,2"), "1%2C2");
        assert_eq!(
            quote_all("eyJhbGciOiJIUzI1NiJ9.abc-DEF_0.xyz"),
            "eyJhbGciOiJIUzI1NiJ9.abc-DEF_0.xyz"
        );
        assert_eq!(quote_all("a/b c~"), "a%2Fb%20c~");
    }

    #[test]
    fn download_url_body_matches_the_source_shape() {
        let body = serde_json::to_string(&DownloadUrlResponse {
            download_url:
                "/api/tasks/21577915845327/export/docx?download_token=tok&message_ids=1%2C2"
                    .to_string(),
            expires_in: 300,
        })
        .unwrap();
        assert_eq!(
            body,
            "{\"download_url\":\"/api/tasks/21577915845327/export/docx?download_token=tok&message_ids=1%2C2\",\"expires_in\":300}"
        );
    }
}
