// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Managed cloud device removal via the distribution's cloud provider.

use brz_http_server::StatusCode;
use brz_mysql::MysqlTransaction;
use brz_redis::Redis;
use serde_json::Value;

use crate::device_identity::{DeviceKindRow, device_connection_route_id};
use crate::device_identity_lock::{IDENTITY_LOCK_BODY_TIMEOUT, IdentityLock};
use crate::device_records::lock_device_owner;
use crate::devices::{internal_error, online_key};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// Destroys a sandbox by its provider-assigned ID. An already absent sandbox
/// counts as success so a request can retry the registration cleanup.
#[async_trait::async_trait]
pub trait CloudDeviceDestroyer: Send + Sync {
    async fn destroy(&self, record_id: i64, sandbox_id: &str) -> Result<(), FastApiError>;
}

const CLOUD_RECORDS_FOR_UPDATE: &str =
    "SELECT id AS kinds_id, name AS kinds_name, json AS kinds_json FROM kinds
     WHERE user_id = ? AND namespace = 'default' AND kind = 'Device' AND is_active = true
     AND JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.deviceType')) = 'cloud'
     AND BINARY JSON_UNQUOTE(JSON_EXTRACT(json, '$.spec.cloudConfig.sandboxId')) = ?
     FOR UPDATE";

const DEACTIVATE_RECORD: &str =
    "UPDATE kinds SET is_active = false, updated_at = now() WHERE id = ?";

#[tracing::instrument(name = "device.cloud.delete", skip(state, spec))]
pub(crate) async fn delete_cloud_device(
    state: &AppState,
    user_id: i64,
    record_id: i64,
    spec: &Value,
) -> Result<(), FastApiError> {
    let provider = state.cloud_device_destroyer.as_ref().ok_or_else(|| {
        FastApiError::detail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Cloud device deletion is unavailable",
        )
    })?;
    let sandbox = sandbox_id(spec)?;
    let redis = state.redis.as_ref().ok_or_else(status_unavailable)?;
    provider.destroy(record_id, sandbox).await?;
    let lock = IdentityLock::acquire(redis, user_id)
        .await
        .map_err(|error| {
            tracing::warn!(record_id, %error, "cloud device identity lock acquisition failed");
            status_unavailable()
        })?
        .ok_or_else(|| {
            tracing::warn!(
                record_id,
                "cloud device identity lock acquisition timed out"
            );
            status_unavailable()
        })?;
    let outcome = tokio::time::timeout(
        IDENTITY_LOCK_BODY_TIMEOUT,
        remove_cloud_records(state, redis, user_id, record_id, sandbox),
    )
    .await;
    if let Err(error) = lock.release().await {
        tracing::warn!(record_id, %error, "cloud device identity lock release failed");
    }
    outcome.map_err(|_| {
        tracing::warn!(record_id, "cloud device registration cleanup timed out");
        status_unavailable()
    })?
}

async fn remove_cloud_records<R: Redis>(
    state: &AppState,
    redis: &R,
    user_id: i64,
    record_id: i64,
    sandbox: &str,
) -> Result<(), FastApiError> {
    state
        .mysql
        .with_transaction(async |transaction| {
            lock_device_owner(transaction, user_id).await?;
            let devices: Vec<DeviceKindRow> = transaction
                .fetch_all(CLOUD_RECORDS_FOR_UPDATE, (user_id, sandbox))
                .await?;
            let mut keys = Vec::new();
            for device in &devices {
                keys.push(online_key(user_id, &device.name));
                keys.push(online_key(user_id, &device_connection_route_id(device)));
            }
            if !keys.is_empty()
                && let Err(error) = redis.del_many(keys).await
            {
                // Preserve the rows so the whole cleanup can be retried.
                tracing::warn!(record_id, %error, "cloud device online status cleanup failed");
                return Ok(false);
            }
            for device in devices {
                transaction.execute(DEACTIVATE_RECORD, (device.id,)).await?;
            }
            Ok(true)
        })
        .await
        .map_err(|error| {
            tracing::error!(record_id, %error, "cloud device registration cleanup failed");
            internal_error()
        })?
        .then_some(())
        .ok_or_else(status_unavailable)
}

fn status_unavailable() -> FastApiError {
    FastApiError::detail(
        StatusCode::SERVICE_UNAVAILABLE,
        "Cloud device registration cleanup is temporarily unavailable",
    )
}

fn sandbox_id(spec: &Value) -> Result<&str, FastApiError> {
    // Socket registration can supply a device name, but only provisioning
    // writes the provider-assigned sandbox ID.
    spec["cloudConfig"]["sandboxId"]
        .as_str()
        .filter(|id| !id.trim().is_empty() && !matches!(*id, "." | ".."))
        .ok_or_else(|| {
            FastApiError::detail(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Cloud device has no valid sandbox ID",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::{StatusCode, delete_cloud_device, sandbox_id};
    use serde_json::json;

    #[test]
    fn deletion_requires_the_persisted_sandbox_id() {
        let spec = json!({"deviceId": "device-1", "cloudConfig": {"sandboxId": "sandbox-2"}});
        assert_eq!(sandbox_id(&spec).unwrap(), "sandbox-2");
        assert!(sandbox_id(&json!({"deviceId": "sandbox-2"})).is_err());
        assert!(sandbox_id(&json!({"cloudConfig": {"sandboxId": ""}})).is_err());
    }

    #[tokio::test]
    async fn cloud_deletion_requires_a_configured_provider() {
        let mysql =
            brz_mysql::MysqlService::connect_lazy("mysql://test:test@127.0.0.1:1/test").unwrap();
        let state = crate::app_test_support::app(mysql);
        let spec = json!({"cloudConfig": {"sandboxId": "sandbox-2"}});

        let error = delete_cloud_device(&state, 7, 42, &spec).await.unwrap_err();

        assert_eq!(error.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
