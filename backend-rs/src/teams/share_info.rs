// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/teams/share/info`
//! (`app.api.endpoints.adapter.teams.get_share_info` ->
//! `SharedTeamService.get_share_info`, `app/services/shared_team.py`).
//!
//! The source route declares no authentication dependency: the share token is
//! the credential. Flow, in source order:
//! 1. `decode_share_token`: `urllib.parse.unquote` + AES-CBC/PKCS#7 decrypt of
//!    `"{user_id}#{team_id}"`, then the active `users` row (`User.id`,
//!    `is_active`) and the active Team `kinds` row (`Kind.id`, `kind`,
//!    `is_active`, no owner predicate), rendering `user_name` and the Team
//!    `name`/`spec.bind_mode`.
//! 2. Any decode, parse, user read, or Team read failure is the route's
//!    `400 "Invalid share token"`.
//! 3. `get_share_info` re-reads the same Team constrained to
//!    `Kind.user_id == token user_id`; a miss is
//!    `404 "Team not found or no longer available"`.
//!
//! `bind_mode` is `Optional[List[str]]` in the source schema, so it renders as
//! JSON `null` when the Team spec omits it.

use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Serialize;
use serde_json::Value;

use crate::attachments::share_token::decode_id_pair;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::teams::teams_repository::{KIND_COLUMNS, USER_COLUMNS};

/// `400 "Invalid share token"` (`SharedTeamService.get_share_info`).
const INVALID_SHARE_TOKEN: &str = "Invalid share token";
/// `404 "Team not found or no longer available"` (`get_share_info`).
const TEAM_NOT_AVAILABLE: &str = "Team not found or no longer available";

/// `TeamShareInfo` (`app/schemas/shared_team.py`). Field order is the source
/// model's declaration order, which FastAPI serializes verbatim.
#[derive(Debug, Serialize)]
struct TeamShareInfo {
    user_id: i64,
    user_name: String,
    team_id: i64,
    team_name: String,
    bind_mode: Option<Vec<String>>,
}

/// The required `share_token` query parameter (`Query(...)`).
#[derive(Debug, serde::Deserialize)]
struct ShareInfoQuery {
    share_token: Option<String>,
}

/// One active `users` row (`db.query(User).filter(User.id, User.is_active)`).
/// The full projection matches the recorded SQLAlchemy rendering; only
/// `user_name` is read here.
#[derive(Debug, FromMysqlRow)]
struct ActiveUserRow {
    #[allow(dead_code)]
    users_id: i64,
    users_user_name: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_password_hash")]
    users_password_hash: String,
    #[allow(dead_code)]
    users_email: Option<String>,
    #[allow(dead_code)]
    users_git_info: Json<brz_json::OpaqueJson>,
    #[allow(dead_code)]
    users_is_active: i8,
    #[allow(dead_code)]
    #[mysql(rename = "users_role")]
    users_role: String,
    #[allow(dead_code)]
    users_auth_source: String,
    #[allow(dead_code)]
    users_preferences: String,
    #[allow(dead_code)]
    users_created_at: Option<NaiveDateTime>,
    #[allow(dead_code)]
    users_updated_at: Option<NaiveDateTime>,
}

/// One active `kinds` row with the full `db.query(Kind)` projection.
#[derive(Debug, FromMysqlRow)]
struct TeamKindRow {
    #[allow(dead_code)]
    kinds_id: i64,
    #[allow(dead_code)]
    kinds_user_id: i64,
    #[allow(dead_code)]
    kinds_kind: String,
    kinds_name: String,
    #[allow(dead_code)]
    kinds_namespace: String,
    kinds_json: Json<Value>,
    #[allow(dead_code)]
    kinds_is_active: i8,
    #[allow(dead_code)]
    kinds_created_at: NaiveDateTime,
    #[allow(dead_code)]
    kinds_updated_at: NaiveDateTime,
}

/// GET /api/teams/share/info: the source declares no authentication
/// dependency, so the route is public.
#[brz_http_server::get("/api/teams/share/info", access = public)]
async fn get_team_share_info(
    #[inject(state)] state: &AppState,
    query: brz_http_server::Query<ShareInfoQuery>,
) -> Result<TeamShareInfo, FastApiError> {
    let Some(share_token) = query.share_token.as_deref() else {
        return Err(missing_share_token());
    };
    team_share_info(state, share_token).await
}

/// The endpoint flow after route dispatch.
async fn team_share_info(
    state: &AppState,
    share_token: &str,
) -> Result<TeamShareInfo, FastApiError> {
    // `decode_share_token`: `_aes_decrypt` + the `"{user_id}#{team_id}"` parse.
    let Some((user_id, team_id)) = decode_id_pair(share_token) else {
        return Err(bad_request(INVALID_SHARE_TOKEN));
    };

    // The source runs both reads unconditionally (`user = ...; team = ...;
    // if not user or not team: return None`), so neither may short-circuit the
    // other.
    let user = active_user(&state.mysql, user_id)
        .await
        .map_err(unhandled)?;
    let team = active_team(&state.mysql, team_id)
        .await
        .map_err(unhandled)?;
    let (Some(user), Some(team)) = (user, team) else {
        return Err(bad_request(INVALID_SHARE_TOKEN));
    };

    // `TeamShareInfo(...)`: a `bind_mode` value the source model cannot
    // validate raises inside `decode_share_token`'s `try`, which the source
    // collapses to the same `400 Invalid share token`.
    let bind_mode = team_bind_mode(&team.kinds_json.0)?;
    let user_name = user.users_user_name;
    let team_name = team.kinds_name;

    // `get_share_info`: re-read the Team owned by the token user.
    let owned = owned_active_team(&state.mysql, team_id, user_id)
        .await
        .map_err(unhandled)?;
    if owned.is_none() {
        return Err(not_found(TEAM_NOT_AVAILABLE));
    }

    Ok(TeamShareInfo {
        user_id,
        user_name,
        team_id,
        team_name,
        bind_mode,
    })
}

/// `db.query(User).filter(User.id == user_id, User.is_active == True).first()`.
async fn active_user<M>(mysql: &M, user_id: i64) -> MysqlResult<Option<ActiveUserRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            format!(
                "SELECT {USER_COLUMNS} \nFROM users \n\
                 WHERE users.id = ? AND users.is_active = true \n LIMIT 1"
            )
            .as_str(),
            (user_id,),
        )
        .await
}

/// `db.query(Kind).filter(Kind.id == team_id, Kind.kind == "Team",
/// Kind.is_active == True).first()`: the decode-time read, which does not
/// constrain the owner.
async fn active_team<M>(mysql: &M, team_id: i64) -> MysqlResult<Option<TeamKindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \n\
                 WHERE kinds.id = ? AND kinds.kind = 'Team' \
                 AND kinds.is_active = true \n LIMIT 1"
            )
            .as_str(),
            (team_id,),
        )
        .await
}

/// `db.query(Kind).filter(Kind.id == team_id, Kind.user_id == user_id,
/// Kind.kind == "Team", Kind.is_active == True).first()`: the
/// `get_share_info` re-read that pins the token's owner.
async fn owned_active_team<M>(
    mysql: &M,
    team_id: i64,
    user_id: i64,
) -> MysqlResult<Option<TeamKindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \n\
                 WHERE kinds.id = ? AND kinds.user_id = ? AND kinds.kind = 'Team' \
                 AND kinds.is_active = true \n LIMIT 1"
            )
            .as_str(),
            (team_id, user_id),
        )
        .await
}

/// `team.json.get("spec", {}).get("bind_mode")` coerced to
/// `Optional[List[str]]`:
/// - a non-object document is not a `dict`, so the source yields `None`;
/// - an absent `spec` or `bind_mode` yields `None` (`bind_mode: null`);
/// - a non-object `spec` raises `AttributeError` inside the source's `try`,
///   and a `bind_mode` the schema cannot validate raises `ValidationError`;
///   both collapse to `400 Invalid share token`.
fn team_bind_mode(team_json: &Value) -> Result<Option<Vec<String>>, FastApiError> {
    let Some(document) = team_json.as_object() else {
        return Ok(None);
    };
    let Some(spec) = document.get("spec") else {
        return Ok(None);
    };
    let Some(spec) = spec.as_object() else {
        return Err(bad_request(INVALID_SHARE_TOKEN));
    };
    match spec.get("bind_mode") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|_| bad_request(INVALID_SHARE_TOKEN)),
    }
}

/// FastAPI's `Query(...)` rejection for a missing required parameter.
fn missing_share_token() -> FastApiError {
    FastApiError::validation(serde_json::json!([
        {
            "type": "missing",
            "loc": ["query", "share_token"],
            "msg": "Field required",
            "input": serde_json::Value::Null,
        }
    ]))
}

fn bad_request(detail: &'static str) -> FastApiError {
    FastApiError::detail(StatusCode::BAD_REQUEST, detail)
}

fn not_found(detail: &'static str) -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, detail)
}

/// A dependency failure is unhandled in the source, so the application's
/// exception handler renders `500 {"error_code":500,"detail":"Internal
/// server error"}`.
fn unhandled(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(%error, "[team_share_info] database error");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;
    use serde_json::json;

    #[test]
    fn response_serializes_in_the_source_field_order() {
        let info = TeamShareInfo {
            user_id: 7,
            user_name: "sharer".to_string(),
            team_id: 42,
            team_name: "team".to_string(),
            bind_mode: Some(vec!["chat".to_string()]),
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"user_id":7,"user_name":"sharer","team_id":42,"team_name":"team","bind_mode":["chat"]}"#
        );
    }

    #[test]
    fn absent_bind_mode_renders_null() {
        let info = TeamShareInfo {
            user_id: 7,
            user_name: "sharer".to_string(),
            team_id: 42,
            team_name: "team".to_string(),
            bind_mode: None,
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"user_id":7,"user_name":"sharer","team_id":42,"team_name":"team","bind_mode":null}"#
        );
    }

    #[test]
    fn team_bind_mode_reads_the_team_spec_list() {
        let document = json!({"spec": {"bind_mode": ["chat", "code"]}});
        assert_eq!(
            team_bind_mode(&document).unwrap(),
            Some(vec!["chat".to_string(), "code".to_string()])
        );
    }

    #[test]
    fn team_bind_mode_is_none_for_missing_document_spec_or_value() {
        for document in [
            json!({}),
            json!({"spec": {}}),
            json!({"spec": {"bind_mode": null}}),
            json!("not-an-object"),
            json!(null),
        ] {
            assert_eq!(team_bind_mode(&document).unwrap(), None, "{document}");
        }
    }

    #[test]
    fn team_bind_mode_rejects_a_non_mapping_spec_and_non_string_values() {
        // A non-object `spec` makes the source's `.get` raise `AttributeError`,
        // and a non-string entry fails `Optional[List[str]]` validation; both
        // surface as `400 Invalid share token`.
        for document in [
            json!({"spec": null}),
            json!({"spec": ["chat"]}),
            json!({"spec": {"bind_mode": "chat"}}),
            json!({"spec": {"bind_mode": [1, 2]}}),
        ] {
            let error = team_bind_mode(&document).unwrap_err();
            assert_eq!(error.status(), StatusCode::BAD_REQUEST);
            assert_eq!(error.validation_detail(), "\"Invalid share token\"");
        }
    }

    #[test]
    fn missing_share_token_matches_the_fastapi_query_error() {
        let error = missing_share_token();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            error.validation_detail(),
            r#"[{"type":"missing","loc":["query","share_token"],"msg":"Field required","input":null}]"#
        );
    }

    #[tokio::test]
    async fn active_user_reads_the_active_row_with_the_recorded_projection() {
        let capture = KindQueryCapture::default();
        assert!(active_user(&capture, 7).await.unwrap().is_none());
        let queries = capture.queries();
        assert_eq!(queries.len(), 1);
        assert!(
            queries[0]
                .sql
                .contains("users.id = ? AND users.is_active = true")
        );
        assert!(queries[0].sql.starts_with("SELECT users.id AS users_id"));
        assert_eq!(queries[0].args, 1);
        assert_eq!(queries[0].first_integer, Some(7));
    }

    #[tokio::test]
    async fn decode_time_team_read_does_not_constrain_the_owner() {
        let capture = KindQueryCapture::default();
        assert!(active_team(&capture, 42).await.unwrap().is_none());
        let queries = capture.queries();
        assert_eq!(queries.len(), 1);
        assert!(
            queries[0]
                .sql
                .contains("WHERE kinds.id = ? AND kinds.kind = 'Team'")
        );
        // The projection selects `kinds.user_id`, but the decode-time WHERE
        // clause must not constrain the owner.
        assert!(!queries[0].sql.contains("AND kinds.user_id"));
        assert_eq!(queries[0].args, 1);
        assert_eq!(queries[0].first_integer, Some(42));
    }

    #[tokio::test]
    async fn owner_revalidation_pins_the_token_user() {
        let capture = KindQueryCapture::default();
        assert!(owned_active_team(&capture, 42, 7).await.unwrap().is_none());
        let queries = capture.queries();
        assert_eq!(queries.len(), 1);
        assert!(
            queries[0]
                .sql
                .contains("kinds.id = ? AND kinds.user_id = ? AND kinds.kind = 'Team'")
        );
        assert_eq!(queries[0].args, 2);
        assert_eq!(queries[0].first_integer, Some(42));
    }

    /// Unverified cutovers keep Python ownership while their handlers stay registered.
    #[test]
    fn registered_route_keeps_python_ownership() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == "/api/teams/share/info"
                    && rule.methods.iter().any(|method| method == "GET")),
            "GET /api/teams/share/info must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::GET, "/api/teams/share/info"));
        assert!(!table.matches(&http::Method::POST, "/api/teams/share/info"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == "/api/teams/share/info" && route.methods & GET != 0);
        assert!(
            registered,
            "GET /api/teams/share/info must be registered by the router"
        );
    }
}
