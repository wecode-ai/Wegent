// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/public-teams` — admin list of public Team kinds.
//!
//! Mirrors `app.api.endpoints.admin.public_teams.list_public_teams`
//! (route `/public-teams`, router prefix `/admin`, mounted under `/api`).
//!
//! Source pipeline:
//! 1. `security.get_admin_user` — the standard bearer-session lookup
//!    (`get_current_user`) followed by a `role == "admin"` check that rejects
//!    a non-admin principal with `403 {"detail": "Permission denied. Admin
//!    access required."}`.
//! 2. `db.query(Kind).filter(user_id == 0, kind == "Team")` — count every
//!    public team (no `is_active` filter).
//! 3. The same query ordered by `updated_at DESC` and paginated with
//!    `LIMIT (page - 1) * limit, limit`.
//! 4. Each row becomes a `PublicTeamResponse`: `display_name` from
//!    `json.metadata.displayName` (omitted when empty or equal to `name`),
//!    `description` from `json.spec.description`, `display_config` from
//!    `json.spec.displayConfig` (a `TeamDisplayConfig`, always rendered with
//!    its single `show_final_answer_only` field), `json` echoed verbatim,
//!    and second-precision naive datetimes.
use brz_mysql::{FromMysqlRow, Json};
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::http_compat::FastApiError;
use crate::json_compat::{JsonNull, OpaqueJson};
use crate::state::AppState;

/// `kinds` projection rendered by `db.query(Kind)` (SQLAlchemy labels every
/// column `kinds_<name>`); shared by the count subquery and the page query.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// A public-team `kinds` row, selected with the full labeled source column
/// list so the prepared statement matches the recorded exchange for replay.
#[derive(Debug, FromMysqlRow)]
struct PublicTeamRow {
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_kind")]
    kind: String,
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
    count_1: i64,
}

/// The subset of the Team CRD (`kinds.json`) the response reads. A value that
/// is not a JSON object, or that carries a mismatched field type, fails to
/// deserialize and falls back to the empty defaults, matching the source's
/// defensive `isinstance` checks.
#[derive(Debug, Default, Deserialize, Serialize)]
struct TeamCrd {
    #[serde(default)]
    spec: Option<TeamSpec>,
    #[serde(default)]
    metadata: Option<TeamMetadata>,
}

/// `json.spec` fields used by the response.
#[derive(Debug, Default, Deserialize, Serialize)]
struct TeamSpec {
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "displayConfig")]
    display_config: Option<TeamDisplayConfig>,
}

/// `json.spec.displayConfig`.
#[derive(Debug, Default, Deserialize, Serialize)]
struct TeamDisplayConfig {
    #[serde(default)]
    show_final_answer_only: Option<bool>,
}

/// `json.metadata`.
#[derive(Debug, Default, Deserialize, Serialize)]
struct TeamMetadata {
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
}

/// One `PublicTeamResponse`; `team_json` is serialized under the source's
/// `json` alias.
#[derive(Debug, Serialize)]
struct PublicTeamResponse {
    id: i64,
    name: String,
    namespace: String,
    display_name: Option<String>,
    description: Option<String>,
    display_config: TeamDisplayConfig,
    #[serde(rename = "json")]
    team_json: OpaqueJson,
    is_active: bool,
    created_at: String,
    updated_at: String,
}

/// `PublicTeamListResponse`.
#[derive(Debug, Serialize)]
struct PublicTeamListResponse {
    total: i64,
    items: Vec<PublicTeamResponse>,
}

/// Query parameters (`page >= 1` default 1, `limit >= 1` and `<= 1000`
/// default 20). Values are kept as strings so a non-integer renders the
/// FastAPI 422 body instead of a deserialization failure. `chat_only` and any
/// other unknown parameter are ignored, matching FastAPI.
#[derive(Debug, Default, Deserialize)]
pub struct PublicTeamsQuery {
    pub page: Option<String>,
    pub limit: Option<String>,
}

/// Validated pagination parameters.
#[derive(Debug, PartialEq, Eq)]
struct PublicTeamsParams {
    page: i64,
    limit: i64,
}

/// One entry of FastAPI's 422 validation-error `detail` array.
#[derive(Debug, Serialize)]
struct ValidationEntry<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: JsonNull,
}

/// FastAPI-style 422 validation-error body for a `Query(...)` constraint.
fn validation_error(field: &str, kind: &str, message: &str) -> FastApiError {
    FastApiError::validation(vec![ValidationEntry {
        kind,
        loc: ["query", field],
        msg: message,
        input: JsonNull,
    }])
}

impl PublicTeamsQuery {
    /// Validate the FastAPI query contract: `page >= 1`,
    /// `1 <= limit <= 1000`.
    fn validated(&self) -> Result<PublicTeamsParams, FastApiError> {
        let page = parse_int(self.page.as_deref(), "page", 1, 1, i64::MAX)?;
        let limit = parse_int(self.limit.as_deref(), "limit", 20, 1, 1000)?;
        Ok(PublicTeamsParams { page, limit })
    }
}

/// Parse one optional integer query parameter with FastAPI's messages.
fn parse_int(
    raw: Option<&str>,
    field: &str,
    default: i64,
    min: i64,
    max: i64,
) -> Result<i64, FastApiError> {
    let Some(value) = raw else {
        return Ok(default);
    };
    match value.parse::<i64>() {
        Ok(parsed) if parsed < min => Err(validation_error(
            field,
            "greater_than_equal",
            "Input should be greater than or equal to 1",
        )),
        Ok(parsed) if parsed > max => Err(validation_error(
            field,
            "less_than_equal",
            "Input should be less than or equal to 1000",
        )),
        Ok(parsed) => Ok(parsed),
        Err(_) => Err(validation_error(
            field,
            "int_parsing",
            "Input should be a valid integer, unable to parse string as an integer",
        )),
    }
}

/// The count query (`query.count()`): the projection wrapped in a subquery.
fn count_sql() -> String {
    format!(
        "SELECT count(*) AS count_1 \nFROM (SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = 0 AND kinds.kind = 'Team') AS anon_1"
    )
}

/// The paginated page query ordered by `updated_at DESC`.
fn list_sql(skip: i64, limit: i64) -> String {
    format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \n\
         WHERE kinds.user_id = 0 AND kinds.kind = 'Team' \
         ORDER BY kinds.updated_at DESC \n LIMIT {skip}, {limit}"
    )
}

/// `_get_team_display_name` / `_get_team_description` /
/// `_get_team_display_config`: read the three response fields off the parsed
/// `kinds.json` object.
fn team_fields(crd: &TeamCrd, team_name: &str) -> (Option<String>, Option<String>, Option<bool>) {
    let description = crd.spec.as_ref().and_then(|spec| spec.description.clone());
    let show_final_answer_only = crd
        .spec
        .as_ref()
        .and_then(|spec| spec.display_config.as_ref())
        .and_then(|config| config.show_final_answer_only);
    let display_name = crd
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.display_name.clone())
        .filter(|name| !name.is_empty() && name != team_name);
    (display_name, description, show_final_answer_only)
}

/// pydantic v2 naive-`datetime` serialization: `YYYY-MM-DDTHH:MM:SS`
/// (microseconds appended only when non-zero).
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.f").to_string()
    }
}

/// `_team_to_response`.
fn team_response(row: &PublicTeamRow) -> PublicTeamResponse {
    let crd: TeamCrd = row.json.0.project().unwrap_or_default();
    let (display_name, description, show_final_answer_only) = team_fields(&crd, &row.name);
    PublicTeamResponse {
        id: row.id,
        name: row.name.clone(),
        namespace: row.namespace.clone(),
        display_name,
        description,
        display_config: TeamDisplayConfig {
            show_final_answer_only,
        },
        team_json: row.json.0.clone(),
        is_active: row.is_active != 0,
        created_at: pydantic_datetime(row.created_at),
        updated_at: pydantic_datetime(row.updated_at),
    }
}

/// `get_admin_user`: reject a non-admin principal with the source's 403 body.
fn ensure_admin(role: &str) -> Result<(), FastApiError> {
    if role == "admin" {
        Ok(())
    } else {
        Err(FastApiError::forbidden(
            "Permission denied. Admin access required.",
        ))
    }
}

/// GET /api/admin/public-teams: the public-teams free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/admin/public-teams")]
async fn list_public_teams(
    #[inject(state)] state: &AppState,
    #[auth] user: crate::auth::SessionUser,
    query: brz_http_server::Query<PublicTeamsQuery>,
) -> Result<PublicTeamListResponse, FastApiError> {
    public_teams(state, &user, &query).await
}

/// Handler body for `GET /api/admin/public-teams`.
async fn public_teams(
    state: &AppState,
    user: &crate::auth::SessionUser,
    query: &PublicTeamsQuery,
) -> Result<PublicTeamListResponse, FastApiError> {
    // `get_admin_user`: reject a non-admin principal with a 403 body before
    // any query runs.
    ensure_admin(&user.role)?;

    let params = query.validated()?;
    let skip = (params.page - 1) * params.limit;

    let count: CountRow = state
        .mysql
        .fetch_one(count_sql(), ())
        .await
        .map_err(|error| {
            tracing::error!(%error, "admin public-teams count database failure");
            FastApiError::internal()
        })?;

    let rows: Vec<PublicTeamRow> = state
        .mysql
        .fetch_all(list_sql(skip, params.limit), ())
        .await
        .map_err(|error| {
            tracing::error!(%error, "admin public-teams list database failure");
            FastApiError::internal()
        })?;

    Ok(PublicTeamListResponse {
        total: count.count_1,
        items: rows.iter().map(team_response).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;

    fn query(page: Option<&str>, limit: Option<&str>) -> PublicTeamsQuery {
        PublicTeamsQuery {
            page: page.map(str::to_owned),
            limit: limit.map(str::to_owned),
        }
    }

    #[test]
    fn query_defaults_and_bounds_follow_fastapi() {
        let params = query(None, None).validated().unwrap();
        assert_eq!(params, PublicTeamsParams { page: 1, limit: 20 });

        for bad in [Some("0"), Some("x"), Some(""), Some("-1")] {
            assert_eq!(
                query(bad, None).validated().unwrap_err().status(),
                StatusCode::UNPROCESSABLE_ENTITY,
                "page={bad:?}"
            );
        }
        assert_eq!(
            query(Some("1"), Some("0"))
                .validated()
                .unwrap_err()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            query(Some("1"), Some("1001"))
                .validated()
                .unwrap_err()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            query(Some("2"), Some("1000")).validated().unwrap(),
            PublicTeamsParams {
                page: 2,
                limit: 1000
            }
        );
    }

    #[test]
    fn unknown_query_parameters_are_ignored() {
        let brz_http_server::Query(parsed) = brz_http_server::__private::query_object::<
            PublicTeamsQuery,
        >(Some("page=1&limit=100&chat_only=false"))
        .unwrap();
        assert_eq!(parsed.page.as_deref(), Some("1"));
        assert_eq!(parsed.limit.as_deref(), Some("100"));
    }

    #[test]
    fn sql_statements_match_the_recorded_rendering() {
        assert_eq!(
            count_sql(),
            "SELECT count(*) AS count_1 \n\
             FROM (SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \n\
             FROM kinds \n\
             WHERE kinds.user_id = 0 AND kinds.kind = 'Team') AS anon_1"
        );
        assert_eq!(
            list_sql(0, 100),
            "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
             kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
             kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
             kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
             kinds.updated_at AS kinds_updated_at \n\
             FROM kinds \n\
             WHERE kinds.user_id = 0 AND kinds.kind = 'Team' \
             ORDER BY kinds.updated_at DESC \n LIMIT 0, 100"
        );
    }

    fn sample_crd() -> TeamCrd {
        TeamCrd {
            spec: Some(TeamSpec {
                description: Some("desc".to_owned()),
                display_config: Some(TeamDisplayConfig {
                    show_final_answer_only: Some(true),
                }),
            }),
            metadata: Some(TeamMetadata {
                display_name: Some("Alpha".to_owned()),
            }),
        }
    }

    #[test]
    fn extracts_display_fields_from_the_crd() {
        assert_eq!(
            team_fields(&sample_crd(), "alpha"),
            (
                Some("Alpha".to_owned()),
                Some("desc".to_owned()),
                Some(true)
            )
        );
        // displayName equal to name is dropped.
        assert_eq!(
            team_fields(&sample_crd(), "Alpha"),
            (None, Some("desc".to_owned()), Some(true))
        );
        // A missing displayConfig renders null.
        let crd = TeamCrd {
            spec: Some(TeamSpec {
                description: None,
                display_config: None,
            }),
            metadata: None,
        };
        assert_eq!(team_fields(&crd, "alpha"), (None, None, None));
    }

    #[test]
    fn non_object_json_yields_defaults() {
        let opaque = OpaqueJson::from_serializable(["not", "an", "object"]);
        assert!(opaque.project::<TeamCrd>().is_none());
    }

    #[test]
    fn response_shape_matches_the_source_model() {
        #[derive(Serialize)]
        struct ExpectedItem {
            id: i64,
            name: String,
            namespace: String,
            display_name: Option<String>,
            description: Option<String>,
            display_config: TeamDisplayConfig,
            #[serde(rename = "json")]
            team_json: OpaqueJson,
            is_active: bool,
            created_at: String,
            updated_at: String,
        }
        #[derive(Serialize)]
        struct ExpectedBody {
            total: i64,
            items: Vec<ExpectedItem>,
        }

        let crd = sample_crd();
        let team_json = OpaqueJson::from_serializable(&crd);
        let timestamp =
            NaiveDateTime::parse_from_str("2026-09-22T02:41:57", "%Y-%m-%dT%H:%M:%S").unwrap();
        let row = PublicTeamRow {
            id: 1,
            user_id: 0,
            kind: "Team".to_owned(),
            name: "alpha".to_owned(),
            namespace: "default".to_owned(),
            json: Json(team_json.clone()),
            is_active: 1,
            created_at: timestamp,
            updated_at: timestamp,
        };
        let actual = PublicTeamListResponse {
            total: 1,
            items: vec![team_response(&row)],
        };
        let expected = ExpectedBody {
            total: 1,
            items: vec![ExpectedItem {
                id: 1,
                name: "alpha".to_owned(),
                namespace: "default".to_owned(),
                display_name: Some("Alpha".to_owned()),
                description: Some("desc".to_owned()),
                display_config: TeamDisplayConfig {
                    show_final_answer_only: Some(true),
                },
                team_json,
                is_active: true,
                created_at: "2026-09-22T02:41:57".to_owned(),
                updated_at: "2026-09-22T02:41:57".to_owned(),
            }],
        };
        assert_eq!(
            crate::json_contract_tests::serialized(actual).unwrap(),
            crate::json_contract_tests::serialized(expected).unwrap()
        );
    }

    #[test]
    fn admin_check_rejects_non_admin() {
        assert!(ensure_admin("admin").is_ok());
        for role in ["user", "", "Admin"] {
            let error = ensure_admin(role).unwrap_err();
            assert_eq!(error.status(), StatusCode::FORBIDDEN, "role={role:?}");
            assert_eq!(
                error.detail_message(),
                Some("Permission denied. Admin access required.")
            );
        }
    }
}
