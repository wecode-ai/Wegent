// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/knowledge-bases` — the scoped, paginated knowledge-base listing
//! (`app.api.endpoints.knowledge.list_knowledge_bases` ->
//! `KnowledgeOrchestrator.list_knowledge_bases` ->
//! `KnowledgeService.list_knowledge_bases_paginated`).
//!
//! Source pipeline:
//!
//! 1. `security.get_current_user` — the bearer-session user;
//! 2. query validation: `scope`/`group_name` (400) then `limit`/`offset`
//!    (FastAPI 422 bounds);
//! 3. `build_direct_access_query_context` — the user, the group-role batches
//!    (`get_user_groups`, `get_effective_roles_in_groups`), organization names,
//!    accessible namespace ids, and the external-entity role map;
//! 4. `build_knowledge_base_visibility_query` — per scope, with
//!    `get_effective_role_in_group` for the group scope (an inaccessible group
//!    yields an empty page);
//! 5. `apply_direct_access_filter` — the rendered `EXISTS`-bearing predicate;
//! 6. `count(*)` then the ordered, offset/limit `kinds` page;
//! 7. `KnowledgeBaseResponse.from_kind(kb, spec.document_count)` per row.
//!
//! Recorded cases cover the `group` and `organization` scopes; the `personal`
//! and `all` scopes use the same visibility/predicate machinery with their own
//! base filters and ordering.
mod external_roles;
mod query;
mod response;

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Serialize;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use response::{KbDocument, KnowledgeBaseListResponse, KnowledgeBaseResponse, build_response};

/// `DEFAULT_KNOWLEDGE_LIST_LIMIT`.
const DEFAULT_LIMIT: i64 = 50;
/// `MAX_KNOWLEDGE_LIST_LIMIT`.
const MAX_LIMIT: i64 = 500;

/// The list endpoint's raw query values. FastAPI parses `limit`/`offset` as
/// bounded integers; `scope`/`group_name` are plain strings validated by the
/// handler.
#[derive(Debug, serde::Deserialize)]
struct ListQuery {
    scope: Option<String>,
    group_name: Option<String>,
    limit: Option<String>,
    offset: Option<String>,
}

/// GET /api/knowledge-bases: the scoped knowledge-base listing.
#[brz_http_server::get("/api/knowledge-bases")]
async fn list_knowledge_bases(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<ListQuery>,
) -> Result<KnowledgeBaseListResponse, FastApiError> {
    // FastAPI validates the `int` bounds before the handler runs, so `limit`
    // and `offset` failures (422) take precedence over the scope/group_name
    // checks (400).
    let limit = validated_limit(query.limit.as_deref())?;
    let offset = validated_offset(query.offset.as_deref())?;
    let scope = validated_scope(query.scope.as_deref())?;
    let group_name = query.group_name.clone().filter(|name| !name.is_empty());
    if scope == query::Scope::Group && group_name.is_none() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "group_name is required when scope is group",
        ));
    }
    list_knowledge_bases_inner(state, &user, scope, group_name.as_deref(), limit, offset).await
}

/// `ResourceScope(scope)`; an unknown value renders the source 400 body. The
/// source rejects it with `Invalid scope: {scope}. Must be one of: ...`.
fn validated_scope(raw: Option<&str>) -> Result<query::Scope, FastApiError> {
    let value = raw.unwrap_or("all");
    query::Scope::parse(value).ok_or_else(|| {
        FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Invalid scope: {value}. Must be one of: personal, group, organization, all"),
        )
    })
}

/// FastAPI `Query(default=50, ge=1, le=500)`.
fn validated_limit(raw: Option<&str>) -> Result<i64, FastApiError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_LIMIT);
    };
    let limit = parse_query_int(raw, "limit")?;
    if limit < 1 {
        return Err(bound_error(ValidationEntry::greater_than_equal(
            "limit",
            raw,
            1,
            "Input should be greater than or equal to 1",
        )));
    }
    if limit > MAX_LIMIT {
        return Err(bound_error(ValidationEntry::less_than_equal(
            "limit",
            raw,
            MAX_LIMIT,
            "Input should be less than or equal to 500",
        )));
    }
    Ok(limit)
}

/// FastAPI `Query(default=0, ge=0)`.
fn validated_offset(raw: Option<&str>) -> Result<i64, FastApiError> {
    let Some(raw) = raw else {
        return Ok(0);
    };
    let offset = parse_query_int(raw, "offset")?;
    if offset < 0 {
        return Err(bound_error(ValidationEntry::greater_than_equal(
            "offset",
            raw,
            0,
            "Input should be greater than or equal to 0",
        )));
    }
    Ok(offset)
}

/// `KnowledgeOrchestrator.list_knowledge_bases` ->
/// `KnowledgeService.list_knowledge_bases_paginated`.
async fn list_knowledge_bases_inner(
    state: &AppState,
    user: &SessionUser,
    scope: query::Scope,
    group_name: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<KnowledgeBaseListResponse, FastApiError> {
    let mysql = &state.mysql;
    let redis = state.redis.as_ref();
    let user_id = i64::from(user.id);

    // The orchestrator clamps before the service call; the handler already
    // bounded both for the API path.
    let offset = offset.max(0);
    let limit = limit.clamp(1, MAX_LIMIT);

    // `build_direct_access_query_context`.
    let context = query::build_context(mysql, redis, &state.entity_resolvers, user_id, &user.role)
        .await
        .map_err(internal)?;

    // `build_knowledge_base_visibility_query`: an inaccessible group scope
    // returns `None` and the source yields an empty page.
    let Some(visibility) = query::build_visibility(
        mysql,
        redis,
        &state.entity_resolvers,
        &context,
        scope,
        group_name,
    )
    .await
    .map_err(internal)?
    else {
        return Ok(empty_page(limit, offset));
    };

    let predicate = query::direct_access_predicate(&context);
    let sql = query::build_list_sql(scope, &visibility, &predicate, &context, limit, offset);

    let total = count_rows(mysql, &sql.count).await.map_err(internal)?;
    let rows = page_rows(mysql, &sql.select).await.map_err(internal)?;
    let items: Vec<KnowledgeBaseResponse> = rows.iter().map(row_to_response).collect();
    let returned_count = items.len() as i64;
    Ok(KnowledgeBaseListResponse {
        total,
        returned_count,
        limit,
        offset,
        has_more: offset + returned_count < total,
        items,
    })
}

fn empty_page(limit: i64, offset: i64) -> KnowledgeBaseListResponse {
    KnowledgeBaseListResponse {
        total: 0,
        returned_count: 0,
        limit,
        offset,
        has_more: false,
        items: Vec::new(),
    }
}

/// `query.order_by(None).count()`.
async fn count_rows<M>(mysql: &M, sql: &str) -> MysqlResult<i64>
where
    M: Mysql,
{
    #[derive(Debug, FromMysqlRow)]
    struct CountRow {
        count_1: i64,
    }
    let row: Option<CountRow> = mysql.fetch_optional(sql, ()).await?;
    Ok(row.map(|row| row.count_1).unwrap_or(0))
}

/// `query.offset(offset).limit(limit).all()`.
async fn page_rows<M>(mysql: &M, sql: &str) -> MysqlResult<Vec<KindRow>>
where
    M: Mysql,
{
    mysql.fetch_all(sql, ()).await
}

/// A `kinds` row of the paginated listing.
#[derive(Debug, FromMysqlRow)]
struct KindRow {
    kinds_id: i64,
    kinds_user_id: i64,
    kinds_namespace: String,
    kinds_json: Json<KbDocument>,
    kinds_created_at: NaiveDateTime,
    kinds_updated_at: NaiveDateTime,
}

/// `KnowledgeBaseResponse.from_kind(kb, kb.json.get("spec", {}).get("document_count", 0))`.
fn row_to_response(row: &KindRow) -> KnowledgeBaseResponse {
    build_response(
        row.kinds_id,
        row.kinds_user_id,
        &row.kinds_namespace,
        // The listing only selects `is_active IS true` rows.
        true,
        row.kinds_created_at,
        row.kinds_updated_at,
        &row.kinds_json.0.spec,
    )
}

/// A dependency failure maps to the source's unhandled-exception body.
fn internal(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(error = %error, "knowledge-bases list dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

// ---------------------------------------------------------------------------
// Query-parameter validation (FastAPI `RequestValidationError` rendering)
// ---------------------------------------------------------------------------

/// One FastAPI validation-error entry (`{type, loc, msg, input, ctx?}`).
#[derive(Serialize)]
struct ValidationEntry<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    loc: [&'a str; 2],
    msg: &'static str,
    input: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    ctx: Option<ValidationContext>,
}

/// The numeric bound pydantic reports alongside comparison errors.
#[derive(Serialize)]
#[serde(untagged)]
enum ValidationContext {
    GreaterThanEqual { ge: i64 },
    LessThanEqual { le: i64 },
}

impl<'a> ValidationEntry<'a> {
    fn int_parsing(field: &'a str, input: &'a str) -> Self {
        Self {
            kind: "int_parsing",
            loc: ["query", field],
            msg: "Input should be a valid integer, unable to parse string as an integer",
            input,
            ctx: None,
        }
    }

    fn greater_than_equal(field: &'a str, input: &'a str, ge: i64, msg: &'static str) -> Self {
        Self {
            kind: "greater_than_equal",
            loc: ["query", field],
            msg,
            input,
            ctx: Some(ValidationContext::GreaterThanEqual { ge }),
        }
    }

    fn less_than_equal(field: &'a str, input: &'a str, le: i64, msg: &'static str) -> Self {
        Self {
            kind: "less_than_equal",
            loc: ["query", field],
            msg,
            input,
            ctx: Some(ValidationContext::LessThanEqual { le }),
        }
    }
}

/// Parse one query value into an `int`, mirroring FastAPI's `int_parsing`
/// failure with the raw value as `input`.
fn parse_query_int(raw: &str, field: &str) -> Result<i64, FastApiError> {
    raw.trim()
        .parse::<i64>()
        .map_err(|_| FastApiError::validation([ValidationEntry::int_parsing(field, raw)]))
}

/// Wrap one validation entry in the source's 422 array body.
fn bound_error(entry: ValidationEntry<'_>) -> FastApiError {
    FastApiError::validation([entry])
}

#[cfg(test)]
mod tests;
