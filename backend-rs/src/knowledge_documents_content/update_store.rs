// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `knowledge_documents` / `users` statements and the indexing state machine
//! for `PUT /api/knowledge/documents/{document_id}/content`
//! (`app.services.knowledge.index_state_machine` +
//! `app.services.knowledge.orchestrator._schedule_indexing_celery`).
//!
//! Every statement mirrors the SQLAlchemy rendering: only the attributes whose
//! value changed are written, in mapper column order, with `updated_at=now()`
//! last.

use brz_mysql::{FromMysqlRow, Mysql, MysqlResult, MysqlTransaction};
use chrono::NaiveDateTime;

use super::reader::{self, DocumentRow};
use crate::attachments::upload::{Param, Preflush};

/// `_prepare_document_index_enqueue`'s row lock
/// (`db.query(KnowledgeDocument).filter(id).with_for_update()
/// .populate_existing().first()`), followed by the `selectin` external-source
/// load.
pub(crate) async fn lock_document<M>(
    mysql: &M,
    document_id: i64,
) -> MysqlResult<Option<DocumentRow>>
where
    M: Mysql,
{
    let row: Option<DocumentRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {columns} \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.id = {document_id} \n LIMIT 1 FOR UPDATE",
                columns = reader::DOCUMENT_COLUMNS
            ),
            (),
        )
        .await?;
    reader::external_sources_by_document_ids(mysql, &[document_id]).await?;
    Ok(row)
}

/// The `users` row reload of an attribute read on an instance expired by the
/// overwrite commit (`user.user_name` in `_schedule_indexing_celery`).
pub(crate) async fn refresh_user_name<M>(mysql: &M, user_id: i64) -> MysqlResult<Option<String>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[allow(dead_code)]
        id: i64,
        user_name: String,
    }
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT users.id, users.user_name, users.password_hash, users.email, \
                 users.git_info, users.is_active, users.`role`, users.auth_source, \
                 users.preferences, users.created_at, users.updated_at \nFROM users \n\
                 WHERE users.id = {user_id}"
            ),
            (),
        )
        .await?;
    Ok(row.map(|row| row.user_name))
}

/// The `knowledge_documents` attributes the content update mutates, in mapper
/// column order.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DocumentColumns {
    pub(crate) file_size: i64,
    pub(crate) index_status: String,
    pub(crate) index_generation: i64,
}

impl DocumentColumns {
    pub(crate) fn of(row: &DocumentRow) -> Self {
        Self {
            file_size: row.knowledge_documents_file_size,
            index_status: row.knowledge_documents_index_status.clone(),
            index_generation: row.knowledge_documents_index_generation,
        }
    }

    /// The `UPDATE` for this row's changed attributes, or `None` when nothing
    /// changed (SQLAlchemy emits no statement for a clean instance).
    fn statement(&self, flushed: &Self, document_id: i64) -> Option<(String, Vec<Param>)> {
        let mut assignments = String::new();
        let mut params: Vec<Param> = Vec::new();
        if self.file_size != flushed.file_size {
            assignments.push_str("file_size=?");
            params.push(Param::Int(self.file_size));
        }
        if self.index_status != flushed.index_status {
            if !assignments.is_empty() {
                assignments.push_str(", ");
            }
            assignments.push_str("index_status=?");
            params.push(Param::Text(self.index_status.clone()));
        }
        if self.index_generation != flushed.index_generation {
            if !assignments.is_empty() {
                assignments.push_str(", ");
            }
            assignments.push_str("index_generation=?");
            params.push(Param::Int(self.index_generation));
        }
        if params.is_empty() {
            return None;
        }
        let sql = format!(
            "UPDATE knowledge_documents SET {assignments}, updated_at=now() \
             WHERE knowledge_documents.id = ?"
        );
        params.push(Param::Int(document_id));
        Some((sql, params))
    }

    /// Emit the changed attributes, then treat them as written. A flush with
    /// no changed attribute emits nothing.
    pub(crate) async fn flush<T: MysqlTransaction>(
        &self,
        transaction: &mut T,
        flushed: &mut Self,
        document_id: i64,
    ) -> MysqlResult<()> {
        if let Some((sql, params)) = self.statement(flushed, document_id) {
            transaction.execute(sql, params).await?;
            *flushed = self.clone();
        }
        Ok(())
    }

    /// This row's changed attributes as a statement the caller hands to
    /// `overwrite_attachment_internal`, so the write shares that transaction
    /// (the source's `db.flush()` covers the whole session).
    pub(crate) fn preflush(&self, flushed: &mut Self, document_id: i64) -> Option<Preflush> {
        let (sql, params) = self.statement(flushed, document_id)?;
        *flushed = self.clone();
        Some(Preflush { sql, params })
    }
}

/// `prepare_document_index_enqueue`'s decision.
pub(crate) struct IndexEnqueueDecision {
    pub(crate) should_enqueue: bool,
    pub(crate) generation: Option<i64>,
    #[allow(dead_code)]
    pub(crate) reason: &'static str,
}

/// `shared.knowledge_module.index_state.ACTIVE_INDEX_STATUSES`.
const ACTIVE_INDEX_STATUSES: [&str; 4] = ["queued", "pending_conversion", "converting", "indexing"];

/// `active_index_stale_reason` thresholds
/// (`KNOWLEDGE_INDEX_STALE_*_SECONDS`), with the deployment defaults.
fn stale_threshold(status: &str) -> Option<i64> {
    let (name, default) = match status {
        "queued" => ("KNOWLEDGE_INDEX_STALE_QUEUED_SECONDS", 3600),
        "pending_conversion" => ("KNOWLEDGE_INDEX_STALE_PENDING_CONVERSION_SECONDS", 7200),
        "indexing" => ("KNOWLEDGE_INDEX_STALE_INDEXING_SECONDS", 3600),
        "converting" => ("KNOWLEDGE_INDEX_STALE_CONVERTING_SECONDS", 7200),
        _ => return None,
    };
    Some(
        crate::config::env_or_dotenv(name)
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or(default),
    )
}

/// `_get_active_index_stale_reason_for`: whether an active state expired.
fn active_index_stale_reason(status: &str, updated_at: Option<NaiveDateTime>) -> Option<String> {
    let threshold = stale_threshold(status)?;
    let updated_at = updated_at?;
    let age_seconds = (chrono::Utc::now().naive_utc() - updated_at).num_seconds();
    if age_seconds >= threshold {
        Some(format!("stale_{status}"))
    } else {
        None
    }
}

/// `_decide_enqueue` (`shared.knowledge_module.index_state`) for the
/// content-update dispatch, which passes `allow_if_success=True` and
/// `replace_active=True`, so a found document always schedules the next
/// generation.
fn decide_enqueue(status: &str, generation: i64, stale: bool) -> IndexEnqueueDecision {
    let reason = if ACTIVE_INDEX_STATUSES.contains(&status) && stale {
        "scheduled_after_stale_recovery"
    } else {
        "scheduled"
    };
    IndexEnqueueDecision {
        should_enqueue: true,
        generation: Some(generation + 1),
        reason,
    }
}

/// `_prepare_document_index_enqueue`: hold the row lock, decide, then write the
/// new generation (`db.commit()`), or `db.rollback()` when the event is
/// rejected.
pub(crate) async fn prepare_index_enqueue<M>(
    mysql: &M,
    document_id: i64,
) -> MysqlResult<IndexEnqueueDecision>
where
    M: Mysql,
{
    let Some(document) = lock_document(mysql, document_id).await? else {
        mysql.execute("ROLLBACK", ()).await?;
        return Ok(IndexEnqueueDecision {
            should_enqueue: false,
            generation: None,
            reason: "document_not_found",
        });
    };
    let current_status = if document.knowledge_documents_index_status.is_empty() {
        "not_indexed".to_string()
    } else {
        document.knowledge_documents_index_status.clone()
    };
    let generation = document.knowledge_documents_index_generation.max(0);
    let stale = active_index_stale_reason(&current_status, document.knowledge_documents_updated_at)
        .is_some();
    let decision = decide_enqueue(&current_status, generation, stale);
    if !decision.should_enqueue {
        // `db.rollback()` releases the lock without writing.
        mysql.execute("ROLLBACK", ()).await?;
        return Ok(decision);
    }
    let mut columns = DocumentColumns::of(&document);
    let mut flushed = columns.clone();
    columns.index_generation = decision.generation.unwrap_or(generation + 1);
    columns.index_status = "queued".to_string();
    mysql
        .with_transaction(async |transaction| {
            columns.flush(transaction, &mut flushed, document_id).await
        })
        .await?;
    Ok(decision)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns(file_size: i64, index_status: &str, index_generation: i64) -> DocumentColumns {
        DocumentColumns {
            file_size,
            index_status: index_status.to_string(),
            index_generation,
        }
    }

    /// The content write flushes only `file_size`: the recorded reset flush
    /// carries `UPDATE knowledge_documents SET file_size=?, updated_at=now()`
    /// with no other column.
    #[test]
    fn document_flush_writes_only_the_changed_columns() {
        let flushed = columns(8884, "success", 1);
        let mut changed = flushed.clone();
        changed.file_size = 8599;
        let (sql, params) = changed.statement(&flushed, 43199).unwrap();
        assert_eq!(
            sql,
            "UPDATE knowledge_documents SET file_size=?, updated_at=now() \
             WHERE knowledge_documents.id = ?"
        );
        assert_eq!(params.len(), 2);
        // An unchanged row emits no statement at all.
        assert!(flushed.statement(&flushed, 43199).is_none());
    }

    /// The index flush writes `index_status` then `index_generation`, matching
    /// the recorded `SET index_status='queued', index_generation=2`.
    #[test]
    fn index_flush_orders_status_before_generation() {
        let flushed = columns(8599, "success", 1);
        let mut changed = flushed.clone();
        changed.index_status = "queued".to_string();
        changed.index_generation = 2;
        let (sql, params) = changed.statement(&flushed, 43199).unwrap();
        assert_eq!(
            sql,
            "UPDATE knowledge_documents SET index_status=?, index_generation=?, \
             updated_at=now() WHERE knowledge_documents.id = ?"
        );
        assert_eq!(params.len(), 3);
    }

    /// The enqueue decision advances the generation and queues the document for
    /// the content-update dispatch (`allow_if_success=True`,
    /// `replace_active=True`).
    #[test]
    fn enqueue_advances_the_generation_and_queues() {
        let decision = decide_enqueue("success", 1, false);
        assert!(decision.should_enqueue);
        assert_eq!(decision.generation, Some(2));
        assert_eq!(decision.reason, "scheduled");

        let stale = decide_enqueue("indexing", 4, true);
        assert_eq!(stale.generation, Some(5));
        assert_eq!(stale.reason, "scheduled_after_stale_recovery");
    }

    /// An active generation that is not stale is still replaced: the
    /// content-update caller passes `replace_active=True`.
    #[test]
    fn active_generation_is_replaced_for_the_content_update() {
        let decision = decide_enqueue("queued", 7, false);
        assert!(decision.should_enqueue);
        assert_eq!(decision.generation, Some(8));
    }
}
