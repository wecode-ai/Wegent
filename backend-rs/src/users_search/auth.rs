// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! JWT session verification and user lookup.
//!
//! Mirrors `app.core.security.get_current_user`: decode the bearer token
//! (`app.core.jwt_compat.decode_jose_jwt` with the active then legacy
//! signing keys, `app.core.session_token.is_user_session_payload`), then
//! load the user row and reject missing or inactive users with
//! `401 {"detail": ...}`.
#[cfg(test)]
use jsonwebtoken::Algorithm;

use super::auth_error::AuthError;
use crate::config::AuthConfig;

/// `verify_token` with key rotation: try the active key, then legacy keys.
fn verify_token(config: &AuthConfig, token: &str) -> Result<String, AuthError> {
    crate::auth::verify_token(config, token).map_err(|_| AuthError::invalid_credentials())
}

/// Database user row (`users` table) for authentication.
///
/// The projection mirrors the source SQLAlchemy `db.query(User)` column list
/// exactly (all twelve mapped columns, aliased `users_<column>`), so the
/// prepared statement matches the recorded exchange for replay. Only `id`,
/// `user_name`, and `is_active` are consumed here.
#[derive(Debug, brz_mysql::FromMysqlRow)]
pub struct UserRow {
    #[mysql(rename = "users_id")]
    pub id: i32,
    #[mysql(rename = "users_user_name")]
    pub user_name: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_password_hash")]
    pub users_password_hash: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_email")]
    pub email: Option<String>,
    #[allow(dead_code)]
    #[mysql(rename = "users_git_info")]
    pub git_info: brz_mysql::Json<brz_json::OpaqueJson>,
    #[mysql(rename = "users_is_active")]
    pub is_active: i8,
    #[allow(dead_code)]
    #[mysql(rename = "users_role")]
    pub role: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_auth_source")]
    pub auth_source: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_preferences")]
    pub preferences: String,
    #[allow(dead_code)]
    #[mysql(rename = "users_created_at")]
    pub created_at: chrono::NaiveDateTime,
    #[allow(dead_code)]
    #[mysql(rename = "users_updated_at")]
    pub updated_at: chrono::NaiveDateTime,
}

/// `get_current_user`: verify the bearer token and load the active user.
pub async fn get_current_user<M>(
    config: &AuthConfig,
    mysql: &M,
    authorization: Option<&str>,
) -> Result<UserRow, AuthError>
where
    M: brz_mysql::Mysql,
{
    let token =
        crate::auth::bearer_credential(authorization).ok_or_else(AuthError::missing_token)?;
    let username = verify_token(config, token)?;
    let user: Option<UserRow> = mysql
        .fetch_optional(crate::auth::USER_BY_NAME_QUERY, (username,))
        .await
        .map_err(AuthError::dependency)?;
    match user {
        None => Err(AuthError::invalid_credentials()),
        Some(user) if user.is_active == 0 => Err(AuthError::user_not_activated()),
        Some(user) => Ok(user),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuthConfig;
    use jsonwebtoken::EncodingKey;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn token_for(claims: serde_json::Value) -> String {
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret("test-key".as_bytes());
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }

    #[tokio::test]
    async fn oauth2_scheme_controls_user_lookup() {
        let config = crate::config::AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        };
        let token = crate::jwt_compat::tests::sign(&serde_json::json!({"sub":"u"}), b"test-key");
        for (authorization, queries) in [
            (Some(token.clone()), 0),
            (Some(format!("bEaReR {token}")), 1),
            (Some(format!("Bearer {token}")), 1),
            (None, 0),
        ] {
            let mysql = crate::sql_test_support::KindQueryCapture::default();
            assert!(
                get_current_user(&config, &mysql, authorization.as_deref())
                    .await
                    .is_err()
            );
            assert_eq!(mysql.queries().len(), queries);
        }
    }

    #[test]
    fn verifies_session_token_and_rejects_scoped_tokens() {
        let token = token_for(serde_json::json!({"sub": "junlong5"}));
        assert_eq!(verify_token(&config(), &token).unwrap(), "junlong5");

        let scoped = token_for(serde_json::json!({"sub": "u", "scope": "read"}));
        assert!(verify_token(&config(), &scoped).is_err());

        let service = token_for(serde_json::json!({"sub": "u", "token_use": "api_key"}));
        assert!(verify_token(&config(), &service).is_err());

        let wework = token_for(serde_json::json!({"sub": "u", "token_use": "wework_access"}));
        assert_eq!(verify_token(&config(), &wework).unwrap(), "u");
    }

    #[test]
    fn rejects_wrong_signature_and_missing_sub() {
        let foreign = {
            let header = jsonwebtoken::Header::new(Algorithm::HS256);
            let key = EncodingKey::from_secret("other-key".as_bytes());
            jsonwebtoken::encode(&header, &serde_json::json!({"sub": "u"}), &key).unwrap()
        };
        assert!(verify_token(&config(), &foreign).is_err());

        let no_sub = token_for(serde_json::json!({"user_id": 1}));
        assert!(verify_token(&config(), &no_sub).is_err());
    }

    #[test]
    fn rotates_to_legacy_key() {
        let config = AuthConfig {
            jwt_key: "new-key".to_string(),
            legacy_jwt_keys: vec!["old-key".to_string()],
            algorithm: "HS256".to_string(),
        };
        let legacy_token = {
            let header = jsonwebtoken::Header::new(Algorithm::HS256);
            let key = EncodingKey::from_secret("old-key".as_bytes());
            jsonwebtoken::encode(&header, &serde_json::json!({"sub": "legacy-user"}), &key).unwrap()
        };
        assert_eq!(verify_token(&config, &legacy_token).unwrap(), "legacy-user");
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
