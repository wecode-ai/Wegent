//! Authenticated-user resolution for protected endpoints.
//!
//! Ported from the open-source Python sources `app/core/security.py`
//! (`get_current_user`, `verify_token`), `app/core/jwt_compat.py`
//! (`decode_jose_jwt`), and `app/core/session_token.py`
//! (`is_user_session_payload`) for the interactive-session (Bearer JWT) path:
//!
//! 1. a missing `Authorization` header, or a scheme other than `Bearer`, is
//!    the FastAPI dependency auto-error: 401 `Not authenticated`;
//! 2. a `Bearer` scheme with an empty credential is passed on as the empty
//!    token and then fails verification like any other invalid token;
//! 3. signature/expiry/claim failure -> 401 `Could not validate credentials`;
//! 4. non-interactive session (service `scope`, foreign `token_use`) -> 401;
//! 5. no `users` row for the subject -> 401 as above;
//! 6. deactivated user -> 401 `User not activated`;
//! 7. database failure -> 500, which the source produces by letting the
//!    exception escape `get_current_user`.

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};

use crate::config::AuthConfig;
use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;

/// `WEWORK_ACCESS_TOKEN_USE` (`app.core.session_token`).
pub const WEWORK_ACCESS_TOKEN_USE: &str = "wework_access";

/// Why authentication failed, mapped onto the source HTTP error responses.
#[derive(Debug)]
pub enum AuthError {
    /// FastAPI dependency auto-error: a missing header or a non-Bearer scheme.
    NotAuthenticated,
    /// Source `HTTPException(401, "Could not validate credentials")`.
    InvalidCredentials,
    /// Source `HTTPException(401, "User not activated")`.
    UserNotActivated,
    /// The user lookup dependency failed; the source surfaces a 500.
    Internal,
}

impl AuthError {
    /// Renders the source-compatible FastAPI response for this failure.
    #[must_use]
    pub fn fastapi(&self) -> FastApiError {
        match self {
            Self::NotAuthenticated => FastApiError::unauthorized("Not authenticated"),
            Self::InvalidCredentials => {
                FastApiError::unauthorized("Could not validate credentials")
            }
            Self::UserNotActivated => FastApiError::unauthorized("User not activated"),
            Self::Internal => FastApiError::unhandled_exception(),
        }
    }
}

/// Result of successful token verification: the verified `sub` claim.
#[derive(Debug, Clone)]
pub struct VerifiedSession {
    /// Source `TokenData.username` (JWT `sub` claim).
    pub username: String,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct SessionClaims {
    sub: Option<String>,
    scope: Option<PythonTruthiness>,
    token_use: Option<NullableString>,
}

/// A JSON value reduced to Python truthiness, as `not payload.get("scope")`
/// evaluates it.
#[derive(Debug)]
struct PythonTruthiness(bool);

impl<'de> serde::Deserialize<'de> for PythonTruthiness {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TruthinessVisitor;
        impl<'de> Visitor<'de> for TruthinessVisitor {
            type Value = PythonTruthiness;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("any JSON value")
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(PythonTruthiness(false))
            }
            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(PythonTruthiness(false))
            }
            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(PythonTruthiness(value))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(PythonTruthiness(value != 0))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(PythonTruthiness(value != 0))
            }
            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
                Ok(PythonTruthiness(value != 0.0))
            }
            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(PythonTruthiness(!value.is_empty()))
            }
            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(PythonTruthiness(!value.is_empty()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut populated = false;
                while seq.next_element::<IgnoredAny>()?.is_some() {
                    populated = true;
                }
                Ok(PythonTruthiness(populated))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut populated = false;
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {
                    populated = true;
                }
                Ok(PythonTruthiness(populated))
            }
        }
        deserializer.deserialize_any(TruthinessVisitor)
    }
}

/// A claim that only accepts JSON `null` or a string.
#[derive(Debug)]
enum NullableString {
    Null,
    String(String),
}

impl<'de> serde::Deserialize<'de> for NullableString {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct NullableStringVisitor;
        impl Visitor<'_> for NullableStringVisitor {
            type Value = NullableString;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("null or a string")
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(NullableString::Null)
            }
            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(NullableString::Null)
            }
            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(NullableString::String(value.to_owned()))
            }
            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(NullableString::String(value))
            }
        }
        deserializer.deserialize_any(NullableStringVisitor)
    }
}

/// Extracts the bearer credential like FastAPI's `OAuth2PasswordBearer`.
///
/// The dependency raises 401 `Not authenticated` only when the header is
/// absent or the scheme is not `Bearer`. A `Bearer` scheme carrying no
/// credential yields the empty string, which the caller then passes to the
/// verifier, so it fails as `Could not validate credentials` rather than as an
/// auto-error.
///
/// # Errors
///
/// Returns [`AuthError::NotAuthenticated`] for an absent header, an empty
/// header value, or a non-Bearer scheme.
pub fn extract_bearer_token(authorization: Option<&str>) -> Result<&str, AuthError> {
    // Same split as `fastapi.security.utils.get_authorization_scheme_param`
    // (`str.partition(" ")`): the scheme is everything before the first space
    // and the credential is the remainder, which may be empty. An empty header
    // is falsy in the source and takes the auto-error path.
    let Some(header) = authorization.filter(|header| !header.is_empty()) else {
        return Err(AuthError::NotAuthenticated);
    };
    let (scheme, credentials) = header.split_once(' ').unwrap_or((header, ""));
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(AuthError::NotAuthenticated);
    }
    Ok(credentials)
}

/// The algorithm named by `settings.ALGORITHM`, or `None` when it is one this
/// service cannot verify (the source's `jose` decoder then rejects every
/// token).
fn algorithm(config: &AuthConfig) -> Option<Algorithm> {
    match config.algorithm.as_str() {
        "HS256" => Some(Algorithm::HS256),
        "HS384" => Some(Algorithm::HS384),
        "HS512" => Some(Algorithm::HS512),
        _ => None,
    }
}

/// Decode keys in source order: the active key, then the configured legacy
/// keys, skipping duplicates (`app.core.jwt_compat.get_jwt_decode_secret_keys`).
fn decoding_keys(config: &AuthConfig) -> Vec<&str> {
    let mut keys = vec![config.jwt_key.as_str()];
    for key in &config.legacy_jwt_keys {
        if !keys.contains(&key.as_str()) {
            keys.push(key.as_str());
        }
    }
    keys
}

/// Verifies a user-session JWT against the active then legacy signing keys.
///
/// Mirrors `decode_jose_jwt` (first key that decodes wins) and `verify_token`'s
/// claim checks: `sub` must be present and non-empty, `scope` must be falsy,
/// and `token_use` must be absent, `null`, or `wework_access`.
///
/// # Errors
///
/// Returns [`AuthError::InvalidCredentials`] when the configured algorithm is
/// unsupported, no key verifies the token, or the claims are not a user
/// session.
pub fn verify_session_token(
    token: &str,
    config: &AuthConfig,
) -> Result<VerifiedSession, AuthError> {
    let Some(algorithm) = algorithm(config) else {
        return Err(AuthError::InvalidCredentials);
    };
    let mut last_error = AuthError::InvalidCredentials;
    for key in decoding_keys(config) {
        match decode_token(token, key, algorithm) {
            Ok(claims) => return verified_session(claims),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

/// Decodes and signature-verifies one token with one key.
fn decode_token(token: &str, key: &str, algorithm: Algorithm) -> Result<SessionClaims, AuthError> {
    let mut validation = Validation::new(algorithm);
    // python-jose does not require an `exp` claim to be present; it only
    // validates the claim when it exists.
    validation.required_spec_claims.clear();
    validation.validate_exp = true;
    validation.validate_aud = false;
    validation.leeway = 0;
    let decoding_key = DecodingKey::from_secret(key.as_bytes());
    decode::<SessionClaims>(token, &decoding_key, &validation)
        .map(|token_data| token_data.claims)
        .map_err(|_| AuthError::InvalidCredentials)
}

/// Applies `verify_token` + `is_user_session_payload` claim checks.
fn verified_session(payload: SessionClaims) -> Result<VerifiedSession, AuthError> {
    // `is_user_session_payload`: `scope` must be falsy...
    if payload.scope.is_some_and(|scope| scope.0) {
        return Err(AuthError::InvalidCredentials);
    }
    // ...and `token_use` must be in `{None, WEWORK_ACCESS_TOKEN_USE}`.
    let token_use_ok = match payload.token_use {
        None | Some(NullableString::Null) => true,
        Some(NullableString::String(value)) => value == WEWORK_ACCESS_TOKEN_USE,
    };
    if !token_use_ok {
        return Err(AuthError::InvalidCredentials);
    }
    payload
        .sub
        .filter(|sub| !sub.is_empty())
        .map(|username| VerifiedSession { username })
        .ok_or(AuthError::InvalidCredentials)
}

/// A row of the `users` table, as selected by source authentication.
///
/// Columns beyond `users_is_active` are decoded to keep the selected column
/// list identical to the source query; only the fields the endpoint reads are
/// used, and the rest carry `#[allow(dead_code)]`.
#[derive(Debug, FromMysqlRow)]
pub struct UserRow {
    /// `users.id`
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub users_id: i32,
    /// `users_user_name`
    pub users_user_name: String,
    /// `users.password_hash`
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    /// `users.email`
    pub users_email: Option<String>,
    /// `users.git_info`
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub users_git_info: Json<OpaqueJson>,
    /// `users.is_active`
    pub users_is_active: i8,
    /// `users.role`
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub users_role: String,
    /// `users.auth_source`
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub users_auth_source: String,
    /// `users.preferences`
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub users_preferences: String,
    /// `users.created_at`
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub users_created_at: NaiveDateTime,
    /// `users.updated_at`
    #[allow(dead_code, reason = "selected to match the source column list")]
    pub users_updated_at: NaiveDateTime,
}

/// The source `db.query(User).filter(User.user_name == username).first()`
/// statement: every mapped column, aliased `users_<column>` like SQLAlchemy's
/// labeled query rendering.
pub const USER_BY_NAME_QUERY: &str = "SELECT users.id AS users_id, users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.user_name = ? \
     LIMIT 1";

/// Loads one user by username, mirroring `get_current_user`'s `first()` lookup.
///
/// # Errors
///
/// Returns the driver error when the query cannot be executed.
pub async fn find_user_by_name<M>(mysql: &M, username: &str) -> MysqlResult<Option<UserRow>>
where
    M: Mysql,
{
    mysql.fetch_optional(USER_BY_NAME_QUERY, (username,)).await
}

/// `get_current_user`: verifies the bearer token and loads the active user.
///
/// # Errors
///
/// Returns the [`AuthError`] selecting the source-compatible response.
pub async fn get_current_user<M>(
    config: &AuthConfig,
    mysql: &M,
    authorization: Option<&str>,
) -> Result<UserRow, AuthError>
where
    M: Mysql,
{
    let token = extract_bearer_token(authorization)?;
    let session = verify_session_token(token, config)?;
    let lookup = match find_user_by_name(mysql, &session.username).await {
        Ok(lookup) => lookup,
        Err(error) => {
            tracing::error!(?error, username = %session.username, "user lookup failed");
            return Err(AuthError::Internal);
        }
    };
    resolve_user(lookup)
}

/// The post-lookup decision of `get_current_user`: an existing active row is
/// the authenticated user, a missing row is a credential failure, and a
/// deactivated row is `User not activated`.
fn resolve_user(lookup: Option<UserRow>) -> Result<UserRow, AuthError> {
    match lookup {
        Some(row) if row.users_is_active == 0 => Err(AuthError::UserNotActivated),
        Some(row) => Ok(row),
        None => Err(AuthError::InvalidCredentials),
    }
}

#[cfg(test)]
mod tests {
    use brz_http_server::StatusCode;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::{Value, json};

    use super::*;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "backend-rs-test-key".to_owned(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_owned(),
        }
    }

    fn mint(claims: &Value, key: &str) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            claims,
            &EncodingKey::from_secret(key.as_bytes()),
        )
        .expect("mint token")
    }

    fn valid_claims() -> Value {
        json!({
            "sub": "test-user",
            "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
        })
    }

    fn expiring(offset_hours: i64) -> i64 {
        (chrono::Utc::now() + chrono::Duration::hours(offset_hours)).timestamp()
    }

    fn user_row(is_active: i8) -> UserRow {
        UserRow {
            users_id: 1,
            users_user_name: "test-user".to_owned(),
            users_password_hash: String::new(),
            users_email: Some("test-user@example.com".to_owned()),
            users_git_info: Json(OpaqueJson::from_serializable(Value::Null)),
            users_is_active: is_active,
            users_role: String::new(),
            users_auth_source: String::new(),
            users_preferences: String::new(),
            users_created_at: NaiveDateTime::default(),
            users_updated_at: NaiveDateTime::default(),
        }
    }

    #[test]
    fn accepts_valid_user_session_token() {
        let token = mint(&valid_claims(), "backend-rs-test-key");
        let session = verify_session_token(&token, &config()).expect("valid token");
        assert_eq!(session.username, "test-user");
    }

    #[test]
    fn accepts_wework_session_and_missing_token_use() {
        for claims in [
            json!({"sub": "u", "token_use": WEWORK_ACCESS_TOKEN_USE, "exp": expiring(1)}),
            json!({"sub": "u", "token_use": null, "exp": expiring(1)}),
            json!({"sub": "u", "exp": expiring(1)}),
        ] {
            assert!(
                verify_session_token(&mint(&claims, "backend-rs-test-key"), &config()).is_ok(),
                "claims must be accepted"
            );
        }
    }

    #[test]
    fn rejects_service_scope_and_foreign_token_use() {
        for claims in [
            json!({"sub": "u", "scope": "service", "exp": expiring(1)}),
            json!({"sub": "u", "token_use": "outbound", "exp": expiring(1)}),
        ] {
            assert!(matches!(
                verify_session_token(&mint(&claims, "backend-rs-test-key"), &config()),
                Err(AuthError::InvalidCredentials)
            ));
        }
    }

    #[test]
    fn scope_keeps_python_json_truthiness() {
        for scope in [
            json!(null),
            json!(false),
            json!(0),
            json!(0.0),
            json!(""),
            json!([]),
            json!({}),
        ] {
            let claims = json!({"sub": "u", "scope": scope, "exp": expiring(1)});
            assert!(
                verify_session_token(&mint(&claims, "backend-rs-test-key"), &config()).is_ok(),
                "falsy scope {scope} must be a session"
            );
        }
        for scope in [
            json!(true),
            json!(1),
            json!("x"),
            json!([0]),
            json!({"x": 0}),
        ] {
            let claims = json!({"sub": "u", "scope": scope, "exp": expiring(1)});
            assert!(
                verify_session_token(&mint(&claims, "backend-rs-test-key"), &config()).is_err(),
                "truthy scope {scope} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_missing_sub_and_expired_token() {
        let no_sub = json!({"exp": expiring(1)});
        assert!(verify_session_token(&mint(&no_sub, "backend-rs-test-key"), &config()).is_err());

        let empty_sub = json!({"sub": "", "exp": expiring(1)});
        assert!(verify_session_token(&mint(&empty_sub, "backend-rs-test-key"), &config()).is_err());

        let expired = json!({"sub": "u", "exp": expiring(-1)});
        assert!(verify_session_token(&mint(&expired, "backend-rs-test-key"), &config()).is_err());
    }

    #[test]
    fn rejects_a_token_signed_with_a_foreign_key() {
        let token = mint(&valid_claims(), "backend-rs-foreign-key");
        assert!(verify_session_token(&token, &config()).is_err());
    }

    #[test]
    fn tries_legacy_key_after_active_key_fails() {
        let mut legacy_config = config();
        legacy_config.legacy_jwt_keys = vec!["backend-rs-legacy-key".to_owned()];
        let token = mint(&valid_claims(), "backend-rs-legacy-key");
        let session = verify_session_token(&token, &legacy_config).expect("legacy key accepted");
        assert_eq!(session.username, "test-user");
    }

    #[test]
    fn decoding_keys_skip_duplicates_but_keep_order() {
        let mut legacy_config = config();
        legacy_config.legacy_jwt_keys = vec![
            "backend-rs-test-key".to_owned(),
            "b".to_owned(),
            "b".to_owned(),
        ];
        assert_eq!(decoding_keys(&legacy_config), ["backend-rs-test-key", "b"]);
    }

    #[test]
    fn rejects_an_unsupported_configured_algorithm() {
        let mut other = config();
        other.algorithm = "RS256".to_owned();
        let token = mint(&valid_claims(), "backend-rs-test-key");
        assert!(verify_session_token(&token, &other).is_err());
    }

    #[test]
    fn extracts_bearer_token_like_fastapi() {
        assert_eq!(extract_bearer_token(Some("Bearer abc")).unwrap(), "abc");
        assert_eq!(extract_bearer_token(Some("bearer abc")).unwrap(), "abc");
        // The credential keeps its verbatim remainder after the first space.
        assert_eq!(extract_bearer_token(Some("Bearer  abc")).unwrap(), " abc");
        // A `Bearer` scheme with no credential is not an auto-error: the empty
        // token is returned and then fails verification.
        assert_eq!(extract_bearer_token(Some("Bearer")).unwrap(), "");
        assert_eq!(extract_bearer_token(Some("Bearer ")).unwrap(), "");
        // An absent, empty, or non-Bearer header is the dependency auto-error.
        assert!(matches!(
            extract_bearer_token(Some("Basic z")),
            Err(AuthError::NotAuthenticated)
        ));
        assert!(matches!(
            extract_bearer_token(Some("")),
            Err(AuthError::NotAuthenticated)
        ));
        assert!(matches!(
            extract_bearer_token(None),
            Err(AuthError::NotAuthenticated)
        ));
    }

    #[test]
    fn an_empty_credential_fails_verification() {
        // What `get_current_user` does with the empty token an empty Bearer
        // credential yields.
        assert!(matches!(
            verify_session_token("", &config()),
            Err(AuthError::InvalidCredentials)
        ));
    }

    #[test]
    fn resolve_user_maps_the_lookup_outcome() {
        assert!(matches!(
            resolve_user(None),
            Err(AuthError::InvalidCredentials)
        ));
        assert!(matches!(
            resolve_user(Some(user_row(0))),
            Err(AuthError::UserNotActivated)
        ));
        assert_eq!(
            resolve_user(Some(user_row(1)))
                .expect("an active row authenticates")
                .users_user_name,
            "test-user"
        );
    }

    #[test]
    fn auth_errors_render_the_source_responses() {
        // Every 401 carries the Bearer challenge, as `app.core.security` and
        // FastAPI's OAuth2 dependency both set it.
        for error in [
            AuthError::NotAuthenticated,
            AuthError::InvalidCredentials,
            AuthError::UserNotActivated,
        ] {
            assert_eq!(error.fastapi().status(), StatusCode::UNAUTHORIZED);
        }
        assert_eq!(
            AuthError::Internal.fastapi().status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
