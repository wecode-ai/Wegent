//! A desktop key-bound plugin principal never impersonates a registered Device.

use super::*;
use crate::auth::{USER_BY_NAME_QUERY, UserRow};
use brz_redis::{Redis, SetExpiration, SetOptions};
use jsonwebtoken::{DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wegent_authentication::wework_auth_refresh::{
    WeworkTokenRefreshRequest, verify_bound_native_request,
};

const TOKEN_USE: &str = "plugin_native";
const SESSION_SECONDS: i64 = 3600;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Principal {
    pub user_id: i64,
    pub sub: String,
    pub thumbprint: String,
    token_use: String,
    scope: String,
    exp: i64,
}

fn unauthorized() -> FastApiError {
    FastApiError::detail(StatusCode::UNAUTHORIZED, "plugin_auth_native_unauthorized")
        .with_header("cache-control", "no-store")
}

pub(super) fn verify(app: &AppState, token: &str) -> Result<Principal, FastApiError> {
    let algorithm = crate::auth::algorithm(&app.auth).ok_or_else(unauthorized)?;
    let mut validation = Validation::new(algorithm);
    validation.leeway = 0;
    validation.validate_aud = false;
    let principal = jsonwebtoken::decode::<Principal>(
        token,
        &DecodingKey::from_secret(app.auth.jwt_key.as_bytes()),
        &validation,
    )
    .map_err(|_| unauthorized())?
    .claims;
    if principal.token_use != TOKEN_USE
        || principal.scope != TOKEN_USE
        || principal.user_id <= 0
        || principal.sub.is_empty()
        || principal.thumbprint.is_empty()
    {
        return Err(unauthorized());
    }
    Ok(principal)
}

impl Principal {
    pub(super) async fn is_active(&self, app: &AppState) -> MysqlResult<bool> {
        let user: Option<UserRow> = app
            .mysql
            .fetch_optional(USER_BY_NAME_QUERY, (self.sub.as_str(),))
            .await?;
        Ok(user.is_some_and(|u| i64::from(u.id) == self.user_id && u.is_active != 0))
    }
}

pub(super) fn require_active(
    result: MysqlResult<bool>,
    timing: &mut ExchangeTiming,
) -> Result<(), FastApiError> {
    match result {
        Ok(true) => Ok(()),
        Ok(false) => Err(unauthorized()),
        Err(error) => {
            timing.outcome = Some("mysql_account_lookup_failed");
            timing.record_mysql_error(&error);
            Err(unauthorized())
        }
    }
}

pub(super) async fn open(
    app: &AppState,
    data: Value,
    timing: &mut timing::ExchangeTiming,
) -> Result<Value, FastApiError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Proof {
        refresh_token: String,
        proof: String,
    }
    timing.failure_stage = Some("session_proof_verify");
    let proof: Proof = serde_json::from_value(data).map_err(|_| unauthorized())?;
    let now = chrono::Utc::now().timestamp();
    let claims = verify_bound_native_request(
        &app.auth,
        &WeworkTokenRefreshRequest {
            refresh_token: proof.refresh_token,
            proof: proof.proof.clone(),
        },
        PATH,
        now,
    )?;
    let user_id = claims["user_id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or_else(unauthorized)?;
    let principal = Principal {
        user_id,
        sub: claims["sub"].as_str().ok_or_else(unauthorized)?.into(),
        thumbprint: claims["cnf"]["jkt"]
            .as_str()
            .ok_or_else(unauthorized)?
            .into(),
        token_use: TOKEN_USE.into(),
        scope: TOKEN_USE.into(),
        exp: (now + SESSION_SECONDS).min(claims["exp"].as_i64().ok_or_else(unauthorized)?),
    };
    timing.failure_stage = Some("verify_active_mysql");
    let active = timing::timed(&mut timing.verify_active_mysql_ms, principal.is_active(app)).await;
    require_active(active, timing)?;
    timing.failure_stage = Some("session_proof_redis");
    let redis = app.redis.as_ref().ok_or_else(|| {
        timing.record_redis_failure("redis_unavailable");
        unauthorized()
    })?;
    let key = format!(
        "wegent:plugin-auth:proof:{:x}",
        Sha256::digest(proof.proof.as_bytes())
    );
    let fresh = timing::timed(
        &mut timing.session_proof_redis_ms,
        redis.set_with(
            key,
            "used",
            SetOptions::default()
                .if_absent()
                .with_expiration(SetExpiration::Seconds(330)),
        ),
    )
    .await
    .map_err(|_| {
        timing.record_redis_failure("redis_proof_store_failed");
        unauthorized()
    })?;
    if !fresh {
        timing.outcome = Some("proof_replayed");
        return Err(unauthorized());
    }
    timing.failure_stage = Some("session_sign");
    let token = crate::wework_auth_tokens::create_token(
        &app.auth.jwt_key,
        &app.auth.algorithm,
        serde_json::to_value(&principal).map_err(|_| unauthorized())?,
    )?;
    Ok(
        json!({"protocolVersion":1,"native_token":token,"expires_at":principal.exp,
        "account_id":user_id,"key_thumbprint":principal.thumbprint}),
    )
}
