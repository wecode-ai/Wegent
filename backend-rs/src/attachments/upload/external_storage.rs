// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! File-type hosting selected before the default binary storage and parser.
use brz_mysql::{MysqlError, MysqlResult, MysqlTransaction};
use serde_json::{Map, Value};

use super::{
    AttachmentUploadBackend, ExternalAttachmentUploadError, ExternalAttachmentUploadRequest,
    UploadBackendError, UploadOutcome, type_data_json,
};

pub(super) async fn prepare_backend(
    backend: &dyn AttachmentUploadBackend,
    mime_type: &str,
    purpose: &str,
) -> Result<String, UploadBackendError> {
    if let Some(selected) = backend.external_storage_backend(mime_type, purpose) {
        return Ok(selected.to_owned());
    }
    backend.ensure_ready().await?;
    Ok(backend.backend_type().to_owned())
}

/// The caller inserts the row and commits only after hosting and persistence succeed.
#[tracing::instrument(skip_all, fields(attachment_id = context_id))]
pub(super) async fn store<T: MysqlTransaction>(
    transaction: &mut T,
    backend: &dyn AttachmentUploadBackend,
    context_id: i64,
    request: ExternalAttachmentUploadRequest<'_>,
    mut type_data: Map<String, Value>,
    validation_error: &mut Option<String>,
) -> MysqlResult<UploadOutcome> {
    let stored = backend
        .store_external_attachment(request)
        .await
        .map_err(|error| {
            if let ExternalAttachmentUploadError::InvalidInput(message) = error {
                *validation_error = Some(message);
            }
            tracing::error!(attachment_id = context_id, "attachment hosting failed");
            MysqlError::InvalidQuery {
                reason: "attachment hosting failed".to_owned(),
            }
        })?;
    type_data.insert(
        "storage_backend".to_owned(),
        Value::from(stored.backend_type),
    );
    type_data.insert("storage_key".to_owned(), Value::from(stored.storage_key));
    type_data.insert("is_encrypted".to_owned(), Value::Bool(false));
    type_data.insert("encryption_version".to_owned(), Value::from(0));
    type_data.extend(stored.type_data);
    transaction
        .execute(
            "UPDATE subtask_contexts SET status='ready', binary_data=X'', \
             type_data=?, updated_at=now() WHERE subtask_contexts.id = ?",
            (type_data_json(&type_data), context_id),
        )
        .await?;
    Ok(UploadOutcome::Parsed {
        context_id,
        truncation_info: None,
    })
}
