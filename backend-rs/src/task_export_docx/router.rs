// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Route and handler for `GET /api/tasks/{task_id}/export/docx`
//! (`app.api.endpoints.adapter.tasks.export_task_docx`).

use brz_http_server::{Binary, HttpResponse, StatusCode};
use serde::Deserialize;

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
        // `get_current_user_optional`: a missing or invalid token yields
        // `None`, and the member check below turns that into 404.
        let Some(user) = current_user else {
            return Err(not_found().into());
        };
        i64::from(user.id)
    };

    // `task_member_service.is_member` (accessible task + owner/member check).
    let owner_id = repository::get_accessible_task_owner(&state.mysql, task_id)
        .await
        .map_err(|_| ExportError::Internal)?;
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
    let task = repository::get_task_by_states(&state.mysql, state.task_policy, task_id)
        .await
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
    let subtasks = repository::list_subtasks_ordered(
        &state.mysql,
        state.task_policy,
        task_id,
        filter_message_ids.as_deref(),
    )
    .await
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
