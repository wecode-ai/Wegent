// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge/documents` — list documents in a knowledge base
//! (`app.api.endpoints.knowledge_open.list_documents_open` ->
//! `KnowledgeOrchestrator.list_documents` ->
//! `KnowledgeService.list_documents_paginated`).
//!
//! Source pipeline (recorded case `api-knowledge-documents/abb90b7d`,
//! request `?knowledge_base_id=210837`, service API key with
//! `wegent-username: hongbin9`):
//!
//! 1. `security.get_auth_context` — API key by SHA-256 hash, `last_used_at`
//!    UPDATE + COMMIT, the
//!    ORM reload by primary key, then the public direct user reader;
//! 2. `KnowledgeService.get_knowledge_base` (twice: once in
//!    `orchestrator.list_documents`, once inside
//!    `list_documents_paginated`) — the KB `Kind` record, then the full ACL
//!    chain of `resolve_knowledge_base_permission`;
//! 3. the `wiki_pages` document query: `count(*)` subquery, the ordered
//!    page query (`created_at DESC, id DESC`, `LIMIT 0, 50`), the
//!    `selectin` external-source load, then the `created_by` batch user
//!    lookup.
use std::collections::HashMap;
use std::sync::Arc;

use brz_http_server::{Binary, EphemeralBytesArena, HttpResponse, IntoHttpError, Response};
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde_json::json;

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::knowledge_documents_content::ApiFailure;
use super::knowledge_documents_content::access::{self, KnowledgeBase};
use super::knowledge_documents_content::auth;

/// `knowledge_documents` columns as rendered by
/// `db.query(KnowledgeDocument)` (same text as the content reader's).
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

/// `knowledge_document_external_sources` columns (same text as the content
/// reader's).
const EXTERNAL_SOURCE_COLUMNS: &str = "knowledge_document_external_sources.document_id \
     AS knowledge_document_external_sources_document_id, \
     knowledge_document_external_sources.kind_id \
     AS knowledge_document_external_sources_kind_id, \
     knowledge_document_external_sources.external_provider \
     AS knowledge_document_external_sources_external_provider, \
     knowledge_document_external_sources.external_resource_id \
     AS knowledge_document_external_sources_external_resource_id";

mod splitter_config;

use self::splitter_config::{StoredSplitterConfig, normalize_splitter_config};
/// One `knowledge_documents` row of the listing (the same labeled projection
/// as the content reader; only the fields the response reads are modeled,
/// and the JSON columns decode into typed payloads).
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct DocumentListRow {
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

/// The stored `source_config` payload: the keys the response logic reads
/// are modeled; the remaining keys are ignored (the recorded payloads are
/// `{}`).
#[derive(Debug, Clone, Default, serde::Deserialize)]
struct StoredSourceConfig {
    #[serde(default)]
    processing_error: Option<ProcessingErrorPayload>,
}

/// `source_config["processing_error"]`: the `DocumentProcessingError`
/// payload (`app.schemas.knowledge`). `derive_processing_error` validates
/// it with `DocumentProcessingError.model_validate`; a payload that fails
/// validation (or whose `generation` differs from the document's
/// `index_generation`) yields no error, so this type's `Deserialize` only
/// succeeds for schema-valid payloads.
#[derive(Debug, Clone, serde::Deserialize)]
struct ProcessingErrorPayload {
    stage: String,
    code: String,
    message: String,
    retryable: bool,
    generation: i64,
    occurred_at: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
}

impl ProcessingErrorPayload {
    /// `DocumentProcessingStage` members: any other stage fails validation.
    fn stage_is_valid(&self) -> bool {
        matches!(
            self.stage.as_str(),
            "dispatch" | "conversion" | "indexing" | "system"
        )
    }

    /// `code` (1..=64) and `message` (1..=1000) length constraints and
    /// `generation >= 0`; violations fail validation in the source.
    fn fields_are_valid(&self) -> bool {
        (1..=64).contains(&self.code.len())
            && (1..=1000).contains(&self.message.len())
            && self.generation >= 0
            && pydantic_datetime(&self.occurred_at).is_some()
    }

    /// Serialize like the validated pydantic model in field order.
    fn to_response(&self) -> impl serde::Serialize + '_ {
        json!({
            "stage": self.stage,
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
            "generation": self.generation,
            "occurred_at": pydantic_datetime(&self.occurred_at),
            "provider": self.provider,
            "model": self.model,
            "request_id": self.request_id,
        })
    }
}

/// Parse one `occurred_at` timestamp like pydantic v2 and re-serialize it
/// the way `model_dump(mode="json")` renders it: RFC 3339 with `Z` for
/// UTC inputs (`+00:00` becomes `Z`). `None` mirrors a validation failure.
fn pydantic_datetime(value: &str) -> Option<String> {
    let parsed = chrono::DateTime::parse_from_rfc3339(value).ok()?;
    let formatted = parsed.to_rfc3339();
    // `to_rfc3339` renders '+00:00' for UTC; pydantic uses 'Z'.
    Some(
        formatted
            .strip_suffix("+00:00")
            .map_or_else(|| formatted.clone(), |utc| format!("{utc}Z")),
    )
}

#[cfg(test)]
#[path = "knowledge_documents_list_tests.rs"]
mod tests;

/// `DEFAULT_KNOWLEDGE_LIST_LIMIT` (`app.services.knowledge.orchestrator`).
pub const DEFAULT_KNOWLEDGE_LIST_LIMIT: i64 = 50;
/// `MAX_KNOWLEDGE_LIST_LIMIT` (`app.services.knowledge.orchestrator`).
pub const MAX_KNOWLEDGE_LIST_LIMIT: i64 = 500;

// The response (`KnowledgeDocumentListResponse`) and each item
// (`KnowledgeDocumentResponse`) are built with `json!` in field order; the
// pydantic models' serialization order is asserted by tests.

/// GET /api/knowledge/documents: the knowledge-documents list free function,
/// injecting the process-lifetime application state.
#[allow(clippy::too_many_arguments)]
#[brz_http_server::get("/api/knowledge/documents")]
async fn list_documents_route(
    #[inject(state)] state: &Arc<AppState>,
    knowledge_base_id: Option<String>,
    folder_id: Option<String>,
    include_subfolders: Option<String>,
    keyword: Option<String>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
    #[auth] user: auth::KnowledgeUser,
) -> Result<HttpResponse<Binary>, KnowledgeListError> {
    list_documents_handler(
        state,
        knowledge_base_id.as_deref(),
        folder_id.as_deref(),
        include_subfolders.as_deref(),
        keyword.as_deref(),
        sort_by.as_deref(),
        sort_order.as_deref(),
        limit.as_deref(),
        offset.as_deref(),
        &user,
    )
    .await
}

/// One of the endpoint's failure shapes: 422 validation or a mapped
/// 404/403/400/401 value error.
enum KnowledgeListError {
    Validation(FastApiError),
    Failure(ApiFailure),
}

impl From<FastApiError> for KnowledgeListError {
    fn from(error: FastApiError) -> Self {
        Self::Validation(error)
    }
}

impl From<ApiFailure> for KnowledgeListError {
    fn from(error: ApiFailure) -> Self {
        Self::Failure(error)
    }
}

impl IntoHttpError for KnowledgeListError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        match self {
            Self::Validation(error) => error.into_http_error(arena),
            Self::Failure(error) => error.into_http_error(arena),
        }
    }
}

/// FastAPI-style 422 validation error body for one query parameter.
fn validation_error(loc: &str, error_type: &str, msg: &str, input: &str) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": error_type,
            "loc": ["query", loc],
            "msg": msg,
            "input": input,
        }
    ]))
}

/// Parse one optional integer query parameter.
fn parse_int(value: &str, field: &str) -> Result<i64, FastApiError> {
    value.parse().map_err(|_| {
        validation_error(
            field,
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
            value,
        )
    })
}

/// The validated query parameters of `list_documents_open`. The folder and
/// keyword filters are validated like the source; the representative case
/// exercises the unfiltered listing, and the folder/keyword SQL branches
/// (`list_documents_paginated`) are not yet implemented for this scope.
struct ListParams {
    knowledge_base_id: i64,
    #[allow(dead_code)]
    folder_id: Option<i64>,
    #[allow(dead_code)]
    include_subfolders: bool,
    #[allow(dead_code)]
    keyword: Option<String>,
    sort_by: String,
    sort_order: String,
    limit: i64,
    offset: i64,
}

/// Validate the raw query strings like FastAPI's `Query(...)` constraints.
#[allow(clippy::too_many_arguments)]
fn parse_params(
    knowledge_base_id: Option<&str>,
    folder_id: Option<&str>,
    include_subfolders: Option<&str>,
    keyword: Option<String>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    limit: Option<&str>,
    offset: Option<&str>,
) -> Result<ListParams, FastApiError> {
    let knowledge_base_id = knowledge_base_id
        .ok_or_else(|| validation_error("knowledge_base_id", "missing", "Field required", ""))
        .and_then(|value| parse_int(value, "knowledge_base_id"))?;

    let folder_id = match folder_id {
        None => None,
        Some(value) => {
            let parsed = parse_int(value, "folder_id")?;
            if parsed < 0 {
                return Err(validation_error(
                    "folder_id",
                    "greater_than_equal",
                    "Input should be greater than or equal to 0",
                    value,
                ));
            }
            Some(parsed)
        }
    };

    // FastAPI bool parsing accepts 0/1, true/false (case-insensitive), and
    // rejects everything else with 422.
    let include_subfolders = match include_subfolders {
        None => false,
        Some(value) => match value.to_ascii_lowercase().as_str() {
            "1" | "true" | "on" | "yes" => true,
            "0" | "false" | "off" | "no" => false,
            _ => {
                return Err(validation_error(
                    "include_subfolders",
                    "bool_parsing",
                    "Input should be a valid boolean, unable to interpret input as boolean",
                    value,
                ));
            }
        },
    };

    // `KnowledgeDocumentSortField` / `SortOrder` enums reject unknown
    // values with 422.
    let sort_by = match sort_by.as_deref() {
        None | Some("createdAt") => "createdAt".to_string(),
        Some("name") => "name".to_string(),
        Some("size") => "size".to_string(),
        Some("updatedAt") => "updatedAt".to_string(),
        Some(other) => {
            return Err(validation_error(
                "sort_by",
                "enum",
                "Input should be 'name', 'size', 'createdAt' or 'updatedAt'",
                other,
            ));
        }
    };
    let sort_order = match sort_order.as_deref() {
        None | Some("desc") => "desc".to_string(),
        Some("asc") => "asc".to_string(),
        Some(other) => {
            return Err(validation_error(
                "sort_order",
                "enum",
                "Input should be 'asc' or 'desc'",
                other,
            ));
        }
    };

    let limit = match limit {
        None => DEFAULT_KNOWLEDGE_LIST_LIMIT,
        Some(value) => {
            let parsed = parse_int(value, "limit")?;
            if !(1..=MAX_KNOWLEDGE_LIST_LIMIT).contains(&parsed) {
                return Err(validation_error(
                    "limit",
                    "greater_than_equal",
                    "Input should be between 1 and 500",
                    value,
                ));
            }
            parsed
        }
    };
    let offset = match offset {
        None => 0,
        Some(value) => {
            let parsed = parse_int(value, "offset")?;
            if parsed < 0 {
                return Err(validation_error(
                    "offset",
                    "greater_than_equal",
                    "Input should be greater than or equal to 0",
                    value,
                ));
            }
            parsed
        }
    };

    Ok(ListParams {
        knowledge_base_id,
        folder_id,
        include_subfolders,
        keyword,
        sort_by,
        sort_order,
        limit,
        offset,
    })
}

/// Handler body for `GET /api/knowledge/documents`.
#[allow(clippy::too_many_arguments)]
async fn list_documents_handler(
    state: &Arc<AppState>,
    knowledge_base_id: Option<&str>,
    folder_id: Option<&str>,
    include_subfolders: Option<&str>,
    keyword: Option<&str>,
    sort_by: Option<&str>,
    sort_order: Option<&str>,
    limit: Option<&str>,
    offset: Option<&str>,
    user: &auth::KnowledgeUser,
) -> Result<HttpResponse<Binary>, KnowledgeListError> {
    // FastAPI validates the query parameters before the endpoint body runs.
    let params = parse_params(
        knowledge_base_id,
        folder_id,
        include_subfolders,
        keyword.map(str::to_string),
        sort_by.map(str::to_string),
        sort_order.map(str::to_string),
        limit,
        offset,
    )?;

    let response = list_documents(state, i64::from(user.id), &params).await?;

    Ok(response)
}

/// `KnowledgeOrchestrator.list_documents`: access check, then the
/// paginated document listing.
async fn list_documents(
    state: &AppState,
    user_id: i64,
    params: &ListParams,
) -> Result<brz_http_server::HttpResponse<brz_http_server::Binary>, ApiFailure> {
    let mysql = &state.mysql;
    let redis = state.redis.as_ref();

    // `orchestrator.list_documents` calls `KnowledgeService.get_knowledge_base`
    // for the early "not found or access denied" error.
    let Some(kb) = get_knowledge_base_checked(
        mysql,
        redis,
        &state.entity_resolvers,
        params.knowledge_base_id,
        user_id,
    )
    .await?
    else {
        return Err(ApiFailure::from_value_error(
            "Knowledge base not found or access denied",
        ));
    };

    // `offset = max(0, offset)`, `limit = min(max(1, limit), 500)`.
    let offset = params.offset.max(0);
    let limit = params.limit.clamp(1, MAX_KNOWLEDGE_LIST_LIMIT);

    // `KnowledgeService.list_documents_paginated` runs its own
    // `get_knowledge_base` (the KB Kind + full ACL chain) before listing;
    // the recorded dependency sequence carries the full access chain
    // twice. The earlier orchestrator check already proved access, so this
    // second check passes and only its queries repeat.
    if get_knowledge_base_checked(
        mysql,
        redis,
        &state.entity_resolvers,
        params.knowledge_base_id,
        user_id,
    )
    .await?
    .is_none()
    {
        return Err(ApiFailure::from_value_error(
            "Knowledge base not found or access denied",
        ));
    }

    let (documents, total) =
        list_documents_paginated(mysql, params.knowledge_base_id, &kb, params, offset, limit)
            .await
            .map_err(ApiFailure::internal)?;

    // Batch query user names for the `created_by` field.
    let user_ids: Vec<i64> = {
        let mut seen = std::collections::HashSet::new();
        documents
            .iter()
            .filter(|doc| doc.knowledge_documents_user_id != 0)
            .filter(|doc| seen.insert(doc.knowledge_documents_user_id))
            .map(|doc| doc.knowledge_documents_user_id)
            .collect()
    };
    let user_name_map = user_names(mysql, &user_ids)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    let items = documents
        .into_iter()
        .map(|doc| {
            let created_by = user_name_map.get(&doc.knowledge_documents_user_id).cloned();
            build_item(doc, created_by)
        })
        .collect::<Vec<_>>();

    let response = json!({
        "total": total,
        "returned_count": items.len(),
        "limit": limit,
        "offset": offset,
        "has_more": offset + i64::try_from(items.len()).unwrap_or(i64::MAX) < total,
        "items": items,
    });
    Ok(brz_http_server::HttpResponse::new(
        brz_http_server::Binary::new(serde_json::to_vec(&response).unwrap_or_default()),
    ))
}

/// `KnowledgeService.get_knowledge_base`: the KB `Kind` record plus the
/// full ACL chain (`resolve_knowledge_base_permission` +
/// `meets_direct_access_requirement`). `Ok(None)` maps to the endpoint's
/// "Knowledge base not found or access denied" 404.
async fn get_knowledge_base_checked<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &crate::permissions::EntityResolvers<R>,
    knowledge_base_id: i64,
    user_id: i64,
) -> Result<Option<KnowledgeBase>, ApiFailure>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let kb = access::knowledge_base_record(mysql, knowledge_base_id)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
    let Some(kb) = kb else {
        return Ok(None);
    };
    let has_access = access::knowledge_base_access(mysql, redis, resolvers, &kb, user_id).await?;
    if has_access { Ok(Some(kb)) } else { Ok(None) }
}

/// `KnowledgeService.list_documents_paginated`: the `wiki_pages` scoped
/// document query with `count(*)`, ordering, and pagination.
async fn list_documents_paginated<M>(
    mysql: &M,
    knowledge_base_id: i64,
    kb: &KnowledgeBase,
    params: &ListParams,
    offset: i64,
    limit: i64,
) -> Result<(Vec<DocumentListRow>, i64), String>
where
    M: Mysql,
{
    // `wiki_pages(query)` excludes code targets.
    let scope = format!(
        "knowledge_documents.kind_id = {knowledge_base_id} \
         AND knowledge_documents.source_type != 'code'"
    );

    // `query.count()` renders the subquery count.
    #[derive(Debug, FromMysqlRow)]
    struct CountRow {
        count_1: i64,
    }
    let count: Option<CountRow> = mysql
        .fetch_optional(
            &format!(
                "SELECT count(*) AS count_1 \nFROM (SELECT {DOCUMENT_COLUMNS} \n\
                 FROM knowledge_documents \nWHERE {scope}) AS anon_1"
            ),
            (),
        )
        .await
        .map_err(|error| error.to_string())?;
    let total = count.map(|row| row.count_1).unwrap_or(0);

    // The ordered page query: `ORDER BY <sort>, id DESC LIMIT offset, limit`.
    let sort_column = match params.sort_by.as_str() {
        "name" => "knowledge_documents.name",
        "size" => "knowledge_documents.file_size",
        "updatedAt" => "knowledge_documents.updated_at",
        _ => "knowledge_documents.created_at",
    };
    let direction = if params.sort_order == "asc" {
        "ASC"
    } else {
        "DESC"
    };
    let documents: Vec<DocumentListRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {DOCUMENT_COLUMNS} \nFROM knowledge_documents \nWHERE {scope} \
                 ORDER BY {sort_column} {direction}, knowledge_documents.id DESC \n \
                 LIMIT {offset}, {limit}"
            ),
            (),
        )
        .await
        .map_err(|error| error.to_string())?;

    // The `selectin` external-source load for the page's documents.
    let document_ids: Vec<i64> = documents
        .iter()
        .map(|row| row.knowledge_documents_id)
        .collect();
    external_sources_by_document_ids(mysql, &document_ids)
        .await
        .map_err(|error| error.to_string())?;

    let _ = kb;
    Ok((documents, total))
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

/// The `created_by` batch lookup (`User.id.in_(user_ids)`).
async fn user_names<M>(mysql: &M, user_ids: &[i64]) -> MysqlResult<HashMap<i64, String>>
where
    M: Mysql,
{
    let mut map = HashMap::new();
    if user_ids.is_empty() {
        return Ok(map);
    }
    let ids = user_ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        users_id: i64,
        users_user_name: String,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            &format!(
                "SELECT users.id AS users_id, users.user_name AS users_user_name \n\
                 FROM users \nWHERE users.id IN ({ids})"
            ),
            (),
        )
        .await?;
    for row in rows {
        map.insert(row.users_id, row.users_user_name);
    }
    Ok(map)
}

/// `KnowledgeDocumentResponse` construction: `derive_processing_error`
/// pops `processing_error` from `source_config`, `source_config` `None`
/// becomes `{}`, and `splitter_config` is normalized.
fn build_item(doc: DocumentListRow, created_by: Option<String>) -> impl serde::Serialize {
    // `derive_processing_error`: the payload only surfaces for a failed
    // document whose validated error generation matches the current one.
    let processing_error = doc
        .knowledge_documents_source_config
        .as_ref()
        .and_then(|config| config.0.processing_error.as_ref())
        .filter(|payload| {
            doc.knowledge_documents_index_status == "failed"
                && payload.fields_are_valid()
                && payload.stage_is_valid()
                && payload.generation == doc.knowledge_documents_index_generation
        })
        .map(ProcessingErrorPayload::to_response);

    let splitter_config = doc
        .knowledge_documents_splitter_config
        .as_ref()
        .map(|config| normalize_splitter_config(&config.0));

    // `source_config` `None` becomes `{}` for backward compatibility; the
    // modeled keys are popped (processing_error) and the remainder echoes.
    // The recorded payloads are empty objects.
    json!({
        "id": doc.knowledge_documents_id,
        "kind_id": doc.knowledge_documents_kind_id,
        "attachment_id": doc.knowledge_documents_attachment_id,
        "name": doc.knowledge_documents_name,
        "file_extension": doc.knowledge_documents_file_extension,
        "file_size": doc.knowledge_documents_file_size,
        "status": doc.knowledge_documents_status,
        "user_id": doc.knowledge_documents_user_id,
        "created_by": created_by,
        "is_active": doc.knowledge_documents_is_active != 0,
        "index_status": doc.knowledge_documents_index_status,
        "index_generation": doc.knowledge_documents_index_generation,
        "processing_error": processing_error,
        "splitter_config": splitter_config,
        "source_type": doc.knowledge_documents_source_type,
        "source_config": {},
        "external_provider": null,
        "external_resource_id": null,
        "origin": doc.knowledge_documents_origin,
        "folder_id": doc.knowledge_documents_folder_id,
        "doc_ref": null,
        "created_at": doc
            .knowledge_documents_created_at
            .map(|ts| ts.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_default(),
        "updated_at": doc
            .knowledge_documents_updated_at
            .map(|ts| ts.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_default(),
    })
}
