// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Execution-environment status and value projection
//! (`execution_environment_statuses`, `personal_environment_values`).
use brz_redis::{Redis as _, RedisBytes};
use serde::de::DeserializeOwned;

use crate::auth::UserRow;
use crate::devices;
use crate::state::AppState;
use crate::v1_resources::repository::OwnedKindRow;
use crate::v1_resources::response::ExecutionEnvironmentResource;
use brz_json::JsonProjection;

/// Device type discriminant read from `spec.deviceType` (default `local`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeviceType {
    Local,
    App,
    Cloud,
    Remote,
}

impl DeviceType {
    fn from_device(row: &OwnedKindRow) -> Self {
        let s = spec(row).value.unwrap_or_default();
        match s.device_type.as_deref() {
            Some("cloud") => Self::Cloud,
            Some("app") => Self::App,
            Some("remote") => Self::Remote,
            _ => Self::Local,
        }
    }
}

/// Device `spec` projection.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct DeviceSpec {
    #[serde(rename = "deviceType")]
    device_type: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
    #[serde(rename = "bindShell")]
    bind_shell: Option<String>,
    #[serde(rename = "cloudConfig")]
    cloud_config: Option<CloudConfigSpec>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct CloudConfigSpec {
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
}

/// `_kind_spec(device)`: the Device CRD document's `spec` object
/// (`device.json.get("spec")`), not the top-level document.
fn spec(row: &OwnedKindRow) -> JsonProjection<DeviceSpec> {
    match row.json.0.get("spec") {
        Some(spec) => JsonProjection::<DeviceSpec>::from_json(spec),
        None => JsonProjection { value: None },
    }
}

/// `device_connection_route_id` (`app/services/device/identity.py`).
fn connection_route_id(row: &OwnedKindRow) -> String {
    if DeviceType::from_device(row) == DeviceType::Cloud {
        let s = spec(row).value.unwrap_or_default();
        if let Some(device_id) = s.device_id.filter(|id| !id.trim().is_empty()) {
            return device_id;
        }
        if let Some(cloud_id) = s
            .cloud_config
            .as_ref()
            .and_then(|c| c.device_id.as_deref())
            .filter(|id| !id.trim().is_empty())
        {
            return cloud_id.to_string();
        }
        return row.name.clone();
    }
    if DeviceType::from_device(row) == DeviceType::App {
        return format!("app-record-{}", row.id);
    }
    row.name.clone()
}

/// `personal_environment_values` + `execution_environment_kind` +
/// `runtime_device_route_id` + `coding_tools`.
pub fn personal_environment_values(
    device: &OwnedKindRow,
    connection_status: &str,
    owner: &UserRow,
    workspace_ids: Vec<String>,
) -> ExecutionEnvironmentResource {
    let s = spec(device).value.unwrap_or_default();
    let device_type = s.device_type.clone().unwrap_or_else(|| "local".to_string());
    let name = s
        .display_name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| device.name.clone());
    ExecutionEnvironmentResource {
        id: device.id.to_string(),
        device_id: device.id,
        device_key: runtime_device_route_id(device, &device_type, &s),
        name,
        kind: execution_environment_kind(&device_type),
        coding_tools: coding_tools(&s),
        owner_type: "user",
        owner_id: owner.id.to_string(),
        owner_name: owner.user_name.clone(),
        status: connection_status.to_string(),
        workspace_ids,
        updated_at: pydantic_datetime(device.updated_at),
    }
}

/// `runtime_device_route_id`: app uses the record route id; otherwise
/// `spec.deviceId`, the cloud `deviceId`, or the name.
fn runtime_device_route_id(device: &OwnedKindRow, device_type: &str, spec: &DeviceSpec) -> String {
    if device_type == "app" {
        return format!("app-record-{}", device.id);
    }
    let mut route = spec
        .device_id
        .clone()
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_default();
    if route.is_empty()
        && let Some(cloud_id) = spec
            .cloud_config
            .as_ref()
            .and_then(|c| c.device_id.as_deref())
            .filter(|id| !id.trim().is_empty())
    {
        route = cloud_id.to_string();
    }
    if route.is_empty() {
        route = device.name.clone();
    }
    route.trim().to_string()
}

/// `execution_environment_kind`.
fn execution_environment_kind(device_type: &str) -> String {
    if device_type == "cloud" || device_type == "remote" {
        "cloud_host".to_string()
    } else {
        "local_device".to_string()
    }
}

/// `coding_tools`: `bindShell` only (the recorded openclaw device derives
/// `["openclaw"]`; the default claudecode shell derives
/// `["claude_code", "codex"]`).
fn coding_tools(spec: &DeviceSpec) -> Vec<String> {
    match spec.bind_shell.as_deref().map(str::to_ascii_lowercase) {
        Some(shell) if shell == "openclaw" => vec!["openclaw".to_string()],
        _ => vec!["claude_code".to_string(), "codex".to_string()],
    }
}

/// `execution_environment_statuses`: one Redis MGET of the online keys for the
/// active devices, translating each `status` to `online`/`offline`.
pub async fn execution_environment_statuses(
    state: &AppState,
    devices: &[OwnedKindRow],
) -> Vec<String> {
    let mut keys: Vec<String> = Vec::with_capacity(devices.len());
    let mut keep: Vec<bool> = Vec::with_capacity(devices.len());
    for device in devices {
        keep.push(device.is_active != 0);
        let route = connection_route_id(device);
        keys.push(devices::online_key(device.user_id, &route));
    }
    let online_map: Vec<Option<JsonProjection<OnlineStateInput>>> =
        cache_manager_mget(state, keys.clone()).await;
    let mut statuses = Vec::with_capacity(devices.len());
    for ((index, device), keep_value) in devices.iter().enumerate().zip(keep) {
        let _ = device;
        if !keep_value {
            statuses.push("offline".to_string());
            continue;
        }
        let info = online_map
            .get(index)
            .and_then(Option::as_ref)
            .and_then(|online| online.value.as_ref());
        let status = info
            .and_then(|info| info.status.as_deref())
            .unwrap_or("online");
        statuses.push(
            match status {
                "online" | "busy" => "online",
                _ => "offline",
            }
            .to_string(),
        );
    }
    statuses
}

/// Source `cache_manager.mget`: one batched read of the online keys; errors
/// degrade to an all-missing map (all offline), matching the source swallow.
async fn cache_manager_mget<T: DeserializeOwned>(
    state: &AppState,
    keys: Vec<String>,
) -> Vec<Option<T>> {
    let Some(redis) = state.redis.as_ref() else {
        return keys.iter().map(|_| None).collect();
    };
    match redis.mget::<_, RedisBytes>(keys.clone()).await {
        Ok(values) => values
            .into_iter()
            .map(|bytes| bytes.and_then(|bytes| serde_json::from_slice(bytes.as_ref()).ok()))
            .collect(),
        Err(_) => keys.iter().map(|_| None).collect(),
    }
}

/// Decoded `device:online:*` document used by the status projection.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct OnlineStateInput {
    pub status: Option<String>,
}

/// Pydantic naive datetime rendering: seconds precision, microseconds only
/// when non-zero (`isoformat()`).
fn pydantic_datetime(value: chrono::NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_micros() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_json::OpaqueJson;

    fn timestamp() -> chrono::NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 9, 20)
            .unwrap()
            .and_hms_opt(18, 54, 27)
            .unwrap()
    }

    fn user() -> UserRow {
        UserRow {
            id: 157,
            user_name: "sifang".to_string(),
            users_password_hash: "hash".to_string(),
            email: Some("sifang@example.invalid".to_string()),
            git_info: brz_mysql::Json(OpaqueJson::from(serde_json::json!({}))),
            is_active: 1,
            role: "user".to_string(),
            auth_source: "oidc".to_string(),
            preferences: "{}".to_string(),
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    fn device(id: i64, name: &str, document: serde_json::Value) -> OwnedKindRow {
        OwnedKindRow {
            id,
            user_id: 157,
            kind: "Device".to_string(),
            name: name.to_string(),
            namespace: "default".to_string(),
            json: brz_mysql::Json(document),
            is_active: 1,
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    /// A cloud device renders `kind`/`name`/`device_key`/`coding_tools` from the
    /// CRD `spec` object, not from the top-level document.
    #[test]
    fn projects_cloud_device_from_spec_level() {
        let row = device(
            254391,
            "948010f3-6e14-4096-8442-612ba7598009",
            serde_json::json!({
                "apiVersion": "wegent.io/v1alpha1",
                "kind": "Device",
                "metadata": {"name": "948010f3-6e14-4096-8442-612ba7598009"},
                "spec": {
                    "deviceType": "cloud",
                    "deviceId": "948010f3-6e14-4096-8442-612ba7598009",
                    "displayName": "sifang-openclaw-612ba7598009",
                    "bindShell": "openclaw",
                    "cloudConfig": {"deviceId": "948010f3-6e14-4096-8442-612ba7598009"},
                },
            }),
        );
        let environment = personal_environment_values(&row, "online", &user(), Vec::new());
        assert_eq!(environment.kind, "cloud_host");
        assert_eq!(environment.name, "sifang-openclaw-612ba7598009");
        assert_eq!(
            environment.device_key,
            "948010f3-6e14-4096-8442-612ba7598009"
        );
        assert_eq!(environment.coding_tools, vec!["openclaw".to_string()]);
        assert_eq!(environment.status, "online");
    }

    /// A device without a usable `spec` falls back to the source defaults:
    /// `local_device`, the kind name, and the default coding-tool pair.
    #[test]
    fn projects_defaults_without_spec() {
        let row = device(1, "some-device", serde_json::json!({"kind": "Device"}));
        let environment = personal_environment_values(&row, "offline", &user(), Vec::new());
        assert_eq!(environment.kind, "local_device");
        assert_eq!(environment.name, "some-device");
        assert_eq!(environment.device_key, "some-device");
        assert_eq!(
            environment.coding_tools,
            vec!["claude_code".to_string(), "codex".to_string()]
        );
    }
}
