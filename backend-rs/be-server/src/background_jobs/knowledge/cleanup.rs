// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Scoped attachment reclamation; storage failures retain their retryable row.

use std::collections::BTreeSet;

use anyhow::Result;
use brz_mysql::{FromMysqlRow, MysqlTransaction};
use serde_json::{Value, json};

use crate::{AppState, attachments::context_store};

const REFERENCES: &str = "d.attachment_id=c.id OR CAST(JSON_UNQUOTE(JSON_EXTRACT(d.source_config,'$.converted_attachment_id')) AS SIGNED)=c.id OR CAST(JSON_UNQUOTE(JSON_EXTRACT(d.source_config,'$._pending_external_refresh.previous_attachment_id')) AS SIGNED)=c.id OR CAST(JSON_UNQUOTE(JSON_EXTRACT(d.source_config,'$._pending_external_refresh.previous_converted_attachment_id')) AS SIGNED)=c.id";

#[derive(FromMysqlRow)]
struct Candidate {
    id: i64,
    user_id: i64,
}

pub async fn scan(state: &AppState, context: &brz_schedule::JobContext) -> Result<Value> {
    let retention = super::state::seconds("KNOWLEDGE_ATTACHMENT_ORPHAN_RETENTION_HOURS", 24);
    let batch = super::state::seconds("KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_BATCH_SIZE", 200);
    let sql = format!(
        "SELECT c.id,c.user_id FROM subtask_contexts c WHERE c.context_type='attachment' AND c.subtask_id=0 AND c.created_at<DATE_SUB(NOW(),INTERVAL ? HOUR) AND JSON_UNQUOTE(JSON_EXTRACT(c.type_data,'$.lifecycle_owner'))='external_wiki_sync' AND NOT EXISTS(SELECT 1 FROM knowledge_documents d WHERE {REFERENCES}) ORDER BY c.id LIMIT ?"
    );
    let candidates: Vec<Candidate> = state.mysql.fetch_all(sql, (retention, batch)).await?;
    let scanned = candidates.len();
    let (mut deleted, mut referenced, mut failures) = (0, 0, 0);
    for candidate in candidates {
        if context.cancellation.is_cancelled() {
            anyhow::bail!("attachment cleanup cancelled");
        }
        match remove(state, candidate.id, candidate.user_id).await {
            Ok(true) => deleted += 1,
            Ok(false) => referenced += 1,
            Err(error) => {
                failures += 1;
                tracing::warn!(attachment_id=candidate.id, %error, "attachment cleanup failed; retained for retry");
            }
        }
    }
    Ok(
        json!({"scanned":scanned,"referenced":referenced,"deleted":deleted,"retryable_failures":failures}),
    )
}

pub async fn remove(state: &AppState, id: i64, owner: i64) -> Result<bool> {
    let Some(context) =
        context_store::get_context_optional_with_user(&state.mysql, id, owner).await?
    else {
        return Ok(false);
    };
    if context.context_type != "attachment" || context.subtask_id != 0 {
        return Ok(false);
    }
    #[derive(FromMysqlRow)]
    struct Count {
        count: i64,
    }
    let count: Count = state.mysql.fetch_one(
        format!("SELECT COUNT(*) AS count FROM subtask_contexts c WHERE c.id=? AND EXISTS(SELECT 1 FROM knowledge_documents d WHERE {REFERENCES})"), (id,),
    ).await?;
    if count.count != 0 {
        return Ok(false);
    }
    let key = context.storage_key();
    if !key.is_empty() {
        state.attachment_upload.ensure_ready().await?;
        if !state.attachment_upload.delete_object(&key).await? {
            anyhow::bail!("attachment object deletion was not acknowledged");
        }
    }
    let removed = state.mysql.with_transaction(async |transaction| {
        transaction.execute(
            "DELETE FROM subtask_contexts WHERE id=? AND user_id=? AND context_type='attachment' AND subtask_id=0",
            (id, owner),
        ).await
    }).await?;
    Ok(removed.rows_affected > 0)
}

pub async fn cleanup_replaced(state: &AppState, owner: i64, ids: BTreeSet<i64>) {
    for id in ids {
        if let Err(error) = remove(state, id, owner).await {
            tracing::warn!(attachment_id=id, %error, "refresh attachment retained for orphan cleanup");
            if let Err(mark_error) = state.mysql.with_transaction(async |transaction| {
                transaction.execute(
                    "UPDATE subtask_contexts SET type_data=JSON_SET(COALESCE(type_data,JSON_OBJECT()),'$.lifecycle_owner','external_wiki_sync'),updated_at=NOW() WHERE id=? AND user_id=? AND context_type='attachment' AND subtask_id=0",
                    (id, owner),
                ).await?;
                Ok(())
            }).await {
                tracing::error!(attachment_id=id, %mark_error, "failed to retain attachment cleanup ownership");
            }
        }
    }
}
