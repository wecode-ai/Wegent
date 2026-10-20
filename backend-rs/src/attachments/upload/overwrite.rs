// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `ContextService.overwrite_attachment` / `overwrite_attachment_internal`:
//! the shared trusted overwrite (`_overwrite_attachment_impl`).
//!
//! Two source callers share this stage:
//! `POST /api/attachments/upload?overwrite_attachment_id=...` (owner-checked
//! `get_context`) and
//! `PUT /api/knowledge/documents/{document_id}/content`
//! (`KnowledgeService.update_document_content`, trusted internal path).
//!
//! Source order (`app/services/context/context_service.py`):
//! 1. `_validate_attachment_input` — extension support, size, MIME type;
//! 2. `get_storage_backend(db)` — the configured object store (`HEAD` probe);
//! 3. `_reset_attachment_context` + `db.flush()` — the `uploading` reset;
//! 4. `_store_attachment_binary` -> `save`: the object write, the save's own
//!    re-query and its `type_data` flush;
//! 5. `context.status = PARSING; db.flush()`;
//! 6. `_parse_and_update_context` then the `READY` flush;
//! 7. `db.commit()` + `db.refresh(context)`.
//!
//! SQLAlchemy writes only the attributes whose value changed, so every
//! statement is built from the desired attribute values compared with the
//! values last loaded or written ([`OverwriteState`]).

use std::sync::Arc;

use brz_mysql::{MysqlError, MysqlResult, MysqlTransaction, MysqlValue, MysqlValueWriter};
use serde_json::{Map, Value};

use super::backend::StoreObjectRequest;
use super::store::{OverwriteContextRow, refresh_context, type_data_json};
use super::{
    FastApiError, StatusCode, document, generate_storage_key, internal_error, parse_error_value,
};
use crate::attachments::context_store;
use crate::state::AppState;

/// One bound SQL value. SQLAlchemy builds the `SET` list at runtime, so the
/// statement's parameters are heterogeneous.
pub(crate) enum Param {
    Text(String),
    Int(i64),
    Bytes(Vec<u8>),
}

impl MysqlValue for Param {
    fn write(self, writer: &mut MysqlValueWriter) -> MysqlResult<()> {
        match self {
            Param::Text(value) => writer.push(value),
            Param::Int(value) => writer.push(value),
            Param::Bytes(value) => writer.push(value),
        }
    }
}

/// `type_data` keys `_reset_attachment_context` drops before merging the new
/// attachment metadata.
const IMAGE_PID_KEYS: [&str; 4] = [
    "image_pid",
    "image_pid_source",
    "image_pid_status",
    "image_pid_error",
];

/// The failure classes `_overwrite_attachment_impl` can surface, kept separate
/// because each source caller maps them differently.
pub(crate) enum OverwriteError {
    /// `_validate_attachment_input`'s `ValueError`, `NotFoundException`, or a
    /// dependency/transport failure: `<status> {"detail": <message>}`.
    Detail(FastApiError),
    /// `DocumentParseError` (`_parse_and_update_context`): the upload endpoint
    /// renders 400 `{"message", "error_code"}`; a caller that only catches
    /// `ValueError` (the knowledge path) lets it reach the application's
    /// generic 500 handler.
    Parse(Value),
}

impl OverwriteError {
    /// The error as the upload endpoint renders it: `HTTPException(detail=...)`
    /// always wraps the detail value in `{"detail": ...}`.
    pub(crate) fn into_upload_error(self) -> FastApiError {
        match self {
            Self::Detail(error) => error,
            Self::Parse(body) => FastApiError::json_body(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "detail": body }),
            ),
        }
    }

    /// The status and detail of a [`Self::Detail`] failure, for callers that
    /// re-map the source `ValueError`/`NotFoundException` themselves.
    pub(crate) fn into_detail(self) -> Option<FastApiError> {
        match self {
            Self::Detail(error) => Some(error),
            Self::Parse(_) => None,
        }
    }
}

/// The `subtask_contexts` attribute values the overwrite stage mutates, in
/// mapper column order.
#[derive(Clone, Debug, PartialEq)]
struct Columns {
    name: String,
    status: String,
    error_message: Option<String>,
    binary_data: Vec<u8>,
    image_base64: Option<String>,
    extracted_text: Option<String>,
    text_length: i32,
    type_data: Option<Map<String, Value>>,
}

/// SQLAlchemy's unit of work for one `SubtaskContext` instance: the desired
/// attribute values plus the values last loaded or written.
struct OverwriteState {
    current: Columns,
    flushed: Columns,
}

impl OverwriteState {
    fn new(loaded: Columns) -> Self {
        Self {
            current: loaded.clone(),
            flushed: loaded,
        }
    }

    /// The changed attributes in mapper order, as `(column, value)` pairs.
    fn changes(&self) -> Vec<(&'static str, Param)> {
        let mut changes = Vec::new();
        if self.current.name != self.flushed.name {
            changes.push(("name", Param::Text(self.current.name.clone())));
        }
        if self.current.status != self.flushed.status {
            changes.push(("status", Param::Text(self.current.status.clone())));
        }
        if self.current.error_message != self.flushed.error_message {
            changes.push((
                "error_message",
                Param::Text(self.current.error_message.clone().unwrap_or_default()),
            ));
        }
        if self.current.binary_data != self.flushed.binary_data {
            changes.push((
                "binary_data",
                Param::Bytes(self.current.binary_data.clone()),
            ));
        }
        if self.current.image_base64 != self.flushed.image_base64 {
            changes.push((
                "image_base64",
                Param::Text(self.current.image_base64.clone().unwrap_or_default()),
            ));
        }
        if self.current.extracted_text != self.flushed.extracted_text {
            changes.push((
                "extracted_text",
                Param::Text(self.current.extracted_text.clone().unwrap_or_default()),
            ));
        }
        if self.current.text_length != self.flushed.text_length {
            changes.push((
                "text_length",
                Param::Int(i64::from(self.current.text_length)),
            ));
        }
        if self.current.type_data != self.flushed.type_data {
            let empty = Map::new();
            changes.push((
                "type_data",
                Param::Text(type_data_json(
                    self.current.type_data.as_ref().unwrap_or(&empty),
                )),
            ));
        }
        changes
    }

    /// `db.flush()`: emit the changed attributes, then treat them as written.
    /// A flush with no changed attribute emits nothing, exactly like
    /// SQLAlchemy's dirty-attribute check.
    async fn flush<T: MysqlTransaction>(
        &mut self,
        transaction: &mut T,
        context_id: i64,
    ) -> MysqlResult<()> {
        let changes = self.changes();
        if changes.is_empty() {
            return Ok(());
        }
        let mut assignments = String::new();
        let mut params: Vec<Param> = Vec::with_capacity(changes.len() + 1);
        for (column, value) in changes {
            if !assignments.is_empty() {
                assignments.push_str(", ");
            }
            assignments.push_str(column);
            assignments.push_str("=?");
            params.push(value);
        }
        let sql = format!(
            "UPDATE subtask_contexts SET {assignments}, updated_at=now() \
             WHERE subtask_contexts.id = ?"
        );
        params.push(Param::Int(context_id));
        transaction.execute(sql, params).await?;
        self.flushed = self.current.clone();
        Ok(())
    }
}

/// The writable projection of the loaded row.
fn columns_of(row: &OverwriteContextRow) -> Columns {
    Columns {
        name: row.name.clone(),
        status: row.status.clone(),
        error_message: row.error_message.clone(),
        binary_data: row.binary_data.clone(),
        image_base64: row.image_base64.clone(),
        extracted_text: row.extracted_text.clone(),
        text_length: row.text_length,
        type_data: row.type_data_map(),
    }
}

/// `_build_attachment_type_data` inside `_reset_attachment_context`: drop the
/// stale image-pid keys, then merge the ordered base payload.
fn reset_type_data(
    loaded: Option<&Map<String, Value>>,
    filename: &str,
    extension: &str,
    file_size: i64,
    mime_type: &str,
    storage_backend: &str,
    storage_key: &str,
) -> Map<String, Value> {
    let mut merged = Map::new();
    if let Some(loaded) = loaded {
        for (key, value) in loaded {
            if !IMAGE_PID_KEYS.contains(&key.as_str()) {
                merged.insert(key.clone(), value.clone());
            }
        }
    }
    for (key, value) in super::store::build_type_data(
        filename,
        extension,
        file_size,
        mime_type,
        storage_backend,
        storage_key,
    ) {
        merged.insert(key, value);
    }
    merged
}

/// `_store_attachment_binary`'s encryption metadata merge.
fn with_encryption(mut type_data: Map<String, Value>, encrypt: bool) -> Map<String, Value> {
    type_data.insert("is_encrypted".to_string(), Value::Bool(encrypt));
    type_data.insert(
        "encryption_version".to_string(),
        Value::from(if encrypt { 1 } else { 0 }),
    );
    type_data
}

/// A statement the caller's own pending unit-of-work changes need written with
/// the overwrite's first flush.
///
/// The source's session holds every dirty instance, so its first `db.flush()`
/// writes the attachment reset **and** whatever else the caller mutated, inside
/// one transaction. A caller that also changed another row passes that write
/// here so the transaction boundaries stay identical.
pub(crate) struct Preflush {
    pub(crate) sql: String,
    pub(crate) params: Vec<Param>,
}

/// `_overwrite_attachment_impl`'s result: the refreshed row the caller renders
/// plus the truncation info the upload response carries.
pub(crate) struct OverwriteOutcome {
    /// `db.refresh(context)`'s row, absent only when the row disappeared.
    pub row: Option<super::store::SubtaskContextRefreshRow>,
    pub truncation_info: Option<Value>,
}

/// `_overwrite_attachment_impl`: reset, store, parse, commit, then
/// `db.refresh(context)`.
///
/// `owner_user_id` selects `get_context`'s ownership filter: `Some(user_id)`
/// for `overwrite_attachment`, `None` for the trusted
/// `overwrite_attachment_internal` path.
///
/// `extra_type_data` is the endpoint-owned image-pid metadata. The source
/// merges it after the overwrite with a second commit; folding it into the
/// reset flush leaves the same stored `type_data` without a second write.
pub(crate) async fn overwrite_attachment_internal(
    state: &Arc<AppState>,
    owner_user_id: Option<i64>,
    context_id: i64,
    filename: &str,
    binary_data: &[u8],
    extra_type_data: &Map<String, Value>,
    caller_flush: Option<Preflush>,
) -> Result<OverwriteOutcome, OverwriteError> {
    // `_validate_attachment_input`.
    let (extension, mime_type) =
        super::validate_input(filename, binary_data).map_err(OverwriteError::Detail)?;
    let file_size = binary_data.len() as i64;
    let backend = Arc::clone(&state.attachment_upload);
    let backend_type = backend.backend_type().to_string();

    // `get_context(db, context_id[, user_id])`.
    let row = load_context(&state.mysql, owner_user_id, context_id).await?;
    let Some(row) = row else {
        return Err(OverwriteError::Detail(super::attachment_not_found()));
    };
    if row.context_type != "attachment" {
        return Err(OverwriteError::Detail(super::attachment_not_found()));
    }

    // `get_storage_backend(db)`: the object store's bucket probe.
    backend
        .ensure_ready()
        .await
        .map_err(|_| OverwriteError::Detail(internal_error()))?;

    let storage_key = if row.storage_key().is_empty() {
        generate_storage_key(context_id, i64::from(row.user_id))
    } else {
        row.storage_key()
    };
    let user_id = i64::from(row.user_id);

    let mut attributes = OverwriteState::new(columns_of(&row));
    // `_reset_attachment_context`.
    attributes.current.name = filename.to_string();
    attributes.current.status = "uploading".to_string();
    attributes.current.error_message = Some(String::new());
    attributes.current.binary_data = Vec::new();
    attributes.current.image_base64 = Some(String::new());
    attributes.current.extracted_text = Some(String::new());
    attributes.current.text_length = 0;
    let loaded_type_data = row.type_data_map();
    let mut reset_data = reset_type_data(
        loaded_type_data.as_ref(),
        filename,
        &extension,
        file_size,
        mime_type,
        &backend_type,
        &storage_key,
    );
    super::store::merge_extra_type_data(&mut reset_data, extra_type_data);
    attributes.current.type_data = Some(reset_data);

    let encrypt = super::encryption_enabled();
    let store_data = if encrypt {
        crate::attachments::crypto::encrypt_attachment(binary_data)
            .unwrap_or_else(|_| binary_data.to_vec())
    } else {
        binary_data.to_vec()
    };
    let reset_type_data = attributes.current.type_data.clone().unwrap_or_default();
    let stored_type_data = with_encryption(reset_type_data.clone(), encrypt);
    let mut parse_failure: Option<Value> = None;
    let mut truncation_info: Option<Value> = None;

    state
        .mysql
        .with_transaction(async |transaction| {
            // The caller's other pending attribute changes flush with the
            // reset: the source's one `db.flush()` covers every dirty instance
            // in the session.
            if let Some(preflush) = caller_flush {
                transaction.execute(preflush.sql, preflush.params).await?;
            }
            // `_reset_attachment_context` + `db.flush()`.
            attributes.flush(transaction, context_id).await?;

            // `StorageBackend.save`: the object write.
            let external = match backend
                .store_object(StoreObjectRequest {
                    key: &storage_key,
                    data: &store_data,
                    filename,
                    mime_type,
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
                    return Err(MysqlError::InvalidQuery {
                        reason: "attachment storage write failed".to_owned(),
                    });
                }
            };

            // The save's own `SubtaskContext` re-query.
            let _reloaded: Option<OverwriteContextRow> = transaction
                .fetch_optional(context_store::CONTEXT_BY_ID_QUERY, (context_id,))
                .await?;

            // The save's `type_data` flush, then its `binary_data` write for a
            // backend that keeps the bytes in the row.
            attributes.current.type_data = Some(stored_type_data.clone());
            if !external {
                attributes.current.binary_data = store_data.clone();
            }
            attributes.flush(transaction, context_id).await?;

            // `context.status = PARSING; db.flush()`.
            attributes.current.status = "parsing".to_string();
            attributes.flush(transaction, context_id).await?;

            // `_parse_and_update_context` + the `READY` flush.
            match document::parse_async(binary_data, &extension).await {
                Ok(parsed) => {
                    let mut type_data = attributes.current.type_data.clone().unwrap_or_default();
                    type_data.insert(
                        "is_truncated".to_string(),
                        Value::Bool(
                            parsed
                                .truncation_info
                                .as_ref()
                                .and_then(|info| info.get("is_truncated"))
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        ),
                    );
                    attributes.current.status = "ready".to_string();
                    attributes.current.extracted_text = Some(parsed.text);
                    attributes.current.text_length = parsed.text_length as i32;
                    attributes.current.image_base64 = Some(parsed.image_base64.unwrap_or_default());
                    attributes.current.type_data = Some(type_data);
                    truncation_info = parsed.truncation_info.clone();
                    attributes.flush(transaction, context_id).await?;
                }
                Err(error) => {
                    // `_parse_and_update_context`'s `except DocumentParseError`
                    // branch: mark the row failed, then let the caller commit
                    // and re-raise.
                    attributes.current.status = "failed".to_string();
                    attributes.current.error_message = Some(error.message.clone());
                    attributes.flush(transaction, context_id).await?;
                    parse_failure = Some(parse_error_value(&error));
                }
            }
            Ok(())
        })
        .await
        .map_err(|error| OverwriteError::Detail(mysql_failure(error)))?;

    match parse_failure {
        // The source re-raises before its `db.refresh(context)`.
        Some(body) => Err(OverwriteError::Parse(body)),
        // `db.refresh(context)`.
        None => {
            let row = refresh_context(&state.mysql, context_id)
                .await
                .map_err(|error| OverwriteError::Detail(mysql_failure(error)))?;
            Ok(OverwriteOutcome {
                row,
                truncation_info,
            })
        }
    }
}

/// `get_context(db, context_id[, user_id])`.
async fn load_context<M>(
    mysql: &M,
    owner_user_id: Option<i64>,
    context_id: i64,
) -> Result<Option<OverwriteContextRow>, OverwriteError>
where
    M: brz_mysql::Mysql,
{
    let row = match owner_user_id {
        Some(user_id) => {
            mysql
                .fetch_optional(
                    super::store::OVERWRITE_CONTEXT_OWNED_QUERY,
                    (context_id, user_id),
                )
                .await
        }
        None => {
            mysql
                .fetch_optional(super::store::OVERWRITE_CONTEXT_QUERY, (context_id,))
                .await
        }
    };
    row.map_err(|error| OverwriteError::Detail(mysql_failure(error)))
}

/// Keep the source's operational error category: a failed overwrite is the
/// endpoint's generic 500 (`Failed to upload attachment`).
fn mysql_failure(error: MysqlError) -> FastApiError {
    tracing::error!(%error, "attachment overwrite dependency failed");
    internal_error()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The recorded reset flush for a stored (`ready`) attachment:
    /// `status='uploading', extracted_text='', text_length=0, type_data=?` with
    /// `updated_at=now()` last. `name`, `error_message`, `binary_data` and
    /// `image_base64` are unchanged, so SQLAlchemy omits them.
    #[test]
    fn reset_flush_writes_only_the_changed_columns() {
        let loaded = Columns {
            name: "notes.md".to_string(),
            status: "ready".to_string(),
            error_message: Some(String::new()),
            binary_data: Vec::new(),
            image_base64: Some(String::new()),
            extracted_text: Some("# old".to_string()),
            text_length: 5,
            type_data: None,
        };
        let mut state = OverwriteState::new(loaded);
        state.current.status = "uploading".to_string();
        state.current.extracted_text = Some(String::new());
        state.current.text_length = 0;
        state.current.type_data = Some(Map::new());

        let names: Vec<&str> = state
            .changes()
            .into_iter()
            .map(|(column, _)| column)
            .collect();
        assert_eq!(
            names,
            ["status", "extracted_text", "text_length", "type_data"]
        );
    }

    /// The parsing flush changes only `status`; the ready flush adds the parsed
    /// text without rewriting the unchanged `type_data`.
    #[test]
    fn parse_flushes_write_only_the_columns_each_step_changes() {
        let loaded = Columns {
            name: "notes.md".to_string(),
            status: "uploading".to_string(),
            error_message: Some(String::new()),
            binary_data: Vec::new(),
            image_base64: Some(String::new()),
            extracted_text: Some(String::new()),
            text_length: 0,
            type_data: Some(Map::new()),
        };
        let mut state = OverwriteState::new(loaded);
        state.current.status = "parsing".to_string();
        let parsing: Vec<&str> = state
            .changes()
            .into_iter()
            .map(|(column, _)| column)
            .collect();
        assert_eq!(parsing, ["status"]);

        state.flushed = state.current.clone();
        state.current.status = "ready".to_string();
        state.current.extracted_text = Some("# body".to_string());
        state.current.text_length = 6;
        let ready: Vec<&str> = state
            .changes()
            .into_iter()
            .map(|(column, _)| column)
            .collect();
        assert_eq!(ready, ["status", "extracted_text", "text_length"]);
    }

    /// `_reset_attachment_context` drops the stale image-pid keys and merges
    /// the new attachment metadata in place, preserving the stored key order.
    #[test]
    fn reset_type_data_drops_image_pid_keys_and_merges_in_place() {
        let loaded: Map<String, Value> = serde_json::from_str(
            r#"{"file_size":10,"image_pid":"1","mime_type":"text/plain","storage_key":"k"}"#,
        )
        .unwrap();
        let merged = reset_type_data(
            Some(&loaded),
            "notes.md",
            ".md",
            12,
            "text/markdown",
            "minio",
            "k",
        );
        let keys: Vec<&str> = merged.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "file_size",
                "mime_type",
                "storage_key",
                "original_filename",
                "file_extension",
                "storage_backend"
            ]
        );
        assert_eq!(merged.get("file_size"), Some(&Value::from(12)));
        assert!(!merged.contains_key("image_pid"));
    }

    /// The encryption metadata merge keeps existing positions and appends a new
    /// `encryption_version`, matching the recorded `type_data` order.
    #[test]
    fn encryption_merge_appends_only_new_keys() {
        let base: Map<String, Value> =
            serde_json::from_str(r#"{"is_encrypted":false,"storage_key":"k"}"#).unwrap();
        let merged = with_encryption(base, false);
        let keys: Vec<&str> = merged.keys().map(String::as_str).collect();
        assert_eq!(keys, ["is_encrypted", "storage_key", "encryption_version"]);
    }
}
