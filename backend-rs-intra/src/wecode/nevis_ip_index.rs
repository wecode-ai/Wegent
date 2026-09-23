// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Local Nevis IP index for cloud devices.
//!
//! Mirrors the write path of `wecode/service/cloud_device_ip_index.py` that
//! `GET /api/cloud-devices/{device_id}/status` exercises: `normalize_nevis_ip`
//! and `CloudDeviceIpIndexService.persist_observation` with the endpoint's
//! defaults (`observed_at=None`, `only_if_missing=False`). The backfill
//! sweeper, the distributed locks, and the per-device synchronization belong
//! to the jobs that call them.
use std::net::IpAddr;

use brz_mysql::{Mysql, MysqlError, MysqlTransaction};
use chrono::Utc;
use serde_json::Value;
use wegent_backend_rs::json_compat::python_json_value;

use super::cloud_device_provider::{load_device_for_update, update_device_document};

/// `NEVIS_IP_FIELD`.
const NEVIS_IP_FIELD: &str = "nevisIp";
/// `NEVIS_IP_OBSERVED_AT_FIELD`.
const NEVIS_IP_OBSERVED_AT_FIELD: &str = "nevisIpObservedAt";
/// `NEVIS_IP_SANDBOX_ID_FIELD`.
const NEVIS_IP_SANDBOX_ID_FIELD: &str = "nevisIpSandboxId";

/// `CloudDeviceIpTarget`.
pub(crate) struct CloudDeviceIpTarget<'a> {
    pub(crate) user_id: i64,
    pub(crate) device_name: &'a str,
    pub(crate) sandbox_id: &'a str,
}

/// `normalize_nevis_ip`: the canonical address for a Nevis sandbox field, or
/// `None` when the value is not a string or not an address literal. Python's
/// `ipaddress.ip_address` additionally accepts a bare decimal integer as the
/// packed address; a sandbox `details.urls` carries a dotted address, so only
/// address literals are treated as addresses here.
pub(crate) fn normalize_nevis_ip(value: Option<&str>) -> Option<String> {
    let candidate = value?.trim();
    if candidate.is_empty() {
        return None;
    }
    candidate.parse::<IpAddr>().ok().map(|ip| ip.to_string())
}

/// `CloudDeviceIpIndexService.persist_observation` together with the
/// endpoint's `db.commit()`: reload the Device row under `FOR UPDATE`, keep
/// the observation only for the current sandbox, and write the three
/// `cloudConfig` fields.
///
/// The reload's row lock lives until the source's `db.commit()` flushes the
/// `UPDATE` and ends the transaction, so both statements run on one
/// transaction connection here. A write that fails rolls the transaction back
/// — the source's `except Exception: db.rollback()` — and the endpoint keeps
/// serving its status response.
pub(crate) async fn persist_observation<M: Mysql>(
    mysql: &M,
    target: &CloudDeviceIpTarget<'_>,
    nevis_ip: &str,
) -> Result<bool, MysqlError> {
    mysql
        .with_transaction(async |transaction| {
            persist_observation_in(transaction, target, nevis_ip).await
        })
        .await
}

/// The transaction body of [`persist_observation`]. It reports whether the
/// observation was written, like the source method's return value.
async fn persist_observation_in<T: MysqlTransaction>(
    transaction: &mut T,
    target: &CloudDeviceIpTarget<'_>,
    nevis_ip: &str,
) -> Result<bool, MysqlError> {
    let Some(row) = load_device_for_update(transaction, target.user_id, target.device_name).await?
    else {
        return Ok(false);
    };
    let id = row.id;
    let mut document = row.json;
    let Some(cloud_config) = cloud_config_mut(&mut document) else {
        return Ok(false);
    };
    // A device that was recreated (or whose sandbox was replaced) keeps its
    // own address; the reload under the row lock is what makes this guard
    // meaningful.
    if cloud_config.get("sandboxId").and_then(Value::as_str) != Some(target.sandbox_id) {
        return Ok(false);
    }
    cloud_config.insert(
        NEVIS_IP_FIELD.to_string(),
        Value::String(nevis_ip.to_string()),
    );
    cloud_config.insert(
        NEVIS_IP_OBSERVED_AT_FIELD.to_string(),
        Value::String(observed_at_now()),
    );
    cloud_config.insert(
        NEVIS_IP_SANDBOX_ID_FIELD.to_string(),
        Value::String(target.sandbox_id.to_string()),
    );
    // `Kind.updated_at` is a Python-side `onupdate` value, so the flush
    // renders the naive-UTC timestamp of the write.
    let updated_at = Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string();
    update_device_document(transaction, id, &python_json_value(&document), &updated_at).await?;
    Ok(true)
}

/// `device_json.setdefault("spec", {}).setdefault("cloudConfig", {})`: the
/// mutable `cloudConfig` object, created when it is absent.
fn cloud_config_mut(document: &mut Value) -> Option<&mut serde_json::Map<String, Value>> {
    let spec = document
        .as_object_mut()?
        .entry("spec".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let config = spec
        .as_object_mut()?
        .entry("cloudConfig".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    config.as_object_mut()
}

/// `datetime.now(timezone.utc).isoformat()`: microsecond precision with an
/// explicit `+00:00` offset.
fn observed_at_now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn document(json: &str) -> Value {
        serde_json::from_str(json).expect("device document")
    }

    #[test]
    fn normalize_accepts_address_literals_only() {
        assert_eq!(
            normalize_nevis_ip(Some("192.0.2.10")).as_deref(),
            Some("192.0.2.10")
        );
        assert_eq!(
            normalize_nevis_ip(Some("  192.0.2.10  ")).as_deref(),
            Some("192.0.2.10")
        );
        assert_eq!(normalize_nevis_ip(Some("not-an-address")), None);
        assert_eq!(normalize_nevis_ip(Some("")), None);
        assert_eq!(normalize_nevis_ip(Some("192.0.2.10:8080")), None);
        assert_eq!(normalize_nevis_ip(None), None);
    }

    #[test]
    fn cloud_config_is_created_without_disturbing_the_document() {
        let mut value = document(
            r#"{"kind": "Device", "spec": {"deviceType": "cloud", "displayName": "Cloud"}}"#,
        );
        let config = cloud_config_mut(&mut value).expect("cloudConfig");
        config.insert("nevisIp".to_string(), Value::String("192.0.2.10".into()));
        config.insert(
            "nevisIpSandboxId".to_string(),
            Value::String("sandbox-1".into()),
        );
        assert_eq!(
            python_json_value(&value),
            "{\"kind\": \"Device\", \"spec\": {\"deviceType\": \"cloud\", \
             \"displayName\": \"Cloud\", \"cloudConfig\": {\"nevisIp\": \"192.0.2.10\", \
             \"nevisIpSandboxId\": \"sandbox-1\"}}}"
        );
    }

    #[test]
    fn an_existing_cloud_config_keeps_its_member_order_and_appends() {
        let mut value = document(
            r#"{"kind": "Device", "spec": {"cloudConfig": {"imageId": "img", "sandboxId": "sandbox-1"}}}"#,
        );
        let config = cloud_config_mut(&mut value).expect("cloudConfig");
        config.insert("nevisIp".to_string(), Value::String("192.0.2.10".into()));
        config.insert(
            "nevisIpObservedAt".to_string(),
            Value::String("2026-09-20T07:08:29.742845+00:00".into()),
        );
        config.insert(
            "nevisIpSandboxId".to_string(),
            Value::String("sandbox-1".into()),
        );
        assert_eq!(
            python_json_value(&value),
            "{\"kind\": \"Device\", \"spec\": {\"cloudConfig\": {\"imageId\": \"img\", \
             \"sandboxId\": \"sandbox-1\", \"nevisIp\": \"192.0.2.10\", \
             \"nevisIpObservedAt\": \"2026-09-20T07:08:29.742845+00:00\", \
             \"nevisIpSandboxId\": \"sandbox-1\"}}}"
        );
    }

    #[test]
    fn a_non_object_document_has_no_cloud_config() {
        let mut scalar = document("[]");
        assert!(cloud_config_mut(&mut scalar).is_none());
    }

    #[test]
    fn observed_at_uses_the_python_isoformat_shape() {
        let value = observed_at_now();
        assert!(value.ends_with("+00:00"), "{value}");
        assert_eq!(value.len(), "2026-09-20T07:08:29.742845+00:00".len());
    }
}
