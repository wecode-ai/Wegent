// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/public-ghosts` — list all public ghosts (admin only).
//!
//! Mirrors `app.api.endpoints.admin.public_ghosts.list_public_ghosts`
//! (`router` prefix `/admin`, mounted under `/api`) together with the
//! `app.core.security.get_admin_user` dependency.
//!
//! Source pipeline:
//! 1. `security.get_current_user` — JWT session decode plus the labeled
//!    `users` lookup (shared [`crate::auth`]).
//! 2. `security.get_admin_user` — rejects a non-admin principal with
//!    `403 {"detail": "Permission denied. Admin access required."}`.
//! 3. `db.query(Kind).filter(user_id == 0, kind == "Ghost").count()` — the
//!    SQLAlchemy `count()` wraps the whole select projection in a subquery.
//! 4. The paginated rows, `ORDER BY updated_at DESC`, `offset`/`limit`.
//!
//! The response is `PublicGhostListResponse` (`total`, `items`) whose items
//! follow the pydantic `PublicGhostResponse` declaration order. `display_name`
//! and `description` are derived from the stored `kinds.json`.
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::http_compat::FastApiError;
use crate::json_compat::{JsonField, OpaqueJson};
use crate::state::AppState;

/// The `kinds` column projection rendered by `db.query(Kind)` (SQLAlchemy
/// labels every column `kinds_<name>`), matching the recorded statement.
const GHOST_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// The ghost filter shared by the count and list statements.
const GHOST_COUNT_FILTER: &str = "kinds.user_id = 0 AND kinds.kind = 'Ghost'";

/// Query parameters: `page` (`ge=1`, default 1) and `limit` (`ge=1`, `le=1000`,
/// default 20).
#[derive(Debug, Deserialize)]
pub struct ListParams {
    #[serde(default)]
    page: Option<String>,
    #[serde(default)]
    limit: Option<String>,
}

/// The validated pagination values.
#[derive(Debug, PartialEq, Eq)]
struct Pagination {
    page: i64,
    limit: i64,
}

impl ListParams {
    /// Validate the FastAPI query contract.
    fn validated(self) -> Result<Pagination, FastApiError> {
        let page = parse_int(self.page.as_deref(), "page", 1, Some(1), None)?;
        let limit = parse_int(self.limit.as_deref(), "limit", 20, Some(1), Some(1000))?;
        Ok(Pagination { page, limit })
    }
}

/// Parse an optional integer query parameter with FastAPI-compatible
/// messages. `default` is used when the parameter is absent.
fn parse_int(
    raw: Option<&str>,
    field: &str,
    default: i64,
    min: Option<i64>,
    max: Option<i64>,
) -> Result<i64, FastApiError> {
    let Some(value) = raw else {
        return Ok(default);
    };
    let parsed = value.parse::<i64>().map_err(|_| {
        validation_error(
            field,
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
        )
    })?;
    if let Some(min) = min
        && parsed < min
    {
        return Err(validation_error(
            field,
            "greater_than_equal",
            &format!("Input should be greater than or equal to {min}"),
        ));
    }
    if let Some(max) = max
        && parsed > max
    {
        return Err(validation_error(
            field,
            "less_than_equal",
            &format!("Input should be less than or equal to {max}"),
        ));
    }
    Ok(parsed)
}

/// One FastAPI validation-error entry for a query parameter.
#[derive(Debug, Serialize)]
struct ValidationEntry<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: &'a str,
}

/// FastAPI-style 422 validation error body.
fn validation_error(field: &str, kind: &str, message: &str) -> FastApiError {
    FastApiError::validation([ValidationEntry {
        kind,
        loc: ["query", field],
        msg: message,
        input: "",
    }])
}

/// A `kinds` row selected with the full labeled source column list; only the
/// response-driving fields are consumed.
#[derive(Debug, FromMysqlRow)]
struct GhostRow {
    #[mysql(rename = "kinds_id")]
    id: i32,
    #[mysql(rename = "kinds_name")]
    name: String,
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[mysql(rename = "kinds_json")]
    json: Json<OpaqueJson>,
    #[mysql(rename = "kinds_is_active")]
    is_active: i8,
    #[mysql(rename = "kinds_created_at")]
    created_at: NaiveDateTime,
    #[mysql(rename = "kinds_updated_at")]
    updated_at: NaiveDateTime,
}

/// `count(*) AS count_1` row.
#[derive(Debug, FromMysqlRow)]
struct CountRow {
    #[mysql(rename = "count_1")]
    count: i64,
}

/// `PublicGhostListResponse` — the top-level JSON body.
#[derive(Debug, Serialize)]
struct PublicGhostListResponse {
    total: i64,
    items: Vec<PublicGhostItem>,
}

/// One `PublicGhostResponse` in pydantic field declaration order. `json` is
/// the stored `kinds.json` (serialized under its `serialization_alias`).
#[derive(Debug, Serialize)]
struct PublicGhostItem {
    id: i32,
    name: String,
    namespace: String,
    display_name: Option<String>,
    description: Option<String>,
    json: OpaqueJson,
    is_active: bool,
    created_at: String,
    updated_at: String,
}

/// `json.metadata` of a ghost CRD.
#[derive(Debug, Deserialize)]
struct GhostMetadata {
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

/// `json.spec` of a ghost CRD.
#[derive(Debug, Deserialize)]
struct GhostSpec {
    description: Option<String>,
}

/// The `kinds.json` fields consumed by the response. `JsonField` mirrors the
/// source's `isinstance(..., dict)` guards: a non-object `metadata`/`spec`
/// yields `None` instead of failing the whole projection.
#[derive(Debug, Deserialize)]
struct GhostJsonView {
    #[serde(default)]
    metadata: JsonField<GhostMetadata>,
    #[serde(default)]
    spec: JsonField<GhostSpec>,
}

/// `GET /api/admin/public-ghosts`.
#[brz_http_server::get("/api/admin/public-ghosts")]
async fn list_public_ghosts(
    #[inject(state)] state: &AppState,
    #[auth] current_user: crate::auth::SessionUser,
    query: brz_http_server::Query<ListParams>,
) -> Result<PublicGhostListResponse, FastApiError> {
    list(state, &current_user, &query).await
}

/// Handler body for `GET /api/admin/public-ghosts`.
async fn list(
    state: &AppState,
    current_user: &crate::auth::SessionUser,
    query: &ListParams,
) -> Result<PublicGhostListResponse, FastApiError> {
    // `get_admin_user` runs as a dependency before the endpoint body.
    if current_user.role != "admin" {
        return Err(FastApiError::forbidden(
            "Permission denied. Admin access required.",
        ));
    }

    let pagination = ListParams {
        page: query.page.clone(),
        limit: query.limit.clone(),
    }
    .validated()?;

    let total = count_public_ghosts(&state.mysql).await?;
    let offset = (pagination.page - 1) * pagination.limit;
    let rows = fetch_public_ghosts(&state.mysql, offset, pagination.limit).await?;
    let items = rows.into_iter().map(build_item).collect();
    Ok(PublicGhostListResponse { total, items })
}

/// `db.query(Kind).filter(user_id == 0, kind == "Ghost").count()`.
async fn count_public_ghosts<M>(mysql: &M) -> Result<i64, FastApiError>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT count(*) AS count_1 \nFROM (SELECT {GHOST_COLUMNS} \nFROM kinds \n\
         WHERE {GHOST_COUNT_FILTER}) AS anon_1"
    );
    let row: Option<CountRow> = mysql
        .fetch_optional(&sql, ())
        .await
        .map_err(|_| FastApiError::unhandled())?;
    Ok(row.map_or(0, |row| row.count))
}

/// The paginated ghost rows, `ORDER BY updated_at DESC LIMIT offset, limit`.
async fn fetch_public_ghosts<M>(
    mysql: &M,
    offset: i64,
    limit: i64,
) -> Result<Vec<GhostRow>, FastApiError>
where
    M: Mysql,
{
    let sql = format!(
        "SELECT {GHOST_COLUMNS} \nFROM kinds \nWHERE {GHOST_COUNT_FILTER} \
         ORDER BY kinds.updated_at DESC \n LIMIT {offset}, {limit}"
    );
    mysql
        .fetch_all(&sql, ())
        .await
        .map_err(|_| FastApiError::unhandled())
}

/// Convert a `kinds` row into a `PublicGhostResponse`.
fn build_item(row: GhostRow) -> PublicGhostItem {
    let view = row.json.0.project::<GhostJsonView>();
    PublicGhostItem {
        id: row.id,
        name: row.name.clone(),
        namespace: row.namespace,
        display_name: ghost_display_name(view.as_ref(), &row.name),
        description: ghost_description(view.as_ref()),
        json: row.json.0,
        is_active: row.is_active != 0,
        created_at: pydantic_datetime(row.created_at),
        updated_at: pydantic_datetime(row.updated_at),
    }
}

/// `_get_ghost_display_name`: `json.metadata.displayName` when it is a
/// non-empty string different from `ghost.name`.
fn ghost_display_name(view: Option<&GhostJsonView>, name: &str) -> Option<String> {
    let display = view?.metadata.value.as_ref()?.display_name.as_deref()?;
    (!display.is_empty() && display != name).then(|| display.to_string())
}

/// `_get_ghost_description`: `json.spec.description` when it is a string.
fn ghost_description(view: Option<&GhostJsonView>) -> Option<String> {
    view?.spec.value.as_ref()?.description.clone()
}

/// pydantic serializes a DB `datetime` as `YYYY-MM-DDTHH:MM:SS`, appending
/// fractional seconds only when nonzero.
fn pydantic_datetime(value: NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        base
    } else {
        format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;
    use chrono::NaiveDate;

    fn dt() -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 9, 24)
            .unwrap()
            .and_hms_opt(3, 54, 53)
            .unwrap()
    }

    /// A serializable `kinds.json` fixture (metadata + spec as in a ghost CRD).
    #[derive(Serialize)]
    struct GhostFixture {
        metadata: MetadataFixture,
        spec: SpecFixture,
    }

    #[derive(Serialize)]
    struct MetadataFixture {
        #[serde(rename = "displayName")]
        display_name: Option<String>,
    }

    #[derive(Serialize)]
    struct SpecFixture {
        description: Option<String>,
    }

    fn ghost_view(display_name: Option<&str>, description: Option<&str>) -> GhostJsonView {
        OpaqueJson::from_serializable(GhostFixture {
            metadata: MetadataFixture {
                display_name: display_name.map(str::to_string),
            },
            spec: SpecFixture {
                description: description.map(str::to_string),
            },
        })
        .project::<GhostJsonView>()
        .expect("fixture projects to a ghost object")
    }

    fn row(display_name: Option<&str>, description: Option<&str>) -> GhostRow {
        GhostRow {
            id: 251882,
            name: "wegent-skill-creator-ghost".to_string(),
            namespace: "default".to_string(),
            json: Json(OpaqueJson::from_serializable(GhostFixture {
                metadata: MetadataFixture {
                    display_name: display_name.map(str::to_string),
                },
                spec: SpecFixture {
                    description: description.map(str::to_string),
                },
            })),
            is_active: 1,
            created_at: dt(),
            updated_at: dt(),
        }
    }

    #[test]
    fn defaults_are_page_1_limit_20() {
        let params = ListParams {
            page: None,
            limit: None,
        }
        .validated()
        .unwrap();
        assert_eq!(params, Pagination { page: 1, limit: 20 });
    }

    #[test]
    fn recorded_query_params_are_accepted() {
        let params = ListParams {
            page: Some("1".to_string()),
            limit: Some("100".to_string()),
        }
        .validated()
        .unwrap();
        assert_eq!(
            params,
            Pagination {
                page: 1,
                limit: 100
            }
        );
    }

    #[test]
    fn out_of_range_limits_are_rejected() {
        for limit in ["0", "1001"] {
            let error = ListParams {
                page: None,
                limit: Some(limit.to_string()),
            }
            .validated()
            .unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
        let error = ListParams {
            page: Some("0".to_string()),
            limit: None,
        }
        .validated()
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn non_integer_params_are_rejected() {
        let error = ListParams {
            page: Some("abc".to_string()),
            limit: None,
        }
        .validated()
        .unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn display_name_matches_name_is_null() {
        let name = "ghost";
        assert_eq!(
            ghost_display_name(Some(&ghost_view(Some("ghost"), None)), name),
            None
        );
        assert_eq!(
            ghost_display_name(Some(&ghost_view(Some("Pretty"), None)), name),
            Some("Pretty".to_string())
        );
        assert_eq!(
            ghost_display_name(Some(&ghost_view(Some(""), None)), name),
            None
        );
        assert_eq!(
            ghost_display_name(Some(&ghost_view(None, None)), name),
            None
        );
    }

    #[test]
    fn description_reads_spec_description() {
        let view = ghost_view(None, Some("hello"));
        assert_eq!(ghost_description(Some(&view)), Some("hello".to_string()));
        let view = ghost_view(None, None);
        assert_eq!(ghost_description(Some(&view)), None);
        assert_eq!(ghost_description(None), None);
    }

    #[test]
    fn item_has_pydantic_field_order_and_shape() {
        let item = build_item(row(None, None));
        // Render through the project's opaque-JSON helper so the assertion is
        // the exact pydantic field order and null shape, without naming the
        // `serde_json` crate.
        let rendered = OpaqueJson::from_serializable(&item).to_raw_value();
        assert_eq!(
            rendered.get(),
            r#"{"id":251882,"name":"wegent-skill-creator-ghost","namespace":"default","display_name":null,"description":null,"json":{"metadata":{"displayName":null},"spec":{"description":null}},"is_active":true,"created_at":"2026-09-24T03:54:53","updated_at":"2026-09-24T03:54:53"}"#
        );
    }

    #[test]
    fn pydantic_datetime_renders_without_fraction() {
        assert_eq!(pydantic_datetime(dt()), "2026-09-24T03:54:53");
    }

    #[tokio::test]
    async fn queries_match_the_recorded_statements() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let total = count_public_ghosts(&mysql).await.unwrap();
        assert_eq!(total, 0);
        let _ = fetch_public_ghosts(&mysql, 0, 100).await.unwrap();
        let queries = mysql.queries();
        assert_eq!(queries.len(), 2);
        assert_eq!(
            queries[0].sql,
            format!(
                "SELECT count(*) AS count_1 FROM (SELECT {GHOST_COLUMNS} FROM kinds \
                 WHERE kinds.user_id = 0 AND kinds.kind = 'Ghost') AS anon_1"
            )
        );
        assert_eq!(queries[0].args, 0);
        assert_eq!(
            queries[1].sql,
            format!(
                "SELECT {GHOST_COLUMNS} FROM kinds WHERE kinds.user_id = 0 AND \
                 kinds.kind = 'Ghost' ORDER BY kinds.updated_at DESC LIMIT 0, 100"
            )
        );
        assert_eq!(queries[1].args, 0);
    }
}
