// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Knowledge-document download policy for attachment binary exits
//! (`app/services/knowledge/attachment_download_policy.py:
//! require_attachment_download_allowed`).
//!
//! The source handler runs this policy before any storage access: it probes
//! `knowledge_documents` by `attachment_id` (ordered by `id`, first row —
//! the recorded statement selects the full column list), and when the
//! attachment is linked to a document it loads the owning active
//! `KnowledgeBase` `Kind` and rejects the download when the knowledge base
//! explicitly sets `spec.allowDocumentDownload = false`
//! (`document_download_policy.require_document_download_allowed`; no
//! deployment resolver is installed, so the open-source default applies).
//!
//! The error is the FastAPI 403 body
//! `{"detail": {"code": "DOCUMENT_DOWNLOAD_DISABLED",
//! "message": "Document download is disabled"}}`.

use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};

/// The download purpose an attachment exit passes to the policy
/// (`AttachmentAccessPurpose`).
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Purpose {
    Download,
    Playback,
    Executor,
    Share,
}

/// `require_attachment_download_allowed`: `None` when the download may
/// proceed, `Some(error)` when the knowledge base protects its originals.
/// MySQL failures propagate to the caller (the source raises an unhandled
/// 500).
pub(super) async fn require_attachment_download_allowed<M>(
    mysql: &M,
    attachment_id: i64,
    mime_type: &str,
    purpose: Purpose,
) -> MysqlResult<Option<FastApiError>>
where
    M: Mysql,
{
    let document: Option<DocumentRow> = mysql
        .fetch_optional(DOCUMENT_BY_ATTACHMENT_QUERY, (attachment_id,))
        .await?;
    let Some(document) = document else {
        return Ok(None);
    };
    // `purpose == "playback" and normalized_mime_type.startswith(
    //  ("image/", "video/"))`: only playback exempts media originals.
    if purpose == Purpose::Playback && playback_exempt(mime_type) {
        return Ok(None);
    }
    let knowledge_base: Option<KnowledgeBaseRow> = mysql
        .fetch_optional(ACTIVE_KNOWLEDGE_BASE_QUERY, (document.kind_id,))
        .await?;
    let Some(knowledge_base) = knowledge_base else {
        return Ok(None);
    };
    if original_download_allowed(&knowledge_base.kinds_json.0) {
        return Ok(None);
    }
    Ok(Some(download_disabled()))
}

/// `db.query(KnowledgeDocument).filter(
/// KnowledgeDocument.attachment_id == attachment_id).order_by(
/// KnowledgeDocument.id).first()` — the full labeled projection the source
/// statement selects; only `kind_id` is decoded.
const DOCUMENT_BY_ATTACHMENT_QUERY: &str = "SELECT knowledge_documents.id AS knowledge_documents_id, \
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
     knowledge_documents.updated_at AS knowledge_documents_updated_at \
     FROM knowledge_documents \
     WHERE knowledge_documents.attachment_id = ? ORDER BY knowledge_documents.id \
     LIMIT 1";

/// `db.query(Kind).filter(Kind.id == document.kind_id,
/// Kind.kind == "KnowledgeBase", Kind.is_active.is_(True)).first()` — the
/// full labeled projection; only `json` is decoded.
const ACTIVE_KNOWLEDGE_BASE_QUERY: &str = "SELECT kinds.id AS kinds_id, \
     kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, \
     kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, \
     kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, \
     kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \
     FROM kinds \
     WHERE kinds.id = ? AND kinds.kind = 'KnowledgeBase' AND kinds.is_active IS true \
     LIMIT 1";

/// The `knowledge_documents` policy probe (only the owning `kind_id` is
/// read).
#[derive(Debug, FromMysqlRow)]
struct DocumentRow {
    #[mysql(rename = "knowledge_documents_kind_id")]
    kind_id: i64,
}

/// The active `KnowledgeBase` `Kind` row (only the CRD `json` is read).
#[derive(Debug, FromMysqlRow)]
struct KnowledgeBaseRow {
    #[mysql(rename = "kinds_json")]
    kinds_json: Json<OpaqueJson>,
}

/// The `Kind` CRD payload: only the download-policy field is modeled; a
/// payload of any other shape falls back to the defaults.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct KnowledgeBaseJson {
    spec: Option<KnowledgeBaseSpec>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct KnowledgeBaseSpec {
    #[serde(rename = "allowDocumentDownload")]
    allow_document_download: Option<bool>,
}

/// `is_default_original_download_allowed`: a missing, null, or true
/// `spec.allowDocumentDownload` allows downloads; only an explicit false
/// protects the knowledge base.
fn original_download_allowed(kinds_json: &OpaqueJson) -> bool {
    !matches!(
        kinds_json
            .project::<KnowledgeBaseJson>()
            .and_then(|json| json.spec)
            .and_then(|spec| spec.allow_document_download),
        Some(false)
    )
}

/// The playback media exemption: `image/` or `video/` MIME prefixes.
fn playback_exempt(mime_type: &str) -> bool {
    let mime_type = mime_type.to_lowercase();
    mime_type.starts_with("image/") || mime_type.starts_with("video/")
}

/// `_require_attachment_download_allowed`'s 403 body for a
/// `DocumentDownloadDisabledError`.
fn download_disabled() -> FastApiError {
    #[derive(serde::Serialize)]
    struct Detail {
        code: &'static str,
        message: &'static str,
    }
    #[derive(serde::Serialize)]
    struct Body {
        detail: Detail,
    }
    FastApiError::json_body(
        StatusCode::FORBIDDEN,
        Body {
            detail: Detail {
                code: "DOCUMENT_DOWNLOAD_DISABLED",
                message: "Document download is disabled",
            },
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds_json(spec: Option<serde_json::Value>) -> OpaqueJson {
        let mut value = serde_json::json!({});
        if let Some(spec) = spec {
            value["spec"] = spec;
        }
        OpaqueJson::from(value)
    }

    #[test]
    fn only_explicit_false_disables_downloads() {
        // Missing spec, missing/null/true flags, and non-boolean values all
        // allow the download (`is not False`).
        assert!(original_download_allowed(&kinds_json(None)));
        assert!(original_download_allowed(&kinds_json(Some(
            serde_json::json!({})
        ))));
        assert!(original_download_allowed(&kinds_json(Some(
            serde_json::json!({"allowDocumentDownload": null})
        ))));
        assert!(original_download_allowed(&kinds_json(Some(
            serde_json::json!({"allowDocumentDownload": true})
        ))));
        assert!(original_download_allowed(&kinds_json(Some(
            serde_json::json!({"allowDocumentDownload": "false"})
        ))));
        assert!(!original_download_allowed(&kinds_json(Some(
            serde_json::json!({"allowDocumentDownload": false})
        ))));
        // Unknown JSON shapes keep the permissive default.
        assert!(original_download_allowed(&OpaqueJson::from(
            serde_json::json!([1, 2])
        )));
    }

    #[test]
    fn playback_exempts_media_mimes_only() {
        assert!(playback_exempt("Image/PNG"));
        assert!(playback_exempt("video/mp4"));
        assert!(!playback_exempt("application/pdf"));
        assert!(!playback_exempt(""));
    }

    /// The recorded statement (case 4d6183d6, attachment 1300614) with the
    /// inline literal swapped for the bound parameter: the target SQL must
    /// stay token-identical after whitespace normalization.
    #[test]
    fn document_query_matches_the_recorded_statement() {
        let recorded = "SELECT knowledge_documents.id AS knowledge_documents_id, knowledge_documents.kind_id AS knowledge_documents_kind_id, knowledge_documents.attachment_id AS knowledge_documents_attachment_id, knowledge_documents.name AS knowledge_documents_name, knowledge_documents.file_extension AS knowledge_documents_file_extension, knowledge_documents.file_size AS knowledge_documents_file_size, knowledge_documents.status AS knowledge_documents_status, knowledge_documents.user_id AS knowledge_documents_user_id, knowledge_documents.is_active AS knowledge_documents_is_active, knowledge_documents.index_status AS knowledge_documents_index_status, knowledge_documents.index_generation AS knowledge_documents_index_generation, knowledge_documents.splitter_config AS knowledge_documents_splitter_config, knowledge_documents.source_type AS knowledge_documents_source_type, knowledge_documents.source_config AS knowledge_documents_source_config, knowledge_documents.origin AS knowledge_documents_origin, knowledge_documents.folder_id AS knowledge_documents_folder_id, knowledge_documents.summary AS knowledge_documents_summary, knowledge_documents.chunks AS knowledge_documents_chunks, knowledge_documents.created_at AS knowledge_documents_created_at, knowledge_documents.updated_at AS knowledge_documents_updated_at \nFROM knowledge_documents \nWHERE knowledge_documents.attachment_id = 1300614 ORDER BY knowledge_documents.id \n LIMIT 1";
        fn tokens(sql: &str) -> Vec<String> {
            sql.split_whitespace()
                .map(|token| {
                    if token == "1300614" {
                        "?".to_string()
                    } else {
                        token.to_string()
                    }
                })
                .collect()
        }
        assert_eq!(tokens(DOCUMENT_BY_ATTACHMENT_QUERY), tokens(recorded));
    }

    /// The `kinds` probe renders the `.is_(True)` filter the source emits
    /// for the active-KnowledgeBase lookup.
    #[test]
    fn knowledge_base_query_uses_is_true_filter() {
        assert!(ACTIVE_KNOWLEDGE_BASE_QUERY.contains(
            "WHERE kinds.id = ? AND kinds.kind = 'KnowledgeBase' \
             AND kinds.is_active IS true"
        ));
    }
}
