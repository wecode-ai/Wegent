//! Redis is the sole cloud inbox store. There is no database fallback.
use super::*;
use brz_redis::Redis;

const PREFIX: &str = "wegent:{git-inbox}:";
pub(super) const SCRIPT: &str = include_str!("inbox.lua");

pub(super) async fn run<R: Redis>(
    redis: &R,
    id: &str,
    user: Option<i64>,
    operation: &str,
    input: Value,
) -> Result<Value, FastApiError> {
    let base = format!("{PREFIX}subscription:{id}");
    let delivery = input["deliveryId"].as_str().unwrap_or_default();
    let keys = [
        base.clone(),
        format!("{base}:queue"),
        format!("{base}:payloads"),
        format!("{base}:expiry"),
        format!("{base}:dedup:{:x}", Sha256::digest(delivery.as_bytes())),
    ];
    let args = [
        operation.to_owned(),
        user.map(|id| id.to_string()).unwrap_or_default(),
        input.to_string(),
    ];
    let raw: String = redis.eval(SCRIPT, keys, args).await.map_err(|error| {
        tracing::warn!(error_kind = ?error.kind(), "Git inbox Redis command failed");
        #[cfg(test)]
        eprintln!(
            "Git inbox Redis failure: {:?}: {:?}",
            error.kind(),
            error.detail()
        );
        storage_error(error)
    })?;
    let result: Value = serde_json::from_str(&raw).map_err(storage_error)?;
    match result["error"].as_str() {
        None => Ok(result),
        Some("missing") => Err(missing()),
        Some("changed" | "duplicate") => Err(FastApiError::detail(
            StatusCode::CONFLICT,
            "Subscription binding changed",
        )),
        Some("inactive") => Err(FastApiError::detail(
            StatusCode::GONE,
            "Subscription disconnected",
        )),
        Some("limit") => Err(invalid("Subscription limit reached")),
        Some("unknown_ack") => Err(invalid("Unknown acknowledgement")),
        Some("capacity") => Err(FastApiError::detail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Webhook inbox capacity reached; inspect failed deliveries",
        )),
        Some(_) => Err(storage_error("Redis inbox incomplete")),
    }
}

pub(super) fn redis(state: &AppState) -> Result<&brz_redis::RedisService, FastApiError> {
    state
        .redis
        .as_ref()
        .ok_or_else(|| storage_error("Redis unavailable"))
}

pub(super) fn row(result: &Value) -> Result<Subscription, FastApiError> {
    serde_json::from_value(result["row"].clone()).map_err(storage_error)
}

pub(super) async fn owned(
    state: &AppState,
    id: &str,
    user: Option<i64>,
) -> Result<Subscription, FastApiError> {
    row(&run(redis(state)?, id, user, "get", json!({})).await?)
}

#[cfg(test)]
mod redis_tests;
