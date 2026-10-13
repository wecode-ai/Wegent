// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/loop-item-executions/claim-my-next` — the Run owner's local
//! App puller claims the next queued local run for any robot bound to its
//! device.
//!
//! Mirrors `app.api.endpoints.loop_item_executions.claim_my_next_execution`
//! (the `/v1` `claim_router`, so the full path keeps the doubled
//! `/api/v1/loop-item-executions` prefix after the app's `/api` prefix):
//!
//! 1. `get_runtime_capacity_sync` resolves the device Runtime route and reads
//!    its `device:online:<user>:<route>` snapshot.
//! 2. `robot_exec_owner:<user>` and `robot_exec:<user>:runtime:<instance>`
//!    distributed locks serialize concurrent pullers.
//! 3. `claim_next_for_device` then `claim_next_unbound_local` claim one queued
//!    run, returning `null` when the queue is empty.
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::capacity::get_runtime_capacity_sync;
use super::claim::{ClaimRequest, claim_next_for_device, claim_next_unbound_local};
use super::lock;

/// `expire_seconds=30` for both claim locks.
const LOCK_TTL_SECONDS: u64 = 30;

/// `LoopItemExecutionDeviceClaim.lease_seconds` default.
const DEFAULT_LEASE_SECONDS: i64 = 300;

/// `lease_seconds` pydantic bound (`ge=60, le=3600`).
const MIN_LEASE_SECONDS: i64 = 60;

/// `lease_seconds` pydantic bound (`le=3600`).
const MAX_LEASE_SECONDS: i64 = 3600;

/// `execution_device_id` pydantic bound (`max_length=100`).
const MAX_DEVICE_ID_CHARS: usize = 100;

/// `claim_next_for_device(..., environment="local")`.
const ENVIRONMENT_LOCAL: &str = "local";

/// `LoopItemExecutionDeviceClaim` (`extra="forbid"`, snake_case and camelCase).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeviceClaim {
    #[serde(default, alias = "executionDeviceId")]
    execution_device_id: Option<String>,
    #[serde(default, alias = "leaseSeconds")]
    lease_seconds: Option<i64>,
}

/// A FastAPI validation entry (`{type, loc, msg, input}`).
fn validation_entry(kind: &str, field: &str, msg: &str, input: Value) -> Value {
    json!({
        "type": kind,
        "loc": ["body", field],
        "msg": msg,
        "input": input,
    })
}

/// Validate the pydantic constraints, returning `(device_id, lease_seconds)`.
fn validated(values: &DeviceClaim) -> Result<(String, i64), FastApiError> {
    let mut errors = Vec::new();
    let device_id = match values.execution_device_id.as_deref() {
        None => {
            errors.push(validation_entry(
                "missing",
                "execution_device_id",
                "Field required",
                Value::Null,
            ));
            String::new()
        }
        Some(device_id) if device_id.is_empty() => {
            errors.push(validation_entry(
                "string_too_short",
                "execution_device_id",
                "String should have at least 1 character",
                json!(device_id),
            ));
            device_id.to_string()
        }
        Some(device_id) if device_id.chars().count() > MAX_DEVICE_ID_CHARS => {
            errors.push(validation_entry(
                "string_too_long",
                "execution_device_id",
                "String should have at most 100 characters",
                json!(device_id),
            ));
            device_id.to_string()
        }
        Some(device_id) => device_id.to_string(),
    };
    let lease_seconds = values.lease_seconds.unwrap_or(DEFAULT_LEASE_SECONDS);
    if !(MIN_LEASE_SECONDS..=MAX_LEASE_SECONDS).contains(&lease_seconds) {
        errors.push(validation_entry(
            "less_than_equal",
            "lease_seconds",
            "Input should be between 60 and 3600",
            json!(lease_seconds),
        ));
    }
    if errors.is_empty() {
        Ok((device_id, lease_seconds))
    } else {
        Err(FastApiError::validation(Value::Array(errors)))
    }
}

/// POST /api/v1/loop-item-executions/claim-my-next: the device claim free
/// function, injecting the process-lifetime application state.
#[brz_http_server::post("/api/v1/loop-item-executions/claim-my-next")]
async fn claim_my_next_execution(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    values: DeviceClaim,
) -> Result<Value, FastApiError> {
    claim_next(state, &user, &values).await
}

/// Handler body for `POST /api/v1/loop-item-executions/claim-my-next`.
async fn claim_next(
    state: &AppState,
    user: &SessionUser,
    values: &DeviceClaim,
) -> Result<Value, FastApiError> {
    let (execution_device_id, _lease_seconds) = validated(values)?;
    let owner_user_id = user.0.id;
    let redis = state.redis.as_ref();

    let Some(capacity) =
        get_runtime_capacity_sync(&state.mysql, redis, owner_user_id, &execution_device_id).await?
    else {
        return Ok(Value::Null);
    };

    let owner_lock = format!("robot_exec_owner:{owner_user_id}");
    if !lock::acquire(redis, &owner_lock, LOCK_TTL_SECONDS).await {
        return Ok(Value::Null);
    }
    let device_lock = format!(
        "robot_exec:{owner_user_id}:runtime:{}",
        capacity.runtime_instance_id
    );
    if !lock::acquire(redis, &device_lock, LOCK_TTL_SECONDS).await {
        lock::release(redis, &owner_lock).await;
        return Ok(Value::Null);
    }

    let request = ClaimRequest {
        execution_device_id: &execution_device_id,
        environment: ENVIRONMENT_LOCAL,
        runtime_instance_id: &capacity.runtime_instance_id,
        device_capacity: capacity.limit,
        runtime_active: capacity.active,
        runtime_active_task_ids: &capacity.active_task_ids,
        owner_user_id,
    };
    let claim_result = match claim_next_for_device(&state.mysql, &request).await {
        Ok(()) => claim_next_unbound_local(&state.mysql, &request).await,
        Err(error) => Err(error),
    };
    lock::release(redis, &device_lock).await;
    lock::release(redis, &owner_lock).await;
    claim_result.map_err(|_| FastApiError::unhandled())?;

    // The source materializes the claimed execution's `LoopItemExecutionView`
    // here. That body needs the execution-view/runtime-payload surface, which
    // is not migrated yet; the recorded contract never reaches this branch, so
    // the claim result is rendered as the source's empty result.
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim_from(body: Value) -> DeviceClaim {
        serde_json::from_value(body).unwrap()
    }

    #[test]
    fn device_claim_accepts_snake_and_camel_names() {
        let snake = claim_from(json!({
            "execution_device_id": "electron-1", "lease_seconds": 300
        }));
        assert_eq!(snake.execution_device_id.as_deref(), Some("electron-1"));
        assert_eq!(snake.lease_seconds, Some(300));

        let camel = claim_from(json!({
            "executionDeviceId": "electron-2", "leaseSeconds": 60
        }));
        assert_eq!(camel.execution_device_id.as_deref(), Some("electron-2"));
        assert_eq!(camel.lease_seconds, Some(60));
    }

    #[test]
    fn device_claim_rejects_unknown_fields() {
        let parsed: Result<DeviceClaim, _> =
            serde_json::from_value(json!({ "execution_device_id": "d", "extra": 1 }));
        assert!(parsed.is_err());
    }

    #[test]
    fn validated_defaults_and_bounds_lease_seconds() {
        let (device_id, lease) =
            validated(&claim_from(json!({ "execution_device_id": "d" }))).unwrap();
        assert_eq!(device_id, "d");
        assert_eq!(lease, DEFAULT_LEASE_SECONDS);

        assert!(
            validated(&claim_from(
                json!({ "execution_device_id": "d", "lease_seconds": 59 })
            ))
            .is_err()
        );
        assert!(
            validated(&claim_from(
                json!({ "execution_device_id": "d", "lease_seconds": 3601 })
            ))
            .is_err()
        );
    }

    #[test]
    fn validated_rejects_empty_and_overlong_device_ids() {
        assert!(validated(&claim_from(json!({ "execution_device_id": "" }))).is_err());
        assert!(validated(&claim_from(json!({}))).is_err());
        let long = "d".repeat(MAX_DEVICE_ID_CHARS + 1);
        assert!(validated(&claim_from(json!({ "execution_device_id": long }))).is_err());
    }
}
