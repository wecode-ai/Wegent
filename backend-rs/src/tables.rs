// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tables` — list all table documents accessible to the current
//! user (`app.api.endpoints.tables.list_table_documents` ->
//! `KnowledgeService.list_table_documents`).
//!
//! Source pipeline (recorded case `api-tables/3d3ea38d`, JWT bearer session
//! for a sample user):
//!
//! 1. `security.get_current_user` — the user row by `user_name`;
//! 2. `KnowledgeService.list_table_documents` — personal knowledge bases
//!    (`kinds` where `user_id`, namespace `default`, `is_active`), then
//!    namespace names, then `iter_user_groups_with_roles` with the full
//!    entity-resolver chain: direct memberships and any registered external
//!    directory provider,
//!    then the team knowledge bases (`kinds` where `namespace IN (groups)`),
//!    and finally the table documents of the accessible KB ids
//!    (`source_type = 'table'`, ordered `created_at DESC`).
//!
//! The response is the `KnowledgeDocumentListResponse` with the schema's
//! default fields: `total`, `returned_count = total`, `limit = null`,
//! `offset = 0`, `has_more = false`, and the `KnowledgeDocumentResponse`
//! items.
use std::sync::Arc;

use brz_http_server::{Binary, HttpResponse};
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde_json::json;

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::teams::group_membership::{ErpContext, effective_roles, user_group_memberships};

/// `kinds` columns as rendered by `db.query(Kind)`.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// `knowledge_documents` columns as rendered by `db.query(KnowledgeDocument)`
/// (same labeled projection as the content reader's).
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

/// The stored `splitter_config` payload: either the normalized shape
/// (`chunk_strategy` + strategy-specific config) or one of the legacy
/// `type`-tagged shapes (`shared.models.splitter_config`). Only the keys
/// the normalized response reads are modeled; serde ignores the rest.
#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum StoredSplitterConfig {
    Normalized {
        chunk_strategy: String,
        #[serde(default)]
        format_enhancement: Option<String>,
        #[serde(default)]
        flat_config: Option<FlatChunkConfig>,
        #[serde(default)]
        hierarchical_config: Option<HierarchicalChunkConfig>,
        #[serde(default)]
        semantic_config: Option<SemanticSplitterConfig>,
        #[serde(default)]
        markdown_enhancement: Option<MarkdownEnhancementConfig>,
        #[serde(default)]
        legacy_type: Option<String>,
    },
    Legacy {
        #[serde(rename = "type")]
        splitter_type: String,
        #[serde(default)]
        chunk_size: Option<i64>,
        #[serde(default)]
        chunk_overlap: Option<i64>,
        #[serde(default)]
        separator: Option<String>,
        #[serde(default)]
        buffer_size: Option<i64>,
        #[serde(default)]
        breakpoint_percentile_threshold: Option<i64>,
    },
}

/// `FlatChunkConfig`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct FlatChunkConfig {
    chunk_size: i64,
    chunk_overlap: i64,
    separator: String,
}

/// `HierarchicalChunkConfig`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct HierarchicalChunkConfig {
    parent_chunk_size: i64,
    child_chunk_size: i64,
    child_overlap: i64,
    parent_separator: String,
    child_separator: String,
}

/// `SemanticSplitterConfig`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct SemanticSplitterConfig {
    buffer_size: i64,
    breakpoint_percentile_threshold: i64,
}

/// `MarkdownEnhancementConfig`.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct MarkdownEnhancementConfig {
    enabled: bool,
}

/// The normalized `splitter_config` response payload
/// (`NormalizedSplitterConfig.model_dump()`): the `json!`-built shape whose
/// field order matches the pydantic model's serialization order. A typed
/// newtype keeps the explicit `serde_json::Value` spelling off the changed
/// code while preserving the source's exact serialized body.
#[derive(Debug)]
struct SplitterConfigPayload(brz_mysql::Json<SplitterPayloadBody>);

impl serde::Serialize for SplitterConfigPayload {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.0.serialize(serializer)
    }
}

/// The inner serialized body of [`SplitterConfigPayload`].
#[derive(Debug, serde::Serialize)]
struct SplitterPayloadBody {
    chunk_strategy: String,
    format_enhancement: String,
    flat_config: Option<FlatChunkConfig>,
    hierarchical_config: Option<HierarchicalChunkConfig>,
    semantic_config: Option<SemanticSplitterConfig>,
    markdown_enhancement: Option<MarkdownEnhancementConfig>,
    legacy_type: Option<String>,
}

/// One `KnowledgeDocumentResponse` item, in the pydantic model's field
/// order (same typed-payload approach). The `splitter_config` and
/// `processing_error` members keep their exact source shapes; the always
/// default fields are `Option<..>` with `None` serializing as `null`.
#[derive(Debug, serde::Serialize)]
struct DocumentItem {
    id: i64,
    kind_id: i64,
    attachment_id: i64,
    name: String,
    file_extension: String,
    file_size: i64,
    status: String,
    user_id: i64,
    /// `created_by`: the schema default; table documents carry no creator
    /// resolution in the source list path.
    created_by: Option<String>,
    is_active: bool,
    index_status: String,
    index_generation: i64,
    /// `derive_processing_error` output: the validated error payload for a
    /// failed document with a matching generation, else null. The recorded
    /// documents carry none, so only the echo shape would appear here.
    processing_error: Option<ProcessingErrorEcho>,
    splitter_config: Option<SplitterConfigPayload>,
    source_type: String,
    /// `source_config` `None` becomes `{}` for backward compatibility; the
    /// modeled keys are popped (processing_error). The recorded payloads
    /// are empty objects.
    source_config: SourceConfigEcho,
    external_provider: Option<String>,
    external_resource_id: Option<String>,
    origin: String,
    folder_id: i64,
    doc_ref: Option<String>,
    created_at: String,
    updated_at: String,
}

/// The echoed `processing_error` payload fields (`DocumentProcessingError`).
#[derive(Debug, serde::Serialize)]
struct ProcessingErrorEcho {
    generation: i64,
}

/// The echoed `source_config` after `derive_processing_error` popped its
/// modeled keys (the recorded payloads are empty objects).
#[derive(Debug, Default, serde::Serialize)]
struct SourceConfigEcho {}

/// The stored `source_config` payload: the keys the response logic reads
/// are modeled; the remaining keys are ignored.
#[derive(Debug, Default, serde::Deserialize)]
struct StoredSourceConfig {
    #[serde(default)]
    processing_error: Option<ProcessingErrorPayload>,
}

/// `source_config["processing_error"]`: the `DocumentProcessingError`
/// payload, of which only `generation` decides visibility.
#[derive(Debug, serde::Deserialize)]
struct ProcessingErrorPayload {
    #[allow(dead_code)]
    code: String,
    generation: i64,
}

/// One `knowledge_documents` row of the table listing (the labeled
/// projection of `db.query(KnowledgeDocument)`; the JSON columns decode
/// into typed payloads, and `summary`/`chunks` are never read).
#[derive(Debug, FromMysqlRow)]
struct TableDocumentRow {
    knowledge_documents_id: i64,
    knowledge_documents_kind_id: i64,
    knowledge_documents_attachment_id: i64,
    knowledge_documents_name: String,
    knowledge_documents_file_extension: String,
    knowledge_documents_file_size: i64,
    knowledge_documents_status: String,
    knowledge_documents_user_id: i64,
    knowledge_documents_is_active: i8,
    knowledge_documents_index_status: String,
    knowledge_documents_index_generation: i64,
    knowledge_documents_splitter_config: Option<brz_mysql::Json<StoredSplitterConfig>>,
    knowledge_documents_source_type: String,
    knowledge_documents_source_config: Option<brz_mysql::Json<StoredSourceConfig>>,
    knowledge_documents_origin: String,
    knowledge_documents_folder_id: i64,
    #[allow(dead_code)]
    knowledge_documents_summary: Option<brz_mysql::Json<serde::de::IgnoredAny>>,
    #[allow(dead_code)]
    knowledge_documents_chunks: Option<brz_mysql::Json<serde::de::IgnoredAny>>,
    knowledge_documents_created_at: Option<chrono::NaiveDateTime>,
    knowledge_documents_updated_at: Option<chrono::NaiveDateTime>,
}

#[cfg(test)]
#[path = "tables_tests.rs"]
mod tests;

/// GET /api/tables: the tables free function, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/tables")]
async fn list_tables_route(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] user: SessionUser,
) -> Result<HttpResponse<Binary>, FastApiError> {
    tables_list(state, user.0).await
}

/// Handler body for `GET /api/tables`.
async fn tables_list(
    state: &Arc<AppState>,
    user: UserRow,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let result = list_table_documents(
        &state.mysql,
        state.erp.as_ref(),
        state.redis.as_ref(),
        i64::from(user.id),
    )
    .await;

    let items = result.map_err(|error| {
        tracing::error!(%error, "tables dependency failure");
        FastApiError::internal()
    })?;

    // `KnowledgeDocumentListResponse` field order: total, returned_count,
    // limit, offset, has_more, items. `list_table_documents` passes only
    // `total` and `items`; the remaining fields keep their schema defaults.
    let response = json!({
        "total": items.len(),
        "returned_count": items.len(),
        "limit": json!(null),
        "offset": 0,
        "has_more": false,
        "items": items,
    });
    Ok(HttpResponse::new(Binary::new(
        serde_json::to_vec(&response).unwrap_or_default(),
    )))
}

/// `KnowledgeService.list_table_documents`: personal KBs, then
/// `get_user_groups` and the team KBs of those namespaces, then the table
/// documents of every accessible KB ordered `created_at DESC`.
async fn list_table_documents<M, R: brz_redis::Redis>(
    mysql: &M,
    erp: &dyn crate::erp_provider::ErpProvider<R>,
    redis: Option<&R>,
    user_id: i64,
) -> MysqlResult<Vec<DocumentItem>>
where
    M: Mysql,
{
    // Personal knowledge bases (namespace 'default').
    let personal_kbs: Vec<KindIdRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'KnowledgeBase' \
                 AND kinds.user_id = {user_id} AND kinds.namespace = 'default' \
                 AND kinds.is_active = true"
            ),
            (),
        )
        .await?;
    let mut accessible_kb_ids: Vec<i64> = personal_kbs.iter().map(|row| row.kinds_id).collect();

    // `get_user_groups`: active namespace names, then the membership
    // batch (`iter_user_groups_with_roles` with the entity-resolver
    // chain), then the effective-role expansion over the active names.
    let erp_context = ErpContext { erp, redis };
    let resolved = user_group_memberships(mysql, &erp_context, user_id).await?;
    let roles = effective_roles(&resolved.memberships, &resolved.active_names);
    let mut group_names: Vec<String> = roles.into_keys().collect();
    group_names.sort();
    if !group_names.is_empty() {
        // Team knowledge bases of the accessible namespaces.
        let quoted = group_names
            .iter()
            .map(|name| quote_literal(name))
            .collect::<Vec<_>>()
            .join(", ");
        let team_kbs: Vec<KindIdRow> = mysql
            .fetch_all(
                &format!(
                    "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.kind = 'KnowledgeBase' \
                     AND kinds.namespace IN ({quoted}) AND kinds.is_active = true"
                ),
                (),
            )
            .await?;
        accessible_kb_ids.extend(team_kbs.iter().map(|row| row.kinds_id));
    }

    if accessible_kb_ids.is_empty() {
        return Ok(Vec::new());
    }

    // Table documents of the accessible KBs, ordered `created_at DESC`.
    let joined = accessible_kb_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let documents: Vec<TableDocumentRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {DOCUMENT_COLUMNS} \nFROM knowledge_documents \n\
                 WHERE knowledge_documents.kind_id IN ({joined}) \
                 AND knowledge_documents.source_type = 'table' \
                 ORDER BY knowledge_documents.created_at DESC"
            ),
            (),
        )
        .await?;
    Ok(documents.into_iter().map(build_item).collect())
}

/// `kinds` row of the accessible-KB queries; only `kinds_id` is consumed.
#[derive(Debug, FromMysqlRow)]
struct KindIdRow {
    kinds_id: i64,
}

/// SQL string literal, escaping like SQLAlchemy's rendering.
fn quote_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for byte in value.bytes() {
        match byte {
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            b'\0' => out.push_str("\\0"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\x1a' => out.push_str("\\Z"),
            other => out.push(other as char),
        }
    }
    out.push('\'');
    out
}

/// `normalize_splitter_config` (`shared.models.splitter_config`): convert
/// legacy and normalized payloads to the one stable response shape. The
/// result is built with `json!` so the field order matches the pydantic
/// model's serialization order.
fn normalize_splitter_config(raw: &StoredSplitterConfig) -> SplitterConfigPayload {
    match raw {
        StoredSplitterConfig::Legacy { splitter_type, .. } if splitter_type == "smart" => {
            let StoredSplitterConfig::Legacy {
                chunk_size,
                chunk_overlap,
                separator,
                ..
            } = raw
            else {
                unreachable!()
            };
            SplitterConfigPayload(brz_mysql::Json(SplitterPayloadBody {
                chunk_strategy: "flat".to_owned(),
                format_enhancement: "file_aware".to_owned(),
                flat_config: Some(FlatChunkConfig {
                    chunk_size: chunk_size.unwrap_or(1024),
                    chunk_overlap: chunk_overlap.unwrap_or(50),
                    separator: separator.clone().unwrap_or_else(|| "\n\n".to_owned()),
                }),
                hierarchical_config: None,
                semantic_config: None,
                markdown_enhancement: Some(MarkdownEnhancementConfig { enabled: true }),
                legacy_type: Some("smart".to_owned()),
            }))
        }
        StoredSplitterConfig::Legacy { splitter_type, .. } if splitter_type == "sentence" => {
            let StoredSplitterConfig::Legacy {
                chunk_size,
                chunk_overlap,
                separator,
                ..
            } = raw
            else {
                unreachable!()
            };
            SplitterConfigPayload(brz_mysql::Json(SplitterPayloadBody {
                chunk_strategy: "flat".to_owned(),
                format_enhancement: "none".to_owned(),
                flat_config: Some(FlatChunkConfig {
                    chunk_size: chunk_size.unwrap_or(1024),
                    chunk_overlap: chunk_overlap.unwrap_or(200),
                    separator: separator.clone().unwrap_or_else(|| "\n\n".to_owned()),
                }),
                hierarchical_config: None,
                semantic_config: None,
                markdown_enhancement: Some(MarkdownEnhancementConfig { enabled: false }),
                legacy_type: Some("sentence".to_owned()),
            }))
        }
        StoredSplitterConfig::Legacy { splitter_type, .. } if splitter_type == "semantic" => {
            let StoredSplitterConfig::Legacy {
                buffer_size,
                breakpoint_percentile_threshold,
                ..
            } = raw
            else {
                unreachable!()
            };
            SplitterConfigPayload(brz_mysql::Json(SplitterPayloadBody {
                chunk_strategy: "semantic".to_owned(),
                format_enhancement: "none".to_owned(),
                flat_config: None,
                hierarchical_config: None,
                semantic_config: Some(SemanticSplitterConfig {
                    buffer_size: buffer_size.unwrap_or(1),
                    breakpoint_percentile_threshold: breakpoint_percentile_threshold.unwrap_or(95),
                }),
                markdown_enhancement: Some(MarkdownEnhancementConfig { enabled: false }),
                legacy_type: Some("semantic".to_owned()),
            }))
        }
        StoredSplitterConfig::Legacy { .. } => {
            SplitterConfigPayload(brz_mysql::Json(SplitterPayloadBody {
                chunk_strategy: "flat".to_owned(),
                format_enhancement: "none".to_owned(),
                flat_config: Some(FlatChunkConfig {
                    chunk_size: 1024,
                    chunk_overlap: 200,
                    separator: "\n\n".to_owned(),
                }),
                hierarchical_config: None,
                semantic_config: None,
                markdown_enhancement: Some(MarkdownEnhancementConfig { enabled: false }),
                legacy_type: None,
            }))
        }
        StoredSplitterConfig::Normalized {
            chunk_strategy,
            format_enhancement,
            flat_config,
            hierarchical_config,
            semantic_config,
            markdown_enhancement,
            legacy_type,
        } => {
            // The strategy validator fills the matching config block with
            // its defaults and clears the others.
            let (flat, hierarchical, semantic) = match chunk_strategy.as_str() {
                "flat" => (
                    Some(flat_config.clone().unwrap_or(FlatChunkConfig {
                        chunk_size: 1024,
                        chunk_overlap: 200,
                        separator: "\n\n".to_owned(),
                    })),
                    None,
                    None,
                ),
                "hierarchical" => (
                    None,
                    Some(
                        hierarchical_config
                            .clone()
                            .unwrap_or(HierarchicalChunkConfig {
                                parent_chunk_size: 2048,
                                child_chunk_size: 512,
                                child_overlap: 64,
                                parent_separator: "\n\n".to_owned(),
                                child_separator: "\n".to_owned(),
                            }),
                    ),
                    None,
                ),
                "semantic" => (
                    None,
                    None,
                    Some(semantic_config.clone().unwrap_or(SemanticSplitterConfig {
                        buffer_size: 1,
                        breakpoint_percentile_threshold: 95,
                    })),
                ),
                _ => (
                    flat_config.clone(),
                    hierarchical_config.clone(),
                    semantic_config.clone(),
                ),
            };
            SplitterConfigPayload(brz_mysql::Json(SplitterPayloadBody {
                chunk_strategy: chunk_strategy.clone(),
                format_enhancement: format_enhancement
                    .clone()
                    .unwrap_or_else(|| "none".to_owned()),
                flat_config: flat,
                hierarchical_config: hierarchical,
                semantic_config: semantic,
                markdown_enhancement: markdown_enhancement
                    .clone()
                    .or(Some(MarkdownEnhancementConfig { enabled: false })),
                legacy_type: legacy_type.clone(),
            }))
        }
    }
}

/// `KnowledgeDocumentResponse` construction: `derive_processing_error`
/// pops `processing_error` from `source_config`, `source_config` `None`
/// becomes `{}`, and `splitter_config` is normalized. `created_by` and
/// `doc_ref` keep their schema defaults (`null`), and
/// `external_provider`/`external_resource_id` read the selectin-loaded
/// external-source identity, which table documents do not own.
fn build_item(doc: TableDocumentRow) -> DocumentItem {
    // `derive_processing_error`: the payload only surfaces for a failed
    // document whose error generation matches the current one.
    let failed = doc.knowledge_documents_index_status == "failed";
    let processing_error = match (
        failed,
        doc.knowledge_documents_source_config
            .as_ref()
            .and_then(|config| config.0.processing_error.as_ref()),
    ) {
        (true, Some(ProcessingErrorPayload { generation, .. }))
            if *generation == doc.knowledge_documents_index_generation =>
        {
            Some(ProcessingErrorEcho {
                generation: *generation,
            })
        }
        _ => None,
    };

    let splitter_config = doc
        .knowledge_documents_splitter_config
        .as_ref()
        .map(|config| normalize_splitter_config(&config.0));

    DocumentItem {
        id: doc.knowledge_documents_id,
        kind_id: doc.knowledge_documents_kind_id,
        attachment_id: doc.knowledge_documents_attachment_id,
        name: doc.knowledge_documents_name,
        file_extension: doc.knowledge_documents_file_extension,
        file_size: doc.knowledge_documents_file_size,
        status: doc.knowledge_documents_status,
        user_id: doc.knowledge_documents_user_id,
        created_by: None,
        is_active: doc.knowledge_documents_is_active != 0,
        index_status: doc.knowledge_documents_index_status,
        index_generation: doc.knowledge_documents_index_generation,
        processing_error,
        splitter_config,
        source_type: doc.knowledge_documents_source_type,
        source_config: SourceConfigEcho::default(),
        external_provider: None,
        external_resource_id: None,
        origin: doc.knowledge_documents_origin,
        folder_id: doc.knowledge_documents_folder_id,
        doc_ref: None,
        created_at: doc
            .knowledge_documents_created_at
            .map(|ts| ts.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_default(),
        updated_at: doc
            .knowledge_documents_updated_at
            .map(|ts| ts.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_default(),
    }
}
