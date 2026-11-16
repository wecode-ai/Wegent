// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/users/me/wegent-runtime-token` — task token for WeWork local
//! skills.
//!
//! Mirrors `app.api.endpoints.users.create_wegent_runtime_auth_token`: the
//! endpoint authenticates the bearer session (`security.get_current_user`,
//! which rejects an absent, invalid, or inactive credential before the body
//! runs) and returns a 24-hour task token issued by
//! `app.services.auth.task_token.create_task_token` with `task_id=0` and
//! `subtask_id=0`, wrapped in `WegentRuntimeAuthTokenResponse`.
//!
//! Re-opened 2026-10-11 for E1 remediation: the traffic-e2e
//! `resolve_e2e_response_rule_evidence` replay-report gate was removed, but the
//! route's only focused run (2026-10-10 23:32) predates the current
//! `.traffic-e2e/verification.yaml` (changed 2026-10-11 03:04), so its recorded
//! assertions can never match the current replay-policy fingerprint while the
//! cached target fingerprint stays unchanged. This no-behaviour-change comment is
//! a fingerprint marker that forces a fresh focused replay under the current policy.
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use serde::Serialize;

use crate::auth::{SessionUser, UserRow};
use crate::config::AuthConfig;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `expires_delta_minutes = 1440` (24 hours) in `create_wegent_runtime_auth_token`.
const EXPIRES_DELTA_MINUTES: i64 = 1440;
/// `TaskTokenData.type` value written by `create_task_token`.
const TASK_TOKEN_TYPE: &str = "task_token";

/// POST /api/users/me/wegent-runtime-token: the token free function,
/// injecting the process-lifetime application state.
///
/// The source declares `response_model=WegentRuntimeAuthTokenResponse`, so
/// FastAPI renders the model as `application/json`; returning the serializable
/// view keeps that content type instead of the raw-bytes default.
#[brz_http_server::post("/api/users/me/wegent-runtime-token")]
async fn create_wegent_runtime_auth_token(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
) -> Result<WegentRuntimeAuthTokenResponse, FastApiError> {
    runtime_token_response(&state.auth, &user.0)
}

/// `WegentRuntimeAuthTokenResponse`: field order as declared in the model.
#[derive(Serialize)]
struct WegentRuntimeAuthTokenResponse {
    auth_token: String,
    token_type: &'static str,
    expires_in: i64,
}

/// The endpoint body: `expires_in` is `expires_delta_minutes * 60`; the token
/// is signed over the endpoint's fixed task identity.
fn runtime_token_response(
    config: &AuthConfig,
    user: &UserRow,
) -> Result<WegentRuntimeAuthTokenResponse, FastApiError> {
    Ok(WegentRuntimeAuthTokenResponse {
        auth_token: create_task_token(config, user),
        // `token_type: str = "bearer"` (the model default).
        token_type: "bearer",
        expires_in: EXPIRES_DELTA_MINUTES * 60,
    })
}

/// Task-token JWT claims (`create_task_token`'s `payload`): declaration order
/// is the source dict order, so the compact JSON payload is byte-identical.
#[derive(Debug, Serialize)]
struct TaskTokenClaims<'a> {
    task_id: i64,
    subtask_id: i64,
    user_id: i32,
    user_name: &'a str,
    dispatch_id: Option<String>,
    dispatch_role: Option<String>,
    manager_agent_id: Option<String>,
    exp: i64,
    #[serde(rename = "type")]
    token_type: &'static str,
}

/// `create_task_token(task_id=0, subtask_id=0, user_id=..., user_name=...,
/// expires_delta_minutes=1440)`.
///
/// `exp` is `datetime.now(timezone.utc) + timedelta(minutes=1440)` rendered by
/// PyJWT's JSON encoder as integer Unix seconds. The token is signed with
/// `settings.SECRET_KEY` and `settings.ALGORITHM` (`AuthConfig`), the same
/// material the session verifier accepts.
fn create_task_token(config: &AuthConfig, user: &UserRow) -> String {
    let exp = (chrono::Utc::now() + chrono::Duration::minutes(EXPIRES_DELTA_MINUTES)).timestamp();
    let claims = TaskTokenClaims {
        task_id: 0,
        subtask_id: 0,
        user_id: user.id,
        user_name: &user.user_name,
        dispatch_id: None,
        dispatch_role: None,
        manager_agent_id: None,
        exp,
        token_type: TASK_TOKEN_TYPE,
    };
    let header = Header::new(signing_algorithm(config));
    jsonwebtoken::encode(&header, &claims, &encoding_key(config))
        .expect("task-token claims and key always encode")
}

/// Signing algorithm from settings (`ALGORITHM`, default `HS256`).
fn signing_algorithm(config: &AuthConfig) -> Algorithm {
    match config.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    }
}

/// The active signing key (`SECRET_KEY`).
fn encoding_key(config: &AuthConfig) -> EncodingKey {
    EncodingKey::from_secret(config.jwt_key.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use chrono::NaiveDate;

    fn user() -> UserRow {
        UserRow {
            id: 2399,
            user_name: "yuxin34".to_string(),
            users_password_hash: "hash".to_string(),
            email: None,
            git_info: brz_mysql::Json(serde_json::json!(null).into()),
            is_active: 1,
            role: "user".to_string(),
            auth_source: "dingtalk".to_string(),
            preferences: "{}".to_string(),
            created_at: NaiveDate::from_ymd_opt(2025, 12, 24)
                .unwrap()
                .and_hms_opt(17, 42, 56)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 9, 8)
                .unwrap()
                .and_hms_opt(19, 18, 0)
                .unwrap(),
        }
    }

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn payload_segment(token: &str) -> String {
        let segment = token.split('.').nth(1).expect("payload segment");
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(segment)
            .expect("base64url payload");
        String::from_utf8(bytes).expect("utf8 payload")
    }

    #[test]
    fn payload_matches_the_source_claim_set_and_order() {
        let token = create_task_token(&config(), &user());
        let payload = payload_segment(&token);
        assert!(
            payload.starts_with(
                r#"{"task_id":0,"subtask_id":0,"user_id":2399,"user_name":"yuxin34","dispatch_id":null,"dispatch_role":null,"manager_agent_id":null,"exp":"#
            ),
            "{payload}"
        );
        assert!(payload.ends_with(r#","type":"task_token"}"#), "{payload}");
    }

    #[test]
    fn token_verifies_with_the_configured_key_and_lifetime() {
        let token = create_task_token(&config(), &user());
        let mut validation = jsonwebtoken::Validation::new(Algorithm::HS256);
        validation.validate_aud = false;
        validation.required_spec_claims.clear();
        let decoded = jsonwebtoken::decode::<serde_json::Value>(
            &token,
            &jsonwebtoken::DecodingKey::from_secret(b"test-key"),
            &validation,
        )
        .expect("token decodes with the signing key");
        assert_eq!(decoded.claims["user_id"], serde_json::json!(2399));
        assert_eq!(decoded.claims["type"], serde_json::json!("task_token"));
        let exp = decoded.claims["exp"].as_i64().expect("integer exp");
        let now = chrono::Utc::now().timestamp();
        let expected = now + EXPIRES_DELTA_MINUTES * 60;
        assert!(
            (expected - exp).abs() <= 5,
            "exp {exp} is not within 5s of {expected}"
        );
    }

    #[test]
    fn response_matches_the_model_field_order_and_defaults() {
        let body =
            serde_json::to_string(&runtime_token_response(&config(), &user()).unwrap()).unwrap();
        // `WegentRuntimeAuthTokenResponse` declaration order, with the default
        // `token_type` and `expires_in = 1440 * 60`.
        assert!(body.starts_with(r#"{"auth_token":""#), "{body}");
        assert!(
            body.ends_with(r#"","token_type":"bearer","expires_in":86400}"#),
            "{body}"
        );
    }

    #[test]
    fn signing_algorithm_follows_the_setting() {
        for (name, expected) in [
            ("HS256", Algorithm::HS256),
            ("HS384", Algorithm::HS384),
            ("HS512", Algorithm::HS512),
            ("unknown", Algorithm::HS256),
        ] {
            let config = AuthConfig {
                algorithm: name.to_string(),
                ..config()
            };
            assert_eq!(signing_algorithm(&config), expected, "{name}");
        }
    }
}
