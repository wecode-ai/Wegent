//! Grey (beta) test status for `GET /api/grey/status`.
//!
//! Mirrors `app.api.endpoints.grey.get_grey_status`: authenticate the user,
//! then check membership of `grey:<config_name>` with `SISMEMBER`. The target
//! reuses the application Redis client: this ordinary command carries no
//! connection-local state, so the source's per-request client is unnecessary.
//! Each request still performs its own membership lookup. The source
//! module hardcodes `GREY_CONFIG_NAME = "wegent-grey-uids"`, so the checked
//! key is `grey:wegent-grey-uids`.
//!
//! Only `/status` is routed here; the recorded case covers the status check
//! and the module's join/leave actions also call an external dashboard API
//! and are not part of this endpoint.
use brz_http_server::StatusCode;
use brz_redis::Redis;
use serde::Serialize;

#[derive(Serialize)]
struct GreyStatusResponse {
    is_grey_user: bool,
}

use super::startup::SharedWecodeAppState;
use wegent_backend_rs::auth::{AuthFailure, UserRow, get_current_user};
use wegent_backend_rs::http_compat::FastApiError;

/// Grey test config name hardcoded in the source module.
const GREY_CONFIG_NAME: &str = "wegent-grey-uids";

/// Redis key holding the grey user set (`get_grey_redis_key`).
fn grey_redis_key() -> String {
    format!("grey:{GREY_CONFIG_NAME}")
}

/// `redis.sismember(key, str(current_user.id))`: membership of the decimal
/// user id string in the grey set.
async fn is_grey_member(service: &impl Redis, user_id: i32) -> brz_redis::RedisResult<bool> {
    service
        .sismember(grey_redis_key(), user_id.to_string())
        .await
}

/// GET /api/grey/status: the grey-status free function, injecting the
/// internal state and its shared public dependencies.
#[brz_http_server::get("/api/grey/status", group = crate::wecode::startup::wecode_apis)]
async fn get_grey_status(
    #[inject(wecode)] state: &SharedWecodeAppState,
    #[header] authorization: Option<&str>,
) -> Result<GreyStatusResponse, FastApiError> {
    grey_status(
        &state.app.auth,
        &state.app.mysql,
        state.app.redis.as_ref(),
        authorization,
    )
    .await
}

/// Handler body for `GET /api/grey/status`.
async fn grey_status<M: brz_mysql::Mysql, R: Redis>(
    auth: &wegent_backend_rs::config::AuthConfig,
    mysql: &M,
    redis: Option<&R>,
    authorization: Option<&str>,
) -> Result<GreyStatusResponse, FastApiError> {
    let user: UserRow = match get_current_user(auth, mysql, authorization).await {
        Ok(user) => user,
        Err(AuthFailure::InvalidCredentials) => {
            return Err(FastApiError::unauthorized("Could not validate credentials"));
        }
        Err(AuthFailure::UserNotActivated) => {
            return Err(FastApiError::unauthorized("User not activated"));
        }
    };

    let redis = redis.ok_or_else(internal_error)?;
    let is_member: bool = match is_grey_member(redis, user.id).await {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(%error, "grey redis dependency failure");
            return Err(internal_error());
        }
    };

    Ok(GreyStatusResponse {
        is_grey_user: is_member,
    })
}

/// FastAPI unhandled-error 500 response shape (body rendered by the generic
/// exception handler; only the status is observable in the recording).
fn internal_error() -> FastApiError {
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        r#"{"detail":"Internal Server Error"}"#,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_internal_error_preserve_json_contract() {
        for is_grey_user in [false, true] {
            assert_eq!(
                crate::json_contract_tests::serialized(GreyStatusResponse { is_grey_user })
                    .unwrap(),
                serde_json::json!({"is_grey_user": is_grey_user})
            );
        }
        let error = internal_error();
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        // The old handler passed a JSON string as detail; preserve that nesting.
        assert_eq!(
            error.validation_detail(),
            serde_json::to_string(r#"{"detail":"Internal Server Error"}"#).unwrap()
        );
    }

    #[test]
    fn grey_key_matches_source_config_name() {
        assert_eq!(grey_redis_key(), "grey:wegent-grey-uids");
    }
}
