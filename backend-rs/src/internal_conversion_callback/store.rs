// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `knowledge_documents` / `subtask_contexts` statements for
//! `POST /api/internal/conversion/callback/completed`
//! (`app/api/endpoints/internal/conversion_callback.py` +
//! `shared/knowledge_module/documents.py` + `app/services/knowledge/
//! index_state_machine.py`).
//!
//! The document load is the ORM entity projection followed by the
//! `lazy="selectin"` external-source load. The post-upload reload is the
//! unaliased `db.refresh(document)` shape with the single-parent `=` form of
//! the external-source relationship. Both repeats are request-owned: the
//! upload commits inside the request and expires the loaded instances.

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use serde_json::{Map, Value};

use crate::knowledge_documents_content::reader::{self, DOCUMENT_COLUMNS, DocumentRow};

/// The external-source columns; the relationship's `selectin` load renders
/// them without aliases.
const EXTERNAL_SOURCE_COLUMNS: &str = "knowledge_document_external_sources.document_id, \
     knowledge_document_external_sources.kind_id, \
     knowledge_document_external_sources.external_provider, \
     knowledge_document_external_sources.external_resource_id";

/// The `db.refresh(document)` projection: unaliased columns, no `LIMIT`.
const DOCUMENT_REFRESH_COLUMNS: &str = "knowledge_documents.id, knowledge_documents.kind_id, \
     knowledge_documents.attachment_id, knowledge_documents.name, \
     knowledge_documents.file_extension, knowledge_documents.file_size, \
     knowledge_documents.status, knowledge_documents.user_id, \
     knowledge_documents.is_active, knowledge_documents.index_status, \
     knowledge_documents.index_generation, knowledge_documents.splitter_config, \
     knowledge_documents.source_type, knowledge_documents.source_config, \
     knowledge_documents.origin, knowledge_documents.folder_id, \
     knowledge_documents.summary, knowledge_documents.chunks, \
     knowledge_documents.created_at, knowledge_documents.updated_at";

/// `db.query(KnowledgeDocument).filter(id).first()` plus the `selectin`
/// external-source load. Returns the loaded provider (`doc.external_provider`),
/// which selects the converted attachment's lifecycle owner.
pub(crate) async fn document_with_provider<M>(
    mysql: &M,
    document_id: i64,
) -> MysqlResult<(Option<DocumentRow>, Option<String>)>
where
    M: Mysql,
{
    let document: Option<DocumentRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {DOCUMENT_COLUMNS} \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.id = ? \n LIMIT 1"
            ),
            (document_id,),
        )
        .await?;

    #[derive(Debug, FromMysqlRow)]
    struct ProviderRow {
        external_provider: Option<String>,
    }
    let providers: Vec<ProviderRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {EXTERNAL_SOURCE_COLUMNS} \n\
                 FROM knowledge_document_external_sources \n\
                 WHERE knowledge_document_external_sources.document_id IN (?)"
            ),
            (document_id,),
        )
        .await?;

    Ok((
        document,
        providers.into_iter().find_map(|row| row.external_provider),
    ))
}

/// `db.refresh(document)`: the full entity reload plus the single-parent
/// external-source relationship load the refresh performs.
///
/// The refresh projection is unaliased (`knowledge_documents.id`, not
/// `... AS knowledge_documents_id`), so the shared aliased [`DocumentRow`]
/// decode cannot consume it; decode the consumed fields from their plain
/// column names instead.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct RefreshedDocumentRow {
    #[allow(dead_code)]
    pub(crate) id: i64,
    #[allow(dead_code)]
    pub(crate) kind_id: i64,
    #[allow(dead_code)]
    #[allow(dead_code)]
    pub(crate) attachment_id: i64,
    #[allow(dead_code)]
    pub(crate) index_status: String,
    #[allow(dead_code)]
    pub(crate) index_generation: i64,
    source_config: Option<Json<brz_json::OpaqueJson>>,
}

impl RefreshedDocumentRow {
    /// `KnowledgeDocument.converted_attachment_id`: the integer stored under
    /// `source_config.converted_attachment_id`, when present.
    pub(crate) fn converted_attachment_id(&self) -> Option<i64> {
        self.source_config_map()?
            .get("converted_attachment_id")
            .and_then(Value::as_i64)
    }

    /// `source_config` as an ordered map, for the pointer rewrite and the
    /// stale-race restore.
    pub(crate) fn source_config_map(&self) -> Option<Map<String, Value>> {
        let raw = self.source_config.as_ref()?;
        let text = raw.0.as_raw().get();
        if text == "null" {
            return None;
        }
        serde_json::from_str(text).ok()
    }
}

pub(crate) async fn refresh_document_row<M>(
    mysql: &M,
    document_id: i64,
) -> MysqlResult<Option<RefreshedDocumentRow>>
where
    M: Mysql,
{
    let document: Option<RefreshedDocumentRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {DOCUMENT_REFRESH_COLUMNS} \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.id = ?"
            ),
            (document_id,),
        )
        .await?;
    reader::external_sources_by_document(mysql, document_id).await?;
    Ok(document)
}

/// The staleness pre-check's two-column read. The source reads the columns
/// rather than the entity so an identity-mapped instance cannot hand stale
/// values to the decision.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct IndexAttempt {
    #[mysql(rename = "knowledge_documents_index_generation")]
    pub(crate) generation: Option<i64>,
    #[mysql(rename = "knowledge_documents_index_status")]
    pub(crate) status: Option<String>,
}

/// `db.query(KnowledgeDocument.index_generation, KnowledgeDocument.index_status)`
/// for one document.
pub(crate) async fn index_attempt<M>(
    mysql: &M,
    document_id: i64,
) -> MysqlResult<Option<IndexAttempt>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            "SELECT knowledge_documents.index_generation AS \
             knowledge_documents_index_generation, knowledge_documents.index_status AS \
             knowledge_documents_index_status \nFROM knowledge_documents \n\
             WHERE knowledge_documents.id = ? \n LIMIT 1",
            (document_id,),
        )
        .await
}

/// `shared.knowledge_module.CONVERSION_COMPLETE_STATUSES`: the statuses a
/// completed conversion may still replace.
const CONVERSION_COMPLETE_STATUSES: [&str; 2] = ["converting", "pending_conversion"];

/// `decide_conversion_completed` (`shared/knowledge_module/documents.py`).
pub(crate) fn decide_conversion_completed(generation: i64, attempt: Option<&IndexAttempt>) -> bool {
    let Some(attempt) = attempt else {
        return false;
    };
    let Some(current_generation) = attempt.generation else {
        return false;
    };
    if current_generation != generation {
        return false;
    }
    attempt
        .status
        .as_deref()
        .is_some_and(|status| CONVERSION_COMPLETE_STATUSES.contains(&status))
}

/// `subtask_contexts` columns for the attachment lookup; the ORM entity
/// projection carries the `subtask_contexts_` aliases.
const ORIGINAL_ATTACHMENT_COLUMNS: &str = "subtask_contexts.id AS subtask_contexts_id, \
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
     subtask_contexts.updated_at AS subtask_contexts_updated_at";

/// The original attachment row fields the callback consumes.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct OriginalAttachment {
    #[allow(dead_code)]
    #[mysql(rename = "subtask_contexts_id")]
    pub(crate) id: i64,
    /// `original_attachment.user_id`: the converted attachment's owner.
    #[mysql(rename = "subtask_contexts_user_id")]
    pub(crate) user_id: i64,
}

/// `db.query(SubtaskContext).filter(id == attachment_id,
/// context_type == "attachment").first()`.
pub(crate) async fn original_attachment<M>(
    mysql: &M,
    attachment_id: i64,
) -> MysqlResult<Option<OriginalAttachment>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {ORIGINAL_ATTACHMENT_COLUMNS} \nFROM subtask_contexts \n\
                 WHERE subtask_contexts.id = ? \
                 AND subtask_contexts.context_type = 'attachment' \n LIMIT 1"
            ),
            (attachment_id,),
        )
        .await
}

/// `db.refresh(converted_context)`: the unaliased primary-key re-select the
/// source issues when a later attribute read follows the commit that expired
/// the instance.
#[derive(Debug, FromMysqlRow)]
pub(crate) struct ConvertedContext {
    pub(crate) id: i64,
}

pub(crate) async fn refresh_converted_context<M>(
    mysql: &M,
    context_id: i64,
) -> MysqlResult<Option<ConvertedContext>>
where
    M: Mysql,
{
    // The converted row was committed by this request and may still be absent
    // from the replica. Reuse the upload's primary refresh for this reload too.
    crate::attachments::upload::refresh_context(mysql, context_id)
        .await
        .map(|row| row.map(|row| ConvertedContext { id: row.id }))
}

/// `doc.converted_attachment_id = id; db.flush()`: SQLAlchemy writes only the
/// changed JSON column plus `updated_at`.
pub(crate) const UPDATE_SOURCE_CONFIG_QUERY: &str = "UPDATE knowledge_documents SET source_config=?, updated_at=now() \
     WHERE knowledge_documents.id = ?";

/// `mark_document_conversion_succeeded`'s conditional update
/// (`KnowledgeDocument.index_status.in_(conversion_complete_statuses())`).
pub(crate) const MARK_CONVERSION_SUCCEEDED_QUERY: &str = "UPDATE knowledge_documents SET index_status=?, updated_at=now() \
     WHERE knowledge_documents.id = ? \
     AND knowledge_documents.index_generation = ? \
     AND knowledge_documents.index_status IN (?, ?)";

/// `DocumentIndexStatus.QUEUED`.
pub(crate) const QUEUED_STATUS: &str = "queued";

#[cfg(test)]
mod tests {
    use super::*;

    fn attempt(generation: Option<i64>, status: Option<&str>) -> IndexAttempt {
        IndexAttempt {
            generation,
            status: status.map(str::to_owned),
        }
    }

    /// `decide_conversion_completed` only accepts the current generation while
    /// the document still waits in a replaceable conversion state.
    #[test]
    fn completed_decision_matches_the_shared_module() {
        assert!(decide_conversion_completed(
            1,
            Some(&attempt(Some(1), Some("converting")))
        ));
        assert!(decide_conversion_completed(
            1,
            Some(&attempt(Some(1), Some("pending_conversion")))
        ));
        // Older generation, already-finalized status, missing row/columns.
        assert!(!decide_conversion_completed(
            1,
            Some(&attempt(Some(2), Some("converting")))
        ));
        assert!(!decide_conversion_completed(
            1,
            Some(&attempt(Some(1), Some("queued")))
        ));
        assert!(!decide_conversion_completed(
            1,
            Some(&attempt(Some(1), Some("success")))
        ));
        assert!(!decide_conversion_completed(1, Some(&attempt(None, None))));
        assert!(!decide_conversion_completed(1, None));
    }

    fn refreshed_row(source_config: Option<&str>) -> RefreshedDocumentRow {
        RefreshedDocumentRow {
            id: 43384,
            kind_id: 1884840,
            attachment_id: 1392099,
            index_status: "converting".to_string(),
            index_generation: 1,
            source_config: source_config
                .map(|text| Json(brz_json::OpaqueJson::from_json_text(text).expect("valid JSON"))),
        }
    }

    /// The refreshed row decodes `source_config` and exposes the converted
    /// reference the same way the aliased `DocumentRow` projection does.
    #[test]
    fn refreshed_row_reads_the_converted_attachment_reference() {
        let row = refreshed_row(Some(r#"{"converted_attachment_id": 1392107}"#));
        assert_eq!(row.converted_attachment_id(), Some(1392107));
        let map = row.source_config_map().expect("decoded map");
        assert_eq!(
            map.get("converted_attachment_id"),
            Some(&Value::from(1392107))
        );

        // An empty object config and an SQL NULL config carry no reference.
        let empty = refreshed_row(Some("{}"));
        assert_eq!(empty.converted_attachment_id(), None);
        assert_eq!(empty.source_config_map().expect("decoded map").len(), 0);
        assert_eq!(refreshed_row(None).converted_attachment_id(), None);
        assert!(refreshed_row(None).source_config_map().is_none());
    }

    /// The refresh projection stays unaliased: `db.refresh(document)` renders
    /// plain column names, unlike the aliased entity load.
    #[test]
    fn refresh_projection_keeps_the_source_column_names() {
        assert!(DOCUMENT_REFRESH_COLUMNS.contains("knowledge_documents.id,"));
        assert!(!DOCUMENT_REFRESH_COLUMNS.contains(" AS knowledge_documents_id"));
        assert!(DOCUMENT_COLUMNS.contains("AS knowledge_documents_id"));
    }
}
