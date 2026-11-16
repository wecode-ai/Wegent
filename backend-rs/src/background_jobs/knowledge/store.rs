// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Locked document transitions. Business ownership is never inferred from a queue ACK.

use std::collections::BTreeSet;

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlService, MysqlTransaction};
use chrono::{DateTime, Utc};
use serde_json::{Map, Value};

use super::{
    snapshot::Document,
    state::{self, Event, Snapshot, StaleThresholds},
};

const COLUMNS: &str = "d.id,d.user_id,d.attachment_id,d.file_extension,d.file_size,d.is_active,d.status,d.index_status,d.index_generation,COALESCE(NULLIF(d.source_config,CAST('null' AS JSON)),JSON_OBJECT()) AS source_config,d.chunks,TIMESTAMPDIFF(SECOND,d.updated_at,NOW()) AS age_seconds,EXISTS(SELECT 1 FROM knowledge_document_external_sources e WHERE e.document_id=d.id) AS external_identity";

#[derive(FromMysqlRow)]
struct DocumentRow {
    id: i64,
    user_id: i64,
    attachment_id: i64,
    file_extension: String,
    file_size: i64,
    is_active: i8,
    status: String,
    index_status: String,
    index_generation: i64,
    source_config: Json<Map<String, Value>>,
    chunks: Option<Json<Value>>,
    age_seconds: Option<i64>,
    external_identity: i8,
}

impl DocumentRow {
    fn snapshot(&self) -> Snapshot {
        Snapshot {
            status: self.index_status.clone(),
            generation: self.index_generation,
        }
    }

    fn into_document(self) -> Document {
        Document {
            id: self.id,
            user_id: self.user_id,
            attachment_id: self.attachment_id,
            file_extension: self.file_extension,
            file_size: self.file_size,
            active: self.is_active != 0,
            status: self.status,
            index_status: self.index_status,
            generation: self.index_generation,
            source_config: self.source_config.0,
            chunks: self.chunks.map(|value| value.0),
            external_identity: self.external_identity != 0,
        }
    }
}

#[derive(Debug)]
pub struct Transition {
    pub accepted: bool,
    pub reason: &'static str,
    pub previous_status: Option<String>,
    pub document: Option<Document>,
    pub cleanup: BTreeSet<i64>,
}

impl Transition {
    fn skipped(reason: &'static str) -> Self {
        Self {
            accepted: false,
            reason,
            previous_status: None,
            document: None,
            cleanup: BTreeSet::new(),
        }
    }
}

pub async fn load<M: Mysql>(mysql: &M, id: i64) -> MysqlResult<Option<Document>> {
    let row: Option<DocumentRow> = mysql
        .fetch_optional(
            &format!("SELECT {COLUMNS} FROM knowledge_documents d WHERE d.id=?"),
            (id,),
        )
        .await?;
    Ok(row.map(DocumentRow::into_document))
}

async fn locked<T: MysqlTransaction>(
    transaction: &mut T,
    id: i64,
) -> MysqlResult<Option<DocumentRow>> {
    transaction
        .fetch_optional(
            &format!("SELECT {COLUMNS} FROM knowledge_documents d WHERE d.id=? FOR UPDATE"),
            (id,),
        )
        .await
}

async fn save<T: MysqlTransaction>(transaction: &mut T, doc: &Document) -> MysqlResult<()> {
    transaction.execute(
        "UPDATE knowledge_documents SET attachment_id=?,file_extension=?,file_size=?,is_active=?,status=?,index_status=?,index_generation=?,source_config=?,chunks=?,updated_at=NOW() WHERE id=?",
        (doc.attachment_id, doc.file_extension.as_str(), doc.file_size, doc.active,
         doc.status.as_str(), doc.index_status.as_str(), doc.generation,
         Json(&doc.source_config), doc.chunks.as_ref().map(Json), doc.id),
    ).await?;
    Ok(())
}

pub async fn start(mysql: &MysqlService, id: i64, generation: i64) -> MysqlResult<Transition> {
    mysql.with_transaction(async |transaction| {
        let row = locked(transaction, id).await?;
        let decision = state::decide(row.as_ref().map(DocumentRow::snapshot).as_ref(), generation, Event::Start);
        if !decision.accepted {
            return Ok(Transition::skipped(decision.reason));
        }
        let mut doc = row.expect("accepted decision requires a document").into_document();
        doc.index_status = "indexing".into();
        transaction.execute("UPDATE knowledge_documents SET index_status='indexing',updated_at=NOW() WHERE id=? AND index_generation=?", (id, generation)).await?;
        Ok(Transition { accepted: true, reason: "started", previous_status: None, document: Some(doc), cleanup: BTreeSet::new() })
    }).await
}

const IMPORT_CLAIM: &str = "_native_import_claim";

#[cfg(test)]
pub async fn claim_import(mysql: &MysqlService, id: i64, expected: i64) -> MysqlResult<Transition> {
    claim_import_with(mysql, id, expected, None).await
}

pub async fn claim_import_for_job(
    mysql: &MysqlService,
    id: i64,
    expected: i64,
    job_id: &str,
) -> MysqlResult<Transition> {
    claim_import_with(mysql, id, expected, Some(job_id)).await
}

async fn claim_import_with(
    mysql: &MysqlService,
    id: i64,
    expected: i64,
    job_id: Option<&str>,
) -> MysqlResult<Transition> {
    mysql
        .with_transaction(async |transaction| {
            let Some(row) = locked(transaction, id).await? else {
                return Ok(Transition::skipped("document_not_found"));
            };
            let resumed = job_id.is_some_and(|job_id| {
                let marker = row
                    .source_config
                    .0
                    .get(IMPORT_CLAIM)
                    .unwrap_or(&Value::Null);
                marker["job_id"].as_str() == Some(job_id)
                    && marker["expected_generation"].as_i64() == Some(expected)
                    && marker["generation"].as_i64() == Some(row.index_generation)
                    && expected.checked_add(1) == Some(row.index_generation)
            });
            if row.index_generation != expected && !resumed {
                return Ok(Transition::skipped("stale_generation"));
            }
            if row.index_status != "queued" {
                return Ok(Transition::skipped("not_queued"));
            }
            if row.external_identity == 0 {
                return Ok(Transition::skipped("external_source_not_found"));
            }
            if resumed {
                return Ok(Transition {
                    accepted: true,
                    reason: "resumed",
                    previous_status: None,
                    document: Some(row.into_document()),
                    cleanup: BTreeSet::new(),
                });
            }
            let Some(next) = expected.checked_add(1) else {
                return Ok(Transition::skipped("generation_exhausted"));
            };
            let mut doc = row.into_document();
            doc.advance(expected, next);
            doc.generation = next;
            doc.source_config.remove("processing_error");
            if let Some(job_id) = job_id {
                doc.source_config.insert(
                    IMPORT_CLAIM.into(),
                    serde_json::json!({
                        "job_id": job_id,
                        "expected_generation": expected,
                        "generation": next,
                    }),
                );
            }
            save(transaction, &doc).await?;
            Ok(Transition {
                accepted: true,
                reason: "claimed",
                previous_status: None,
                document: Some(doc),
                cleanup: BTreeSet::new(),
            })
        })
        .await
}

pub async fn enqueue(
    mysql: &MysqlService,
    id: i64,
    expected: Option<i64>,
    replace_active: bool,
    capture: bool,
) -> MysqlResult<Transition> {
    mysql
        .with_transaction(async |transaction| {
            let row = locked(transaction, id).await?;
            let previous_status = row.as_ref().map(|row| row.index_status.clone());
            let stale = row.as_ref().is_some_and(|row| {
                StaleThresholds::from_env().expired(&row.index_status, row.age_seconds)
            });
            let decision = state::decide(
                row.as_ref().map(DocumentRow::snapshot).as_ref(),
                expected.unwrap_or_default(),
                Event::Enqueue {
                    expected,
                    allow_success: true,
                    replace_active,
                    stale,
                },
            );
            if !decision.accepted {
                return Ok(Transition::skipped(decision.reason));
            }
            let mut doc = row
                .expect("accepted enqueue requires a document")
                .into_document();
            let mut cleanup = BTreeSet::new();
            if capture {
                if decision.reason == "scheduled_after_stale_recovery" {
                    if let Some(ids) = doc.restore(doc.generation) {
                        cleanup = ids;
                    } else {
                        doc.index_status = "failed".into();
                    }
                }
                doc.capture(decision.generation);
            } else {
                doc.advance(doc.generation, decision.generation);
            }
            doc.generation = decision.generation;
            doc.index_status = "queued".into();
            doc.source_config.remove("processing_error");
            doc.source_config.remove(IMPORT_CLAIM);
            save(transaction, &doc).await?;
            Ok(Transition {
                accepted: true,
                reason: decision.reason,
                previous_status,
                document: Some(doc),
                cleanup,
            })
        })
        .await
}

pub async fn succeed(
    mysql: &MysqlService,
    id: i64,
    generation: i64,
    chunks: Option<Value>,
    keep_chunks: bool,
) -> MysqlResult<Transition> {
    let now = Utc::now();
    mysql
        .with_transaction(async |transaction| {
            let row = locked(transaction, id).await?;
            let decision = state::decide(
                row.as_ref().map(DocumentRow::snapshot).as_ref(),
                generation,
                Event::Success,
            );
            if !decision.accepted {
                return Ok(Transition::skipped(decision.reason));
            }
            let mut doc = row
                .expect("accepted decision requires a document")
                .into_document();
            let cleanup = doc.finalize(generation).unwrap_or_default();
            doc.source_config.remove(IMPORT_CLAIM);
            doc.index_status = "success".into();
            doc.active = true;
            doc.status = "enabled".into();
            doc.chunks = selected_chunks(chunks.clone(), keep_chunks);
            if doc.external_identity {
                finalize_external_success(&mut doc, now);
            }
            save(transaction, &doc).await?;
            Ok(Transition {
                accepted: true,
                reason: "finalized",
                previous_status: None,
                document: Some(doc),
                cleanup,
            })
        })
        .await
}

fn selected_chunks(chunks: Option<Value>, keep: bool) -> Option<Value> {
    if keep {
        return chunks;
    }
    chunks.and_then(|chunks| {
        let object = chunks.as_object()?;
        let metadata = ["splitter_subtype", "qa_pair_count"]
            .into_iter()
            .filter_map(|field| {
                object
                    .get(field)
                    .cloned()
                    .map(|value| (field.to_owned(), value))
            })
            .collect::<Map<_, _>>();
        (!metadata.is_empty()).then(|| metadata.into())
    })
}

fn finalize_external_success(doc: &mut Document, now: DateTime<Utc>) {
    let mut external = doc.external();
    external.insert("last_success_at".into(), now.to_rfc3339().into());
    external.insert(
        "last_success_attachment_id".into(),
        doc.attachment_id.into(),
    );
    if let Some(sync) = external.get_mut("sync").and_then(Value::as_object_mut)
        && sync.get("enabled").and_then(Value::as_bool) == Some(true)
    {
        sync.insert(
            "indexed_version".into(),
            sync.get("content_version").cloned().unwrap_or(Value::Null),
        );
        sync.insert("last_synced_at".into(), now.to_rfc3339().into());
        for field in ["last_error_code", "last_error_retryable", "failed_version"] {
            sync.remove(field);
        }
    }
    doc.source_config.insert("external".into(), external.into());
}

pub async fn fail(
    mysql: &MysqlService,
    id: i64,
    generation: i64,
    error: Value,
    preserve_served: bool,
    require_stale: bool,
) -> MysqlResult<Transition> {
    fail_with(
        mysql,
        id,
        generation,
        error,
        preserve_served,
        require_stale,
        false,
    )
    .await
}

pub async fn fail_import(
    mysql: &MysqlService,
    id: i64,
    generation: i64,
    error: Value,
) -> MysqlResult<Transition> {
    fail_with(mysql, id, generation, error, true, false, true).await
}

async fn fail_with(
    mysql: &MysqlService,
    id: i64,
    generation: i64,
    error: Value,
    preserve_served: bool,
    require_stale: bool,
    import_failure: bool,
) -> MysqlResult<Transition> {
    let thresholds = StaleThresholds::from_env();
    mysql
        .with_transaction(async |transaction| {
            let row = locked(transaction, id).await?;
            let decision = state::decide(
                row.as_ref().map(DocumentRow::snapshot).as_ref(),
                generation,
                Event::Failure,
            );
            if !decision.accepted {
                return Ok(Transition::skipped(decision.reason));
            }
            let row = row.expect("accepted decision requires a document");
            if require_stale && !thresholds.expired(&row.index_status, row.age_seconds) {
                return Ok(Transition::skipped("no_longer_stale"));
            }
            let mut doc = row.into_document();
            let restored = doc.restore(generation);
            doc.source_config.remove(IMPORT_CLAIM);
            let reason =
                apply_failure(&mut doc, error.clone(), preserve_served, restored.is_some());
            if import_failure {
                apply_import_failure(&mut doc, &error);
            }
            save(transaction, &doc).await?;
            Ok(Transition {
                accepted: true,
                reason,
                previous_status: None,
                document: Some(doc),
                cleanup: restored.unwrap_or_default(),
            })
        })
        .await
}

fn apply_import_failure(doc: &mut Document, error: &Value) {
    if matches!(
        error["code"].as_str(),
        Some("external_source_missing" | "external_source_unavailable")
    ) {
        return;
    }
    let mut external = doc.external();
    let Some(sync) = external
        .get_mut("sync")
        .and_then(Value::as_object_mut)
        .filter(|sync| sync.get("enabled").and_then(Value::as_bool) == Some(true))
    else {
        return;
    };
    sync.insert("last_error_code".into(), error["code"].clone());
    let retryable = error["retryable"].as_bool().unwrap_or(true);
    sync.insert("last_error_retryable".into(), retryable.into());
    if retryable {
        sync.remove("failed_version");
    } else if let Some(version) = sync
        .get("observed_version")
        .filter(|v| !v.is_null() && *v != "")
        .cloned()
    {
        sync.insert("failed_version".into(), version);
    }
    external.insert("status".into(), "sync_error".into());
    external.insert("last_error".into(), error["message"].clone());
    doc.source_config.insert("external".into(), external.into());
}

fn apply_failure(
    doc: &mut Document,
    error: Value,
    preserve_served: bool,
    restored: bool,
) -> &'static str {
    let mut external = doc.external();
    let sync = external.get("sync").and_then(Value::as_object);
    let active_sync = !restored
        && preserve_served
        && doc.active
        && doc.attachment_id != 0
        && sync.is_some_and(|sync| {
            sync.get("enabled").and_then(Value::as_bool) == Some(true)
                && sync
                    .get("indexed_version")
                    .is_some_and(|value| !value.is_null() && value != "")
        });
    let served = !restored
        && preserve_served
        && !active_sync
        && doc.attachment_id != 0
        && external
            .get("last_success_attachment_id")
            .and_then(Value::as_i64)
            == Some(doc.attachment_id);
    if !restored {
        doc.source_config
            .insert("processing_error".into(), error.clone());
        doc.index_status = if active_sync || served {
            "success"
        } else {
            "failed"
        }
        .into();
        if active_sync {
            doc.source_config.remove("processing_error");
        }
        if served {
            doc.active = true;
        }
    }
    let unavailable = matches!(
        error.get("code").and_then(Value::as_str),
        Some("external_source_unavailable" | "external_source_missing")
    );
    if doc.external_identity && (restored || active_sync || served || unavailable) {
        external.insert(
            "status".into(),
            if unavailable {
                "inaccessible"
            } else {
                "sync_error"
            }
            .into(),
        );
        external.insert(
            "last_error".into(),
            error.get("message").cloned().unwrap_or(Value::Null),
        );
        if let Some(sync) = external.get_mut("sync").and_then(Value::as_object_mut)
            && sync.get("enabled").and_then(Value::as_bool) == Some(true)
        {
            sync.insert(
                "last_error_code".into(),
                error.get("code").cloned().unwrap_or(Value::Null),
            );
        }
        doc.source_config.insert("external".into(), external.into());
    }
    if restored {
        "external_refresh_snapshot_restored"
    } else if served {
        "served_body_kept"
    } else if active_sync {
        "source_unavailable_active_index_preserved"
    } else {
        "finalized"
    }
}

#[derive(Debug, FromMysqlRow)]
pub struct ActiveAttempt {
    pub id: i64,
    pub index_generation: i64,
    pub index_status: String,
    pub age_seconds: Option<i64>,
}

pub async fn active_attempts<M: Mysql>(mysql: &M) -> MysqlResult<Vec<ActiveAttempt>> {
    mysql.fetch_all("SELECT id,index_generation,index_status,TIMESTAMPDIFF(SECOND,updated_at,NOW()) AS age_seconds FROM knowledge_documents WHERE index_status IN ('queued','pending_conversion','converting','indexing')", ()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_storage_disabled_retains_qa_metadata_without_chunk_bodies() {
        let chunks = serde_json::json!({"splitter_subtype":"qa","qa_pair_count":3,"chunks":[{"content":"private body"}]});
        assert_eq!(
            selected_chunks(Some(chunks), false),
            Some(serde_json::json!({"splitter_subtype":"qa","qa_pair_count":3}))
        );
        assert_eq!(selected_chunks(None, false), None);
        assert_eq!(
            selected_chunks(Some(serde_json::json!({"chunks": []})), false),
            None
        );
    }
}
