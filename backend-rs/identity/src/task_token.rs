// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wegent task-token verification (`app.services.auth.task_token`).
//!
//! `extract_token_from_header` keeps only the credential of a two-token
//! `Bearer <token>` header, and `verify_task_token` decodes a
//! `type=task_token` JWT with the active key and then each configured legacy
//! decode-only key (`jwt_compat.decode_pyjwt`): signature and `exp` are
//! validated with no leeway, `nbf` is honoured, and no audience is required.
//! `task_id`, `subtask_id`, `user_id` and `user_name` are read with `[]` in
//! the source, so a missing one rejects the token; `exp` is read with `.get`
//! and defaults to `0`.
//!
//! Both the runtime-user endpoint and the MCP servers authenticate with this
//! contract.

use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;

use crate::config::AuthConfig;

/// `verify_task_token`'s required `type` claim value.
const TASK_TOKEN_TYPE: &str = "task_token";

pub fn create_personal_runtime_token(
    config: &AuthConfig,
    user_id: i64,
    user_name: &str,
) -> Result<String, crate::http_compat::FastApiError> {
    let now = chrono::Utc::now().timestamp();
    let hour = 60 * 60;
    let expires_at = now - now.rem_euclid(hour) + 24 * hour;
    crate::wework_auth_tokens::create_token(
        &config.jwt_key,
        &config.algorithm,
        serde_json::json!({
            "type": TASK_TOKEN_TYPE,
            "task_id": 0,
            "subtask_id": 0,
            "user_id": user_id,
            "user_name": user_name,
            "exp": expires_at,
        }),
    )
}

/// The authenticated task identity carried by a verified task token.
pub struct TaskTokenIdentity {
    pub user_id: i64,
    #[allow(dead_code, reason = "part of the task-token identity contract")]
    pub task_id: i64,
    #[allow(dead_code, reason = "part of the task-token identity contract")]
    pub subtask_id: i64,
    #[allow(dead_code, reason = "part of the task-token identity contract")]
    pub user_name: String,
    /// `token_info.expire_at` (`payload["exp"]`, `0` when absent).
    pub expire_at: i64,
    pub project_group_execution: bool,
}

/// The token claim set.
///
/// `task_id`, `subtask_id`, `user_id` and `user_name` are required through
/// their deserialization type, matching the source's `[]` access; `exp` stays
/// optional and is additionally validated by `jsonwebtoken`.
#[derive(Debug, Deserialize)]
struct TaskTokenClaims {
    #[serde(rename = "type")]
    token_type: Option<String>,
    task_id: i64,
    subtask_id: i64,
    user_id: i64,
    user_name: String,
    exp: Option<i64>,
    #[serde(default)]
    project_group_execution: bool,
    device_manager_execution_id: Option<i64>,
    dispatch_id: Option<String>,
}

/// `extract_token_from_header`: the credential of a two-token
/// `Bearer <token>` header (`str.split()` collapses runs of whitespace and
/// drops empty tokens), or `None` for any other shape.
pub fn extract_token_from_header(authorization: &str) -> Option<&str> {
    let mut parts = authorization.split_whitespace();
    let scheme = parts.next()?;
    let token = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    scheme.eq_ignore_ascii_case("bearer").then_some(token)
}

/// `verify_task_token`: decode and validate the task token carried by an
/// `Authorization` header value. Any failure returns `None`.
pub fn verify(config: &AuthConfig, authorization: Option<&str>) -> Option<TaskTokenIdentity> {
    let token = extract_token_from_header(authorization?)?;
    let claims = decode_task_token(config, token)?;
    if claims.token_type.as_deref() != Some(TASK_TOKEN_TYPE) {
        return None;
    }
    Some(TaskTokenIdentity {
        user_id: claims.user_id,
        task_id: claims.task_id,
        subtask_id: claims.subtask_id,
        user_name: claims.user_name,
        expire_at: claims.exp.unwrap_or(0),
        project_group_execution: claims.project_group_execution
            || claims.device_manager_execution_id.is_some()
            || claims
                .dispatch_id
                .as_deref()
                .is_some_and(|id| id.starts_with("collaboration-group:")),
    })
}

/// Personal connection grants belong to the caller only in a personal execution.
pub fn verify_personal_connector(
    config: &AuthConfig,
    authorization: Option<&str>,
) -> Option<TaskTokenIdentity> {
    verify(config, authorization).filter(|identity| !identity.project_group_execution)
}

/// Decode a task token with the active key, then each legacy key.
fn decode_task_token(config: &AuthConfig, token: &str) -> Option<TaskTokenClaims> {
    let mut validation = Validation::new(algorithm(config));
    // python-jose/PyJWT defaults: signature and `exp` when present, no audience,
    // no required claims, and no leeway.
    validation.validate_aud = false;
    validation.validate_exp = true;
    validation.validate_nbf = true;
    validation.leeway = 0;
    validation.required_spec_claims.clear();
    decoding_keys(config).into_iter().find_map(|key_bytes| {
        decode::<TaskTokenClaims>(token, &DecodingKey::from_secret(&key_bytes), &validation)
            .ok()
            .map(|data| data.claims)
    })
}

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

/// Algorithm from settings (`ALGORITHM`, default `HS256`).
fn algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
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

    #[test]
    fn personal_runtime_token_uses_the_verified_account_without_task_delegation() {
        let config = config();
        let token = create_personal_runtime_token(&config, 42, "account").unwrap();
        let identity = verify(&config, Some(&format!("Bearer {token}"))).unwrap();
        assert_eq!(identity.user_id, 42);
        assert_eq!(identity.user_name, "account");
        assert_eq!((identity.task_id, identity.subtask_id), (0, 0));
        assert!(identity.expire_at > chrono::Utc::now().timestamp());
    }

    fn token_for(claims: serde_json::Value) -> String {
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret("test-key".as_bytes());
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }

    fn task_claims() -> serde_json::Value {
        serde_json::json!({
            "task_id": 1606,
            "subtask_id": 9001,
            "user_id": 5831,
            "user_name": "example-user",
            "exp": 1893456000,
            "type": "task_token",
        })
    }

    #[test]
    fn extracts_the_bearer_credential_only_for_a_two_token_header() {
        assert_eq!(extract_token_from_header("Bearer abc.def"), Some("abc.def"));
        assert_eq!(extract_token_from_header("bearer  abc"), Some("abc"));
        assert_eq!(extract_token_from_header("Bearer"), None);
        assert_eq!(extract_token_from_header("Basic abc"), None);
        assert_eq!(extract_token_from_header("Bearer a b"), None);
        assert_eq!(extract_token_from_header(""), None);
    }

    #[test]
    fn accepts_a_task_token_and_carries_the_identity() {
        let token = token_for(task_claims());
        let identity = verify(&config(), Some(&format!("Bearer {token}"))).expect("valid token");
        assert_eq!(identity.user_id, 5831);
        assert_eq!(identity.task_id, 1606);
        assert_eq!(identity.subtask_id, 9001);
        assert_eq!(identity.user_name, "example-user");
        assert_eq!(identity.expire_at, 1893456000);
    }

    #[test]
    fn project_group_tokens_keep_task_authority_without_personal_connector_access() {
        for (claim, value) in [
            ("project_group_execution", serde_json::json!(true)),
            ("device_manager_execution_id", serde_json::json!(42)),
            (
                "dispatch_id",
                serde_json::json!("collaboration-group:42:assignment"),
            ),
        ] {
            let mut claims = task_claims();
            claims[claim] = value;
            let header = format!("Bearer {}", token_for(claims));
            assert!(verify(&config(), Some(&header)).is_some());
            assert!(verify_personal_connector(&config(), Some(&header)).is_none());
        }
        let personal = format!("Bearer {}", token_for(task_claims()));
        assert!(verify_personal_connector(&config(), Some(&personal)).is_some());
    }

    #[test]
    fn rejects_non_task_tokens_and_malformed_headers() {
        let mut session = task_claims();
        session["type"] = serde_json::json!("access");
        assert!(verify(&config(), Some(&format!("Bearer {}", token_for(session)))).is_none());

        assert!(verify(&config(), None).is_none());
        assert!(verify(&config(), Some("Bearer")).is_none());
        assert!(verify(&config(), Some("Bearer not-a-jwt")).is_none());
    }

    #[test]
    fn rejects_a_missing_required_claim_and_a_wrong_signature() {
        for claim in ["user_id", "task_id", "subtask_id", "user_name"] {
            let mut missing = task_claims();
            missing.as_object_mut().unwrap().remove(claim);
            assert!(
                verify(&config(), Some(&format!("Bearer {}", token_for(missing)))).is_none(),
                "missing {claim} must reject the token"
            );
        }

        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret(b"other-key");
        let forged = jsonwebtoken::encode(&header, &task_claims(), &key).unwrap();
        assert!(verify(&config(), Some(&format!("Bearer {forged}"))).is_none());
    }

    #[test]
    fn rejects_an_expired_task_token() {
        let mut claims = task_claims();
        claims["exp"] = serde_json::json!(1);
        assert!(verify(&config(), Some(&format!("Bearer {}", token_for(claims)))).is_none());
    }

    #[test]
    fn falls_back_to_a_legacy_decode_key() {
        let mut config = config();
        config.legacy_jwt_keys = vec!["legacy-key".to_string()];
        let header = jsonwebtoken::Header::new(Algorithm::HS256);
        let key = EncodingKey::from_secret(b"legacy-key");
        let token = jsonwebtoken::encode(&header, &task_claims(), &key).unwrap();
        assert!(verify(&config, Some(&format!("Bearer {token}"))).is_some());
    }
}
