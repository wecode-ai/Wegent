// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Runtime capacity truth for one device claim.
//!
//! Mirrors `app.services.device.capacity.get_runtime_capacity_sync`,
//! `_parse_capacity`, and `loop_item_execution_service._runtime_capacity_used`:
//! the claimed device's Redis online snapshot is the Runtime truth, and durable
//! reservations in `loop_item_executions` are added without double counting.
use brz_mysql::{FromMysqlRow, Mysql, MysqlResult};
use brz_redis::{Redis, RedisBytes};
use serde_json::Value;

use crate::http_compat::FastApiError;

use super::device::resolve_runtime_route_identity;

/// `LocalDeviceProvider.generate_online_key` Redis key for a device snapshot.
pub(crate) fn generate_online_key(user_id: i32, device_id: &str) -> String {
    format!("device:online:{user_id}:{device_id}")
}

/// `RuntimeCapacity`: the validated capacity snapshot of one installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeCapacity {
    pub runtime_instance_id: String,
    pub limit: i64,
    pub active: i64,
    pub active_task_ids: Vec<String>,
    pub queued: i64,
}

/// A JSON integer, rejecting JSON booleans and non-integral numbers, matching
/// Python's `isinstance(value, int) and not isinstance(value, bool)`.
fn json_int(value: Option<&Value>) -> Option<i64> {
    match value {
        Some(Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_u64().map(|v| v as i64)),
        _ => None,
    }
}

/// `_parse_capacity`: validate a snapshot against the expected installation.
pub(crate) fn parse_capacity(
    online_info: Option<&Value>,
    expected_instance_id: &str,
) -> Option<RuntimeCapacity> {
    let reported_instance_id = online_info
        .and_then(Value::as_object)
        .map(|online| {
            super::device::py_str_or_empty(online.get("runtime_instance_id"))
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    let capacity = online_info
        .and_then(Value::as_object)
        .and_then(|online| online.get("runtime_capacity"))
        .and_then(Value::as_object)?;
    if reported_instance_id != expected_instance_id {
        return None;
    }
    let limit = json_int(capacity.get("limit"))?;
    let active = json_int(capacity.get("active"))?;
    let queued = json_int(capacity.get("queued"))?;
    let active_task_ids: Vec<String> = capacity
        .get("active_task_ids")
        .and_then(Value::as_array)?
        .iter()
        .map(|task_id| task_id.as_str().map(str::to_string))
        .collect::<Option<Vec<String>>>()?;
    // Every task id must be non-blank and unique, and the count must agree
    // with the reported `active` slot count.
    if active_task_ids
        .iter()
        .any(|task_id| task_id.trim().is_empty())
        || active_task_ids
            .iter()
            .enumerate()
            .any(|(index, task_id)| active_task_ids[..index].contains(task_id))
    {
        return None;
    }
    if !(1..=20).contains(&limit) || active < 0 || queued < 0 {
        return None;
    }
    if active_task_ids.len() as i64 != active {
        return None;
    }
    Some(RuntimeCapacity {
        runtime_instance_id: reported_instance_id,
        limit,
        active,
        active_task_ids,
        queued,
    })
}

/// `cache_manager.get_sync_or_raise`: decode a JSON document, `None` when absent.
///
/// A read failure is not hidden (`get_sync_or_raise`), so it surfaces as the
/// source's unhandled 500 rather than an empty snapshot.
async fn online_snapshot(
    redis: Option<&brz_redis::RedisService>,
    key: &str,
) -> Result<Option<Value>, FastApiError> {
    let Some(redis) = redis else {
        return Ok(None);
    };
    match redis.get::<_, RedisBytes>(key).await {
        Ok(Some(bytes)) => Ok(std::str::from_utf8(bytes.as_ref())
            .ok()
            .and_then(|text| serde_json::from_str(text).ok())),
        Ok(None) => Ok(None),
        Err(error) => {
            tracing::error!(%error, key, "device online snapshot read failed");
            Err(FastApiError::internal())
        }
    }
}

/// `_runtime_route`: the Runtime route of an owned device, when it has one.
async fn runtime_route<M: Mysql>(
    mysql: &M,
    owner_user_id: i32,
    device_id: &str,
) -> MysqlResult<Option<(String, String)>> {
    let identity = resolve_runtime_route_identity(mysql, owner_user_id, device_id).await?;
    Ok(identity.and_then(|identity| {
        identity
            .runtime_instance_id
            .filter(|instance| !instance.is_empty())
            .map(|instance| (identity.runtime_device_id, instance))
    }))
}

/// `get_runtime_capacity_sync`: the live capacity truth for one installation.
pub(crate) async fn get_runtime_capacity_sync<M: Mysql>(
    mysql: &M,
    redis: Option<&brz_redis::RedisService>,
    owner_user_id: i32,
    device_id: &str,
) -> Result<Option<RuntimeCapacity>, FastApiError> {
    let Some((runtime_device_id, expected_instance_id)) =
        runtime_route(mysql, owner_user_id, device_id)
            .await
            .map_err(|_| FastApiError::internal())?
    else {
        return Ok(None);
    };
    let snapshot = online_snapshot(
        redis,
        &generate_online_key(owner_user_id, &runtime_device_id),
    )
    .await?;
    Ok(parse_capacity(snapshot.as_ref(), &expected_instance_id))
}

#[derive(Debug, FromMysqlRow)]
struct ExecutionIdRow {
    #[allow(dead_code, reason = "selected to match the source column list")]
    #[mysql(rename = "loop_item_executions_id")]
    id: i64,
}

#[derive(Debug, FromMysqlRow)]
struct RuntimeTaskIdRow {
    #[mysql(rename = "loop_item_executions_runtime_task_id")]
    runtime_task_id: Option<String>,
}

/// `_runtime_capacity_used`: Runtime truth plus durable reservations.
pub(crate) async fn runtime_capacity_used<M: Mysql>(
    mysql: &M,
    owner_user_id: i32,
    runtime_instance_id: &str,
    runtime_active: i64,
    runtime_active_task_ids: &[String],
) -> MysqlResult<Option<i64>> {
    // Managed Wegent runs never occupy a device Runtime slot; one such row
    // makes the device's capacity ambiguous for this owner.
    let ambiguous: Option<ExecutionIdRow> = mysql
        .fetch_optional(
            "SELECT loop_item_executions.id AS loop_item_executions_id \
             \nFROM loop_item_executions \
             \nWHERE loop_item_executions.executor_owner_user_id = ? \
             AND loop_item_executions.status IN ('running', 'cancel_requested', 'claimed') \
             AND loop_item_executions.execution_environment != 'wegent' \
             AND loop_item_executions.runtime_instance_id = ? \
             \n LIMIT 1",
            (owner_user_id, ""),
        )
        .await?;
    if ambiguous.is_some() {
        return Ok(None);
    }
    let durable: Vec<RuntimeTaskIdRow> = mysql
        .fetch_all(
            "SELECT loop_item_executions.runtime_task_id \
             AS loop_item_executions_runtime_task_id \
             \nFROM loop_item_executions \
             \nWHERE loop_item_executions.executor_owner_user_id = ? \
             AND loop_item_executions.runtime_instance_id = ? \
             AND loop_item_executions.status IN ('running', 'cancel_requested', 'claimed')",
            (owner_user_id, runtime_instance_id),
        )
        .await?;
    let pending = durable
        .iter()
        .filter(|row| {
            let task_id = row.runtime_task_id.as_deref().unwrap_or("");
            task_id.is_empty() || !runtime_active_task_ids.iter().any(|id| id == task_id)
        })
        .count() as i64;
    Ok(Some(runtime_active + pending))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn online_key_matches_the_provider() {
        assert_eq!(
            generate_online_key(157, "app-record-267101"),
            "device:online:157:app-record-267101"
        );
    }

    #[test]
    fn parse_capacity_accepts_a_valid_snapshot() {
        let snapshot = json!({
            "runtime_instance_id": "runtime-1",
            "runtime_capacity": {
                "limit": 2, "active": 1, "active_task_ids": ["t1"], "queued": 0
            }
        });
        let capacity = parse_capacity(Some(&snapshot), "runtime-1").unwrap();
        assert_eq!(capacity.limit, 2);
        assert_eq!(capacity.active, 1);
        assert_eq!(capacity.active_task_ids, vec!["t1".to_string()]);
    }

    #[test]
    fn parse_capacity_rejects_a_stale_instance_or_bad_bounds() {
        let stale = json!({
            "runtime_instance_id": "runtime-2",
            "runtime_capacity": { "limit": 1, "active": 0, "active_task_ids": [], "queued": 0 }
        });
        assert!(parse_capacity(Some(&stale), "runtime-1").is_none());

        let over_limit = json!({
            "runtime_instance_id": "runtime-1",
            "runtime_capacity": { "limit": 21, "active": 0, "active_task_ids": [], "queued": 0 }
        });
        assert!(parse_capacity(Some(&over_limit), "runtime-1").is_none());

        let count_mismatch = json!({
            "runtime_instance_id": "runtime-1",
            "runtime_capacity": { "limit": 2, "active": 2, "active_task_ids": ["t1"], "queued": 0 }
        });
        assert!(parse_capacity(Some(&count_mismatch), "runtime-1").is_none());

        assert!(parse_capacity(None, "runtime-1").is_none());
        assert!(parse_capacity(Some(&json!([])), "runtime-1").is_none());
    }

    #[test]
    fn parse_capacity_rejects_boolean_and_duplicate_task_ids() {
        let boolean_limit = json!({
            "runtime_instance_id": "runtime-1",
            "runtime_capacity": { "limit": true, "active": 0, "active_task_ids": [], "queued": 0 }
        });
        assert!(parse_capacity(Some(&boolean_limit), "runtime-1").is_none());

        let duplicates = json!({
            "runtime_instance_id": "runtime-1",
            "runtime_capacity": {
                "limit": 2, "active": 2, "active_task_ids": ["t1", "t1"], "queued": 0
            }
        });
        assert!(parse_capacity(Some(&duplicates), "runtime-1").is_none());
    }
}
