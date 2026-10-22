// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `PUT /api/knowledge/documents/{document_id}/content` — replace a document's
//! text content and re-index
//! (`app.api_endpoints.knowledge_open.update_document_content_open`).
//!
//! Source pipeline:
//! 1. `security.get_auth_context` — API-key authentication (`auth.rs`);
//! 2. `KnowledgeOrchestrator.update_document_content` ->
//!    `KnowledgeService.update_document_content`: document load with access
//!    validation, mutability/source-type gates, the document-scoped manage
//!    check, then `context_service.overwrite_attachment_internal`
//!    (`attachments::upload::overwrite`) with the document's `file_size`
//!    written in the same transaction, and `db.refresh(document)`;
//! 3. the converted-attachment reference is dropped when the row still points
//!    at one (the stored content is stale after an overwrite);
//! 4. `KnowledgeService.get_knowledge_base` again, then
//!    `_schedule_indexing_celery`: `prepare_document_index_enqueue` advances
//!    `index_generation` and queues the document (`update_store`);
//! 5. the response is `DocumentContentUpdateResponse`.

use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};

use super::reader::{self, DocumentRow};
use super::update_store::{self, DocumentColumns};
use super::{ApiFailure, KnowledgeError, access};
use crate::attachments::upload::{OverwriteError, overwrite_attachment_internal};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `content_scope.GENERATED_CONTENT_READ_ONLY_MESSAGE`.
const GENERATED_CONTENT_READ_ONLY_MESSAGE: &str = "Generated Code Wiki content is read-only";

/// `DocumentContentUpdate.content`: `min_length=1`, `max_length=500000`.
const CONTENT_MAX_LENGTH: usize = 500_000;

/// `KnowledgeService.update_document_content`'s `editable_extensions`.
const EDITABLE_EXTENSIONS: [&str; 60] = [
    "adoc",
    "asciidoc",
    "asm",
    "bat",
    "c",
    "cc",
    "cpp",
    "css",
    "csv",
    "conf",
    "config",
    "dart",
    "env",
    "go",
    "gradle",
    "groovy",
    "h",
    "html",
    "ini",
    "java",
    "js",
    "json",
    "jsx",
    "kotlin",
    "less",
    "license",
    "log",
    "lua",
    "markdown",
    "md",
    "mjs",
    "php",
    "pl",
    "properties",
    "ps1",
    "py",
    "rb",
    "readme",
    "rst",
    "rust",
    "sass",
    "scala",
    "scss",
    "sh",
    "sql",
    "srt",
    "styl",
    "svg",
    "swift",
    "textile",
    "toml",
    "ts",
    "tsx",
    "tsv",
    "txt",
    "vue",
    "wiki",
    "xml",
    "yaml",
    "yml",
];

/// The response schema (`DocumentContentUpdateResponse`); field order matches
/// the pydantic model's serialization order.
#[derive(Debug, Serialize)]
struct DocumentContentUpdateResponse {
    success: bool,
    document_id: i64,
    message: String,
}

/// `PUT /api/knowledge/documents/{document_id}/content`.
#[brz_http_server::put("/api/knowledge/documents/:document_id/content")]
async fn put_document_content(
    #[inject(state)] state: &Arc<AppState>,
    document_id: &str,
    body: Value,
    #[auth] user: super::auth::KnowledgeUser,
) -> Result<DocumentContentUpdateResponse, KnowledgeError> {
    // FastAPI binds the path and the `DocumentContentUpdate` body before the
    // endpoint body runs; invalid values surface as 422.
    let Ok(document_id) = document_id.parse::<i64>() else {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "int_parsing",
            "loc": ["path", "document_id"],
            "msg": "Input should be a valid integer, unable to parse string as an integer",
            "input": document_id,
        }]))
        .into());
    };
    let content = decode_update_body(&body)?;

    let document_id = update_document_content(state, &content, document_id, user.id)
        .await
        .map_err(KnowledgeError::Failure)?;
    Ok(DocumentContentUpdateResponse {
        success: true,
        document_id,
        message: "Document content updated successfully".to_string(),
    })
}

/// `DocumentContentUpdate` pydantic validation: `content` is a required string
/// of 1..=500000 characters.
fn decode_update_body(body: &Value) -> Result<String, KnowledgeError> {
    let Some(object) = body.as_object() else {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "model_type",
            "loc": ["body"],
            "msg": "Input should be a valid dictionary or object to extract fields from",
        }]))
        .into());
    };
    let Some(content) = object.get("content") else {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "missing",
            "loc": ["body", "content"],
            "msg": "Field required",
        }]))
        .into());
    };
    let Some(text) = content.as_str() else {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "string_type",
            "loc": ["body", "content"],
            "msg": "Input should be a valid string",
            "input": content,
        }]))
        .into());
    };
    if text.is_empty() {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "string_too_short",
            "loc": ["body", "content"],
            "msg": "String should have at least 1 character",
            "input": text,
        }]))
        .into());
    }
    if text.chars().count() > CONTENT_MAX_LENGTH {
        return Err(FastApiError::validation(serde_json::json!([{
            "type": "string_too_long",
            "loc": ["body", "content"],
            "msg": format!("String should have at most {CONTENT_MAX_LENGTH} characters"),
            "input": text,
        }]))
        .into());
    }
    Ok(text.to_string())
}

/// `KnowledgeOrchestrator.update_document_content`: overwrite the content,
/// drop a stale converted-attachment reference, then schedule re-indexing.
async fn update_document_content(
    state: &Arc<AppState>,
    content: &str,
    document_id: i64,
    user_id: i64,
) -> Result<i64, ApiFailure> {
    let Some(document) = write_document_content(state, content, document_id, user_id).await? else {
        return Err(ApiFailure::from_value_error(
            "Document not found or access denied",
        ));
    };

    // The stored content changed, so any converted attachment is stale: the
    // source drops the reference unconditionally and leaves the physical
    // attachment as an orphan for separate cleanup.
    if let Some(converted_id) = document.converted_attachment_id() {
        clear_converted_attachment(state, &document, converted_id).await?;
    }

    let knowledge_base =
        access::knowledge_base_record(&state.mysql, document.knowledge_documents_kind_id)
            .await
            .map_err(internal_failure)?;
    let has_access = match &knowledge_base {
        Some(kb) => {
            access::knowledge_base_access(
                &state.mysql,
                state.redis.as_ref(),
                &state.entity_resolvers,
                kb,
                user_id,
            )
            .await?
        }
        None => false,
    };
    if let Some(kb) = knowledge_base.filter(|_| has_access) {
        schedule_indexing(state, &kb, &document, user_id).await?;
    }
    Ok(document.knowledge_documents_id)
}

/// `KnowledgeService.get_document`: the document load plus its first
/// `get_knowledge_base` access check.
async fn authorized_document(
    state: &Arc<AppState>,
    document_id: i64,
    user_id: i64,
) -> Result<Option<DocumentRow>, ApiFailure> {
    let document = reader::document_by_id(&state.mysql, document_id)
        .await
        .map_err(internal_failure)?;
    let Some(document) = document else {
        return Ok(None);
    };
    let Some(kb) =
        access::knowledge_base_record(&state.mysql, document.knowledge_documents_kind_id)
            .await
            .map_err(internal_failure)?
    else {
        return Ok(None);
    };
    let has_access = access::knowledge_base_access(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        &kb,
        user_id,
    )
    .await?;
    if !has_access {
        return Ok(None);
    }
    Ok(Some(document))
}

/// `KnowledgeService.update_document_content`: the mutability and source-type
/// gates, the document-scoped manage check, and the attachment overwrite.
async fn write_document_content(
    state: &Arc<AppState>,
    content: &str,
    document_id: i64,
    user_id: i64,
) -> Result<Option<DocumentRow>, ApiFailure> {
    let Some(document) = authorized_document(state, document_id, user_id).await? else {
        return Ok(None);
    };

    // `assert_user_content_is_mutable`.
    if document.knowledge_documents_origin == "generated" {
        return Err(ApiFailure::from_value_error(
            GENERATED_CONTENT_READ_ONLY_MESSAGE,
        ));
    }
    // Externally imported bodies are read-only: the provider owns the content.
    if document.knowledge_documents_source_type == "external" {
        return Err(ApiFailure::from_value_error(
            "Externally imported document content is read-only; delete it and import a fresh copy",
        ));
    }

    let source_type = document.knowledge_documents_source_type.as_str();
    // Python short-circuits, so an empty `file_extension` only raises for a
    // `file` document.
    let is_editable_file = source_type == "file" && {
        let extension = normalize_document_extension(&document.knowledge_documents_file_extension)?;
        EDITABLE_EXTENSIONS.contains(&extension.as_str())
    };
    if !(source_type == "text" || is_editable_file) {
        return Err(ApiFailure::from_value_error(
            "Only TEXT type documents or plain text files (txt, md) can be edited",
        ));
    }

    // The document's own KB lookup, distinct from the permission lookup's
    // `is_active` predicate.
    let kb = access::document_kb_record(&state.mysql, document.knowledge_documents_kind_id)
        .await
        .map_err(internal_failure)?;
    if kb.is_none() {
        return Err(ApiFailure::from_value_error(
            "Knowledge base not found for document",
        ));
    }
    // `_assert_can_manage_document` -> `can_manage_knowledge_document`, which
    // resolves the permission without a preloaded record.
    let can_manage = access::can_manage_knowledge_base_documents(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        document.knowledge_documents_kind_id,
        user_id,
    )
    .await
    .map_err(internal_failure)?;
    if !can_manage {
        return Err(ApiFailure::from_value_error(
            "You do not have permission to manage this document in this knowledge base",
        ));
    }

    if document.knowledge_documents_attachment_id == 0 {
        return Err(ApiFailure::from_value_error(
            "Document has no attachment to update",
        ));
    }
    let Some(context) =
        reader::context_by_id(&state.mysql, document.knowledge_documents_attachment_id)
            .await
            .map_err(internal_failure)?
    else {
        return Err(ApiFailure::from_value_error(
            "Document attachment not found",
        ));
    };

    let binary_content = content.as_bytes();
    let filename = match context.original_filename() {
        name if !name.is_empty() => name,
        _ => build_attachment_filename(
            &document.knowledge_documents_name,
            &document.knowledge_documents_file_extension,
        ),
    };

    // `doc.file_size = len(binary_content)`: the source's first `db.flush()`
    // writes it with the attachment reset, in one transaction.
    let mut flushed = DocumentColumns::of(&document);
    let mut columns = flushed.clone();
    columns.file_size = binary_content.len() as i64;

    // `context_service.overwrite_attachment_internal` (trusted internal path:
    // no owner filter; the manage check above already authorized the write).
    overwrite_attachment_internal(
        state,
        None,
        document.knowledge_documents_attachment_id,
        &filename,
        binary_content,
        &Map::new(),
        columns.preflush(&mut flushed, document_id),
    )
    .await
    .map_err(overwrite_failure)?;

    // `db.refresh(doc)`.
    reader::refresh_document(&state.mysql, document_id)
        .await
        .map_err(internal_failure)?;
    Ok(Some(document))
}

/// The overwrite stage's `ValueError` classes reach the endpoint's
/// `except ValueError`; the knowledge path does not catch
/// `DocumentParseError`, so it falls through to the application's generic 500.
fn overwrite_failure(error: OverwriteError) -> ApiFailure {
    match error.into_detail() {
        Some(error) => ApiFailure::new(
            error.status(),
            error
                .detail_message()
                .unwrap_or("Internal Server Error")
                .to_string(),
        ),
        None => internal_failure("document parsing failed"),
    }
}

/// Drop the stale converted-attachment reference
/// (`document.converted_attachment_id = None; db.commit()`).
///
/// The source then calls `context_service.delete_context` best-effort; the
/// physical attachment therefore stays as an orphan until the deployment's
/// own attachment cleanup runs.
async fn clear_converted_attachment(
    state: &Arc<AppState>,
    document: &DocumentRow,
    converted_id: i64,
) -> Result<(), ApiFailure> {
    let Some(mut source_config) = document.source_config_map() else {
        return Ok(());
    };
    if source_config.remove("converted_attachment_id").is_none() {
        return Ok(());
    }
    let rendered = crate::json_compat::python_json_value(&Value::Object(source_config));
    state
        .mysql
        .execute(
            "UPDATE knowledge_documents SET source_config=?, updated_at=now() \
             WHERE knowledge_documents.id = ?",
            (rendered, document.knowledge_documents_id),
        )
        .await
        .map_err(internal_failure)?;
    tracing::warn!(
        document_id = document.knowledge_documents_id,
        converted_attachment_id = converted_id,
        "stale converted attachment reference cleared"
    );
    Ok(())
}

/// `_schedule_indexing_celery`: advance the indexing generation and queue the
/// document.
async fn schedule_indexing(
    state: &Arc<AppState>,
    knowledge_base: &access::KnowledgeBase,
    document: &DocumentRow,
    user_id: i64,
) -> Result<(), ApiFailure> {
    // The retrieval-config gate: a KB without a complete RAG configuration is
    // not scheduled.
    let spec = knowledge_base
        .kinds_json
        .decode::<Value>()
        .ok()
        .and_then(|value| value.get("spec").cloned())
        .unwrap_or(Value::Null);
    let Some(retrieval) = spec.get("retrievalConfig").filter(|value| !value.is_null()) else {
        return Ok(());
    };
    let Some(retriever_name) = retrieval
        .get("retriever_name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let Some(embedding) = retrieval
        .get("embedding_config")
        .filter(|value| !value.is_null())
    else {
        return Ok(());
    };
    let Some(embedding_model_name) = embedding
        .get("model_name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };

    // `get_kb_index_info_by_record` reads the loaded record only: the index
    // owner is the persisted knowledge-base owner, not the caller.
    let index_owner_user_id = knowledge_base.kinds_user_id;
    // `_schedule_indexing_celery` reads `user.user_name` while it builds the
    // task kwargs, which reloads the instance the overwrite commit expired.
    let Some(user_name) = update_store::refresh_user_name(&state.mysql, user_id)
        .await
        .map_err(internal_failure)?
    else {
        return Err(internal_failure(format!("user {user_id} not found")));
    };

    let decision =
        update_store::prepare_index_enqueue(&state.mysql, document.knowledge_documents_id)
            .await
            .map_err(internal_failure)?;
    if !decision.should_enqueue {
        tracing::info!(
            document_id = document.knowledge_documents_id,
            reason = decision.reason,
            "skipping knowledge index enqueue"
        );
        return Ok(());
    }

    // The source dispatches the Celery task here
    // (`index_document_task.delay(...)`, published on the `wegent_online`
    // queue). The broker publish is not migrated: see the work item's
    // capability-gap report. The generation has already advanced, so a later
    // dispatch re-uses this generation.
    tracing::warn!(
        document_id = document.knowledge_documents_id,
        attachment_id = document.knowledge_documents_attachment_id,
        knowledge_base_id = knowledge_base.kinds_id,
        index_generation = decision.generation.unwrap_or_default(),
        index_owner_user_id,
        user_name = %user_name,
        retriever_name,
        embedding_model_name,
        "knowledge index dispatch is not migrated: no re-index task was enqueued"
    );
    Ok(())
}

/// `shared.knowledge_module.normalize_document_extension`: the bare, lower-case
/// extension. An empty extension is the source `KnowledgeDocumentError`
/// (`ValueError`).
fn normalize_document_extension(file_extension: &str) -> Result<String, ApiFailure> {
    let normalized = file_extension.trim_start_matches('.').trim().to_lowercase();
    if normalized.is_empty() {
        return Err(ApiFailure::from_value_error("file_extension is required"));
    }
    Ok(normalized)
}

/// `knowledge_service._build_attachment_filename`.
fn build_attachment_filename(name: &str, file_extension: &str) -> String {
    let normalized = file_extension.trim().trim_start_matches('.');
    if normalized.is_empty() {
        return name.to_string();
    }
    let suffix = format!(".{normalized}");
    if name.to_lowercase().ends_with(&suffix.to_lowercase()) {
        return name.to_string();
    }
    format!("{name}{suffix}")
}

/// Keep the endpoint's error category for dependency failures
/// (`python_exception_handler` renders the 500 body).
fn internal_failure(error: impl std::fmt::Display) -> ApiFailure {
    tracing::error!(%error, "knowledge content update dependency failed");
    ApiFailure::internal("Internal Server Error")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editable_extension_gate_matches_source() {
        assert!(EDITABLE_EXTENSIONS.contains(&"md"));
        assert!(EDITABLE_EXTENSIONS.contains(&"txt"));
        // The source list holds bare extensions, so a dotted value never
        // matches (only a `file` document is checked by extension anyway).
        assert!(!EDITABLE_EXTENSIONS.contains(&".md"));
        assert!(!EDITABLE_EXTENSIONS.contains(&"pdf"));
    }

    #[test]
    fn normalize_document_extension_strips_dots_and_case() {
        assert_eq!(normalize_document_extension(".MD").unwrap(), "md");
        assert_eq!(normalize_document_extension(" txt ").unwrap(), "txt");
        assert!(normalize_document_extension("").is_err());
        assert!(normalize_document_extension("...").is_err());
    }

    #[test]
    fn attachment_filename_matches_source() {
        assert_eq!(build_attachment_filename("notes", "md"), "notes.md");
        assert_eq!(build_attachment_filename("notes.md", "md"), "notes.md");
        assert_eq!(build_attachment_filename("notes", ".md"), "notes.md");
        assert_eq!(build_attachment_filename("notes", ""), "notes");
    }

    #[test]
    fn body_validation_requires_a_non_empty_content_string() {
        assert!(decode_update_body(&serde_json::json!({"content": "x"})).is_ok());
        assert!(decode_update_body(&serde_json::json!({"content": ""})).is_err());
        assert!(decode_update_body(&serde_json::json!({"content": 1})).is_err());
        assert!(decode_update_body(&serde_json::json!({})).is_err());
        assert!(decode_update_body(&serde_json::json!("text")).is_err());
        let long = "a".repeat(CONTENT_MAX_LENGTH + 1);
        assert!(decode_update_body(&serde_json::json!({"content": long})).is_err());
    }
}
