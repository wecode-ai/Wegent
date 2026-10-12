// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/users` — the admin user listing.
//!
//! Mirrors `app.api.endpoints.admin.users.list_all_users` (the router is
//! included by `app.api.endpoints.admin.router` and mounted under
//! `prefix="/admin"` in `app.api.api`, so the public path is
//! `/api/admin/users`):
//!
//! 1. authenticate the bearer token (`Depends(get_current_user)`); a missing or
//!    invalid credential or an inactive user is the standard session `401`;
//! 2. require an admin role (`Depends(get_admin_user)` — a non-admin session is
//!    `403 {"detail": "Permission denied. Admin access required."}`);
//! 3. validate the FastAPI query contract (`page >= 1` default 1,
//!    `1 <= limit <= 100` default 20, `include_inactive` default false, and an
//!    optional `search`);
//! 4. count the filtered `users` rows (`query.count()`);
//! 5. load one page with `.offset((page - 1) * limit).limit(limit)`;
//! 6. render `AdminUserListResponse` (`total`, `items`), each item the
//!    `AdminUserResponse` projection of a `User` row.
//!
//! Sub-dependencies resolve before the endpoint's own query validation, so the
//! sequence is authentication, then the admin check, then query validation.

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// FastAPI `Query(1, ge=1)` default for `page`.
const DEFAULT_PAGE: i64 = 1;
/// FastAPI `Query(20, ge=1, le=100)` default for `limit`.
const DEFAULT_LIMIT: i64 = 20;

/// `get_admin_user`'s 403 detail for a non-admin session.
const ADMIN_REQUIRED_DETAIL: &str = "Permission denied. Admin access required.";

/// The `users` column projection, labeled like SQLAlchemy's query rendering
/// (`users.<column> AS users_<column>`) so the prepared statement matches the
/// recorded exchange. The column list is the full `User` mapping.
const USER_COLUMNS: &str = "users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at";

/// The endpoint's query parameters. Every value is captured as an optional
/// string so binding never fails; the FastAPI-compatible constraints are
/// validated in the handler after authentication and the admin check, matching
/// the source dependency order.
#[derive(Debug, Default, Deserialize)]
pub struct UserListQuery {
    pub page: Option<String>,
    pub limit: Option<String>,
    pub include_inactive: Option<String>,
    pub search: Option<String>,
}

/// The effective query contract after FastAPI-compatible validation.
#[derive(Debug, PartialEq, Eq)]
struct UserListParams {
    page: i64,
    limit: i64,
    include_inactive: bool,
    search: Option<String>,
}

/// One entry of FastAPI's 422 validation-error array (`{type, loc, msg, input}`).
#[derive(Debug, Serialize)]
struct QueryValidationError<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: String,
    input: &'a str,
}

impl UserListQuery {
    /// Validate the FastAPI query contract in signature order: `page >= 1`,
    /// `1 <= limit <= 100`, a boolean `include_inactive`, and an optional
    /// `search`. Pydantic reports every field error at once.
    fn validated(&self) -> Result<UserListParams, FastApiError> {
        let mut errors: Vec<QueryValidationError<'_>> = Vec::new();
        let page = parse_int(&self.page, "page", DEFAULT_PAGE, 1, i64::MAX, &mut errors);
        let limit = parse_int(&self.limit, "limit", DEFAULT_LIMIT, 1, 100, &mut errors);
        let include_inactive = parse_bool(
            &self.include_inactive,
            "include_inactive",
            false,
            &mut errors,
        );
        if !errors.is_empty() {
            return Err(FastApiError::validation(errors));
        }
        Ok(UserListParams {
            page,
            limit,
            include_inactive,
            // `if search:` treats an empty string as absent.
            search: self.search.clone().filter(|value| !value.is_empty()),
        })
    }
}

/// One FastAPI query-validation entry.
fn validation_error<'a>(
    kind: &'a str,
    field: &'a str,
    msg: impl Into<String>,
    input: &'a str,
) -> QueryValidationError<'a> {
    QueryValidationError {
        kind,
        loc: ["query", field],
        msg: msg.into(),
        input,
    }
}

/// Parse an optional integer query parameter. On failure the FastAPI default is
/// returned and one validation error is recorded.
fn parse_int<'a>(
    raw: &'a Option<String>,
    field: &'a str,
    default: i64,
    min: i64,
    max: i64,
    errors: &mut Vec<QueryValidationError<'a>>,
) -> i64 {
    let Some(value) = raw else {
        return default;
    };
    match value.parse::<i64>() {
        Ok(parsed) if parsed < min => {
            errors.push(validation_error(
                "greater_than_equal",
                field,
                format!("Input should be greater than or equal to {min}"),
                value,
            ));
            default
        }
        Ok(parsed) if parsed > max => {
            errors.push(validation_error(
                "less_than_equal",
                field,
                format!("Input should be less than or equal to {max}"),
                value,
            ));
            default
        }
        Ok(parsed) => parsed,
        Err(_) => {
            errors.push(validation_error(
                "int_parsing",
                field,
                "Input should be a valid integer, unable to parse string as an integer",
                value,
            ));
            default
        }
    }
}

/// Parse an optional boolean query parameter using pydantic's accepted literal
/// set. On failure the FastAPI default is returned and one validation error is
/// recorded.
fn parse_bool<'a>(
    raw: &'a Option<String>,
    field: &'a str,
    default: bool,
    errors: &mut Vec<QueryValidationError<'a>>,
) -> bool {
    let Some(value) = raw else {
        return default;
    };
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" | "y" | "t" => true,
        "false" | "0" | "no" | "off" | "n" | "f" => false,
        _ => {
            errors.push(validation_error(
                "bool_parsing",
                field,
                "Input should be a valid boolean, unable to interpret input",
                value,
            ));
            default
        }
    }
}

/// The `count(*)` row of `query.count()`.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct CountRow {
    count_1: i64,
}

/// The SQLAlchemy `WHERE` chain applied by `list_all_users`, plus the bound
/// search patterns it uses. The `include_inactive` flag drops the
/// `is_active == True` predicate; a non-empty `search` adds the case-insensitive
/// `user_name`/`email` match (`ilike`, rendered as `lower(...) LIKE lower(?)`).
fn where_clause(params: &UserListParams) -> (String, Vec<String>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut args: Vec<String> = Vec::new();
    if !params.include_inactive {
        conditions.push("users.is_active = true".to_string());
    }
    if let Some(search) = &params.search {
        let pattern = format!("%{search}%");
        conditions.push(
            "(lower(users.user_name) LIKE lower(?) OR lower(users.email) LIKE lower(?))"
                .to_string(),
        );
        args.push(pattern.clone());
        args.push(pattern);
    }
    let clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" \nWHERE {}", conditions.join(" AND "))
    };
    (clause, args)
}

/// `query.count()`: the filtered `User` projection wrapped in
/// `SELECT count(*) AS count_1 ... AS anon_1`.
fn count_sql(params: &UserListParams) -> (String, Vec<String>) {
    let (clause, args) = where_clause(params);
    (
        format!(
            "SELECT count(*) AS count_1 \nFROM (SELECT {USER_COLUMNS} \nFROM users{clause}) AS anon_1",
        ),
        args,
    )
}

/// The paginated list query. SQLAlchemy renders the offset and limit as inline
/// literals; both are validated integers, so inlining is injection-safe.
fn list_sql(params: &UserListParams) -> (String, Vec<String>) {
    let (clause, args) = where_clause(params);
    let offset = (params.page - 1) * params.limit;
    (
        format!(
            "SELECT {USER_COLUMNS} \nFROM users{clause} \n LIMIT {offset}, {}",
            params.limit,
        ),
        args,
    )
}

/// pydantic datetime serialization (`YYYY-MM-DDTHH:MM:SS`, microseconds appended
/// only when non-zero).
fn pydantic_datetime(value: NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        format!(
            "{}.{:06}",
            value.format("%Y-%m-%dT%H:%M:%S"),
            value.and_utc().timestamp_subsec_micros()
        )
    }
}

/// `AdminUserResponse` pydantic serialization. Field order follows the model
/// declaration.
#[derive(Debug, Serialize)]
struct AdminUserResponse {
    id: i32,
    user_name: String,
    email: Option<String>,
    role: String,
    auth_source: String,
    is_active: bool,
    created_at: String,
    updated_at: String,
}

/// `AdminUserListResponse` (`total`, `items`).
#[derive(Debug, Serialize)]
struct AdminUserListResponse {
    total: i64,
    items: Vec<AdminUserResponse>,
}

/// `_user_to_response`: project one `User` row into the admin response.
fn user_response(row: &UserRow) -> AdminUserResponse {
    AdminUserResponse {
        id: row.id,
        user_name: row.user_name.clone(),
        email: row.email.clone(),
        role: row.role.clone(),
        auth_source: row.auth_source.clone(),
        is_active: row.is_active != 0,
        created_at: pydantic_datetime(row.created_at),
        updated_at: pydantic_datetime(row.updated_at),
    }
}

/// `get_admin_user`: reject a non-admin session with the source 403.
fn require_admin(role: &str) -> Result<(), FastApiError> {
    if role != "admin" {
        return Err(FastApiError::forbidden(ADMIN_REQUIRED_DETAIL));
    }
    Ok(())
}

/// GET /api/admin/users: the admin user listing, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/admin/users")]
async fn list_all_users(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<UserListQuery>,
) -> Result<AdminUserListResponse, FastApiError> {
    admin_users(state, &user, &query).await
}

/// Handler body for `GET /api/admin/users`.
async fn admin_users(
    state: &AppState,
    user: &SessionUser,
    query: &UserListQuery,
) -> Result<AdminUserListResponse, FastApiError> {
    require_admin(&user.role)?;
    let params = query.validated()?;

    // `query.count()`.
    let (count_statement, count_args) = count_sql(&params);
    let count_row: Option<CountRow> = state
        .mysql
        .fetch_optional(count_statement.as_str(), count_args)
        .await
        .map_err(|error| {
            tracing::error!(%error, "admin users count database failure");
            FastApiError::internal()
        })?;
    let total = count_row.map_or(0, |row| row.count_1);

    // `query.offset(...).limit(...).all()`.
    let (list_statement, list_args) = list_sql(&params);
    let rows: Vec<UserRow> = state
        .mysql
        .fetch_all(list_statement.as_str(), list_args)
        .await
        .map_err(|error| {
            tracing::error!(%error, "admin users list database failure");
            FastApiError::internal()
        })?;

    Ok(AdminUserListResponse {
        total,
        items: rows.iter().map(user_response).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    /// The exact `count(*)` statement captured in the recording (`page=1`).
    const RECORDED_COUNT_SQL: &str = "SELECT count(*) AS count_1 \n\
        FROM (SELECT users.id AS users_id, users.user_name AS users_user_name, \
        users.password_hash AS users_password_hash, users.email AS users_email, \
        users.git_info AS users_git_info, users.is_active AS users_is_active, \
        users.`role` AS users_role, users.auth_source AS users_auth_source, \
        users.preferences AS users_preferences, users.created_at AS users_created_at, \
        users.updated_at AS users_updated_at \nFROM users \n\
        WHERE users.is_active = true) AS anon_1";

    /// The exact paginated statement captured in the recording (`page=1`,
    /// `limit=20`).
    const RECORDED_LIST_SQL: &str = "SELECT users.id AS users_id, \
        users.user_name AS users_user_name, users.password_hash AS users_password_hash, \
        users.email AS users_email, users.git_info AS users_git_info, \
        users.is_active AS users_is_active, users.`role` AS users_role, \
        users.auth_source AS users_auth_source, users.preferences AS users_preferences, \
        users.created_at AS users_created_at, users.updated_at AS users_updated_at \n\
        FROM users \nWHERE users.is_active = true \n LIMIT 0, 20";

    fn params(page: i64, limit: i64) -> UserListParams {
        UserListParams {
            page,
            limit,
            include_inactive: false,
            search: None,
        }
    }

    fn user_row() -> UserRow {
        UserRow {
            id: 1,
            user_name: "Wegent".to_string(),
            users_password_hash: "hash".to_string(),
            email: Some("admin@example.com".to_string()),
            git_info: brz_mysql::Json(crate::json_compat::OpaqueJson::from_serializable(
                crate::json_compat::JsonNull,
            )),
            is_active: 1,
            role: "admin".to_string(),
            auth_source: "password".to_string(),
            preferences: "{}".to_string(),
            created_at: NaiveDate::from_ymd_opt(2025, 10, 14)
                .unwrap()
                .and_hms_opt(16, 19, 56)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 9, 4)
                .unwrap()
                .and_hms_opt(12, 50, 2)
                .unwrap(),
        }
    }

    #[test]
    fn count_sql_matches_the_recorded_statement() {
        let (statement, args) = count_sql(&params(1, 20));
        assert_eq!(statement, RECORDED_COUNT_SQL);
        assert!(args.is_empty());
    }

    #[test]
    fn list_sql_matches_the_recorded_statement() {
        let (statement, args) = list_sql(&params(1, 20));
        assert_eq!(statement, RECORDED_LIST_SQL);
        assert!(args.is_empty());
    }

    #[test]
    fn list_sql_renders_offset_from_page_and_limit() {
        assert!(list_sql(&params(6, 20)).0.ends_with(" LIMIT 100, 20"));
        assert!(list_sql(&params(2, 20)).0.ends_with(" LIMIT 20, 20"));
    }

    #[test]
    fn include_inactive_drops_the_active_filter() {
        let mut p = params(1, 20);
        p.include_inactive = true;
        let (statement, _) = list_sql(&p);
        assert!(!statement.contains("WHERE"));
        assert!(statement.ends_with(" LIMIT 0, 20"));
    }

    #[test]
    fn search_binds_both_patterns() {
        let mut p = params(1, 20);
        p.search = Some("ji".to_string());
        let (statement, args) = list_sql(&p);
        assert!(statement.contains(
            "WHERE users.is_active = true AND \
             (lower(users.user_name) LIKE lower(?) OR lower(users.email) LIKE lower(?))"
        ));
        assert_eq!(args, vec!["%ji%".to_string(), "%ji%".to_string()]);
    }

    #[test]
    fn query_defaults_when_absent() {
        let query = UserListQuery::default();
        assert_eq!(
            query.validated().unwrap(),
            UserListParams {
                page: 1,
                limit: 20,
                include_inactive: false,
                search: None,
            }
        );
    }

    #[test]
    fn query_accepts_explicit_values() {
        let query = UserListQuery {
            page: Some("3".to_string()),
            limit: Some("50".to_string()),
            include_inactive: Some("true".to_string()),
            search: Some("ji".to_string()),
        };
        assert_eq!(
            query.validated().unwrap(),
            UserListParams {
                page: 3,
                limit: 50,
                include_inactive: true,
                search: Some("ji".to_string()),
            }
        );
    }

    #[test]
    fn empty_search_is_treated_as_absent() {
        let query = UserListQuery {
            search: Some(String::new()),
            ..UserListQuery::default()
        };
        assert_eq!(query.validated().unwrap().search, None);
    }

    #[test]
    fn query_rejects_out_of_range_values() {
        for (field, value) in [("page", "0"), ("page", "abc")] {
            let query = UserListQuery {
                page: Some(value.to_string()),
                ..UserListQuery::default()
            };
            let error = query.validated().unwrap_err();
            assert_eq!(
                error.status(),
                brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
            );
            assert!(error.validation_detail().contains(field));
        }
        for value in ["0", "101", "abc"] {
            let query = UserListQuery {
                limit: Some(value.to_string()),
                ..UserListQuery::default()
            };
            let error = query.validated().unwrap_err();
            assert_eq!(
                error.status(),
                brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
            );
        }
    }

    #[test]
    fn query_rejects_non_boolean_include_inactive() {
        let query = UserListQuery {
            include_inactive: Some("maybe".to_string()),
            ..UserListQuery::default()
        };
        let error = query.validated().unwrap_err();
        assert_eq!(
            error.status(),
            brz_http_server::StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn user_response_matches_the_recorded_item() {
        let value = crate::json_contract_tests::serialized(user_response(&user_row())).unwrap();
        assert_eq!(
            value.to_string(),
            "{\"id\":1,\"user_name\":\"Wegent\",\"email\":\"admin@example.com\",\
             \"role\":\"admin\",\"auth_source\":\"password\",\"is_active\":true,\
             \"created_at\":\"2025-10-14T16:19:56\",\"updated_at\":\"2026-09-04T12:50:02\"}"
        );
    }

    #[test]
    fn absent_email_serializes_as_null() {
        let mut row = user_row();
        row.email = None;
        let body = crate::json_contract_tests::serialized(user_response(&row))
            .unwrap()
            .to_string();
        assert!(body.contains("\"email\":null"));
    }

    #[test]
    fn admin_check_rejects_non_admin_sessions() {
        let error = require_admin("user").unwrap_err();
        assert_eq!(error.status(), brz_http_server::StatusCode::FORBIDDEN);
        assert_eq!(error.detail_message(), Some(ADMIN_REQUIRED_DETAIL));
        assert!(require_admin("admin").is_ok());
    }
}
