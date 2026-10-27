// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/attachments/upload` — chat attachment upload
//! (`app/api/endpoints/adapter/attachments.py:upload_attachment` ->
//! `app/services/context/context_service.py:ContextService.upload_attachment`).
//!
//! Source pipeline (the recorded path):
//! 1. `get_current_user_jwt_apikey_tasktoken` — the flexible JWT/API-key/
//!    task-token authentication plus the `users` lookup.
//! 2. a best-effort source image upload for the source image-type
//!    extensions (`state.attachment_upload`).
//! 3. `get_storage_backend(db)` — the configured object store
//!    (`ATTACHMENT_STORAGE_BACKEND`; the MinIO backend probes the bucket here).
//! 4. `_create_attachment_context` + `db.flush()` — the `uploading` INSERT.
//! 5. `_store_attachment_binary` -> `StorageBackend.save`: the object write,
//!    the save's own re-query (`SELECT ... WHERE id = ? LIMIT 1`), and its
//!    `type_data` flush.
//! 6. `context.status = PARSING; db.flush()`.
//! 7. `_parse_and_update_context` (`document.rs`) then `context.status =
//!    READY; db.flush()`. Image payloads first run the model-image
//!    preprocessing (`model_image.rs`) that Pillow applies before the base64
//!    value is inlined.
//! 8. `db.commit()` + `db.refresh(context)`.
//! 9. `_build_attachment_response`.
//!
//! The object store and the image upload are application-owned seams
//! (`backend.rs`); `overwrite_attachment_id` overwrites an existing owned row
//! instead of inserting one.
pub mod backend;
#[cfg(test)]
mod consistency_tests;
mod csv;
pub(crate) mod document;
mod jpeg_metadata;
pub(crate) mod model_image;
mod model_jpeg;
pub(crate) mod office;
mod overwrite;
pub(crate) mod pdf;
mod resample;
mod response;
mod store;
#[cfg(test)]
mod tests;
pub(crate) mod truncation;
mod video_metadata;

pub use backend::{
    AttachmentUploadBackend, ImagePid, ImageUploadRequest, MySqlStorageBackend, StoreObjectRequest,
    UploadBackendError,
};
pub(crate) use overwrite::{OverwriteError, Param, Preflush, overwrite_attachment_internal};
use response::AttachmentResponse;
pub(crate) use store::refresh_context;
use store::{
    INSERT_CONTEXT_QUERY, UPDATE_BINARY_DATA_QUERY, UPDATE_FAILED_QUERY, UPDATE_PARSING_QUERY,
    UPDATE_READY_QUERY, UPDATE_READY_WITH_IMAGE_QUERY, UPDATE_TYPE_DATA_QUERY, build_type_data,
    merge_extra_type_data, type_data_json,
};

use std::sync::Arc;

use brz_http_server::{Multipart, StatusCode};
use brz_mysql::MysqlTransaction;
use serde_json::{Map, Value};

use super::context_store;
use crate::attachments_task_all::auth::AuthenticatedUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::user_reader::USER_ENTITY_BY_ID_QUERY;

/// The source image-type allowlist (`attachments.py`): the extensions the
/// image upload accepts.
fn image_mime_type(extension: &str) -> Option<&'static str> {
    match extension {
        ".gif" => Some("image/gif"),
        ".jpeg" | ".jpg" => Some("image/jpeg"),
        ".png" => Some("image/png"),
        _ => None,
    }
}

/// Whether the filename is accepted by the image upload service.
fn attempts_image_upload(filename: &str) -> bool {
    image_mime_type(&document::extension_of(filename)).is_some()
}

/// One `Session.get(User, id)` row: the unlabeled `users` projection
/// SQLAlchemy renders for the identity-map reload.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct OwnerEntityRow {
    #[allow(dead_code, reason = "selected to match the source column list")]
    id: i64,
    #[allow(dead_code, reason = "selected to match the source column list")]
    user_name: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    password_hash: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    email: Option<String>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    git_info: Option<brz_mysql::Json<brz_json::OpaqueJson>>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    is_active: i8,
    #[allow(dead_code, reason = "selected to match the source column list")]
    role: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    auth_source: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    preferences: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    updated_at: chrono::NaiveDateTime,
}

/// The owner-row reload the source issues after its image upload.
///
/// The image upload commits inside the request, which expires the
/// session's owner row; the request's next use reloads it through the ORM
/// identity map as `Session.get(User, id)` — the unlabeled projection by
/// primary key, one row, no `LIMIT`. Only the accepted image types reach that
/// upload, so only they carry the read; office documents do not.
async fn reload_owner_after_image_upload(
    state: &Arc<AppState>,
    filename: &str,
    user_id: i64,
) -> Result<(), FastApiError> {
    if !attempts_image_upload(filename) {
        return Ok(());
    }
    let row: Option<OwnerEntityRow> = state
        .mysql
        .fetch_optional(USER_ENTITY_BY_ID_QUERY, (user_id,))
        .await
        .map_err(dependency_error)?;
    if row.is_none() {
        tracing::warn!(
            user_id,
            "the owner row disappeared before the image-upload reload"
        );
    }
    Ok(())
}

/// `context_service.UNLINKED_SUBTASK_ID`: unlinked attachments use `0`.
const UNLINKED_SUBTASK_ID: i64 = 0;

/// `ContextService.upload_attachment`'s outcome: the new context id plus
/// either the truncation info the response carries or the committed
/// `DocumentParseError` the endpoint renders as 400.
enum UploadOutcome {
    Parsed {
        context_id: i64,
        truncation_info: Option<Value>,
    },
    /// The overwrite stage already refreshed the row: the endpoint must not
    /// issue the source's single `db.refresh(context)` twice.
    Overwritten {
        row: Option<Box<store::SubtaskContextRefreshRow>>,
        truncation_info: Option<Value>,
    },
    ParseFailed {
        body: Value,
    },
}

/// `POST /api/attachments/upload`.
#[brz_http_server::post("/api/attachments/upload")]
async fn upload_attachment(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] user: AuthenticatedUser,
    overwrite_attachment_id: Option<i64>,
    storage_purpose: Option<String>,
    multipart: Multipart,
) -> Result<AttachmentResponse, FastApiError> {
    let storage_purpose = storage_purpose.unwrap_or_else(|| "default".to_string());
    if storage_purpose != "default" && storage_purpose != "video_reference" {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Invalid storage_purpose",
        ));
    }

    let (filename, binary_data) = bind_upload_file(&multipart, overwrite_attachment_id)?;

    let subtask_id = user.subtask_id.unwrap_or(UNLINKED_SUBTASK_ID);
    tracing::info!(
        user_id = user.id,
        filename = %filename,
        subtask_id,
        storage_purpose = %storage_purpose,
        "[attachments] upload_attachment"
    );

    let image_pid_metadata = upload_image_pid(state, filename, binary_data, &user).await;
    reload_owner_after_image_upload(state, filename, user.id).await?;

    let outcome = match overwrite_attachment_id {
        Some(context_id) => {
            if context_id <= 0 {
                return Err(FastApiError::detail(
                    StatusCode::BAD_REQUEST,
                    "overwrite_attachment_id must be positive",
                ));
            }
            overwrite_attachment(
                state,
                context_id,
                user.id,
                filename,
                binary_data,
                &image_pid_metadata,
            )
            .await?
        }
        None => {
            upload_new_attachment(
                state,
                user.id,
                filename,
                binary_data,
                subtask_id,
                &image_pid_metadata,
                &storage_purpose,
            )
            .await?
        }
    };

    let (row, truncation_info) = match outcome {
        // The source commits the failed row before re-raising, so the endpoint
        // renders the `DocumentParseError` without refreshing the context.
        UploadOutcome::ParseFailed { body } => {
            return Err(FastApiError::json_body(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "detail": body }),
            ));
        }
        // `ContextService.overwrite_attachment` already ran the source's
        // `db.refresh(context)`.
        UploadOutcome::Overwritten {
            row,
            truncation_info,
        } => (row.map(|row| *row), truncation_info),
        // `ContextService.upload_attachment`'s own `db.refresh(context)`.
        UploadOutcome::Parsed {
            context_id,
            truncation_info,
        } => (
            refresh_context(&state.mysql, context_id)
                .await
                .map_err(dependency_error)?,
            truncation_info,
        ),
    };

    let row = row.ok_or_else(attachment_not_found)?;
    Ok(AttachmentResponse::from_context(&row, truncation_info))
}

/// Validate uploads before any media-service, storage, or database work.
/// Empty overwrites retain the existing document-content clearing contract.
fn bind_upload_file(
    multipart: &Multipart,
    overwrite_attachment_id: Option<i64>,
) -> Result<(&str, &[u8]), FastApiError> {
    let Some(file) = multipart.get("file") else {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "missing",
            "loc": ["body", "file"],
            "msg": "Field required",
        }])));
    };
    let Some(filename) = file.filename.as_deref().filter(|name| !name.is_empty()) else {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Filename is required",
        ));
    };
    if file.bytes.is_empty() && overwrite_attachment_id.is_none() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "File is empty",
        ));
    }
    if !document::validate_file_size(file.bytes.len() as i64) {
        let max_size_mb = document::max_file_size() as f64 / (1024.0 * 1024.0);
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("File size exceeds maximum limit ({max_size_mb:.1} MB)"),
        ));
    }
    Ok((filename, &file.bytes))
}

/// The best-effort image PID metadata merged into the attachment's
/// `type_data`. An empty map when the extension is not an accepted image type
/// (the source image-type gate precedes the upload).
async fn upload_image_pid(
    state: &Arc<AppState>,
    filename: &str,
    content: &[u8],
    user: &AuthenticatedUser,
) -> Map<String, Value> {
    let extension = document::extension_of(filename);
    if !attempts_image_upload(filename) {
        return Map::new();
    }
    let Some(mime_type) = image_mime_type(&extension) else {
        return Map::new();
    };
    let uploaded = state
        .attachment_upload
        .upload_image_pid(ImageUploadRequest {
            filename,
            content,
            mime_type,
            preferences: user.preferences.as_str(),
        })
        .await;
    match uploaded {
        Some(ImagePid { pid }) => {
            let mut metadata = Map::new();
            metadata.insert("image_pid".to_string(), Value::from(pid));
            metadata.insert(
                "image_pid_source".to_string(),
                Value::from(state.attachment_upload.image_pid_source()),
            );
            metadata.insert("image_pid_status".to_string(), Value::from("ready"));
            metadata
        }
        None => {
            let mut metadata = Map::new();
            metadata.insert("image_pid_status".to_string(), Value::from("failed"));
            metadata.insert("image_pid_error".to_string(), Value::from("upload_failed"));
            metadata
        }
    }
}

/// `ContextService.upload_attachment`: insert, store, parse, commit.
async fn upload_new_attachment(
    state: &Arc<AppState>,
    user_id: i64,
    filename: &str,
    binary_data: &[u8],
    subtask_id: i64,
    extra_type_data: &Map<String, Value>,
    _storage_purpose: &str,
) -> Result<UploadOutcome, FastApiError> {
    let (extension, mime_type) = validate_input(filename, binary_data)?;
    let file_size = binary_data.len() as i64;
    let backend = Arc::clone(&state.attachment_upload);
    let backend_type = backend.backend_type().to_string();

    // `get_storage_backend(db)`'s construction (the MinIO bucket probe).
    backend.ensure_ready().await.map_err(|_| internal_error())?;

    let effective_subtask_id = if subtask_id > 0 {
        subtask_id
    } else {
        UNLINKED_SUBTASK_ID
    };
    let base_type_data = build_type_data(
        filename,
        &extension,
        file_size,
        mime_type,
        &backend_type,
        "",
    );
    let insert_type_data = type_data_json(&base_type_data);

    let effective_subtask_id_value = effective_subtask_id;
    let user_id_value = user_id;
    let filename_owned = filename.to_string();
    state
        .mysql
        .with_transaction(async |transaction| {
            let execution = transaction
                .execute(
                    INSERT_CONTEXT_QUERY,
                    (
                        effective_subtask_id_value,
                        user_id_value,
                        filename_owned.as_str(),
                        insert_type_data.as_str(),
                    ),
                )
                .await?;
            let context_id = execution.last_insert_id as i64;

            let storage_key = generate_storage_key(context_id, user_id_value);
            let mut type_data = base_type_data.clone();
            type_data.insert("storage_key".to_string(), Value::from(storage_key.clone()));
            merge_extra_type_data(&mut type_data, extra_type_data);

            store_and_parse(
                transaction,
                &*backend,
                context_id,
                user_id_value,
                &filename_owned,
                &extension,
                binary_data,
                storage_key,
                type_data,
            )
            .await
        })
        .await
        .map_err(dependency_error)
}

/// A `ContextService.upload_attachment` failure that reaches a caller which
/// does not translate it: the source raises `ValueError`, `DocumentParseError`
/// or a storage error, and the application's generic handler renders the
/// unhandled 500 body.
#[derive(Debug)]
pub(crate) struct UploadContextError;

/// `ContextService.upload_attachment` for internal callers that render their
/// own response (the conversion callback).
///
/// The public upload endpoint's `upload_new_attachment` applies the same
/// insert/store/parse pipeline; this entry point differs only in the source
/// contract of its caller: it accepts the source's `lifecycle_owner` marker,
/// carries no image-pid metadata, and reports every failure as the caller's
/// unhandled error instead of a 400.
pub(crate) async fn upload_attachment_context(
    state: &Arc<AppState>,
    user_id: i64,
    filename: &str,
    binary_data: &[u8],
    subtask_id: i64,
    lifecycle_owner: Option<&str>,
) -> Result<i64, UploadContextError> {
    // `_validate_attachment_input`: extension support and size limits. The
    // source raises `ValueError` before any database work.
    let extension = document::extension_of(filename);
    if !document::is_supported_extension(&extension)
        || !document::validate_file_size(binary_data.len() as i64)
    {
        return Err(UploadContextError);
    }
    let mime_type = document::mime_type(&extension);
    let file_size = binary_data.len() as i64;
    let backend = Arc::clone(&state.attachment_upload);
    let backend_type = backend.backend_type().to_string();

    // `get_storage_backend(db)`'s construction (the MinIO bucket probe).
    backend
        .ensure_ready()
        .await
        .map_err(|_| UploadContextError)?;

    let mut base_type_data = build_type_data(
        filename,
        &extension,
        file_size,
        mime_type,
        &backend_type,
        "",
    );
    // `context.type_data = {**type_data, "lifecycle_owner": owner}` before
    // the INSERT, so the marker rides on the initial row.
    if let Some(owner) = lifecycle_owner {
        base_type_data.insert("lifecycle_owner".to_string(), Value::from(owner));
    }
    let insert_type_data = type_data_json(&base_type_data);

    let effective_subtask_id = if subtask_id > 0 {
        subtask_id
    } else {
        UNLINKED_SUBTASK_ID
    };
    let filename_owned = filename.to_string();
    let outcome = state
        .mysql
        .with_transaction(async |transaction| {
            let execution = transaction
                .execute(
                    INSERT_CONTEXT_QUERY,
                    (
                        effective_subtask_id,
                        user_id,
                        filename_owned.as_str(),
                        insert_type_data.as_str(),
                    ),
                )
                .await?;
            let context_id = execution.last_insert_id as i64;

            let storage_key = generate_storage_key(context_id, user_id);
            let mut type_data = base_type_data.clone();
            type_data.insert("storage_key".to_string(), Value::from(storage_key.clone()));

            let outcome = store_and_parse(
                transaction,
                &*backend,
                context_id,
                user_id,
                &filename_owned,
                &extension,
                binary_data,
                storage_key,
                type_data,
            )
            .await?;
            Ok((context_id, outcome))
        })
        .await
        .map_err(|_| UploadContextError)?;

    finish_uploaded_context(&state.mysql, outcome).await
}

/// `ContextService.upload_attachment`'s commit tail: the parsed path runs the
/// service's own `db.refresh(context)` (`context_service.py:516-517`,
/// `if commit: db.commit(); db.refresh(context)`) — the commit expired the
/// instance, so the source re-selects the unaliased row once before the
/// caller can use it. A parse failure propagates the caller's unhandled
/// error; the failed row was already committed inside the transaction.
async fn finish_uploaded_context<M: brz_mysql::Mysql>(
    mysql: &M,
    outcome: (i64, UploadOutcome),
) -> Result<i64, UploadContextError> {
    match outcome {
        (context_id, UploadOutcome::Parsed { .. }) => {
            store::refresh_context(mysql, context_id)
                .await
                .map_err(|_| UploadContextError)?;
            Ok(context_id)
        }
        (_, UploadOutcome::ParseFailed { .. }) | (_, UploadOutcome::Overwritten { .. }) => {
            Err(UploadContextError)
        }
    }
}

/// `ContextService.delete_context(db, context_id, user_id)` for an unlinked
/// attachment (`_delete_unlinked_context`).
///
/// A linked row is left in place. A storage removal failure is logged and
/// does not block the row deletion, matching the source's ordinary-context
/// contract. The row itself is deleted and committed.
pub(crate) async fn delete_unlinked_context(
    state: &Arc<AppState>,
    context_id: i64,
    user_id: i64,
) -> Result<(), UploadContextError> {
    let row: Option<store::OverwriteContextRow> = state
        .mysql
        .fetch_optional(store::OVERWRITE_CONTEXT_OWNED_QUERY, (context_id, user_id))
        .await
        .map_err(|_| UploadContextError)?;
    let Some(row) = row else {
        return Ok(());
    };
    if row.subtask_id > 0 {
        tracing::warn!(
            context_id,
            subtask_id = row.subtask_id,
            "refusing to delete a linked attachment context"
        );
        return Ok(());
    }
    if row.context_type == "attachment" && !row.storage_key().is_empty() {
        let key = row.storage_key();
        match state.attachment_upload.delete_object(&key).await {
            Ok(true) => {}
            Ok(false) => tracing::warn!(context_id, "storage did not delete the object"),
            Err(error) => {
                tracing::warn!(%error, context_id, "failed to delete the stored object");
            }
        }
    }
    state
        .mysql
        .with_transaction(async |transaction| {
            transaction
                .execute(
                    "DELETE FROM subtask_contexts WHERE subtask_contexts.id = ?",
                    (context_id,),
                )
                .await?;
            Ok(())
        })
        .await
        .map_err(|_| UploadContextError)
}

///
/// The reset/store/parse stage is shared with the knowledge content update
/// (`overwrite::overwrite_attachment_internal`); this wrapper adds the
/// endpoint's owner check, its image-pid metadata merge, and the parse-failure
/// rendering the upload endpoint applies.
async fn overwrite_attachment(
    state: &Arc<AppState>,
    context_id: i64,
    user_id: i64,
    filename: &str,
    binary_data: &[u8],
    extra_type_data: &Map<String, Value>,
) -> Result<UploadOutcome, FastApiError> {
    let outcome = overwrite::overwrite_attachment_internal(
        state,
        Some(user_id),
        context_id,
        filename,
        binary_data,
        extra_type_data,
        None,
    )
    .await
    .map_err(OverwriteError::into_upload_error)?;
    Ok(UploadOutcome::Overwritten {
        row: outcome.row.map(Box::new),
        truncation_info: outcome.truncation_info,
    })
}

/// The shared `_store_attachment_binary` + `_parse_and_update_context` stage.
///
/// Runs inside the caller's transaction: the object write, the backend save's
/// re-query and `type_data` flush, the `parsing` flush, and the `ready` or
/// `failed` flush. A `DocumentParseError` still commits — the source writes the
/// failed state before re-raising — and is reported through the returned
/// outcome.
#[allow(clippy::too_many_arguments)]
async fn store_and_parse<T: MysqlTransaction>(
    transaction: &mut T,
    backend: &dyn AttachmentUploadBackend,
    context_id: i64,
    user_id: i64,
    filename: &str,
    extension: &str,
    binary_data: &[u8],
    storage_key: String,
    mut type_data: Map<String, Value>,
) -> Result<UploadOutcome, brz_mysql::MysqlError> {
    let encrypt = encryption_enabled();
    let store_data = if encrypt {
        super::crypto::encrypt_attachment(binary_data).unwrap_or_else(|_| binary_data.to_vec())
    } else {
        binary_data.to_vec()
    };

    // `StorageBackend.save`: the object write (MinIO PUT for the object
    // store). A save that raises must abort the session — the source deletes
    // nothing and never reaches the `binary_data` write, and the endpoint's
    // generic handler renders 500 `Failed to upload attachment`. Carry the
    // failure out as a dependency error so the writes roll back.
    let external = match backend
        .store_object(StoreObjectRequest {
            key: &storage_key,
            data: &store_data,
            filename,
            mime_type: mime_type_for(extension),
            user_id,
        })
        .await
    {
        Ok(stored) => stored,
        Err(_) => {
            tracing::error!(
                attachment_id = context_id,
                "attachment storage write failed"
            );
            return Err(brz_mysql::MysqlError::InvalidQuery {
                reason: "attachment storage write failed".to_owned(),
            });
        }
    };

    // The save's own `SubtaskContext` re-query, then its `type_data` flush.
    let _reloaded: Option<context_store::SubtaskContextRow> = transaction
        .fetch_optional(context_store::CONTEXT_BY_ID_QUERY, (context_id,))
        .await?;
    if external {
        transaction
            .execute(
                UPDATE_TYPE_DATA_QUERY,
                (type_data_json(&type_data), context_id),
            )
            .await?;
    } else {
        transaction
            .execute(
                UPDATE_BINARY_DATA_QUERY,
                (store_data, type_data_json(&type_data), context_id),
            )
            .await?;
    }

    // `context.status = PARSING; db.flush()` plus the encryption metadata.
    type_data.insert("is_encrypted".to_string(), Value::from(encrypt));
    type_data.insert(
        "encryption_version".to_string(),
        Value::from(if encrypt { 1 } else { 0 }),
    );
    transaction
        .execute(
            UPDATE_PARSING_QUERY,
            (type_data_json(&type_data), context_id),
        )
        .await?;

    // `_parse_and_update_context`.
    let parsed = match document::parse_async(binary_data, extension).await {
        Ok(parsed) => parsed,
        // The source records the failure and lets the caller commit it.
        Err(error) => {
            transaction
                .execute(UPDATE_FAILED_QUERY, (error.message.as_str(), context_id))
                .await?;
            return Ok(UploadOutcome::ParseFailed {
                body: parse_error_value(&error),
            });
        }
    };

    type_data.insert(
        "is_truncated".to_string(),
        Value::from(parsed.truncation_info.is_some()),
    );
    let ready_type_data = type_data_json(&type_data);
    match parsed
        .image_base64
        .clone()
        .filter(|value| !value.is_empty())
    {
        Some(image_base64) => {
            transaction
                .execute(
                    UPDATE_READY_WITH_IMAGE_QUERY,
                    (
                        image_base64,
                        parsed.text,
                        parsed.text_length,
                        ready_type_data,
                        context_id,
                    ),
                )
                .await?;
        }
        None => {
            transaction
                .execute(
                    UPDATE_READY_QUERY,
                    (parsed.text, parsed.text_length, ready_type_data, context_id),
                )
                .await?;
        }
    }

    Ok(UploadOutcome::Parsed {
        context_id,
        truncation_info: parsed.truncation_info,
    })
}

/// `_validate_attachment_input`: extension support, size, and MIME type.
fn validate_input(
    filename: &str,
    binary_data: &[u8],
) -> Result<(String, &'static str), FastApiError> {
    let extension = document::extension_of(filename);
    if !document::is_supported_extension(&extension) {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Unsupported file type: {extension}"),
        ));
    }
    if !document::validate_file_size(binary_data.len() as i64) {
        let max_size_mb = document::max_file_size() as f64 / (1024.0 * 1024.0);
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("File size exceeds maximum limit ({max_size_mb:.1} MB)"),
        ));
    }
    Ok((extension.clone(), document::mime_type(&extension)))
}

fn mime_type_for(extension: &str) -> &'static str {
    document::mime_type(extension)
}

/// `_should_encrypt`: `ATTACHMENT_ENCRYPTION_ENABLED` (deployment default
/// `false`).
fn encryption_enabled() -> bool {
    crate::config::env_or_dotenv("ATTACHMENT_ENCRYPTION_ENABLED")
        .map(|value| value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// `generate_storage_key`: `attachments/{uuid12}_{ts}_{user_id}_{id}`.
fn generate_storage_key(attachment_id: i64, user_id: i64) -> String {
    let mut bytes = [0u8; 16];
    let unique_id = if getrandom::getrandom(&mut bytes).is_ok() {
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()[..12]
            .to_string()
    } else {
        String::new()
    };
    let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
    format!("attachments/{unique_id}_{timestamp}_{user_id}_{attachment_id}")
}

/// The `DocumentParseError` value the endpoint renders as a 400 `detail` dict.
fn parse_error_value(error: &document::DocumentParseError) -> Value {
    serde_json::json!({
        "message": error.message,
        "error_code": error.error_code,
    })
}

fn attachment_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Attachment not found")
}

fn internal_error() -> FastApiError {
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Failed to upload attachment",
    )
}

fn dependency_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "attachment upload dependency failed");
    internal_error()
}
