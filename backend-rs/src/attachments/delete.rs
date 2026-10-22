// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Owned, unlinked attachment deletion from `adapter/attachments.py` and
//! `ContextService.delete_context`. Storage failures do not prevent row deletion.

use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_mysql::MysqlTransaction;
use serde::Serialize;

use super::context_store::{self, SubtaskContextRow};
use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

#[derive(Serialize)]
struct DeletedAttachment {
    message: &'static str,
}

fn validate_deletion(context_type: &str, subtask_id: i64) -> Result<(), FastApiError> {
    if context_type != "attachment" {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Attachment not found",
        ));
    }
    if subtask_id > 0 {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Cannot delete attachment that is linked to a message",
        ));
    }
    Ok(())
}

fn dependency_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "attachment deletion database operation failed");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

#[brz_http_server::delete("/api/attachments/:attachment_id")]
async fn delete_attachment(
    #[inject(state)] state: &Arc<AppState>,
    attachment_id: i64,
    #[auth] user: SessionUser,
) -> Result<DeletedAttachment, FastApiError> {
    let context = context_store::get_context_optional_with_user(
        &state.mysql,
        attachment_id,
        i64::from(user.id),
    )
    .await
    .map_err(dependency_error)?
    .ok_or_else(|| FastApiError::detail(StatusCode::NOT_FOUND, "Attachment not found"))?;
    validate_deletion(&context.context_type, context.subtask_id)?;

    // The service repeats the owned lookup rather than trusting the route's row.
    let context = context_store::get_context_optional_with_user(
        &state.mysql,
        attachment_id,
        i64::from(user.id),
    )
    .await
    .map_err(dependency_error)?
    .filter(|context| context.subtask_id <= 0)
    .ok_or_else(|| {
        FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to delete attachment",
        )
    })?;
    remove_storage(state, &context).await;
    state
        .mysql
        .with_transaction(async |transaction| {
            if state.attachment_upload.backend_type() == "mysql"
                && !context.storage_key().is_empty()
                && let Err(error) = clear_mysql_storage(transaction, &context.storage_key()).await
            {
                tracing::warn!(%error, "attachment binary cleanup failed; deleting the row");
            }
            transaction
                .execute(
                    "DELETE FROM subtask_contexts WHERE subtask_contexts.id = ?",
                    (attachment_id,),
                )
                .await?;
            Ok(())
        })
        .await
        .map_err(dependency_error)?;
    Ok(DeletedAttachment {
        message: "Attachment deleted successfully",
    })
}

async fn remove_storage(state: &AppState, context: &SubtaskContextRow) {
    let key = context.storage_key();
    if key.is_empty() || context.context_type != "attachment" {
        return;
    }
    if state.attachment_upload.ensure_ready().await.is_err()
        || !matches!(state.attachment_upload.delete_object(&key).await, Ok(true))
    {
        tracing::warn!("attachment storage deletion failed; deleting the unlinked row");
    }
}

async fn clear_mysql_storage<T: MysqlTransaction>(
    transaction: &mut T,
    key: &str,
) -> brz_mysql::MysqlResult<()> {
    let Some(context_id) = super::storage::extract_attachment_id(key) else {
        return Ok(());
    };
    let row: Option<SubtaskContextRow> = transaction
        .fetch_optional(context_store::CONTEXT_BY_ID_QUERY, (context_id,))
        .await?;
    if row.is_some_and(|row| !row.binary_data.is_empty()) {
        transaction
            .execute(
                "UPDATE subtask_contexts SET binary_data=X'', updated_at=now() \
                 WHERE subtask_contexts.id = ?",
                (context_id,),
            )
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_unlinked_attachments_can_be_deleted() {
        assert!(validate_deletion("attachment", 0).is_ok());
        assert_eq!(
            validate_deletion("attachment", 1).unwrap_err().status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            validate_deletion("knowledge", 0).unwrap_err().status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn attachment_delete_route_is_registered() {
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >
            .into_iter()
            .flat_map(|entry| (entry.0.routes)())
            .any(|route| route.path == "/api/attachments/:attachment_id" && route.methods & 1 != 0);
        assert!(registered);
    }
}
