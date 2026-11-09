// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Execution-request JWTs (`app/services/auth/task_token.py` and
//! `app/services/auth/skill_identity_token.py`).
//!
//! Both tokens are signed with `settings.SECRET_KEY` and the configured
//! algorithm; the task token carries a fixed 24-hour lifetime and the skill
//! identity token uses the deployment `SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES`.
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `settings.SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES` (`app/core/config.py:167`:
/// `10 * 24 * 60`, the source's 14400-minute / 10-day default).
const DEFAULT_SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES: i64 = 10 * 24 * 60;

/// `settings.SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES`: the deployment's configured
/// lifetime, read from the same process-env/dotenv source as the JWT key.
fn skill_identity_token_expire_minutes() -> i64 {
    let configured = crate::config::env_or_dotenv("SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES");
    skill_identity_token_expire_minutes_from(configured.as_deref())
}

/// The pydantic integer setting with its declared 14400-minute default: a
/// blank or unparsable deployment value keeps the source default.
fn skill_identity_token_expire_minutes_from(configured: Option<&str>) -> i64 {
    configured
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(DEFAULT_SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES)
}

/// `create_task_token` (`app/services/auth/task_token.py`).
pub(crate) fn create_task_token(
    state: &AppState,
    task_id: i64,
    subtask_id: i64,
    user_id: i64,
    user_name: &str,
) -> Result<String, FastApiError> {
    let expire = chrono::Utc::now().timestamp() + 24 * 60 * 60;
    let claims = serde_json::json!({
        "task_id": task_id,
        "subtask_id": subtask_id,
        "user_id": user_id,
        "user_name": user_name,
        "dispatch_id": Value::Null,
        "dispatch_role": Value::Null,
        "manager_agent_id": Value::Null,
        "exp": expire,
        "type": "task_token",
    });
    sign(state, &claims, "the task token")
}

/// `create_skill_identity_token` (`app/services/auth/skill_identity_token.py`).
pub(crate) fn create_skill_identity_token(
    state: &AppState,
    user_id: i64,
    user_name: &str,
    task_id: i64,
    subtask_id: i64,
) -> Result<String, FastApiError> {
    let claims = skill_identity_claims(
        user_id,
        user_name,
        task_id,
        subtask_id,
        chrono::Utc::now().timestamp(),
        skill_identity_token_expire_minutes(),
    );
    sign(state, &claims, "the skill identity token")
}

/// `create_skill_identity_token`'s payload: `iat` is the issue clock and `exp`
/// is `iat + SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES * 60`.
fn skill_identity_claims(
    user_id: i64,
    user_name: &str,
    task_id: i64,
    subtask_id: i64,
    issued_at: i64,
    ttl_minutes: i64,
) -> Value {
    serde_json::json!({
        "type": "skill_identity",
        "user_id": user_id,
        "user_name": user_name,
        "runtime_type": "executor",
        "runtime_name": format!("task-{task_id}-subtask-{subtask_id}"),
        "iat": issued_at,
        "exp": issued_at + ttl_minutes * 60,
    })
}

/// Sign a JWT with the configured `SECRET_KEY` / algorithm.
fn sign(state: &AppState, claims: &Value, what: &str) -> Result<String, FastApiError> {
    use jsonwebtoken::{Algorithm, EncodingKey, Header};
    let algorithm = match state.auth.algorithm.as_str() {
        "HS384" => Algorithm::HS384,
        "HS512" => Algorithm::HS512,
        _ => Algorithm::HS256,
    };
    jsonwebtoken::encode(
        &Header::new(algorithm),
        claims,
        &EncodingKey::from_secret(state.auth.jwt_key.as_bytes()),
    )
    .map_err(|error| {
        tracing::error!(%error, what, "failed to sign the JWT");
        FastApiError::internal()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn skill_identity_expire_minutes_follow_the_deployment_setting() {
        // `settings.SKILL_IDENTITY_TOKEN_EXPIRE_MINUTES` (`config.py:167`) is
        // `10 * 24 * 60` = 14400 minutes (10 days); the frozen source snapshot
        // does not override it, and the recording pins the same offset.
        assert_eq!(skill_identity_token_expire_minutes_from(None), 14400);
        assert_eq!(
            skill_identity_token_expire_minutes_from(Some("1440")),
            1440,
            "an explicit deployment override wins"
        );
        assert_eq!(
            skill_identity_token_expire_minutes_from(Some("14400")),
            14400
        );
        assert_eq!(skill_identity_token_expire_minutes_from(Some(" 600 ")), 600);
        // Blank and unparsable values keep the pydantic default.
        assert_eq!(skill_identity_token_expire_minutes_from(Some("")), 14400);
        assert_eq!(skill_identity_token_expire_minutes_from(Some("abc")), 14400);
    }

    #[test]
    fn skill_identity_claims_match_the_recorded_ttl() {
        // Recorded case e5c837d8: iat=1792479672, exp=1793343672, i.e. the
        // deployed 14400-minute (10-day) lifetime.
        let claims = skill_identity_claims(6582, "sample-service", 42, 43, 1_792_479_672, 14_400);
        assert_eq!(claims["iat"], json!(1_792_479_672_i64));
        assert_eq!(claims["exp"], json!(1_793_343_672_i64));
        assert_eq!(
            claims["exp"].as_i64().unwrap() - claims["iat"].as_i64().unwrap(),
            14_400 * 60
        );
        assert_eq!(
            claims,
            json!({
                "type": "skill_identity",
                "user_id": 6582,
                "user_name": "sample-service",
                "runtime_type": "executor",
                "runtime_name": "task-42-subtask-43",
                "iat": 1_792_479_672_i64,
                "exp": 1_793_343_672_i64,
            })
        );
        // The one-day default keeps its own offset.
        let claims = skill_identity_claims(1, "u", 2, 3, 100, 1440);
        assert_eq!(claims["exp"], json!(100_i64 + 1440 * 60));
    }
}
