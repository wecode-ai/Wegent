//! Authenticated-user resolution for protected endpoints.
//!
//! Mirrors the source `app.core.security.get_current_user` /
//! `verify_token` / `decode_jose_jwt` chain for the interactive-session
//! (Bearer JWT) path used by the quota endpoint:
//!
//! 1. missing or non-Bearer `Authorization` header -> 403 `Not authenticated`
//!    (FastAPI `OAuth2PasswordBearer` auto-error);
//! 2. signature/expiry/claim failure -> 401 `Could not validate credentials`;
//! 3. non-interactive session (service `scope`, foreign `token_use`) -> 401;
//! 4. user lookup and activation state handled by the caller.
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::de::{IgnoredAny, MapAccess, SeqAccess, Visitor};

use wegent_backend_rs::config::AuthConfig;

/// Why authentication failed, mapped onto the source HTTP error responses.
#[derive(Debug)]
pub enum AuthError {
    /// FastAPI dependency auto-error: missing header or non-Bearer scheme.
    NotAuthenticated,
    /// Source `HTTPException(401, "Could not validate credentials")`.
    InvalidCredentials,
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

#[derive(Debug)]
enum NullableString {
    Null,
    String(String),
}

impl<'de> serde::Deserialize<'de> for NullableString {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct NullableStringVisitor;
        impl<'de> Visitor<'de> for NullableStringVisitor {
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
pub fn extract_bearer_token(authorization: Option<&str>) -> Result<&str, AuthError> {
    let Some(header) = authorization else {
        return Err(AuthError::NotAuthenticated);
    };
    // Same split as fastapi.security.utils.get_authorization_scheme_param.
    let mut parts = header.splitn(2, ' ');
    let scheme = parts.next().unwrap_or_default();
    let param = parts.next().unwrap_or_default();
    if scheme.eq_ignore_ascii_case("bearer") {
        Ok(param)
    } else {
        Err(AuthError::NotAuthenticated)
    }
}

/// Verifies a user-session JWT against the active then legacy signing keys.
///
/// Mirrors `decode_jose_jwt` (active key first, then configured legacy keys)
/// and `verify_token`'s claim checks: `sub` must be present and the payload
/// must be an interactive user session (`scope` falsy, `token_use` absent or
/// `wework_access`).
pub fn verify_session_token(
    token: &str,
    config: &AuthConfig,
) -> Result<VerifiedSession, AuthError> {
    if config.algorithm != "HS256" {
        // The deployed source uses HS256; other algorithms are not part of
        // the verified behavior and are rejected like an unusable key set.
        return Err(AuthError::InvalidCredentials);
    }
    let mut keys = std::iter::once(config.jwt_key.as_str());
    let mut last_error = AuthError::InvalidCredentials;
    for key in keys
        .by_ref()
        .chain(config.legacy_jwt_keys.iter().map(String::as_str))
    {
        match decode_token(token, key) {
            Ok(payload) => return verified_session(payload),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

/// Decodes and signature-verifies one HS256 token with one key.
fn decode_token(token: &str, key: &str) -> Result<SessionClaims, AuthError> {
    let mut validation = Validation::new(Algorithm::HS256);
    // python-jose does not require an `exp` claim to be present; it only
    // validates the claim when it exists.
    validation.required_spec_claims.clear();
    validation.validate_exp = true;
    validation.validate_aud = false;
    validation.leeway = 0;
    let decoding_key = DecodingKey::from_secret(key.as_bytes());
    let token_data = decode::<SessionClaims>(token, &decoding_key, &validation)
        .map_err(|_| AuthError::InvalidCredentials)?;
    Ok(token_data.claims)
}

/// Applies `verify_token` + `is_user_session_payload` claim checks.
fn verified_session(payload: SessionClaims) -> Result<VerifiedSession, AuthError> {
    // is_user_session_payload: scope must be falsy and token_use absent or
    // the WeWork session value.
    if payload.scope.is_some_and(|scope| scope.0) {
        return Err(AuthError::InvalidCredentials);
    }
    let token_use_ok = if payload.token_use.is_some() {
        match payload.token_use {
            Some(NullableString::Null) => true,
            Some(NullableString::String(value)) => value == "wework_access",
            None => false,
        }
    } else {
        true
    };
    if !token_use_ok {
        return Err(AuthError::InvalidCredentials);
    }
    let username = payload
        .sub
        .filter(|sub| !sub.is_empty())
        .ok_or(AuthError::InvalidCredentials)?;
    Ok(VerifiedSession { username })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use serde_json::Value;

    fn config() -> wegent_backend_rs::config::AuthConfig {
        wegent_backend_rs::config::AuthConfig {
            jwt_key: "test-secret".to_owned(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_owned(),
        }
    }

    fn mint(claims: Value, key: &str) -> String {
        encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(key.as_bytes()),
        )
        .expect("mint token")
    }

    fn valid_claims() -> Value {
        serde_json::json!({
            "sub": "liting9",
            "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
        })
    }

    #[test]
    fn accepts_valid_user_session_token() {
        let token = mint(valid_claims(), "test-secret");
        let session = verify_session_token(&token, &config()).expect("valid token");
        assert_eq!(session.username, "liting9");
    }

    #[test]
    fn accepts_wework_session_and_missing_token_use() {
        for claims in [
            serde_json::json!({
                "sub": "u",
                "token_use": "wework_access",
                "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
            }),
            serde_json::json!({
                "sub": "u",
                "token_use": null,
                "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
            }),
        ] {
            let token = mint(claims, "test-secret");
            assert!(verify_session_token(&token, &config()).is_ok());
        }
    }

    #[test]
    fn rejects_service_scope_and_foreign_token_use() {
        for claims in [
            serde_json::json!({
                "sub": "u",
                "scope": "service",
                "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
            }),
            serde_json::json!({
                "sub": "u",
                "token_use": "outbound",
                "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
            }),
        ] {
            let token = mint(claims, "test-secret");
            assert!(matches!(
                verify_session_token(&token, &config()),
                Err(AuthError::InvalidCredentials)
            ));
        }
    }

    #[test]
    fn scope_keeps_python_json_truthiness_and_invalid_token_use_is_rejected() {
        for scope in [
            serde_json::json!(null),
            serde_json::json!(false),
            serde_json::json!(0),
            serde_json::json!(0.0),
            serde_json::json!(""),
            serde_json::json!([]),
            serde_json::json!({}),
        ] {
            let claims = serde_json::json!({
                "sub": "u",
                "scope": scope,
                "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
            });
            assert!(verify_session_token(&mint(claims, "test-secret"), &config()).is_ok());
        }
        for scope in [
            serde_json::json!(true),
            serde_json::json!(1),
            serde_json::json!("x"),
            serde_json::json!([0]),
            serde_json::json!({"x": 0}),
        ] {
            let claims = serde_json::json!({
                "sub": "u",
                "scope": scope,
                "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
            });
            assert!(verify_session_token(&mint(claims, "test-secret"), &config()).is_err());
        }
        let invalid_token_use = serde_json::json!({
            "sub": "u",
            "token_use": false,
            "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp(),
        });
        assert!(verify_session_token(&mint(invalid_token_use, "test-secret"), &config()).is_err());
    }

    #[test]
    fn rejects_missing_sub_and_expired_token() {
        let no_sub = serde_json::json!({
            "exp": (chrono::Utc::now() + chrono::Duration::hours(1)).timestamp()
        });
        assert!(verify_session_token(&mint(no_sub, "test-secret"), &config()).is_err());

        let expired = serde_json::json!({
            "sub": "u",
            "exp": (chrono::Utc::now() - chrono::Duration::hours(1)).timestamp(),
        });
        assert!(verify_session_token(&mint(expired, "test-secret"), &config()).is_err());
    }

    #[test]
    fn tries_legacy_key_after_active_key_fails() {
        let claims = valid_claims();
        let token = mint(claims.clone(), "legacy-secret");
        let mut cfg = config();
        cfg.legacy_jwt_keys = vec!["legacy-secret".to_owned()];
        let session = verify_session_token(&token, &cfg).expect("legacy key accepted");
        assert_eq!(session.username, "liting9");

        let wrong_key = mint(claims, "other-secret");
        assert!(verify_session_token(&wrong_key, &cfg).is_err());
    }

    #[test]
    fn extracts_bearer_token_like_fastapi() {
        assert_eq!(
            extract_bearer_token(Some("Bearer abc")).expect("valid"),
            "abc"
        );
        assert_eq!(
            extract_bearer_token(Some("bearer abc")).expect("case-insensitive"),
            "abc"
        );
        assert_eq!(
            extract_bearer_token(Some("Bearer")).expect("empty param"),
            ""
        );
        assert!(matches!(
            extract_bearer_token(Some("Basic z")),
            Err(AuthError::NotAuthenticated)
        ));
        assert!(matches!(
            extract_bearer_token(None),
            Err(AuthError::NotAuthenticated)
        ));
    }
}
