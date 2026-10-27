// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `subtask_contexts` statements and the refreshed row for
//! `POST /api/attachments/upload`.
//!
//! These mirror the SQLAlchemy unit-of-work statements
//! `ContextService.upload_attachment` emits: the `db.add`/`db.flush` INSERT,
//! the storage backend's own type_data flush, the `PARSING`/`READY` flushes,
//! the commit, and the `db.refresh` re-select. `created_at`/`updated_at`
//! render as SQL `now()` because the model declares `default=func.now()` /
//! `onupdate=func.now()`.
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlTransaction};
use chrono::NaiveDateTime;
use serde_json::Value;

use brz_json::JsonProjection;

use super::super::context_store::AttachmentMetadata;

/// `db.add(context); db.flush()` — SQLAlchemy renders every column set on the
/// new `uploading` row plus its `now()` timestamps.
pub const INSERT_CONTEXT_QUERY: &str = "INSERT INTO subtask_contexts \
     (subtask_id, user_id, context_type, name, status, error_message, binary_data, \
     image_base64, extracted_text, text_length, type_data, created_at, updated_at) \
     VALUES (?, ?, 'attachment', ?, 'uploading', '', X'', '', '', 0, ?, now(), now())";

/// `MinIOStorageBackend.save`'s `db.flush()` after it re-queries and rewrites
/// `type_data` (storage backend/key plus any extra metadata).
pub const UPDATE_TYPE_DATA_QUERY: &str = "UPDATE subtask_contexts \
     SET type_data=?, updated_at=now() WHERE subtask_contexts.id = ?";

/// `context.status = PARSING; db.flush()`.
pub const UPDATE_PARSING_QUERY: &str = "UPDATE subtask_contexts \
     SET status='parsing', type_data=?, updated_at=now() WHERE subtask_contexts.id = ?";

/// `_store_attachment_binary` for the MySQL backend: bytes stay in the row.
pub const UPDATE_BINARY_DATA_QUERY: &str = "UPDATE subtask_contexts \
     SET binary_data=?, type_data=?, updated_at=now() WHERE subtask_contexts.id = ?";

/// `context.status = READY; db.flush()` for a text attachment (SQLAlchemy
/// updates only the attributes that changed, so `image_base64` stays out).
pub const UPDATE_READY_QUERY: &str = "UPDATE subtask_contexts SET status='ready', \
     extracted_text=?, text_length=?, type_data=?, updated_at=now() \
     WHERE subtask_contexts.id = ?";

/// The same `READY` flush for an image attachment, whose `image_base64`
/// changed and is therefore included.
pub const UPDATE_READY_WITH_IMAGE_QUERY: &str = "UPDATE subtask_contexts SET status='ready', \
     image_base64=?, extracted_text=?, text_length=?, type_data=?, updated_at=now() \
     WHERE subtask_contexts.id = ?";

/// `_parse_and_update_context`'s `except DocumentParseError` branch:
/// `context.status = FAILED; context.error_message = str(e)` before the caller
/// commits and re-raises. SQLAlchemy writes the two changed attributes in
/// mapper order.
pub const UPDATE_FAILED_QUERY: &str = "UPDATE subtask_contexts SET status='failed', \
     error_message=?, updated_at=now() WHERE subtask_contexts.id = ?";

/// `db.commit()` + `db.refresh(context)`: SQLAlchemy re-selects the row by
/// primary key with unaliased columns.
pub const REFRESH_CONTEXT_QUERY: &str = "SELECT subtask_contexts.id, subtask_contexts.subtask_id, \
     subtask_contexts.user_id, subtask_contexts.context_type, subtask_contexts.name, \
     subtask_contexts.status, subtask_contexts.error_message, subtask_contexts.binary_data, \
     subtask_contexts.image_base64, subtask_contexts.extracted_text, subtask_contexts.text_length, \
     subtask_contexts.type_data, subtask_contexts.created_at, subtask_contexts.updated_at \n\
     FROM subtask_contexts \nWHERE subtask_contexts.id = ?";

/// One refreshed `subtask_contexts` row (unaliased projection).
#[derive(Debug, FromMysqlRow)]
pub struct SubtaskContextRefreshRow {
    #[mysql(rename = "id")]
    pub id: i64,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_id")]
    pub subtask_id: i64,
    #[allow(dead_code)]
    #[mysql(rename = "user_id")]
    pub user_id: i32,
    #[allow(dead_code)]
    #[mysql(rename = "context_type")]
    pub context_type: String,
    #[mysql(rename = "name")]
    pub name: String,
    #[mysql(rename = "status")]
    pub status: String,
    #[mysql(rename = "error_message")]
    pub error_message: Option<String>,
    #[allow(dead_code)]
    #[mysql(rename = "binary_data")]
    pub binary_data: Vec<u8>,
    #[allow(dead_code)]
    #[mysql(rename = "image_base64")]
    pub image_base64: Option<String>,
    #[allow(dead_code)]
    #[mysql(rename = "extracted_text")]
    pub extracted_text: Option<String>,
    #[mysql(rename = "text_length")]
    pub text_length: i32,
    #[mysql(rename = "type_data")]
    pub type_data: Option<Json<JsonProjection<AttachmentMetadata>>>,
    #[mysql(rename = "created_at")]
    pub created_at: Option<NaiveDateTime>,
    #[allow(dead_code)]
    #[mysql(rename = "updated_at")]
    pub updated_at: Option<NaiveDateTime>,
}

impl SubtaskContextRefreshRow {
    fn metadata(&self) -> Option<&AttachmentMetadata> {
        self.type_data.as_ref()?.0.value.as_ref()
    }

    /// `type_data.get("original_filename", context.name)`.
    pub fn original_filename(&self) -> String {
        self.metadata()
            .and_then(|data| data.original_filename.as_deref())
            .unwrap_or(&self.name)
            .to_owned()
    }

    /// `type_data.get("file_size", 0)`.
    pub fn file_size(&self) -> i64 {
        self.metadata().and_then(|data| data.file_size).unwrap_or(0)
    }

    /// `type_data.get("mime_type", "")`.
    pub fn mime_type(&self) -> String {
        self.metadata()
            .and_then(|data| data.mime_type.clone())
            .unwrap_or_default()
    }

    /// `type_data.get("file_extension", "")`.
    pub fn file_extension(&self) -> String {
        self.metadata()
            .and_then(|data| data.file_extension.clone())
            .unwrap_or_default()
    }
}

/// Refresh after an upload commit on the primary, like the source ORM session.
/// Ordinary reads use the replica and may not see the new row or latest update.
pub async fn refresh_context<M>(
    mysql: &M,
    context_id: i64,
) -> MysqlResult<Option<SubtaskContextRefreshRow>>
where
    M: Mysql,
{
    mysql
        .with_transaction(async |transaction| {
            transaction
                .fetch_optional(REFRESH_CONTEXT_QUERY, (context_id,))
                .await
        })
        .await
}

/// `context_service.get_context(db, context_id)` for the trusted internal
/// overwrite (`overwrite_attachment_internal`).
pub const OVERWRITE_CONTEXT_QUERY: &str = "SELECT subtask_contexts.id AS subtask_contexts_id, \
     subtask_contexts.subtask_id AS subtask_contexts_subtask_id, \
     subtask_contexts.user_id AS subtask_contexts_user_id, \
     subtask_contexts.context_type AS subtask_contexts_context_type, \
     subtask_contexts.name AS subtask_contexts_name, \
     subtask_contexts.status AS subtask_contexts_status, \
     subtask_contexts.error_message AS subtask_contexts_error_message, \
     subtask_contexts.binary_data AS subtask_contexts_binary_data, \
     subtask_contexts.image_base64 AS subtask_contexts_image_base64, \
     subtask_contexts.extracted_text AS subtask_contexts_extracted_text, \
     subtask_contexts.text_length AS subtask_contexts_text_length, \
     subtask_contexts.type_data AS subtask_contexts_type_data, \
     subtask_contexts.created_at AS subtask_contexts_created_at, \
     subtask_contexts.updated_at AS subtask_contexts_updated_at \n\
     FROM subtask_contexts \nWHERE subtask_contexts.id = ? \n LIMIT 1";

/// `context_service.get_context(db, context_id, user_id)` — the same
/// projection with the owner filter (`overwrite_attachment`).
pub const OVERWRITE_CONTEXT_OWNED_QUERY: &str = "SELECT subtask_contexts.id AS subtask_contexts_id, \
     subtask_contexts.subtask_id AS subtask_contexts_subtask_id, \
     subtask_contexts.user_id AS subtask_contexts_user_id, \
     subtask_contexts.context_type AS subtask_contexts_context_type, \
     subtask_contexts.name AS subtask_contexts_name, \
     subtask_contexts.status AS subtask_contexts_status, \
     subtask_contexts.error_message AS subtask_contexts_error_message, \
     subtask_contexts.binary_data AS subtask_contexts_binary_data, \
     subtask_contexts.image_base64 AS subtask_contexts_image_base64, \
     subtask_contexts.extracted_text AS subtask_contexts_extracted_text, \
     subtask_contexts.text_length AS subtask_contexts_text_length, \
     subtask_contexts.type_data AS subtask_contexts_type_data, \
     subtask_contexts.created_at AS subtask_contexts_created_at, \
     subtask_contexts.updated_at AS subtask_contexts_updated_at \n\
     FROM subtask_contexts \n\
     WHERE subtask_contexts.id = ? AND subtask_contexts.user_id = ? \n LIMIT 1";

/// One `subtask_contexts` row with its `type_data` **unmodified**: the
/// overwrite stage merges keys in the stored (MySQL-normalized) order and
/// re-renders it, so a typed projection would lose the key order
/// (`_reset_attachment_context`).
#[derive(Debug, FromMysqlRow)]
pub struct OverwriteContextRow {
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_id")]
    pub id: i64,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_subtask_id")]
    pub subtask_id: i64,
    #[mysql(rename = "subtask_contexts_user_id")]
    pub user_id: i32,
    #[mysql(rename = "subtask_contexts_context_type")]
    pub context_type: String,
    #[mysql(rename = "subtask_contexts_name")]
    pub name: String,
    #[mysql(rename = "subtask_contexts_status")]
    pub status: String,
    #[mysql(rename = "subtask_contexts_error_message")]
    pub error_message: Option<String>,
    #[mysql(rename = "subtask_contexts_binary_data")]
    pub binary_data: Vec<u8>,
    #[mysql(rename = "subtask_contexts_image_base64")]
    pub image_base64: Option<String>,
    #[mysql(rename = "subtask_contexts_extracted_text")]
    pub extracted_text: Option<String>,
    #[mysql(rename = "subtask_contexts_text_length")]
    pub text_length: i32,
    #[mysql(rename = "subtask_contexts_type_data")]
    pub type_data: Option<Json<brz_json::OpaqueJson>>,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_created_at")]
    pub created_at: Option<NaiveDateTime>,
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_updated_at")]
    pub updated_at: Option<NaiveDateTime>,
}

impl OverwriteContextRow {
    /// `SubtaskContext.type_data` as an ordered map (`None` for absent/NULL).
    pub fn type_data_map(&self) -> Option<serde_json::Map<String, Value>> {
        let raw = self.type_data.as_ref()?;
        let text = raw.0.as_raw().get();
        if text == "null" {
            return None;
        }
        serde_json::from_str(text).ok()
    }

    /// `SubtaskContext.storage_key` (`type_data.get("storage_key", "")`).
    pub fn storage_key(&self) -> String {
        self.type_data_map()
            .and_then(|map| {
                map.get("storage_key")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_default()
    }
}

/// `_build_attachment_type_data`: the ordered base `type_data` payload
/// (`json.dumps` keeps the insertion order SQLAlchemy stores).
pub fn build_type_data(
    filename: &str,
    extension: &str,
    file_size: i64,
    mime_type: &str,
    storage_backend: &str,
    storage_key: &str,
) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    map.insert("original_filename".to_string(), Value::from(filename));
    map.insert("file_extension".to_string(), Value::from(extension));
    map.insert("file_size".to_string(), Value::from(file_size));
    map.insert("mime_type".to_string(), Value::from(mime_type));
    map.insert("storage_backend".to_string(), Value::from(storage_backend));
    map.insert("storage_key".to_string(), Value::from(storage_key));
    map
}

/// Merge the `image_pid` metadata the source image upload returned.
pub fn merge_extra_type_data(
    type_data: &mut serde_json::Map<String, Value>,
    extra: &serde_json::Map<String, Value>,
) {
    for (key, value) in extra {
        type_data.insert(key.clone(), value.clone());
    }
}

/// Render `type_data` the way SQLAlchemy's `JSON` column serializer
/// (`json.dumps`, `ensure_ascii=True`, `", "`/`": "`) stores it.
pub fn type_data_json(type_data: &serde_json::Map<String, Value>) -> String {
    crate::json_compat::python_json_value(&Value::Object(type_data.clone()))
}
