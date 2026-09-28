// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Attachment storage resolution mirroring
//! `context_service.get_attachment_binary_data` and
//! `app/services/attachment/storage_factory.get_storage_backend`.
//!
//! The configured `ATTACHMENT_STORAGE_BACKEND` selects the backend
//! (`mysql` stores bytes in `subtask_contexts.binary_data`; `minio`/`s3`
//! store them in the object store). Encryption is applied at this layer
//! (`decrypt_attachment`, AES-256-CBC) when `type_data.is_encrypted` is set;
//! the deployment keeps it disabled, so the target implements only the
//! unencrypted path and fails closed on encrypted rows.
use brz_http::Client as HttpClient;
use brz_mysql::Mysql;

use super::context_store::SubtaskContextRow;
use super::minio_client::{self, MinioConfig};

/// `get_attachment_binary_data`: resolve the bytes from the configured
/// backend. `Ok(None)` mirrors the source's `None` (no storage key, missing
/// object) which the endpoint renders as 500.
pub async fn get_attachment_binary_data<M>(
    mysql: &M,
    http: &HttpClient,
    minio: Option<&MinioConfig>,
    context: &SubtaskContextRow,
) -> Result<Option<Vec<u8>>, MinioStorageError>
where
    M: Mysql,
{
    let storage_key = context.storage_key();
    if storage_key.is_empty() {
        return Ok(None);
    }
    let backend = context.storage_backend();
    let binary_data = match backend.as_str() {
        "mysql" => load_mysql_binary(mysql, &storage_key).await?,
        "minio" | "s3" => {
            let Some(config) = minio else {
                return Err(MinioStorageError);
            };
            // The source constructs a `MinIOStorageBackend` per call; its
            // constructor probes the bucket (`HEAD /{bucket}`) before the
            // object read.
            if minio_client::ensure_bucket_exists(http, config)
                .await
                .is_err()
            {
                return Ok(None);
            }
            match minio_client::get_object(http, config, &storage_key).await {
                Ok(bytes) => Some(bytes),
                Err(_) => return Ok(None),
            }
        }
        // Unregistered backend types fall back to `mysql` in the source.
        _ => load_mysql_binary(mysql, &storage_key).await?,
    };
    let binary_data = match binary_data {
        Some(bytes) => bytes,
        None => return Ok(None),
    };
    if context.is_encrypted() {
        // The deployment keeps `ATTACHMENT_ENCRYPTION_ENABLED=false`; an
        // encrypted row cannot be served without the AES key material and is
        // failed closed like a retrieval failure.
        return Err(MinioStorageError);
    }
    Ok(Some(binary_data))
}

/// Storage failure mirroring the source's logged retrieval errors.
#[derive(Debug)]
pub struct MinioStorageError;

impl MinioStorageError {
    /// The source dependency error message for logging.
    pub fn message(&self) -> &'static str {
        "attachment storage read failed"
    }
}

impl std::fmt::Display for MinioStorageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

/// `MySQLStorageBackend.get`: re-read `binary_data` by the context id
/// extracted from the storage key
/// (`attachments/{uuid}_{timestamp}_{user_id}_{context_id}`).
async fn load_mysql_binary<M>(
    mysql: &M,
    storage_key: &str,
) -> Result<Option<Vec<u8>>, MinioStorageError>
where
    M: Mysql,
{
    #[derive(brz_mysql::FromMysqlRow)]
    struct BinaryRow {
        binary_data: Vec<u8>,
    }
    let Some(context_id) = extract_attachment_id(storage_key) else {
        return Ok(None);
    };
    let row: Option<BinaryRow> = mysql
        .fetch_optional(
            "SELECT subtask_contexts.binary_data AS subtask_contexts_binary_data \
             FROM subtask_contexts \
             WHERE subtask_contexts.id = ? \
             LIMIT 1",
            (context_id,),
        )
        .await
        .map_err(|_| MinioStorageError)?;
    Ok(row.map(|row| row.binary_data))
}

/// `MySQLStorageBackend._extract_attachment_id`: the trailing
/// `_context_id` segment of the key's last path element, needing at least
/// `uuid_timestamp_userid_contextid`.
fn extract_attachment_id(storage_key: &str) -> Option<i64> {
    let (prefix, file) = storage_key.split_once('/')?;
    if prefix != "attachments" {
        return None;
    }
    let parts: Vec<&str> = file.split('_').collect();
    if parts.len() < 4 {
        return None;
    }
    parts.last()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_context_ids_from_storage_keys() {
        assert_eq!(
            extract_attachment_id("attachments/55cb5e46bfa7_20260905042103_5710_1274438"),
            Some(1274438)
        );
        assert_eq!(extract_attachment_id("attachments/short"), None);
        assert_eq!(extract_attachment_id("other/x_y_z_w"), None);
        assert_eq!(extract_attachment_id("attachments/a_b_c_notanumber"), None);
    }
}
