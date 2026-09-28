// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Knowledge document reads for the open content endpoint.
//!
//! Mirrors the `knowledge_documents` / `knowledge_document_external_sources`
//! / `subtask_contexts` queries of
//! `KnowledgeOrchestrator._get_document_with_access_or_raise` and
//! `DocumentReadService.read_documents` (full SQLAlchemy-labeled
//! projections; scalar filters inlined as literals matching the recorded
//! COM_QUERY text).
use crate::json_compat::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
#[cfg(test)]
use serde_json::Value;

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct SourceConfig {
    converted_attachment_id: Option<i64>,
}
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct ContextMetadata {
    file_extension: Option<String>,
}

/// `knowledge_documents` columns as rendered by
/// `db.query(KnowledgeDocument)`.
const DOCUMENT_COLUMNS: &str = "knowledge_documents.id AS knowledge_documents_id, \
     knowledge_documents.kind_id AS knowledge_documents_kind_id, \
     knowledge_documents.attachment_id AS knowledge_documents_attachment_id, \
     knowledge_documents.name AS knowledge_documents_name, \
     knowledge_documents.file_extension AS knowledge_documents_file_extension, \
     knowledge_documents.file_size AS knowledge_documents_file_size, \
     knowledge_documents.status AS knowledge_documents_status, \
     knowledge_documents.user_id AS knowledge_documents_user_id, \
     knowledge_documents.is_active AS knowledge_documents_is_active, \
     knowledge_documents.index_status AS knowledge_documents_index_status, \
     knowledge_documents.index_generation AS knowledge_documents_index_generation, \
     knowledge_documents.splitter_config AS knowledge_documents_splitter_config, \
     knowledge_documents.source_type AS knowledge_documents_source_type, \
     knowledge_documents.source_config AS knowledge_documents_source_config, \
     knowledge_documents.origin AS knowledge_documents_origin, \
     knowledge_documents.folder_id AS knowledge_documents_folder_id, \
     knowledge_documents.summary AS knowledge_documents_summary, \
     knowledge_documents.chunks AS knowledge_documents_chunks, \
     knowledge_documents.created_at AS knowledge_documents_created_at, \
     knowledge_documents.updated_at AS knowledge_documents_updated_at";

/// `knowledge_document_external_sources` columns.
const EXTERNAL_SOURCE_COLUMNS: &str = "knowledge_document_external_sources.document_id \
     AS knowledge_document_external_sources_document_id, \
     knowledge_document_external_sources.kind_id \
     AS knowledge_document_external_sources_kind_id, \
     knowledge_document_external_sources.external_provider \
     AS knowledge_document_external_sources_external_provider, \
     knowledge_document_external_sources.external_resource_id \
     AS knowledge_document_external_sources_external_resource_id";

/// `subtask_contexts` columns as rendered by `db.query(SubtaskContext)`.
const SUBTASK_CONTEXT_COLUMNS: &str = "subtask_contexts.id AS subtask_contexts_id, \
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

/// One `knowledge_documents` row.
#[derive(Debug, FromMysqlRow)]
pub struct DocumentRow {
    pub knowledge_documents_id: i64,
    pub knowledge_documents_kind_id: i64,
    pub knowledge_documents_attachment_id: i64,
    #[allow(dead_code)]
    pub knowledge_documents_name: String,
    #[allow(dead_code)]
    pub knowledge_documents_file_extension: String,
    #[allow(dead_code)]
    pub knowledge_documents_file_size: i64,
    #[allow(dead_code)]
    pub knowledge_documents_status: String,
    #[allow(dead_code)]
    pub knowledge_documents_user_id: i64,
    #[allow(dead_code)]
    pub knowledge_documents_is_active: i8,
    pub knowledge_documents_index_status: String,
    #[allow(dead_code)]
    pub knowledge_documents_index_generation: i64,
    #[allow(dead_code)]
    pub knowledge_documents_splitter_config: Option<Json<crate::json_compat::OpaqueJson>>,
    pub knowledge_documents_source_type: String,
    knowledge_documents_source_config: Option<Json<JsonProjection<SourceConfig>>>,
    #[allow(dead_code)]
    pub knowledge_documents_origin: String,
    #[allow(dead_code)]
    pub knowledge_documents_folder_id: i64,
    #[allow(dead_code)]
    pub knowledge_documents_summary: Option<Json<crate::json_compat::OpaqueJson>>,
    #[allow(dead_code)]
    pub knowledge_documents_chunks: Option<Json<crate::json_compat::OpaqueJson>>,
    #[allow(dead_code)]
    pub knowledge_documents_created_at: Option<chrono::NaiveDateTime>,
    #[allow(dead_code)]
    pub knowledge_documents_updated_at: Option<chrono::NaiveDateTime>,
}

impl DocumentRow {
    /// `KnowledgeDocument.converted_attachment_id`: the integer stored under
    /// `source_config.converted_attachment_id`, when present.
    pub fn converted_attachment_id(&self) -> Option<i64> {
        self.knowledge_documents_source_config
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .and_then(|config| config.converted_attachment_id)
    }
}

/// One `subtask_contexts` row (attachment context). Only the read path's
/// consumed fields are non-`dead_code`.
#[derive(Debug, FromMysqlRow)]
pub struct SubtaskContextRow {
    pub subtask_contexts_id: i64,
    #[allow(dead_code)]
    pub subtask_contexts_subtask_id: i64,
    #[allow(dead_code)]
    pub subtask_contexts_user_id: i32,
    #[allow(dead_code)]
    pub subtask_contexts_context_type: String,
    #[allow(dead_code)]
    pub subtask_contexts_name: String,
    #[allow(dead_code)]
    pub subtask_contexts_status: String,
    #[allow(dead_code)]
    pub subtask_contexts_error_message: String,
    #[allow(dead_code)]
    pub subtask_contexts_binary_data: Vec<u8>,
    #[allow(dead_code)]
    pub subtask_contexts_image_base64: String,
    subtask_contexts_extracted_text: Option<String>,
    #[allow(dead_code)]
    pub subtask_contexts_text_length: i32,
    subtask_contexts_type_data: Option<Json<JsonProjection<ContextMetadata>>>,
    #[allow(dead_code)]
    pub subtask_contexts_created_at: Option<chrono::NaiveDateTime>,
    #[allow(dead_code)]
    pub subtask_contexts_updated_at: Option<chrono::NaiveDateTime>,
}

impl SubtaskContextRow {
    /// `extracted_text` (model default `""`).
    pub fn extracted_text(&self) -> &str {
        self.subtask_contexts_extracted_text
            .as_deref()
            .unwrap_or("")
    }

    fn file_extension(&self) -> &str {
        self.subtask_contexts_type_data
            .as_ref()
            .and_then(|json| json.0.value.as_ref())
            .and_then(|data| data.file_extension.as_deref())
            .unwrap_or("")
    }

    /// `context_service.is_video_context`: an attachment whose
    /// `file_extension` (lowercased) is one of the six video extensions.
    pub fn is_video_context(&self) -> bool {
        matches!(
            self.file_extension().to_ascii_lowercase().as_str(),
            ".mp4" | ".avi" | ".mkv" | ".mov" | ".flv" | ".wmv"
        )
    }
}

/// `_resolve_source_media_type`: `"video"` for video attachments, `None`
/// otherwise (including a missing attachment).
pub fn source_media_type(attachment: Option<&SubtaskContextRow>) -> Option<String> {
    attachment
        .filter(|row| row.is_video_context())
        .map(|_| "video".to_string())
}

/// The single-document load of `_get_document_with_access_or_raise`
/// (`db.query(KnowledgeDocument).filter(id).first()`), followed by the
/// `selectin` external-source load the ORM performs for the loaded row.
pub async fn document_by_id<M>(mysql: &M, document_id: i64) -> MysqlResult<Option<DocumentRow>>
where
    M: Mysql,
{
    let row: Option<DocumentRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT {DOCUMENT_COLUMNS} \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.id = {document_id} \n LIMIT 1"
            ),
            (),
        )
        .await?;
    let document = row;
    // `lazy="selectin"`: the external-source identity loads with the
    // document. The content read itself never consumes it.
    external_sources_by_document_ids(mysql, &[document_id]).await?;
    Ok(document)
}

/// `DocumentReadService._load_documents`
/// (`id.in_(document_ids)` bulk load). `ids` keeps the caller's order.
pub async fn documents_by_ids<M>(mysql: &M, document_ids: &[i64]) -> MysqlResult<Vec<DocumentRow>>
where
    M: Mysql,
{
    if document_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = document_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let rows: Vec<DocumentRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {DOCUMENT_COLUMNS} \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.id IN ({ids})"
            ),
            (),
        )
        .await?;
    // The `selectin` external-source load for every bulk-loaded document.
    external_sources_by_document_ids(mysql, document_ids).await?;
    Ok(rows)
}

/// The `selectin` external-source load (`external_source` relationship).
async fn external_sources_by_document_ids<M>(mysql: &M, document_ids: &[i64]) -> MysqlResult<()>
where
    M: Mysql,
{
    if document_ids.is_empty() {
        return Ok(());
    }
    let ids = document_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[allow(dead_code)]
        knowledge_document_external_sources_document_id: i64,
    }
    let _rows: Vec<Row> = mysql
        .fetch_all(
            &format!(
                "SELECT {EXTERNAL_SOURCE_COLUMNS} \n\
                 FROM knowledge_document_external_sources \n\
                 WHERE knowledge_document_external_sources.document_id IN ({ids})"
            ),
            (),
        )
        .await?;
    Ok(())
}

/// `_load_attachment_contexts`: bulk `subtask_contexts` load restricted to
/// attachment contexts. `ids` keeps the caller's order; the read only needs
/// per-id lookup, so the row order is not observable.
pub async fn attachment_contexts<M>(
    mysql: &M,
    attachment_ids: &[i64],
) -> MysqlResult<Vec<SubtaskContextRow>>
where
    M: Mysql,
{
    if attachment_ids.is_empty() {
        return Ok(Vec::new());
    }
    let ids = attachment_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    mysql
        .fetch_all(
            &format!(
                "SELECT {SUBTASK_CONTEXT_COLUMNS} \nFROM subtask_contexts \n\
                 WHERE subtask_contexts.id IN ({ids}) \
                 AND subtask_contexts.context_type = 'attachment'"
            ),
            (),
        )
        .await
}

/// `_build_document_result` pagination: character slicing of the extracted
/// text with `min(offset, total)` clamping, returning
/// `(content, total_length, actual_start, returned_length, has_more)`.
pub fn page_content(full_content: &str, offset: i64, limit: i64) -> (String, i64, i64, i64, bool) {
    // Python indexes by Unicode code points; Rust `chars()` matches that
    // counting and slicing for text stored as valid UTF-8.
    let total_length = full_content.chars().count() as i64;
    let actual_start = offset.min(total_length).max(0) as usize;
    let end = ((actual_start as i64) + limit).min(total_length) as usize;
    let content: String = full_content
        .chars()
        .skip(actual_start)
        .take(end - actual_start)
        .collect();
    let returned_length = content.chars().count() as i64;
    let has_more = (actual_start as i64 + returned_length) < total_length;
    (
        content,
        total_length,
        actual_start as i64,
        returned_length,
        has_more,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pagination_matches_python_slicing() {
        let text = "abcdef".repeat(40_000); // 240000 chars
        let (content, total, start, returned, has_more) = page_content(&text, 200_000, 100_000);
        assert_eq!(total, 240_000);
        assert_eq!(start, 200_000);
        assert_eq!(returned, 40_000);
        assert!(!has_more);
        assert!(content.starts_with(&text[200_000..200_010]));
    }

    #[test]
    fn pagination_clamps_offset_past_eof() {
        let (content, total, start, returned, has_more) = page_content("abc", 10, 5);
        assert_eq!(
            (content.as_str(), total, start, returned, has_more),
            ("", 3, 3, 0, false)
        );
    }

    #[test]
    fn pagination_reports_has_more() {
        let (_, _, _, returned, has_more) = page_content("abcdef", 0, 3);
        assert_eq!((returned, has_more), (3, true));
    }

    #[test]
    fn pagination_counts_unicode_code_points() {
        let text = "你好世界"; // 4 code points, 12 UTF-8 bytes
        let (content, total, _, returned, _) = page_content(text, 1, 2);
        assert_eq!(total, 4);
        assert_eq!(returned, 2);
        assert_eq!(content, "好世");
    }

    #[test]
    fn empty_attachment_reads_as_empty_content() {
        let (content, total, _, returned, has_more) = page_content("", 0, 100);
        assert_eq!(
            (content.as_str(), total, returned, has_more),
            ("", 0, 0, false)
        );
    }

    #[test]
    fn video_extensions_classify_media_type() {
        let row = |ext: &str| SubtaskContextRow {
            subtask_contexts_id: 1,
            subtask_contexts_subtask_id: 0,
            subtask_contexts_user_id: 1,
            subtask_contexts_context_type: "attachment".to_string(),
            subtask_contexts_name: "v".to_string(),
            subtask_contexts_status: "ready".to_string(),
            subtask_contexts_error_message: String::new(),
            subtask_contexts_binary_data: Vec::new(),
            subtask_contexts_image_base64: String::new(),
            subtask_contexts_extracted_text: None,
            subtask_contexts_text_length: 0,
            subtask_contexts_type_data: Some(Json(
                serde_json::json!({
                    "file_extension": ext
                })
                .into(),
            )),
            subtask_contexts_created_at: None,
            subtask_contexts_updated_at: None,
        };
        assert_eq!(
            source_media_type(Some(&row(".mp4"))).as_deref(),
            Some("video")
        );
        assert_eq!(
            source_media_type(Some(&row(".MP4"))).as_deref(),
            Some("video")
        );
        assert_eq!(source_media_type(Some(&row(".json"))), None);
        assert_eq!(source_media_type(None), None);
        assert_eq!(source_media_type(Some(&row(""))), None);
    }

    #[test]
    fn converted_attachment_id_reads_source_config() {
        let row = |config: Value| DocumentRow {
            knowledge_documents_id: 1,
            knowledge_documents_kind_id: 2,
            knowledge_documents_attachment_id: 3,
            knowledge_documents_name: "n".to_string(),
            knowledge_documents_file_extension: "json".to_string(),
            knowledge_documents_file_size: 0,
            knowledge_documents_status: "enabled".to_string(),
            knowledge_documents_user_id: 8,
            knowledge_documents_is_active: 1,
            knowledge_documents_index_status: "success".to_string(),
            knowledge_documents_index_generation: 1,
            knowledge_documents_splitter_config: None,
            knowledge_documents_source_type: "file".to_string(),
            knowledge_documents_source_config: Some(Json(config.into())),
            knowledge_documents_origin: "user".to_string(),
            knowledge_documents_folder_id: 0,
            knowledge_documents_summary: None,
            knowledge_documents_chunks: None,
            knowledge_documents_created_at: None,
            knowledge_documents_updated_at: None,
        };
        assert_eq!(
            row(serde_json::json!({"converted_attachment_id": 42})).converted_attachment_id(),
            Some(42)
        );
        assert_eq!(row(serde_json::json!({})).converted_attachment_id(), None);
        assert_eq!(row(Value::Null).converted_attachment_id(), None);
    }
}
