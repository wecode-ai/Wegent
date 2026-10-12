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
//!    READY; db.flush()`.
//! 8. `db.commit()` + `db.refresh(context)`.
//! 9. `_build_attachment_response`.
//!
//! The object store and the image upload are application-owned seams
//! (`backend.rs`); `overwrite_attachment_id` overwrites an existing owned row
//! instead of inserting one.
pub mod backend;
mod document;
mod response;
mod store;

pub use backend::{
    AttachmentUploadBackend, ImagePid, ImageUploadRequest, MySqlStorageBackend, StoreObjectRequest,
    UploadBackendError,
};
use response::AttachmentResponse;
use store::{
    INSERT_CONTEXT_QUERY, UPDATE_BINARY_DATA_QUERY, UPDATE_PARSING_QUERY, UPDATE_READY_QUERY,
    UPDATE_READY_WITH_IMAGE_QUERY, UPDATE_TYPE_DATA_QUERY, build_type_data, merge_extra_type_data,
    refresh_context, type_data_json,
};

use std::sync::Arc;

use brz_http_server::{Multipart, StatusCode};
use brz_mysql::MysqlTransaction;
use serde_json::{Map, Value};

use super::context_store;
use crate::attachments_task_all::auth::AuthenticatedUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

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

/// `context_service.UNLINKED_SUBTASK_ID`: unlinked attachments use `0`.
const UNLINKED_SUBTASK_ID: i64 = 0;

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

    // `file: UploadFile = File(...)`: FastAPI rejects a missing field with 422.
    let Some(file) = multipart.get("file") else {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "missing",
            "loc": ["body", "file"],
            "msg": "Field required",
        }])));
    };
    let Some(filename) = file.filename.clone().filter(|name| !name.is_empty()) else {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Filename is required",
        ));
    };
    let binary_data = file.bytes.to_vec();

    // `DocumentParser.validate_file_size` before processing.
    if !document::validate_file_size(binary_data.len() as i64) {
        let max_size_mb = document::max_file_size() as f64 / (1024.0 * 1024.0);
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("File size exceeds maximum limit ({max_size_mb:.1} MB)"),
        ));
    }

    let subtask_id = user.subtask_id.unwrap_or(UNLINKED_SUBTASK_ID);
    tracing::info!(
        user_id = user.id,
        filename = %filename,
        subtask_id,
        storage_purpose = %storage_purpose,
        "[attachments] upload_attachment"
    );

    let image_pid_metadata = upload_weibo_image_pid(state, &filename, &binary_data, &user).await;

    let (context_id, truncation) = match overwrite_attachment_id {
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
                &filename,
                &binary_data,
                &image_pid_metadata,
            )
            .await?
        }
        None => {
            upload_new_attachment(
                state,
                user.id,
                &filename,
                &binary_data,
                subtask_id,
                &image_pid_metadata,
                &storage_purpose,
            )
            .await?
        }
    };

    let row = refresh_context(&state.mysql, context_id)
        .await
        .map_err(dependency_error)?
        .ok_or_else(attachment_not_found)?;
    Ok(AttachmentResponse::from_context(&row, truncation))
}

/// The best-effort image PID metadata merged into the attachment's
/// `type_data`. An empty map when the extension is not an accepted image type
/// (the source image-type gate precedes the upload).
async fn upload_weibo_image_pid(
    state: &Arc<AppState>,
    filename: &str,
    content: &[u8],
    user: &AuthenticatedUser,
) -> Map<String, Value> {
    let extension = document::extension_of(filename);
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
            metadata.insert("image_pid_source".to_string(), Value::from("weibo_upload"));
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
) -> Result<(i64, Option<Value>), FastApiError> {
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

/// `ContextService.overwrite_attachment`: reset and replace an owned row.
async fn overwrite_attachment(
    state: &Arc<AppState>,
    context_id: i64,
    user_id: i64,
    filename: &str,
    binary_data: &[u8],
    extra_type_data: &Map<String, Value>,
) -> Result<(i64, Option<Value>), FastApiError> {
    let (extension, mime_type) = validate_input(filename, binary_data)?;
    let file_size = binary_data.len() as i64;
    let backend = Arc::clone(&state.attachment_upload);
    let backend_type = backend.backend_type().to_string();

    // `get_context(db, id, user_id)`: an owned attachment row or 404.
    let owned: Option<context_store::SubtaskContextRow> = state
        .mysql
        .fetch_optional(
            &format!(
                "{query} AND subtask_contexts.user_id = ?",
                query = context_store::CONTEXT_BY_ID_QUERY
                    .replace("LIMIT 1", "AND subtask_contexts.user_id = ? LIMIT 1")
            ),
            (context_id, user_id),
        )
        .await
        .map_err(dependency_error)?;
    let Some(owned) = owned else {
        return Err(attachment_not_found());
    };
    if owned.context_type != "attachment" {
        return Err(attachment_not_found());
    }

    backend.ensure_ready().await.map_err(|_| internal_error())?;

    let storage_key = owned
        .metadata()
        .and_then(|data| data.storage_key.clone())
        .filter(|key| !key.is_empty())
        .unwrap_or_else(|| generate_storage_key(context_id, user_id));
    let mut type_data = build_type_data(
        filename,
        &extension,
        file_size,
        mime_type,
        &backend_type,
        &storage_key,
    );
    merge_extra_type_data(&mut type_data, extra_type_data);

    state
        .mysql
        .with_transaction(async |transaction| {
            store_and_parse(
                transaction,
                &*backend,
                context_id,
                user_id,
                filename,
                &extension,
                binary_data,
                storage_key.clone(),
                type_data.clone(),
            )
            .await
        })
        .await
        .map_err(dependency_error)
}

/// The shared `_store_attachment_binary` + `_parse_and_update_context` stage.
///
/// Runs inside the caller's transaction: the object write, the backend save's
/// re-query and `type_data` flush, the `parsing` flush, and the `ready` flush.
/// A `DocumentParseError` still commits (the source commits before re-raising)
/// and is reported through the returned outcome.
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
) -> Result<(i64, Option<Value>), brz_mysql::MysqlError> {
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
    let parsed = match document::parse(binary_data, extension) {
        Ok(parsed) => parsed,
        // The source commits the `parsing` state before re-raising.
        Err(error) => return Ok((context_id, Some(parse_error_value(&error)))),
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

    Ok((context_id, parsed.truncation_info))
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

#[cfg(test)]
mod tests {
    use super::*;
    use brz_mysql::{FromMysqlRow, MysqlArgs, MysqlExecution, MysqlResult, MysqlTransaction};

    /// An object store whose write always fails, like the source `save`
    /// raising when `put_object` fails.
    struct FailingStorageBackend;

    #[async_trait::async_trait]
    impl AttachmentUploadBackend for FailingStorageBackend {
        fn backend_type(&self) -> &str {
            "minio"
        }

        async fn ensure_ready(&self) -> Result<(), UploadBackendError> {
            Ok(())
        }

        async fn store_object(
            &self,
            _: StoreObjectRequest<'_>,
        ) -> Result<bool, UploadBackendError> {
            Err(UploadBackendError)
        }

        async fn upload_image_pid(&self, _: ImageUploadRequest<'_>) -> Option<ImagePid> {
            None
        }
    }

    /// Records the statements a transaction executes without a database.
    #[derive(Default)]
    struct StatementLog {
        statements: Vec<String>,
    }

    impl MysqlTransaction for StatementLog {
        async fn execute<S, A>(&mut self, sql: S, _: A) -> MysqlResult<MysqlExecution>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
        {
            let collapsed = sql
                .as_ref()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            self.statements.push(collapsed);
            Ok(MysqlExecution {
                rows_affected: 0,
                last_insert_id: 0,
            })
        }

        async fn fetch_optional<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Option<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Ok(None)
        }

        async fn fetch_one<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<T>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            panic!("unexpected fetch_one")
        }

        async fn fetch_all<S, A, T>(&mut self, _: S, _: A) -> MysqlResult<Vec<T>>
        where
            S: AsRef<str> + Send,
            A: MysqlArgs + Send,
            T: FromMysqlRow + Send,
        {
            Ok(Vec::new())
        }

        fn fetch<'transaction, S, A, T>(
            &'transaction mut self,
            _: S,
            _: A,
        ) -> impl futures_util::Stream<Item = MysqlResult<T>> + Send + 'transaction
        where
            S: AsRef<str> + Send + 'transaction,
            A: MysqlArgs + Send + 'transaction,
            T: FromMysqlRow + Send + 'transaction,
        {
            futures_util::stream::once(async { panic!("unexpected streaming query") })
        }
    }

    /// A failing object write must not fall through to the MySQL `binary_data`
    /// column: the source `save` raises, the session never commits, and the
    /// endpoint renders 500 `Failed to upload attachment`.
    #[tokio::test]
    async fn a_failed_storage_write_aborts_before_any_column_write() {
        let mut transaction = StatementLog::default();
        let result = store_and_parse(
            &mut transaction,
            &FailingStorageBackend,
            1364828,
            157,
            "平台架构周报2026-04-17.md",
            ".md",
            b"## title\n\nbody",
            "attachments/0123456789ab_20261009000000_157_1364828".to_string(),
            Map::new(),
        )
        .await;

        assert!(matches!(
            result,
            Err(brz_mysql::MysqlError::InvalidQuery { .. })
        ));
        assert!(transaction.statements.is_empty());
    }
}
