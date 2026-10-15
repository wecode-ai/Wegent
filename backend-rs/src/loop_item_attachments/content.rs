// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-item-attachments/{attachment_id}/content` — read one
//! attachment's bytes.
//!
//! Mirrors `app.api.endpoints.deliveries.read_loop_item_attachment`:
//! `loop_item_attachment_provider_router.content(db, attachment_id, user_id)`
//! then a Starlette `Response(content, media_type=content_type,
//! headers={"Content-Disposition": f'inline; filename="{filename}"'})`.
//!
//! `LoopItemAttachmentProviderRouter.content` routes on the id prefix:
//! - `gitlab-`: the external provider's unified-storage object
//!   (`external_loop_item_provider.attachment_content`);
//! - otherwise `loop_item_service.attachment_content` — the local
//!   `LoopItemAttachment` row (`db.get`), the owning item's view access
//!   (`self.get`), then `delivery_storage.get_bytes(object_key)`.
use brz_http_server::{Binary, HttpResponse, StatusCode};

use crate::attachments::content_type::content_type_value;
use crate::delivery_storage;
use crate::loop_tasks::auth::FlexibleUser;
use crate::loop_tasks::http_error::HttpError;
use crate::state::AppState;

use super::external;
use super::handler::require_item_view_access;
use super::repository::{get_attachment, get_task_item};

/// `attachment.content_type or "application/octet-stream"`.
const DEFAULT_CONTENT_TYPE: &str = "application/octet-stream";

/// GET /api/v1/loop-item-attachments/{attachment_id}/content: the loop-items
/// free function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/loop-item-attachments/:attachment_id/content")]
async fn read_loop_item_attachment(
    #[inject(state)] state: &AppState,
    attachment_id: &str,
    #[auth] current_user: FlexibleUser,
) -> Result<HttpResponse<Binary>, HttpError> {
    let (content, content_type, filename) =
        attachment_content(state, attachment_id, current_user.id).await?;

    // `Response(media_type=content_type)`: Starlette appends `; charset=utf-8`
    // to a `text/` media type without an existing charset.
    let media_type = content_type_value(&content_type);
    let mut response = HttpResponse::new(Binary::new(content));
    response = response
        .header("content-type", media_type.as_ref())
        .map_err(header_error)?;
    // `headers={"Content-Disposition": f'inline; filename="{filename}"'}`.
    response = response
        .header("content-disposition", &content_disposition(&filename))
        .map_err(header_error)?;
    Ok(response)
}

/// Handler body for `GET /api/v1/loop-item-attachments/{attachment_id}/content`.
async fn attachment_content(
    state: &AppState,
    attachment_id: &str,
    user_id: i32,
) -> Result<(Vec<u8>, String, String), HttpError> {
    // `attachment_id.startswith("gitlab-")`.
    if attachment_id.starts_with("gitlab-") {
        return external::attachment_content(state, attachment_id, user_id).await;
    }
    local_attachment_content(state, attachment_id, user_id).await
}

/// `LoopItemService.attachment_content`: resolve the local attachment row, the
/// owning item's view access, then the delivery object.
async fn local_attachment_content(
    state: &AppState,
    attachment_id: &str,
    user_id: i32,
) -> Result<(Vec<u8>, String, String), HttpError> {
    // `_get_attachment`: `db.get(LoopItemAttachment, attachment_id)`.
    let attachment = get_attachment(&state.mysql, attachment_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(attachment_not_found)?;

    // `self.get(db, attachment.loop_item_id, user_id)`. A null/orphan
    // `loop_item_id` matches no item row and is the source's 404.
    let item_id = attachment
        .loop_item_id
        .as_deref()
        .ok_or_else(HttpError::todo_not_found)?;
    let item = get_task_item(&state.mysql, item_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::todo_not_found)?;
    require_item_view_access(state, &item, user_id).await?;

    // `delivery_storage.get_bytes(attachment.object_key)`.
    let object_key = attachment
        .object_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .ok_or_else(internal_error)?;
    let content = delivery_storage::read_object(&state.attachment_http, object_key)
        .await
        .map_err(|_| internal_error())?;

    let content_type = attachment
        .content_type
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_CONTENT_TYPE.to_string());
    // The source interpolates the raw column value into the header, so a
    // `None` display name renders as the literal `None`.
    let filename = attachment
        .display_name
        .unwrap_or_else(|| "None".to_string());
    Ok((content, content_type, filename))
}

/// `f'inline; filename="{filename}"'`.
fn content_disposition(filename: &str) -> String {
    format!("inline; filename=\"{filename}\"")
}

/// 404 `{"detail": "TODO attachment not found"}` (`_get_attachment`).
fn attachment_not_found() -> HttpError {
    HttpError::new(StatusCode::NOT_FOUND, "TODO attachment not found")
}

/// The source's unhandled storage failure (`DeliveryObjectNotFoundError` /
/// `DeliveryStorageUnavailableError`) renders as a 500.
fn internal_error() -> HttpError {
    HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// A rejected header value is the source's unhandled 500.
fn header_error(error: brz_http_server::HeaderBlockError) -> HttpError {
    HttpError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_disposition_matches_the_source_f_string() {
        assert_eq!(
            content_disposition("image.png"),
            "inline; filename=\"image.png\""
        );
    }
}
