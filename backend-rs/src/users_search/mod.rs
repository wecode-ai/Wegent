// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/search` — search users by username or email.
//!
//! Mirrors `app.api.endpoints.users.search_users`: case-insensitive
//! `LIKE %q%` over `user_name` and `email`, restricted to active users,
//! excluding the current user, limited (default 20, 1..=100).
use serde::Deserialize;
use serde_json::json;

pub mod auth;
pub mod auth_error;

use crate::http_compat::FastApiError;
use crate::state::AppState;
use auth::get_current_user;

/// Active session user using the compact user projection emitted by these
/// user-directory endpoints.
pub struct UsersSearchUser(pub auth::UserRow);

impl std::ops::Deref for UsersSearchUser {
    type Target = auth::UserRow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

const USERS_SEARCH_INACTIVE: &str = "Wegent-Users-Search-Inactive";

impl brz_http_server::Authenticator<UsersSearchUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<UsersSearchUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        get_current_user(&self.state().auth, &self.state().mysql, authorization)
            .await
            .map(UsersSearchUser)
            .map_err(|error| {
                if error.status() == brz_http_server::StatusCode::INTERNAL_SERVER_ERROR {
                    brz_http_server::AuthFailure::Internal
                } else if error.detail() == "User not activated" {
                    brz_http_server::AuthFailure::invalid_credentials(USERS_SEARCH_INACTIVE)
                } else {
                    brz_http_server::AuthFailure::invalid_credentials("Bearer")
                }
            })
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a UsersSearchUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;

        match failure {
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: USERS_SEARCH_INACTIVE,
            } => crate::http_compat::FastApiError::unauthorized("User not activated"),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                crate::http_compat::FastApiError::detail(
                    brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error",
                )
            }
            _ => crate::http_compat::FastApiError::unauthorized("Could not validate credentials"),
        }
        .into_http_error(arena)
    }
}

/// Validated query parameters (`q` min_length=1; `limit` 1..=100, default 20).
#[derive(Debug, Deserialize)]
pub struct SearchParams {
    q: String,
    limit: Option<u32>,
}

impl SearchParams {
    /// FastAPI's `Query(..., min_length=1)` rejects an empty `q` with 422.
    fn validated(self) -> Result<(String, u32), FastApiError> {
        if self.q.is_empty() {
            return Err(validation_error(
                "q",
                "string_too_short",
                "String should have at least 1 character",
            ));
        }
        let limit = match self.limit {
            None => 20,
            Some(limit) if (1..=100).contains(&limit) => limit,
            Some(_) => {
                return Err(validation_error(
                    "limit",
                    "greater_than_equal",
                    "Input should be between 1 and 100",
                ));
            }
        };
        Ok((self.q, limit))
    }
}

/// FastAPI-style 422 validation error body.
fn validation_error(field: &str, kind: &str, message: &str) -> FastApiError {
    FastApiError::validation(json!([
        {
            "type": kind,
            "loc": ["query", field],
            "msg": message,
            "input": "",
        }
    ]))
}

/// The search query's row shape: the full `db.query(User)` projection (all
/// twelve mapped columns, aliased `users_<column>`) so the prepared
/// statement matches the recorded exchange. Only `id`, `user_name`, and
/// `email` are consumed.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct UserSearchRecord {
    #[mysql(rename = "users_id")]
    id: i32,
    #[mysql(rename = "users_user_name")]
    user_name: String,
    #[mysql(rename = "users_email")]
    email: Option<String>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_password_hash")]
    users_password_hash: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_git_info")]
    git_info: brz_mysql::Json<brz_json::OpaqueJson>,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_is_active")]
    is_active: i8,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_role")]
    role: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_auth_source")]
    auth_source: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_preferences")]
    preferences: String,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_created_at")]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// `UserSearchItem` (`app.api.endpoints.users.UserSearchItem`).
#[derive(Debug, serde::Serialize)]
struct UserSearchItem {
    id: i32,
    user_name: String,
    email: Option<String>,
}

#[derive(serde::Serialize)]
struct UserSearchResponse {
    users: Vec<UserSearchItem>,
    total: usize,
}

/// GET /api/users/search: the users-search free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/users/search")]
async fn search_users(
    #[inject(state)] state: &AppState,
    #[auth] current_user: UsersSearchUser,
    query: brz_http_server::Query<SearchParams>,
) -> Result<UserSearchResponse, FastApiError> {
    search(state, &current_user, &query).await
}

/// The source `db.query(User).filter(...)` statement SQLAlchemy renders for
/// the search: every mapped column, aliased `users_<column>`, with the
/// `ilike` predicates rendered as explicit `lower(...) LIKE lower(?)`.
const USER_SEARCH_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.is_active = true AND users.id != ? \
     AND (lower(users.user_name) LIKE lower(?) OR lower(users.email) LIKE lower(?)) \
     LIMIT ?";

/// Handler body for `GET /api/users/search`.
async fn search(
    state: &AppState,
    current_user: &UsersSearchUser,
    params: &SearchParams,
) -> Result<UserSearchResponse, FastApiError> {
    let (q, limit) = SearchParams {
        q: params.q.clone(),
        limit: params.limit,
    }
    .validated()?;

    // Source: `User.is_active == True`, `User.id != current_user.id`,
    // `(user_name ILIKE %q%) OR (email ILIKE %q%)`, `LIMIT limit`.
    let pattern = format!("%{q}%");
    let rows: Result<Vec<UserSearchRecord>, brz_mysql::MysqlError> = state
        .mysql
        .fetch_all(
            USER_SEARCH_QUERY,
            (current_user.id, pattern.as_str(), pattern.as_str(), limit),
        )
        .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return Err(auth_error::AuthError::dependency(error).into()),
    };

    // `UserSearchItem(id, user_name, email)` per result row.
    let users = rows
        .into_iter()
        .map(|row| UserSearchItem {
            id: row.id,
            user_name: row.user_name,
            email: row.email,
        })
        .collect::<Vec<_>>();
    let total = users.len();

    Ok(UserSearchResponse { users, total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;

    #[test]
    fn empty_q_is_rejected() {
        let params = SearchParams {
            q: String::new(),
            limit: Some(20),
        };
        let error = params.validated().unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn limit_bounds_are_enforced() {
        for limit in [0, 101] {
            let params = SearchParams {
                q: "jia".to_string(),
                limit: Some(limit),
            };
            let error = params.validated().unwrap_err();
            assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
        let params = SearchParams {
            q: "jia".to_string(),
            limit: Some(100),
        };
        assert_eq!(params.validated().unwrap(), ("jia".to_string(), 100));
        let params = SearchParams {
            q: "jia".to_string(),
            limit: Some(1),
        };
        assert_eq!(params.validated().unwrap(), ("jia".to_string(), 1));
    }

    #[test]
    fn default_limit_is_20() {
        let params = SearchParams {
            q: "jia xuan".to_string(),
            limit: None,
        };
        assert_eq!(params.validated().unwrap(), ("jia xuan".to_string(), 20));
    }

    #[test]
    fn pattern_wraps_query() {
        let params = SearchParams {
            q: "jia xuan".to_string(),
            limit: None,
        };
        let (q, _) = params.validated().unwrap();
        assert_eq!(q, "jia xuan");
        assert_eq!(format!("%{q}%"), "%jia xuan%");
    }

    /// The search statement carries the full `db.query(User)` projection and
    /// the source's `lower(...) LIKE lower(?)` predicates, matching the
    /// recorded prepared-statement exchange.
    #[test]
    fn search_statement_matches_the_source_rendering() {
        assert!(USER_SEARCH_QUERY.contains("users.id AS users_id"));
        assert!(USER_SEARCH_QUERY.contains(
            "users.preferences AS users_preferences, users.created_at AS users_created_at"
        ));
        assert!(USER_SEARCH_QUERY.contains("users.is_active = true"));
        assert!(
            USER_SEARCH_QUERY.contains(
                "lower(users.user_name) LIKE lower(?) OR lower(users.email) LIKE lower(?)"
            )
        );
    }
}
