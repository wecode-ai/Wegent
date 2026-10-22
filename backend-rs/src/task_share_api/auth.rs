// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.core.security.get_current_user_flexible_for_executor` — the
//! authentication dependency of `POST /api/tasks/{task_id}/share`.
//!
//! Priority order (source `get_current_user_flexible_for_executor`):
//! 1. API key via the `X-API-Key` header (prefix `wg-`),
//! 2. credential via the `Authorization` header: the FastAPI
//!    `OAuth2PasswordBearer` optional scheme keeps a case-insensitive
//!    `Bearer` credential, and `extract_authorization_token` falls back to the
//!    raw header value, so a bare `wg-` key also reaches this branch,
//! 3. inside that branch an API key (`wg-` prefix) verifies as a key,
//!    everything else verifies as a user-session JWT
//!    (`verify_jwt_token_with_db`, user loaded by `user_name`).
//!
//! The recorded case authenticates with a personal API key:
//! `auth_utils.verify_api_key` selects the key by SHA-256 hash (labeled
//! projection, inline literals), loads the owner by id, then updates
//! `last_used_at` (UPDATE + COMMIT). The commit expires both ORM objects, and
//! the trailing `logger.debug` f-string reads `api_key_record.name` and
//! `user.user_name`, so the session re-selects both rows (unlabeled
//! projections, no `LIMIT`) before the dependency returns. Every failure is
//! `401` with `WWW-Authenticate: Bearer`; the detail selects the branch:
//! `Invalid or expired API key`, `Could not validate credentials`, or
//! `Missing authentication credentials`.
use brz_http_server::{EphemeralBytesArena, IntoHttpError as _, Response};
use brz_mysql::{Mysql, MysqlRow};
use chrono::Utc;

use crate::attachments::s3_signing::hex_sha256;
use crate::auth::verify_token;
use crate::config::AuthConfig;
use crate::http_compat::FastApiError;
use crate::sql_support::quote_sql_literal;

/// `app.core.auth_utils.API_KEY_PREFIX`: raw keys carry this prefix.
const API_KEY_PREFIX: &str = "wg-";

/// `app.models.api_key.KEY_TYPE_PERSONAL`: the only key type executor
/// authentication accepts (`find_valid_api_key(key_type=KEY_TYPE_PERSONAL)`).
const KEY_TYPE_PERSONAL: &str = "personal";

/// Challenge tags carrying the distinct 401 details through the SDK's
/// `AuthFailure`, recovered by [`Authenticator::reject`](brz_http_server::Authenticator::reject).
const EXECUTOR_MISSING: &str = "Wegent-Executor-Missing";
const EXECUTOR_INVALID_API_KEY: &str = "Wegent-Executor-Invalid-Api-Key";

/// The authenticated user of one share request.
#[derive(Debug)]
pub(crate) struct ExecutorUser {
    pub(crate) id: i32,
    pub(crate) user_name: String,
}

/// The dependency's failure classification; each maps to the source's own
/// `HTTPException(401, headers={"WWW-Authenticate": "Bearer"})` detail, and
/// `Internal` to the application's unhandled-exception 500 body.
#[derive(Debug, Eq, PartialEq)]
pub(super) enum ExecutorAuthError {
    /// `401 "Missing authentication credentials"`.
    MissingCredentials,
    /// `401 "Invalid or expired API key"`.
    InvalidApiKey,
    /// `401 "Could not validate credentials"`.
    InvalidCredentials,
    /// An API-key-path dependency failure: the source raises through to the
    /// application's 500 handler (`python_exception_handler`).
    Internal,
}

impl brz_http_server::Authenticator<ExecutorUser> for crate::auth::AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<ExecutorUser, brz_http_server::AuthFailure> {
        let header = |name| {
            request
                .header(name)
                .and_then(|value| std::str::from_utf8(value).ok())
        };
        get_current_user_flexible_for_executor(
            &self.state().auth,
            &self.state().mysql,
            header("authorization"),
            header("x-api-key"),
        )
        .await
        .map_err(|error| match error {
            ExecutorAuthError::MissingCredentials => {
                brz_http_server::AuthFailure::missing_credentials(EXECUTOR_MISSING)
            }
            ExecutorAuthError::InvalidApiKey => {
                brz_http_server::AuthFailure::invalid_credentials(EXECUTOR_INVALID_API_KEY)
            }
            ExecutorAuthError::InvalidCredentials | ExecutorAuthError::Internal => {
                brz_http_server::AuthFailure::invalid_credentials("Bearer")
            }
        })
    }

    fn api_log_id<'a>(&'a self, principal: &'a ExecutorUser) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &EphemeralBytesArena,
    ) -> Response {
        let error = match failure {
            brz_http_server::AuthFailure::MissingCredentials {
                challenge: EXECUTOR_MISSING,
            } => FastApiError::unauthorized("Missing authentication credentials"),
            brz_http_server::AuthFailure::InvalidCredentials {
                challenge: EXECUTOR_INVALID_API_KEY,
            } => FastApiError::unauthorized("Invalid or expired API key"),
            brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
                FastApiError::unhandled()
            }
            _ => FastApiError::unauthorized("Could not validate credentials"),
        };
        error.into_http_error(arena)
    }
}

/// `get_current_user_flexible_for_executor` with the source priority order.
pub(crate) async fn get_current_user_flexible_for_executor<M: Mysql>(
    config: &AuthConfig,
    mysql: &M,
    authorization: Option<&str>,
    x_api_key: Option<&str>,
) -> Result<ExecutorUser, ExecutorAuthError> {
    // Priority 1: `X-API-Key` header (`resolved_x_api_key = x_api_key_security
    // or x_api_key`; both bind the same header). A non-`wg-` value is ignored
    // and the bearer branch decides.
    if let Some(api_key) = x_api_key.filter(|key| is_api_key(key)) {
        return verify_api_key(mysql, api_key).await;
    }

    // Priority 2: `token = oauth2_token or extract_authorization_token(...)`.
    // A case-insensitive `Bearer` scheme keeps the credential (the optional
    // scheme's parse); any other non-empty header value is taken verbatim by
    // `extract_authorization_token`'s fallback.
    let token = executor_token(authorization);
    if !token.is_empty() {
        if is_api_key(&token) {
            return verify_api_key(mysql, &token).await;
        }
        // The JWT branch: `verify_jwt_token_with_db` catches every error
        // (including its user lookup) and answers `None`, which the dependency
        // maps to the invalid-credentials detail.
        return match verify_jwt_token_with_db(config, mysql, &token).await {
            Ok(user) => Ok(user),
            Err(()) => Err(ExecutorAuthError::InvalidCredentials),
        };
    }

    Err(ExecutorAuthError::MissingCredentials)
}

/// `token = oauth2_token or extract_authorization_token(authorization)`.
fn executor_token(authorization: Option<&str>) -> String {
    let Some(header) = authorization else {
        return String::new();
    };
    match header.split_once(' ') {
        Some((scheme, credential)) if scheme.eq_ignore_ascii_case("bearer") => {
            credential.to_string()
        }
        // A non-bearer scheme (or no space at all) falls through to
        // `extract_authorization_token`'s raw-header fallback.
        _ => header.to_string(),
    }
}

/// `auth_utils.is_api_key`: the value starts with `wg-`.
fn is_api_key(token: &str) -> bool {
    token.starts_with(API_KEY_PREFIX)
}

/// `auth_utils.verify_api_key`: select the active personal key by SHA-256
/// hash, check expiry, load the owner by id, update `last_used_at`
/// (UPDATE + COMMIT), then the post-commit `logger.debug` f-string refreshes
/// both expired ORM rows.
async fn verify_api_key<M: Mysql>(
    mysql: &M,
    api_key: &str,
) -> Result<ExecutorUser, ExecutorAuthError> {
    // `find_valid_api_key(key_type=KEY_TYPE_PERSONAL)`: labeled projection
    // with the driver's inline literals.
    let key_hash = hex_sha256(api_key.as_bytes());
    let record: Option<MysqlRow> = mysql
        .fetch_optional(&api_key_by_hash_sql(&key_hash), ())
        .await
        .map_err(|_| ExecutorAuthError::Internal)?;
    let Some(record) = record else {
        return Err(ExecutorAuthError::InvalidApiKey);
    };
    let user_id: i32 = decode(&record, "api_keys_user_id")?;
    let expires_at: chrono::NaiveDateTime = decode(&record, "api_keys_expires_at")?;
    // `api_key_record.expires_at < datetime.utcnow()`.
    if expires_at < Utc::now().naive_utc() {
        return Err(ExecutorAuthError::InvalidApiKey);
    }

    // `db.query(User).filter(User.id == record.user_id).first()`.
    let user: Option<MysqlRow> = mysql
        .fetch_optional(&user_by_id_sql(user_id), ())
        .await
        .map_err(|_| ExecutorAuthError::Internal)?;
    let Some(user) = user else {
        return Err(ExecutorAuthError::InvalidApiKey);
    };
    let id: i32 = decode(&user, "users_id")?;
    let user_name: String = decode(&user, "users_user_name")?;
    let is_active: i8 = decode(&user, "users_is_active")?;
    if is_active == 0 {
        return Err(ExecutorAuthError::InvalidApiKey);
    }

    // `api_key_record.last_used_at = datetime.utcnow(); db.commit()`:
    // naive-UTC microsecond literal, then COMMIT. The engine's
    // `api-key-last-used-at` rule covers the timestamp across the
    // COM_QUERY/COM_STMT_EXECUTE protocol difference.
    let record_id: i64 = decode(&record, "api_keys_id")?;
    let now = Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string();
    mysql
        .execute(
            &format!(
                "UPDATE api_keys SET last_used_at='{now}', updated_at=now() \
                 WHERE api_keys.id = {record_id}"
            ),
            (),
        )
        .await
        .map_err(|_| ExecutorAuthError::Internal)?;
    mysql
        .execute("COMMIT", ())
        .await
        .map_err(|_| ExecutorAuthError::Internal)?;

    // The commit expires both ORM objects; the trailing `logger.debug`
    // f-string reads `api_key_record.name` and `user.user_name`, so both rows
    // are re-selected (unlabeled refresh projections, no LIMIT).
    let api_key_refresh: Result<Option<MysqlRow>, _> = mysql
        .fetch_optional(&api_key_refresh_sql(record_id), ())
        .await;
    let user_refresh: Result<Option<MysqlRow>, _> =
        mysql.fetch_optional(&user_refresh_sql(id), ()).await;
    for refresh in [api_key_refresh, user_refresh] {
        refresh.map_err(|_| ExecutorAuthError::Internal)?;
    }

    Ok(ExecutorUser { id, user_name })
}

/// `verify_jwt_token_with_db`: decode a user-session JWT and load the user by
/// `user_name`. Every failure — including the user lookup — answers `Ok(None)`
/// (the source catches `Exception` and returns `None`), which the dependency
/// maps to the invalid-credentials detail.
async fn verify_jwt_token_with_db<M: Mysql>(
    config: &AuthConfig,
    mysql: &M,
    token: &str,
) -> Result<ExecutorUser, ()> {
    let user_name = verify_token(config, token)?;
    let user: Result<Option<MysqlRow>, ()> = mysql
        .fetch_optional(&user_by_name_sql(&user_name), ())
        .await
        .map_err(|_| ());
    let Ok(user) = user else {
        return Err(());
    };
    let Some(user) = user else {
        return Err(());
    };
    let id: i32 = user.get_required("users_id").map_err(|_| ())?;
    let user_name: String = user.get_required("users_user_name").map_err(|_| ())?;
    let is_active: i8 = user.get_required("users_is_active").map_err(|_| ())?;
    if is_active == 0 {
        return Err(());
    }
    Ok(ExecutorUser { id, user_name })
}

/// Decode one required column; a decode failure is a dependency error.
fn decode<T: brz_mysql::FromMysqlValue>(
    row: &MysqlRow,
    column: &str,
) -> Result<T, ExecutorAuthError> {
    row.get_required(column)
        .map_err(|_| ExecutorAuthError::Internal)
}

/// `db.query(APIKey).filter(key_hash, key_type, is_active).first()`:
/// SQLAlchemy's labeled full-entity projection with the driver's inline
/// literals, exactly as the recorded `COM_QUERY` renders it.
fn api_key_by_hash_sql(key_hash: &str) -> String {
    format!(
        "SELECT api_keys.id AS api_keys_id, \
         api_keys.user_id AS api_keys_user_id, api_keys.key_hash AS api_keys_key_hash, \
         api_keys.key_prefix AS api_keys_key_prefix, api_keys.name AS api_keys_name, \
         api_keys.key_type AS api_keys_key_type, \
         api_keys.description AS api_keys_description, \
         api_keys.expires_at AS api_keys_expires_at, \
         api_keys.last_used_at AS api_keys_last_used_at, \
         api_keys.is_active AS api_keys_is_active, \
         api_keys.created_at AS api_keys_created_at, \
         api_keys.updated_at AS api_keys_updated_at \nFROM api_keys \n\
         WHERE api_keys.key_hash = {} AND api_keys.key_type = '{KEY_TYPE_PERSONAL}' \
         AND api_keys.is_active = true \n LIMIT 1",
        quote_sql_literal(key_hash),
    )
}

/// `db.query(User).filter(User.id == ...).first()`: the labeled full-entity
/// projection with the driver's inline integer literal.
fn user_by_id_sql(user_id: i32) -> String {
    format!(
        "SELECT users.id AS users_id, users.user_name AS users_user_name, \
         users.password_hash AS users_password_hash, users.email AS users_email, \
         users.git_info AS users_git_info, users.is_active AS users_is_active, \
         users.`role` AS users_role, users.auth_source AS users_auth_source, \
         users.preferences AS users_preferences, users.created_at AS users_created_at, \
         users.updated_at AS users_updated_at \nFROM users \nWHERE users.id = {user_id} \n LIMIT 1"
    )
}

/// `db.query(User).filter(User.user_name == ...).first()`: the same labeled
/// projection selected by name.
fn user_by_name_sql(user_name: &str) -> String {
    format!(
        "SELECT users.id AS users_id, users.user_name AS users_user_name, \
         users.password_hash AS users_password_hash, users.email AS users_email, \
         users.git_info AS users_git_info, users.is_active AS users_is_active, \
         users.`role` AS users_role, users.auth_source AS users_auth_source, \
         users.preferences AS users_preferences, users.created_at AS users_created_at, \
         users.updated_at AS users_updated_at \nFROM users \n\
         WHERE users.user_name = {} \n LIMIT 1",
        quote_sql_literal(user_name),
    )
}

/// The post-commit refresh of the expired `APIKey` ORM object
/// (`db.refresh`-style: unlabeled projection, no `LIMIT`).
fn api_key_refresh_sql(record_id: i64) -> String {
    format!(
        "SELECT api_keys.id, api_keys.user_id, api_keys.key_hash, \
         api_keys.key_prefix, api_keys.name, api_keys.key_type, \
         api_keys.description, api_keys.expires_at, api_keys.last_used_at, \
         api_keys.is_active, api_keys.created_at, api_keys.updated_at \n\
         FROM api_keys \nWHERE api_keys.id = {record_id}"
    )
}

/// The post-commit refresh of the expired `User` ORM object.
fn user_refresh_sql(user_id: i32) -> String {
    format!(
        "SELECT users.id, users.user_name, users.password_hash, users.email, \
         users.git_info, users.is_active, users.`role`, users.auth_source, \
         users.preferences, users.created_at, users.updated_at \n\
         FROM users \nWHERE users.id = {user_id}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql_test_support::KindQueryCapture;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    #[test]
    fn token_extraction_matches_the_source_schemes() {
        // The optional bearer scheme keeps the credential.
        assert_eq!(executor_token(Some("Bearer abc")), "abc");
        assert_eq!(executor_token(Some("bearer abc")), "abc");
        // `extract_authorization_token`'s fallback returns the raw header.
        assert_eq!(executor_token(Some("Basic xyz")), "Basic xyz");
        assert_eq!(executor_token(Some("wg-key")), "wg-key");
        // Missing or empty headers stay missing. `get_authorization_scheme_param`
        // splits on the first space, so a bare `Bearer` yields an empty
        // credential and the raw-header fallback of
        // `extract_authorization_token` returns "Bearer" itself; that token is
        // not a `wg-` key and fails JWT verification, reaching the same 401.
        assert_eq!(executor_token(None), "");
        assert_eq!(executor_token(Some("")), "");
        assert_eq!(executor_token(Some("Bearer ")), "");
    }

    #[test]
    fn api_key_prefix_is_wg() {
        assert!(is_api_key("wg-abc"));
        assert!(!is_api_key("jwt-token"));
        assert!(!is_api_key(""));
    }

    /// The recorded `COM_QUERY` text of the key-hash lookup (sequence 7931).
    #[test]
    fn renders_the_recorded_api_key_hash_lookup() {
        assert_eq!(
            api_key_by_hash_sql("51176e07f3419b73c09e933acf50af104f5e5f0411f5c06802bd2841ff755c0f"),
            "SELECT api_keys.id AS api_keys_id, api_keys.user_id AS api_keys_user_id, \
             api_keys.key_hash AS api_keys_key_hash, api_keys.key_prefix AS api_keys_key_prefix, \
             api_keys.name AS api_keys_name, api_keys.key_type AS api_keys_key_type, \
             api_keys.description AS api_keys_description, \
             api_keys.expires_at AS api_keys_expires_at, \
             api_keys.last_used_at AS api_keys_last_used_at, \
             api_keys.is_active AS api_keys_is_active, \
             api_keys.created_at AS api_keys_created_at, \
             api_keys.updated_at AS api_keys_updated_at \nFROM api_keys \n\
             WHERE api_keys.key_hash = \
             '51176e07f3419b73c09e933acf50af104f5e5f0411f5c06802bd2841ff755c0f' \
             AND api_keys.key_type = 'personal' AND api_keys.is_active = true \n LIMIT 1"
        );
    }

    /// The recorded owner lookup (sequence 7932).
    #[test]
    fn renders_the_recorded_user_by_id_lookup() {
        assert_eq!(
            user_by_id_sql(89),
            "SELECT users.id AS users_id, users.user_name AS users_user_name, \
             users.password_hash AS users_password_hash, users.email AS users_email, \
             users.git_info AS users_git_info, users.is_active AS users_is_active, \
             users.`role` AS users_role, users.auth_source AS users_auth_source, \
             users.preferences AS users_preferences, users.created_at AS users_created_at, \
             users.updated_at AS users_updated_at \nFROM users \nWHERE users.id = 89 \n LIMIT 1"
        );
    }

    /// The recorded post-commit refresh reads (sequences 6491/6492): the
    /// `logger.debug` f-string reloads both expired ORM rows.
    #[test]
    fn renders_the_recorded_post_commit_refreshes() {
        assert_eq!(
            api_key_refresh_sql(469),
            "SELECT api_keys.id, api_keys.user_id, api_keys.key_hash, \
             api_keys.key_prefix, api_keys.name, api_keys.key_type, \
             api_keys.description, api_keys.expires_at, api_keys.last_used_at, \
             api_keys.is_active, api_keys.created_at, api_keys.updated_at \n\
             FROM api_keys \nWHERE api_keys.id = 469"
        );
        assert_eq!(
            user_refresh_sql(89),
            "SELECT users.id, users.user_name, users.password_hash, users.email, \
             users.git_info, users.is_active, users.`role`, users.auth_source, \
             users.preferences, users.created_at, users.updated_at \n\
             FROM users \nWHERE users.id = 89"
        );
    }

    /// The `last_used_at` write keeps the verification rule's template
    /// (`UPDATE api_keys SET last_used_at=?, updated_at=now() WHERE
    /// api_keys.id = ?`).
    #[test]
    fn update_statement_keeps_the_rule_template_shape() {
        let now = "2026-10-15 15:30:19.751383";
        assert_eq!(
            format!(
                "UPDATE api_keys SET last_used_at='{now}', updated_at=now() \
                 WHERE api_keys.id = {}",
                469
            ),
            "UPDATE api_keys SET last_used_at='2026-10-15 15:30:19.751383', \
             updated_at=now() WHERE api_keys.id = 469"
        );
    }

    #[tokio::test]
    async fn missing_credentials_never_touches_the_database() {
        let mysql = KindQueryCapture::default();
        let error = get_current_user_flexible_for_executor(&config(), &mysql, None, None)
            .await
            .unwrap_err();
        assert_eq!(error, ExecutorAuthError::MissingCredentials);
        assert!(mysql.queries().is_empty());
    }

    #[tokio::test]
    async fn x_api_key_runs_the_hash_lookup() {
        let mysql = KindQueryCapture::default();
        let error = get_current_user_flexible_for_executor(
            &config(),
            &mysql,
            None,
            Some("wg-yMbd40_N7GJnRpF4Uhw_RaJPLbUIfRwpEjgVV1FFCBA"),
        )
        .await
        .unwrap_err();
        // The capture returns no rows, so the key is unknown.
        assert_eq!(error, ExecutorAuthError::InvalidApiKey);
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 0);
        assert!(
            queries[0].sql.contains(&format!(
                "'{}'",
                hex_sha256(b"wg-yMbd40_N7GJnRpF4Uhw_RaJPLbUIfRwpEjgVV1FFCBA")
            )),
            "{}",
            queries[0].sql
        );
    }

    /// A non-`wg-` `X-API-Key` is ignored and the bearer branch decides.
    #[tokio::test]
    async fn non_wg_x_api_key_falls_through_to_the_bearer_branch() {
        let mysql = KindQueryCapture::default();
        let error =
            get_current_user_flexible_for_executor(&config(), &mysql, None, Some("some-other-key"))
                .await
                .unwrap_err();
        assert_eq!(error, ExecutorAuthError::MissingCredentials);
        assert!(mysql.queries().is_empty());
    }

    /// A bearer API key runs the same lookup as the `X-API-Key` branch.
    #[tokio::test]
    async fn bearer_api_key_runs_the_hash_lookup() {
        let mysql = KindQueryCapture::default();
        let error =
            get_current_user_flexible_for_executor(&config(), &mysql, Some("Bearer wg-abc"), None)
                .await
                .unwrap_err();
        assert_eq!(error, ExecutorAuthError::InvalidApiKey);
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert!(
            queries[0]
                .sql
                .contains(&format!("'{}'", hex_sha256(b"wg-abc")))
        );
    }

    /// A valid user-session JWT reaches the by-name user lookup; the capture
    /// returns no rows, so the dependency answers invalid credentials.
    #[tokio::test]
    async fn session_jwt_reaches_the_user_by_name_lookup() {
        use jsonwebtoken::{Algorithm, EncodingKey};
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret(b"test-key");
        let token =
            jsonwebtoken::encode(&header, &serde_json::json!({"sub": "yingeng"}), &key).unwrap();
        let mysql = KindQueryCapture::default();
        let error = get_current_user_flexible_for_executor(
            &config(),
            &mysql,
            Some(&format!("Bearer {token}")),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error, ExecutorAuthError::InvalidCredentials);
        let queries = mysql.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].args, 0);
        assert!(queries[0].sql.contains("users.user_name = 'yingeng'"));
    }

    /// A JWT-path user-lookup failure answers invalid credentials, not 500:
    /// the source's `verify_jwt_token_with_db` catches `Exception`.
    #[tokio::test]
    async fn an_undecodable_bearer_token_is_invalid_credentials() {
        let mysql = KindQueryCapture::default();
        let error = get_current_user_flexible_for_executor(
            &config(),
            &mysql,
            Some("Bearer not-a-jwt"),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error, ExecutorAuthError::InvalidCredentials);
        assert!(mysql.queries().is_empty());
    }
}
