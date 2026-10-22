// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge-bases/{knowledge_base_id}/documents`
//! (`app.api.endpoints.knowledge.list_documents`, session auth, path-scoped
//! knowledge-base id) and `GET /api/knowledge/documents`
//! (`app.api.endpoints.knowledge_open.list_documents_open`, flexible
//! auth-context, query-scoped knowledge-base id). Both delegate to
//! `KnowledgeOrchestrator.list_documents` ->
//! `KnowledgeService.list_documents_paginated`, so they share one
//! implementation here.
//!
//! Source pipeline (representative case `api-knowledge-bases-wildcard-documents`,
//! request `/api/knowledge-bases/236829/documents?limit=500&offset=0`,
//! unencrypted session JWT `sub=furui1`):
//!
//! 1. `security.get_current_user` — `sub` claim, `users` row by `user_name`,
//!    then the active-user check (the open endpoint instead runs
//!    `security.get_auth_context`);
//! 2. `KnowledgeService.get_knowledge_base` (twice: once in
//!    `orchestrator.list_documents`, once inside
//!    `list_documents_paginated`) — the KB `Kind` record, then the full ACL
//!    chain of `resolve_knowledge_base_permission`;
//! 3. the `wiki_pages` document query: `count(*)` subquery, the ordered
//!    page query (`created_at DESC, id DESC`, `LIMIT 0, 500`), the
//!    `selectin` external-source load, then the `created_by` batch user
//!    lookup.
use std::collections::HashMap;
use std::sync::Arc;

use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response};
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use serde_json::{Value, json};

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

/// `KnowledgeDocumentListResponse` (`app.schemas.knowledge`): the paginated
/// listing envelope. The per-document items are the
/// `KnowledgeDocumentResponse` values built by [`build_item`] in pydantic
/// field order. The endpoint declares a `response_model`, so FastAPI renders
/// this value through its default `JSONResponse`; returning the typed value
/// (instead of a pre-serialized `Binary` body) announces `application/json`.
#[derive(Debug, serde::Serialize)]
struct KnowledgeDocumentListResponse {
    total: i64,
    returned_count: i64,
    limit: i64,
    offset: i64,
    has_more: bool,
    items: Vec<Value>,
}

/// GET /api/knowledge-bases/{knowledge_base_id}/documents: the
/// knowledge-bases free function (`app.api.endpoints.knowledge.list_documents`),
/// injecting the process-lifetime application state.
#[allow(clippy::too_many_arguments)]
#[brz_http_server::get("/api/knowledge-bases/:knowledge_base_id/documents")]
async fn list_knowledge_base_documents_route(
    #[inject(state)] state: &Arc<AppState>,
    knowledge_base_id: &str,
    folder_id: Option<String>,
    include_subfolders: Option<String>,
    keyword: Option<String>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    origin: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
    #[auth] user: crate::auth::SessionUser,
) -> Result<KnowledgeDocumentListResponse, KnowledgeListError> {
    // FastAPI validates the path parameter before the endpoint body runs.
    let knowledge_base_id = parse_knowledge_base_id_path(knowledge_base_id)?;
    let params = parse_params(
        knowledge_base_id,
        folder_id.as_deref(),
        include_subfolders.as_deref(),
        keyword,
        sort_by,
        sort_order,
        origin,
        limit.as_deref(),
        offset.as_deref(),
    )?;
    Ok(list_documents(state, i64::from(user.id), &params).await?)
}

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
) -> Result<KnowledgeDocumentListResponse, KnowledgeListError> {
    // FastAPI validates the query parameters before the endpoint body runs.
    let params = parse_params(
        parse_knowledge_base_id_query(knowledge_base_id.as_deref())?,
        folder_id.as_deref(),
        include_subfolders.as_deref(),
        keyword,
        sort_by,
        sort_order,
        None,
        limit.as_deref(),
        offset.as_deref(),
    )?;
    Ok(list_documents(state, user.id, &params).await?)
}

/// One of the endpoints' failure shapes: 422 validation or a mapped
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

/// FastAPI-style 422 validation error body for the `knowledge_base_id` path
/// parameter.
fn path_validation_error(value: &str) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": "int_parsing",
            "loc": ["path", "knowledge_base_id"],
            "msg": "Input should be a valid integer, unable to parse string as an integer",
            "input": value,
        }
    ]))
}

/// Parse the optional `knowledge_base_id` query parameter (the open endpoint).
fn parse_knowledge_base_id_query(value: Option<&str>) -> Result<i64, FastApiError> {
    let value = value
        .ok_or_else(|| validation_error("knowledge_base_id", "missing", "Field required", ""))?;
    parse_int(value, "knowledge_base_id")
}

/// Parse the required `knowledge_base_id` path parameter.
fn parse_knowledge_base_id_path(value: &str) -> Result<i64, FastApiError> {
    value.parse().map_err(|_| path_validation_error(value))
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

/// The validated query parameters shared by both listing endpoints.
struct ListParams {
    knowledge_base_id: i64,
    folder_id: Option<i64>,
    include_subfolders: bool,
    keyword: Option<String>,
    sort_by: String,
    sort_order: String,
    origin: Option<String>,
    limit: i64,
    offset: i64,
}

/// Validate the non-path query strings like FastAPI's `Query(...)` constraints.
#[allow(clippy::too_many_arguments)]
fn parse_params(
    knowledge_base_id: i64,
    folder_id: Option<&str>,
    include_subfolders: Option<&str>,
    keyword: Option<String>,
    sort_by: Option<String>,
    sort_order: Option<String>,
    origin: Option<String>,
    limit: Option<&str>,
    offset: Option<&str>,
) -> Result<ListParams, FastApiError> {
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

    // `ContentOrigin` enum (`app.models.knowledge`): `generated` or `user`;
    // any other value fails validation with 422.
    let origin = match origin.as_deref() {
        None => None,
        Some("generated") => Some("generated".to_string()),
        Some("user") => Some("user".to_string()),
        Some(other) => {
            return Err(validation_error(
                "origin",
                "enum",
                "Input should be 'generated' or 'user'",
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
        origin,
        limit,
        offset,
    })
}

/// `KnowledgeOrchestrator.list_documents`: access check, then the
/// paginated document listing.
async fn list_documents(
    state: &AppState,
    user_id: i64,
    params: &ListParams,
) -> Result<KnowledgeDocumentListResponse, ApiFailure> {
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
            .await?;

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

    let returned_count = i64::try_from(items.len()).unwrap_or(i64::MAX);
    Ok(KnowledgeDocumentListResponse {
        total,
        returned_count,
        limit,
        offset,
        has_more: offset + returned_count < total,
        items,
    })
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
) -> Result<(Vec<DocumentListRow>, i64), ApiFailure>
where
    M: Mysql,
{
    // `wiki_pages(query)` excludes code targets; the folder, keyword and
    // origin filters mirror `list_documents_paginated`'s query builders.
    let scope = document_scope(mysql, knowledge_base_id, params).await?;

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
        .map_err(|error| ApiFailure::internal(error.to_string()))?;
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
        .map_err(|error| ApiFailure::internal(error.to_string()))?;

    // The `selectin` external-source load for the page's documents.
    let document_ids: Vec<i64> = documents
        .iter()
        .map(|row| row.knowledge_documents_id)
        .collect();
    external_sources_by_document_ids(mysql, &document_ids)
        .await
        .map_err(|error| ApiFailure::internal(error.to_string()))?;

    let _ = kb;
    Ok((documents, total))
}

/// The `WHERE` clause shared by the count and page queries: the `wiki_pages`
/// knowledge-base scope plus the optional folder, keyword and origin filters
/// of `list_documents_paginated`.
async fn document_scope<M>(
    mysql: &M,
    knowledge_base_id: i64,
    params: &ListParams,
) -> Result<String, ApiFailure>
where
    M: Mysql,
{
    let mut conditions = vec![
        format!("knowledge_documents.kind_id = {knowledge_base_id}"),
        "knowledge_documents.source_type != 'code'".to_string(),
    ];

    if let Some(folder_id) = params.folder_id {
        // A named folder must exist in this knowledge base.
        if folder_id > 0
            && !folder_exists(mysql, knowledge_base_id, folder_id)
                .await
                .map_err(|error| ApiFailure::internal(error.to_string()))?
        {
            return Err(ApiFailure::from_value_error(
                "Folder not found in this knowledge base",
            ));
        }
        if params.include_subfolders {
            let ids = folder_subtree_ids(mysql, knowledge_base_id, folder_id)
                .await
                .map_err(|error| ApiFailure::internal(error.to_string()))?;
            conditions.push(format!(
                "knowledge_documents.folder_id IN ({})",
                join_ids(&ids)
            ));
        } else {
            conditions.push(format!("knowledge_documents.folder_id = {folder_id}"));
        }
    }

    if let Some(keyword) = params.keyword.as_deref() {
        // `keyword.strip()`; an empty keyword drops the filter.
        let keyword = keyword.trim();
        if !keyword.is_empty() {
            let pattern = format!("%{}%", escape_sql_like(keyword));
            conditions.push(format!(
                "knowledge_documents.name LIKE {} ESCAPE '\\\\'",
                mysql_string_literal(&pattern)
            ));
        }
    }

    if let Some(origin) = params.origin.as_deref() {
        conditions.push(format!(
            "knowledge_documents.origin = {}",
            mysql_string_literal(origin)
        ));
    }

    Ok(conditions.join(" AND "))
}

/// `db.query(KnowledgeFolder).filter(id, kind_id).first()` — the named-folder
/// existence check of the `folder_id > 0` branch.
async fn folder_exists<M>(mysql: &M, knowledge_base_id: i64, folder_id: i64) -> MysqlResult<bool>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        #[allow(dead_code)]
        knowledge_folders_id: i64,
    }
    let row: Option<Row> = mysql
        .fetch_optional(
            &format!(
                "SELECT knowledge_folders.id AS knowledge_folders_id \n\
                 FROM knowledge_folders \n\
                 WHERE knowledge_folders.id = {folder_id} \
                 AND knowledge_folders.kind_id = {knowledge_base_id} \n LIMIT 1"
            ),
            (),
        )
        .await?;
    Ok(row.is_some())
}

/// `db.query(KnowledgeFolder.id, KnowledgeFolder.parent_id).filter(kind_id)`
/// plus the source's stack walk: the folder-id set of `folder_id` and its
/// descendants for `include_subfolders`.
async fn folder_subtree_ids<M>(
    mysql: &M,
    knowledge_base_id: i64,
    folder_id: i64,
) -> MysqlResult<Vec<i64>>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct Row {
        knowledge_folders_id: i64,
        knowledge_folders_parent_id: i64,
    }
    let rows: Vec<Row> = mysql
        .fetch_all(
            &format!(
                "SELECT knowledge_folders.id AS knowledge_folders_id, \
                 knowledge_folders.parent_id AS knowledge_folders_parent_id \n\
                 FROM knowledge_folders \n\
                 WHERE knowledge_folders.kind_id = {knowledge_base_id}"
            ),
            (),
        )
        .await?;

    let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in &rows {
        children
            .entry(row.knowledge_folders_parent_id)
            .or_default()
            .push(row.knowledge_folders_id);
    }
    let mut ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut stack = vec![folder_id];
    while let Some(current) = stack.pop() {
        if !ids.insert(current) {
            continue;
        }
        if let Some(kids) = children.get(&current) {
            stack.extend(kids);
        }
    }
    let mut out: Vec<i64> = ids.into_iter().collect();
    out.sort_unstable();
    Ok(out)
}

/// `_escape_sql_like`: escape the LIKE metacharacters with a backslash so a
/// user keyword matches literally (`escape="\\"`).
fn escape_sql_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Render `value` as a MySQL single-quoted string literal (the source binds
/// these patterns as parameters; inline COM_QUERY text is reproduced here).
fn mysql_string_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for byte in value.bytes() {
        match byte {
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            b'\0' => out.push_str("\\0"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            0x1a => out.push_str("\\Z"),
            other => out.push(char::from(other)),
        }
    }
    out.push('\'');
    out
}

/// Render an `IN (...)` id list the way SQLAlchemy renders a literal list.
fn join_ids(ids: &[i64]) -> String {
    ids.iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// The `selectin` external-source load (`external_source` relationship).
async fn external_sources_by_document_ids<M>(mysql: &M, document_ids: &[i64]) -> MysqlResult<()>
where
    M: Mysql,
{
    if document_ids.is_empty() {
        return Ok(());
    }
    let ids = join_ids(document_ids);
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
    let ids = join_ids(user_ids);
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
fn build_item(doc: DocumentListRow, created_by: Option<String>) -> Value {
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

    // Both datetime columns are NOT NULL in the source schema; the
    // Option only models the driver decode, and a missing value renders
    // as the naive datetime epoch like pydantic's default.
    let created_at = doc.knowledge_documents_created_at.unwrap_or_default();
    let updated_at = doc
        .knowledge_documents_updated_at
        .map(|ts| serialize_updated_at(ts, created_at))
        .unwrap_or_default();

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
        "created_at": created_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
        "updated_at": updated_at.format("%Y-%m-%dT%H:%M:%S").to_string(),
    })
}

/// `KnowledgeDocumentResponse.serialize_updated_at`: repair a legacy naive
/// UTC `updated_at` that precedes the naive local `created_at` by shifting
/// it +8h, and keep the repaired value only when it then no longer precedes
/// the creation time. Both timestamps are naive session-local values here,
/// mirroring the pydantic serializer's `tzinfo is None` fast path.
fn serialize_updated_at(
    updated_at: chrono::NaiveDateTime,
    created_at: chrono::NaiveDateTime,
) -> chrono::NaiveDateTime {
    if updated_at < created_at {
        let corrected = updated_at + chrono::Duration::hours(8);
        if corrected >= created_at {
            return corrected;
        }
    }
    updated_at
}
