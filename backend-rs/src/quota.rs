// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Open-source quota endpoint from `app.api.endpoints.quota`.
//!
//! The source mounts `/{path:path}` below `/api/quota` and authenticates the
//! current user before returning an empty JSON object for every path.
use brz_http_server::StatusCode;
use brz_mysql::Mysql;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Serialize;
use serde_json::Value;

use crate::auth::{USER_BY_NAME_QUERY, UserRow};
use crate::config::AuthConfig;
use crate::http_compat::FastApiError;
use crate::state::AppState;

#[derive(Debug, Serialize)]
struct EmptyQuota {}

#[cfg(test)]
#[derive(Debug)]
enum QuotaError {
    Auth(FastApiError),
    Database,
}

#[cfg(test)]
impl From<FastApiError> for QuotaError {
    fn from(error: FastApiError) -> Self {
        Self::Auth(error)
    }
}

#[cfg(test)]
impl brz_http_server::IntoHttpError for QuotaError {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        match self {
            Self::Auth(error) => error.into_http_error(arena),
            Self::Database => brz_http_server::Response::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                brz_http_server::ResponseBody::Static(b"Internal Server Error"),
            )
            .content_type("text/plain; charset=utf-8"),
        }
    }
}

#[derive(Debug)]
struct QuotaUser {
    user_name: String,
    email: Option<String>,
    is_active: bool,
}

struct QuotaPrincipal(QuotaUser);

const QUOTA_USER_INACTIVE: &str = "Wegent-Quota-User-Inactive";

impl brz_http_server::Authenticator<QuotaPrincipal> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<QuotaPrincipal, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|v| std::str::from_utf8(v).ok());
        let token = bearer_token(authorization)
            .map_err(|_| brz_http_server::AuthFailure::invalid_credentials("Bearer"))?;
        let username = verify_session_token(token, &self.state().auth)
            .map_err(|_| brz_http_server::AuthFailure::invalid_credentials("Bearer"))?;
        let user = self
            .state()
            .mysql
            .find_by_name(&username)
            .await
            .map_err(|_| brz_http_server::AuthFailure::Internal)?
            .ok_or_else(|| brz_http_server::AuthFailure::invalid_credentials("Bearer"))?;
        if !user.is_active {
            return Err(brz_http_server::AuthFailure::invalid_credentials(
                QUOTA_USER_INACTIVE,
            ));
        }
        Ok(QuotaPrincipal(user))
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a QuotaPrincipal,
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
                challenge: QUOTA_USER_INACTIVE,
            } => FastApiError::unauthorized("User not activated").into_http_error(arena),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                brz_http_server::Response::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    brz_http_server::ResponseBody::Static(b"Internal Server Error"),
                )
                .content_type("text/plain; charset=utf-8")
            }
            _ => {
                FastApiError::unauthorized("Could not validate credentials").into_http_error(arena)
            }
        }
    }
}

trait QuotaUsers: Send + Sync {
    async fn find_by_name(
        &self,
        username: &str,
    ) -> Result<Option<QuotaUser>, brz_mysql::MysqlError>;
}

impl<M: Mysql> QuotaUsers for M {
    async fn find_by_name(
        &self,
        username: &str,
    ) -> Result<Option<QuotaUser>, brz_mysql::MysqlError> {
        let user: Option<UserRow> = self.fetch_optional(USER_BY_NAME_QUERY, (username,)).await?;
        Ok(user.map(|user| QuotaUser {
            user_name: user.user_name,
            email: user.email,
            is_active: user.is_active != 0,
        }))
    }
}

#[brz_http_server::get("/api/quota/*path")]
async fn quota(
    #[inject(state)] _state: &AppState,
    path: &str,
    #[auth] user: QuotaPrincipal,
) -> EmptyQuota {
    tracing::info!(email = ?user.0.email, path, "get quota for user");
    EmptyQuota {}
}

#[brz_http_server::get("/api/quota")]
async fn quota_root(
    #[inject(state)] _state: &AppState,
    #[auth] user: QuotaPrincipal,
) -> EmptyQuota {
    tracing::info!(email = ?user.0.email, path = "", "get quota for user");
    EmptyQuota {}
}

#[cfg(test)]
async fn get_quota<U: QuotaUsers>(
    auth: &AuthConfig,
    users: &U,
    path: &str,
    authorization: Option<&str>,
) -> Result<EmptyQuota, QuotaError> {
    let token = bearer_token(authorization)?;
    let username = verify_session_token(token, auth)?;
    let user = users
        .find_by_name(&username)
        .await
        .map_err(|error| {
            tracing::error!(%error, "quota user lookup failed");
            QuotaError::Database
        })?
        .ok_or_else(invalid_credentials)?;
    if !user.is_active {
        return Err(FastApiError::unauthorized("User not activated").into());
    }
    tracing::info!(email = ?user.email, path, "get quota for user");
    Ok(EmptyQuota {})
}

fn bearer_token(authorization: Option<&str>) -> Result<&str, FastApiError> {
    let (scheme, token) = authorization
        .unwrap_or_default()
        .split_once(' ')
        .unwrap_or((authorization.unwrap_or_default(), ""));
    if scheme.eq_ignore_ascii_case("bearer") {
        Ok(token)
    } else {
        Err(FastApiError::unauthorized("Not authenticated"))
    }
}

fn verify_session_token(token: &str, config: &AuthConfig) -> Result<String, FastApiError> {
    let algorithm = match config.algorithm.as_str() {
        "HS256" => Algorithm::HS256,
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => return Err(invalid_credentials()),
    };
    let mut validation = Validation::new(algorithm);
    validation.required_spec_claims.clear();
    validation.leeway = 0;
    validation.validate_nbf = true;
    let keys = std::iter::once(config.jwt_key.as_str())
        .chain(config.legacy_jwt_keys.iter().map(String::as_str));
    for key in keys {
        if let Ok(decoded) = decode::<Value>(
            token,
            &DecodingKey::from_secret(key.as_bytes()),
            &validation,
        ) {
            let claims = decoded.claims;
            let session = !python_truthy(claims.get("scope"))
                && claims.get("token_use").is_none_or(|use_name| {
                    use_name.is_null() || use_name.as_str() == Some("wework_access")
                });
            if session && let Some(username) = claims.get("sub").and_then(Value::as_str) {
                return Ok(username.to_owned());
            }
            return Err(invalid_credentials());
        }
    }
    Err(invalid_credentials())
}

fn python_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(value)) => !value.is_empty(),
        Some(Value::Array(value)) => !value.is_empty(),
        Some(Value::Object(value)) => !value.is_empty(),
    }
}

fn invalid_credentials() -> FastApiError {
    FastApiError::unauthorized("Could not validate credentials")
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    use brz_http_server::{EphemeralBytesArena, IntoHttpError, ResponseBody};
    use jsonwebtoken::{EncodingKey, Header, encode};

    use super::*;

    enum UserState {
        Active,
        Inactive,
        Missing,
        Failed,
    }

    struct TestUsers {
        state: UserState,
        queried_names: Mutex<Vec<String>>,
    }

    impl TestUsers {
        fn new(state: UserState) -> Self {
            Self {
                state,
                queried_names: Mutex::new(Vec::new()),
            }
        }

        fn names(&self) -> Vec<String> {
            self.queried_names.lock().unwrap().clone()
        }
    }

    impl QuotaUsers for TestUsers {
        async fn find_by_name(
            &self,
            username: &str,
        ) -> Result<Option<QuotaUser>, brz_mysql::MysqlError> {
            self.queried_names.lock().unwrap().push(username.to_owned());
            match self.state {
                UserState::Active => Ok(Some(QuotaUser {
                    user_name: username.to_owned(),
                    email: Some("person@example.org".to_owned()),
                    is_active: true,
                })),
                UserState::Inactive => Ok(Some(QuotaUser {
                    user_name: username.to_owned(),
                    email: None,
                    is_active: false,
                })),
                UserState::Missing => Ok(None),
                UserState::Failed => Err(brz_mysql::MysqlError::PoolTimedOut),
            }
        }
    }

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "quota-test-key".to_owned(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_owned(),
        }
    }

    fn token(claims: Value) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(config().jwt_key.as_bytes()),
        )
        .expect("test JWT")
    }

    fn session_claims() -> Value {
        let exp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time after epoch")
            .as_secs()
            + 3600;
        serde_json::json!({"sub": "public-user", "exp": exp})
    }

    #[tokio::test]
    async fn authenticated_root_and_nested_paths_return_empty_json() {
        let users = TestUsers::new(UserState::Active);
        let header = format!("Bearer {}", token(session_claims()));
        for path in ["", "claude/quota", "other/nested/path"] {
            let response = get_quota(&config(), &users, path, Some(&header))
                .await
                .expect("active user gets quota response");
            assert_eq!(
                serde_json::to_value(response).unwrap(),
                serde_json::json!({})
            );
        }
        assert_eq!(users.names(), vec!["public-user"; 3]);
    }

    #[tokio::test]
    async fn oauth2_scheme_rejects_missing_and_non_bearer_headers_before_lookup() {
        let users = TestUsers::new(UserState::Active);
        for header in [None, Some("Basic abc"), Some("")] {
            let error = get_quota(&config(), &users, "anything", header)
                .await
                .expect_err("OAuth2 bearer scheme is required");
            let QuotaError::Auth(error) = error else {
                panic!("header failure must be an auth error");
            };
            assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(error.validation_detail(), "\"Not authenticated\"");
        }
        assert!(users.names().is_empty());
    }

    #[tokio::test]
    async fn invalid_and_scoped_sessions_are_unauthorized_before_lookup() {
        let users = TestUsers::new(UserState::Active);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("current time after epoch")
            .as_secs();
        let scoped = token(serde_json::json!({
            "sub": "public-user", "scope": "read", "exp": session_claims()["exp"]
        }));
        let expired = token(serde_json::json!({"sub": "public-user", "exp": now - 1}));
        let future = token(serde_json::json!({
            "sub": "public-user", "exp": now + 3600, "nbf": now + 3600
        }));
        let audience = token(serde_json::json!({
            "sub": "public-user", "exp": now + 3600, "aud": "other-service"
        }));
        for header in [
            "Bearer invalid".to_owned(),
            format!("Bearer {scoped}"),
            format!("Bearer {expired}"),
            format!("Bearer {future}"),
            format!("Bearer {audience}"),
        ] {
            let error = get_quota(&config(), &users, "anything", Some(&header))
                .await
                .expect_err("invalid session is unauthorized");
            let QuotaError::Auth(error) = error else {
                panic!("invalid session must be an auth error");
            };
            assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(
                error.validation_detail(),
                "\"Could not validate credentials\""
            );
        }
        assert!(users.names().is_empty());
    }

    #[tokio::test]
    async fn inactive_missing_and_failed_user_lookup_keep_source_error_categories() {
        let header = format!("Bearer {}", token(session_claims()));
        for (state, detail) in [
            (UserState::Inactive, "\"User not activated\""),
            (UserState::Missing, "\"Could not validate credentials\""),
        ] {
            let users = TestUsers::new(state);
            let error = get_quota(&config(), &users, "anything", Some(&header))
                .await
                .expect_err("lookup fails");
            let QuotaError::Auth(error) = error else {
                panic!("inactive or missing user must be an auth error");
            };
            assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(error.validation_detail(), detail);
            assert_eq!(users.names(), ["public-user"]);
        }
        let users = TestUsers::new(UserState::Failed);
        let error = get_quota(&config(), &users, "anything", Some(&header))
            .await
            .expect_err("database failure must surface");
        let response = error.into_http_error(&EphemeralBytesArena::new(64));
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let ResponseBody::Static(body) = response.body() else {
            panic!("source default 500 response is plain text");
        };
        assert_eq!(*body, b"Internal Server Error");
        assert_eq!(users.names(), ["public-user"]);
    }

    #[tokio::test]
    async fn falsy_scope_matches_python_session_claim_check() {
        let users = TestUsers::new(UserState::Active);
        for scope in [
            serde_json::json!(false),
            serde_json::json!(0),
            serde_json::json!(""),
            serde_json::json!([]),
            serde_json::json!({}),
        ] {
            let mut claims = session_claims();
            claims["scope"] = scope;
            let header = format!("Bearer {}", token(claims));
            get_quota(&config(), &users, "anything", Some(&header))
                .await
                .expect("falsy scope permits an interactive session");
        }
        assert_eq!(users.names().len(), 5);
    }
}
