// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! JWT session verification and user lookup.
//!
//! Mirrors `app.core.security.get_current_user`: decode the bearer token
//! (`app.core.jwt_compat.decode_jose_jwt` with the active then legacy signing
//! keys, `app.core.session_token.is_user_session_payload`), then load the user
//! row and reject missing or inactive users with `401 {"detail": ...}`.
use brz_mysql::{FromMysqlRow, Json};
use jsonwebtoken::Algorithm;
use serde::Deserialize;
use std::ops::Deref;
use std::sync::Arc;

use crate::config::AuthConfig;
use crate::state::AppState;

/// Process-wide authentication backend used by every exported route group.
///
/// The backend owns the shared application state so individual principal
/// implementations can select the exact credential and lookup behavior they
/// need without threading `Authorization` through business handlers.
#[derive(Clone)]
pub struct AppAuthenticator {
    state: Arc<AppState>,
}

impl AppAuthenticator {
    #[must_use]
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    /// Shared public state for application-specific principal implementations.
    #[must_use]
    pub fn state(&self) -> &AppState {
        &self.state
    }
}

/// The standard active user-session principal.
#[derive(Debug)]
pub struct SessionUser(pub UserRow);

/// Session principal for endpoints whose source `get_current_user` shares the
/// request-scoped SQLAlchemy session with the endpoint body.
///
/// FastAPI caches `Depends(get_db)` per request, so `get_current_user`'s
/// `db.query(User)` is the *same* session transaction as the endpoint's own
/// reads and writes: the user row is loaded on the transaction's connection
/// before the first business statement. [`SessionUser`] resolves that row on a
/// pooled connection before the handler, which splits the one Source
/// transaction across two sockets. This principal verifies the bearer token
/// only; the handler completes the lookup with
/// [`session_user_in_transaction`] on its own transaction.
pub struct TransactionSessionUser {
    pub user_name: String,
}

/// Session principal for endpoints whose source optional dependency treats
/// every absent or invalid credential as anonymous.
pub struct OptionalSessionUser(pub UserRow);

impl Deref for OptionalSessionUser {
    type Target = UserRow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl brz_http_server::Authenticator<OptionalSessionUser> for AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<OptionalSessionUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        get_current_user(&self.state.auth, &self.state.mysql, authorization)
            .await
            .map(OptionalSessionUser)
            .map_err(|_| brz_http_server::AuthFailure::missing_credentials("Bearer"))
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a OptionalSessionUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }
}

impl Deref for SessionUser {
    type Target = UserRow;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

const USER_NOT_ACTIVATED: &str = "Wegent-User-Not-Activated";
const NOT_AUTHENTICATED: &str = "Wegent-Not-Authenticated";

impl brz_http_server::Authenticator<SessionUser> for AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<SessionUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        get_current_user(&self.state.auth, &self.state.mysql, authorization)
            .await
            .map(SessionUser)
            .map_err(session_auth_failure)
    }

    fn api_log_id<'a>(&'a self, principal: &'a SessionUser) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.0.user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;

        session_rejection(failure).into_http_error(arena)
    }
}

impl brz_http_server::Authenticator<TransactionSessionUser> for AppAuthenticator {
    async fn authenticate<'a>(
        &'a self,
        request: brz_http_server::AuthRequest<'a>,
    ) -> Result<TransactionSessionUser, brz_http_server::AuthFailure> {
        let authorization = request
            .header("authorization")
            .and_then(|value| std::str::from_utf8(value).ok());
        verify_session_token(&self.state.auth, authorization)
            .map(|user_name| TransactionSessionUser { user_name })
            .map_err(session_auth_failure)
    }

    fn api_log_id<'a>(
        &'a self,
        principal: &'a TransactionSessionUser,
    ) -> Option<&'a dyn std::fmt::Display> {
        Some(&principal.user_name)
    }

    fn reject(
        &self,
        _request: brz_http_server::AuthRequest<'_>,
        failure: brz_http_server::AuthFailure,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        use brz_http_server::IntoHttpError as _;

        session_rejection(failure).into_http_error(arena)
    }
}

/// The source detail for a rejected session authentication.
///
/// `AuthFailure` carries only a challenge string, so the distinct outcomes are
/// tagged with the module's challenge constants and recovered here.
pub(crate) fn session_auth_detail(failure: brz_http_server::AuthFailure) -> &'static str {
    match failure {
        brz_http_server::AuthFailure::MissingCredentials {
            challenge: NOT_AUTHENTICATED,
        } => "Not authenticated",
        brz_http_server::AuthFailure::InvalidCredentials {
            challenge: USER_NOT_ACTIVATED,
        } => "User not activated",
        _ => "Could not validate credentials",
    }
}

/// Map a `get_current_user` failure to the SDK failure that carries it.
pub(crate) fn session_auth_failure(failure: AuthFailure) -> brz_http_server::AuthFailure {
    match failure {
        AuthFailure::NotAuthenticated => {
            brz_http_server::AuthFailure::missing_credentials(NOT_AUTHENTICATED)
        }
        AuthFailure::InvalidCredentials => {
            brz_http_server::AuthFailure::invalid_credentials("Bearer")
        }
        AuthFailure::UserNotActivated => {
            brz_http_server::AuthFailure::invalid_credentials(USER_NOT_ACTIVATED)
        }
        AuthFailure::Dependency => brz_http_server::AuthFailure::Internal,
    }
}

/// JWT claims carried by a user-session token.
///
/// Shared across authentication paths. Scope uses Python truthiness and
/// NumericDate claims are checked before typed deserialization.
#[derive(Debug, Deserialize)]
pub struct SessionClaims {
    pub sub: Option<String>,
    #[serde(default)]
    pub scope: Option<serde_json::Value>,
    #[serde(default)]
    pub token_use: Option<String>,
    /// Validated with Python integer coercion before deserialization.
    #[serde(default)]
    #[allow(
        dead_code,
        reason = "validated by the shared JWT verifier, not read directly"
    )]
    pub exp: Option<serde_json::Value>,
}

impl SessionClaims {
    /// Match Python's falsey scope and allowed session token_use values.
    pub fn is_user_session_payload(&self) -> bool {
        !self
            .scope
            .as_ref()
            .is_some_and(brz_json::adapters::python_truthy)
            && matches!(
                self.token_use.as_deref(),
                None | Some(WEWORK_ACCESS_TOKEN_USE)
            )
    }

    /// The non-empty `sub` when this is a user-session payload.
    pub fn username(&self) -> Option<String> {
        if !self.is_user_session_payload() {
            return None;
        }
        self.sub.clone().filter(|sub| !sub.is_empty())
    }
}

/// `WEWORK_ACCESS_TOKEN_USE` (`app.core.session_token`).
pub const WEWORK_ACCESS_TOKEN_USE: &str = "wework_access";

/// Decode keys derived from the active key and legacy decode-only keys.
fn decoding_keys(config: &AuthConfig) -> Vec<Vec<u8>> {
    let mut keys = vec![config.jwt_key.as_bytes().to_vec()];
    for key in &config.legacy_jwt_keys {
        if !keys.iter().any(|existing| existing == key.as_bytes()) {
            keys.push(key.as_bytes().to_vec());
        }
    }
    keys
}

/// Algorithm from settings (`HS256`).
pub(crate) fn algorithm(config: &AuthConfig) -> Option<Algorithm> {
    match config.algorithm.as_str() {
        "HS256" => Some(Algorithm::HS256),
        "HS384" => Some(Algorithm::HS384),
        "HS512" => Some(Algorithm::HS512),
        _ => None,
    }
}

/// `extract_authorization_token`: case-insensitive Bearer credential or the
/// plain header value.
pub fn extract_authorization_token(authorization: Option<&str>) -> String {
    let Some(header) = authorization else {
        return String::new();
    };
    if let Some((scheme, token)) = header.split_once(' ')
        && scheme.eq_ignore_ascii_case("bearer")
    {
        return token.trim().to_string();
    }
    header.trim().to_string()
}

/// `verify_token` with key rotation: try the active key, then legacy keys.
pub(crate) fn verify_token(config: &AuthConfig, token: &str) -> Result<String, ()> {
    decode_session_claims(config, token)
        .and_then(|claims| claims.username())
        .ok_or(())
}

/// Shared claim verification for standard and flexible session dependencies.
pub(crate) fn decode_session_claims(config: &AuthConfig, token: &str) -> Option<SessionClaims> {
    crate::jwt_compat::decode_jose(token, decoding_keys(config), algorithm(config)?)
}

/// Database user row (`users` table) for authentication.
///
/// The projection mirrors the source SQLAlchemy `db.query(User)` column list
/// exactly (all twelve mapped columns, aliased `<table>_<column>`), so the
/// prepared statement matches the recorded exchange for replay. Only `id`
/// and `is_active` are consumed by the devices endpoint. The result columns
/// carry the `users_<column>` aliases, so every field is renamed.
#[derive(Debug, FromMysqlRow)]
pub struct UserRow {
    #[mysql(rename = "users_id")]
    pub id: i32,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_user_name")]
    pub user_name: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_email")]
    pub email: Option<String>,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_git_info")]
    pub git_info: Json<brz_json::OpaqueJson>,
    #[mysql(rename = "users_is_active")]
    pub is_active: i8,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_role")]
    pub role: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_auth_source")]
    pub auth_source: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_preferences")]
    pub preferences: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_created_at")]
    pub created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "users_updated_at")]
    pub updated_at: chrono::NaiveDateTime,
}

/// The source `db.query(User).filter(User.user_name == username).first()`
/// statement: every mapped column, aliased `users_<column>` like SQLAlchemy's
/// labeled query rendering.
pub(crate) const USER_BY_NAME_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.user_name = ? \
     LIMIT 1";

/// The bearer credential accepted by the source `oauth2_scheme`.
///
/// FastAPI's `OAuth2PasswordBearer.__call__` splits the header with
/// `get_authorization_scheme_param` and keeps the credential only when the
/// first word is `Bearer`, case-insensitively. A missing header, an empty
/// header, or any other scheme never reaches `get_current_user`: the scheme
/// itself answers `401 {"detail": "Not authenticated"}`. An empty `Bearer`
/// credential still reaches verification and fails there.
pub(crate) fn bearer_credential(authorization: Option<&str>) -> Option<&str> {
    let header = authorization?;
    let (scheme, token) = header.split_once(' ').unwrap_or((header, ""));
    scheme.eq_ignore_ascii_case("bearer").then_some(token)
}

/// `get_current_user`: verify the bearer token and load the active user.
///
/// Returns `Err(reason)` where the reason selects the source-compatible
/// 401 response detail (`Not authenticated`, `Could not validate credentials`,
/// or `User not activated`).
pub async fn get_current_user<M>(
    config: &AuthConfig,
    mysql: &M,
    authorization: Option<&str>,
) -> Result<UserRow, AuthFailure>
where
    M: brz_mysql::Mysql,
{
    let user_name = verify_session_token(config, authorization)?;
    let user: Option<UserRow> = mysql
        .fetch_optional(USER_BY_NAME_QUERY, (user_name,))
        .await
        .map_err(user_lookup_failure)?;
    select_active_user(user)
}

/// The credential half of `get_current_user`: the Bearer token must decode to
/// a non-empty user-session `sub`.
pub fn verify_session_token(
    config: &AuthConfig,
    authorization: Option<&str>,
) -> Result<String, AuthFailure> {
    let Some(token) = bearer_credential(authorization) else {
        return Err(AuthFailure::NotAuthenticated);
    };
    verify_token(config, token).map_err(|_| AuthFailure::InvalidCredentials)
}

/// The lookup half of `get_current_user`, run on a writer transaction for
/// endpoints whose source shares `Depends(get_db)` with the endpoint body.
pub async fn session_user_in_transaction<T>(
    transaction: &mut T,
    user_name: &str,
) -> Result<UserRow, AuthFailure>
where
    T: brz_mysql::MysqlTransaction,
{
    let user: Option<UserRow> = transaction
        .fetch_optional(USER_BY_NAME_QUERY, (user_name,))
        .await
        .map_err(user_lookup_failure)?;
    select_active_user(user)
}

/// `get_current_user`'s missing or inactive user rejection.
fn select_active_user(user: Option<UserRow>) -> Result<UserRow, AuthFailure> {
    match user {
        None => Err(AuthFailure::InvalidCredentials),
        Some(user) if user.is_active == 0 => Err(AuthFailure::UserNotActivated),
        Some(user) => Ok(user),
    }
}

/// Render a deferred session lookup failure exactly like
/// [`AppAuthenticator`]'s `reject` path.
pub(crate) fn session_auth_error(failure: AuthFailure) -> crate::http_compat::FastApiError {
    session_rejection(session_auth_failure(failure))
}

fn session_rejection(failure: brz_http_server::AuthFailure) -> crate::http_compat::FastApiError {
    match failure {
        brz_http_server::AuthFailure::Internal | brz_http_server::AuthFailure::Unavailable => {
            crate::http_compat::FastApiError::unhandled()
        }
        _ => crate::http_compat::FastApiError::unauthorized(session_auth_detail(failure)),
    }
}

fn user_lookup_failure(error: brz_mysql::MysqlError) -> AuthFailure {
    tracing::error!(%error, "session user lookup failed");
    AuthFailure::Dependency
}

/// Authentication failure classification for source-compatible 401 mapping.
pub enum AuthFailure {
    /// `401 {"detail": "Not authenticated"}`: the request carried no bearer
    /// credential, which the source scheme rejects before `get_current_user`.
    NotAuthenticated,
    /// `401 {"detail": "Could not validate credentials"}`.
    InvalidCredentials,
    /// `401 {"detail": "User not activated"}`.
    UserNotActivated,
    /// User lookup failed; this is a server failure, not an invalid credential.
    Dependency,
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::EncodingKey;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn header(value: &'static str) -> Option<&'static str> {
        Some(value)
    }

    fn token_for(claims: serde_json::Value) -> String {
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret("test-key".as_bytes());
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }

    #[test]
    fn extracts_bearer_token() {
        assert_eq!(
            extract_authorization_token(header("Bearer abc.def")),
            "abc.def"
        );
        assert_eq!(extract_authorization_token(header("bearer abc")), "abc");
        assert_eq!(extract_authorization_token(header("abc")), "abc");
        assert_eq!(extract_authorization_token(None), "");
    }

    #[test]
    fn bearer_credential_matches_source_scheme() {
        assert_eq!(bearer_credential(header("Bearer abc")), Some("abc"));
        assert_eq!(bearer_credential(header("bearer abc")), Some("abc"));
        assert_eq!(bearer_credential(header("BEARER abc")), Some("abc"));
        // Only the scheme selects the branch; the credential itself is
        // forwarded verbatim, including an empty one.
        assert_eq!(bearer_credential(header("Bearer ")), Some(""));
        assert_eq!(bearer_credential(header("Bearer")), Some(""));
        assert_eq!(bearer_credential(header("abc")), None);
        assert_eq!(bearer_credential(header("Basic abc")), None);
        assert_eq!(bearer_credential(header("")), None);
        assert_eq!(bearer_credential(None), None);
    }

    /// The recorded representative sends no `Authorization` header, which the
    /// source scheme rejects with `401 "Not authenticated"` before any
    /// verification or user lookup runs.
    #[tokio::test]
    async fn missing_bearer_credential_is_not_authenticated() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        for (authorization, label) in [
            (None, "no header"),
            (header(""), "empty header"),
            (header("Basic abc"), "non-bearer scheme"),
        ] {
            let error = get_current_user(&config(), &mysql, authorization)
                .await
                .err()
                .unwrap_or_else(|| panic!("{label} must be rejected"));
            assert!(
                matches!(error, AuthFailure::NotAuthenticated),
                "{label} reports the wrong failure"
            );
        }
        assert!(
            mysql.queries().is_empty(),
            "the scheme rejects before the user lookup"
        );
    }

    /// An empty `Bearer` credential reaches verification and reports the
    /// invalid-credential detail instead.
    #[tokio::test]
    async fn empty_bearer_credential_is_invalid_credentials() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        for value in ["Bearer ", "Bearer"] {
            let error = get_current_user(&config(), &mysql, header(value))
                .await
                .err()
                .unwrap_or_else(|| panic!("{value:?} must be rejected"));
            assert!(
                matches!(error, AuthFailure::InvalidCredentials),
                "{value:?} reports the wrong failure"
            );
        }
    }

    #[test]
    fn session_reject_details_follow_the_failure() {
        for (failure, detail) in [
            (AuthFailure::NotAuthenticated, "Not authenticated"),
            (
                AuthFailure::InvalidCredentials,
                "Could not validate credentials",
            ),
            (AuthFailure::UserNotActivated, "User not activated"),
        ] {
            assert_eq!(session_auth_detail(session_auth_failure(failure)), detail);
        }
    }

    #[test]
    fn verifies_session_token_and_rejects_scoped_tokens() {
        let token = token_for(serde_json::json!({"sub": "guofeng10"}));
        assert_eq!(verify_token(&config(), &token).unwrap(), "guofeng10");

        let scoped = token_for(serde_json::json!({"sub": "u", "scope": "read"}));
        assert!(verify_token(&config(), &scoped).is_err());

        let service = token_for(serde_json::json!({"sub": "u", "token_use": "api_key"}));
        assert!(verify_token(&config(), &service).is_err());

        let wework = token_for(serde_json::json!({"sub": "u", "token_use": "wework_access"}));
        assert_eq!(verify_token(&config(), &wework).unwrap(), "u");
    }

    /// The deferred principal resolves only the credential; the handler runs
    /// the user lookup on its writer transaction with the same 401 mapping.
    #[test]
    fn deferred_session_principal_keeps_the_source_credential_failures() {
        assert!(matches!(
            verify_session_token(&config(), None),
            Err(AuthFailure::NotAuthenticated)
        ));
        assert!(matches!(
            verify_session_token(&config(), header("Basic abc")),
            Err(AuthFailure::NotAuthenticated)
        ));
        assert!(matches!(
            verify_session_token(&config(), header("Bearer not-a-jwt")),
            Err(AuthFailure::InvalidCredentials)
        ));
        let token = token_for(serde_json::json!({"sub": "shangpeng"}));
        let authorization = format!("Bearer {token}");
        assert_eq!(
            verify_session_token(&config(), Some(authorization.as_str())).ok(),
            Some("shangpeng".to_string())
        );
    }

    #[test]
    fn present_exp_and_nbf_are_validated_without_leeway() {
        // python-jose's default decode options validate a present `exp`/`nbf`
        // with zero leeway, so a session token the source rejects must not pass
        // here on `jsonwebtoken`'s 60-second default leeway or its skipped `nbf`.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after the epoch")
            .as_secs() as i64;

        let expired = token_for(serde_json::json!({"sub": "u", "exp": now - 30}));
        assert!(verify_token(&config(), &expired).is_err());

        let not_yet_valid = token_for(serde_json::json!({"sub": "u", "nbf": now + 30}));
        assert!(verify_token(&config(), &not_yet_valid).is_err());

        let current = token_for(serde_json::json!({"sub": "u", "exp": now + 30, "nbf": now - 30}));
        assert_eq!(verify_token(&config(), &current).unwrap(), "u");
    }

    #[test]
    fn rejects_wrong_signature_and_missing_sub() {
        let foreign = {
            let header = jsonwebtoken::Header::new(Algorithm::HS256);
            let key = EncodingKey::from_secret("other-key".as_bytes());
            jsonwebtoken::encode(&header, &serde_json::json!({"sub": "u"}), &key).unwrap()
        };
        assert!(verify_token(&config(), &foreign).is_err());

        let missing_sub = token_for(serde_json::json!({"n": 1}));
        assert!(verify_token(&config(), &missing_sub).is_err());
    }

    #[test]
    fn python_scope_truthiness_matches_session_classification() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/jwt-python-jose.json")).unwrap();
        for case in fixture["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|case| case["name"].as_str().unwrap().starts_with("scope_"))
        {
            assert_eq!(
                verify_token(&config(), &token_for(case["claims"].clone())).is_ok(),
                case["session_valid"].as_bool().unwrap(),
                "Python session case {}",
                case["name"]
            );
        }
    }

    #[tokio::test]
    async fn reader_failure_stays_a_server_error() {
        let mysql = crate::sql_test_support::KindQueryCapture::failing_reads();
        let token = token_for(serde_json::json!({"sub":"u"}));
        let authorization = format!("Bearer {token}");
        let failure = get_current_user(&config(), &mysql, Some(&authorization))
            .await
            .expect_err("reader must fail");
        assert!(matches!(failure, AuthFailure::Dependency));
        assert_eq!(mysql.queries().len(), 1);

        use brz_http_server::IntoHttpError as _;
        let arena = brz_http_server::EphemeralBytesArena::new(256);
        let response = session_auth_error(failure).into_http_error(&arena);
        assert_eq!(
            response.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn unsupported_configured_algorithm_cannot_fall_back_to_hs256() {
        let token = token_for(serde_json::json!({"sub":"u"}));
        let mut config = config();
        config.algorithm = "RS256".to_string();
        assert!(verify_token(&config, &token).is_err());
    }

    #[test]
    fn rotates_to_legacy_keys() {
        let config = AuthConfig {
            jwt_key: "new-key".to_string(),
            legacy_jwt_keys: vec!["old-key".to_string()],
            algorithm: "HS256".to_string(),
        };
        let legacy = {
            let header = jsonwebtoken::Header::new(Algorithm::HS256);
            let key = EncodingKey::from_secret("old-key".as_bytes());
            jsonwebtoken::encode(&header, &serde_json::json!({"sub": "legacy-user"}), &key).unwrap()
        };
        assert_eq!(verify_token(&config, &legacy).unwrap(), "legacy-user");
    }
}

#[cfg(test)]
mod scope_contract_tests {
    use super::*;
    #[test]
    fn scope_matches_python_truthiness() {
        for raw in ["null", "false", "0", "0.0", "\"\"", "[]", "{}", "\"read\""] {
            let claims: SessionClaims =
                serde_json::from_str(&format!(r#"{{"sub":"user","scope":{raw}}}"#)).unwrap();
            assert_eq!(
                claims.is_user_session_payload(),
                raw != "\"read\"",
                "scope={raw}"
            );
        }
        let claims: SessionClaims = serde_json::from_str(r#"{"sub":"user"}"#).unwrap();
        assert!(claims.is_user_session_payload());
    }
}

#[cfg(test)]
mod python_compatibility {
    #[test]
    fn session_entry_point_matches_python() {
        let config = crate::config::AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        };
        for (name, claims, expected) in crate::jwt_compat::tests::session_cases() {
            let token = crate::jwt_compat::tests::sign(&claims, b"test-key");
            assert_eq!(
                super::verify_token(&config, &token).is_ok(),
                expected,
                "{name}"
            );
        }
    }
}
