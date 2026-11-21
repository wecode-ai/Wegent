// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Execution-environment status and value projection
//! (`execution_environment_statuses`, `personal_environment_values`).
use std::collections::{HashMap, HashSet};

use brz_redis::{Redis as _, RedisBytes};
use serde_json::Value;

use crate::auth::UserRow;
use crate::devices;
use crate::http_compat::FastApiError;
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
    fn from_type(value: &str) -> Self {
        match value {
            "cloud" => Self::Cloud,
            "app" => Self::App,
            "remote" => Self::Remote,
            _ => Self::Local,
        }
    }

    fn from_device(row: &OwnedKindRow) -> Self {
        let s = spec(row).value.unwrap_or_default();
        Self::from_type(s.device_type.as_deref().unwrap_or("local"))
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
    #[serde(rename = "appDeviceId")]
    app_device_id: Option<Value>,
    #[serde(rename = "bindShell")]
    bind_shell: Option<String>,
    #[serde(rename = "cloudConfig")]
    cloud_config: Option<CloudConfigSpec>,
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: Option<Value>,
    #[serde(rename = "codingTools")]
    coding_tools: Option<Value>,
    #[serde(rename = "deploymentLocation")]
    deployment_location: Option<Value>,
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
    workspace_ids: Option<Vec<String>>,
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
        app_device_id: json_text(s.app_device_id.as_ref()),
        name,
        kind: execution_environment_kind(
            json_text(s.deployment_location.as_ref()).as_deref(),
            &device_type,
        ),
        coding_tools: coding_tools(&s),
        owner_type: "user",
        owner_id: owner.id.to_string(),
        owner_name: owner.user_name.clone(),
        status: connection_status.to_string(),
        workspace_ids,
        updated_at: pydantic_datetime(device.updated_at),
    }
}

/// `str(value)` for a JSON scalar: strings pass through, numbers and booleans
/// render like the source's `str()`.
fn json_text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::Bool(true)) => Some("True".to_string()),
        Some(Value::Bool(false)) => Some("False".to_string()),
        Some(Value::Null) | None => None,
        Some(other) => Some(other.to_string()),
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

/// `execution_environment_kind`: `deploymentLocation` overrides `deviceType`.
fn execution_environment_kind(deployment_location: Option<&str>, device_type: &str) -> String {
    let effective = deployment_location
        .filter(|value| !value.is_empty())
        .unwrap_or(device_type);
    if effective == "cloud" || effective == "remote" {
        "cloud_host".to_string()
    } else {
        "local_device".to_string()
    }
}

/// `coding_tools`: an explicit `codingTools` list wins; otherwise `bindShell`
/// decides between `openclaw` and the default Claude/Codex pair.
fn coding_tools(spec: &DeviceSpec) -> Vec<String> {
    if let Some(Value::Array(configured)) = &spec.coding_tools {
        return configured
            .iter()
            .filter_map(|value| json_text(Some(value)))
            .filter(|value| !value.trim().is_empty())
            .collect();
    }
    match spec.bind_shell.as_deref().map(str::to_ascii_lowercase) {
        Some(shell) if shell == "openclaw" => vec!["openclaw".to_string()],
        _ => vec!["claude_code".to_string(), "codex".to_string()],
    }
}

/// `execution_environment_statuses`: one deduplicated Redis MGET of the online
/// keys for the active devices, then the `online`/`busy` projection.
pub async fn execution_environment_statuses(
    state: &AppState,
    devices: &[OwnedKindRow],
) -> Result<Vec<String>, FastApiError> {
    let mut keys: Vec<String> = Vec::with_capacity(devices.len());
    let mut seen: HashSet<String> = HashSet::with_capacity(devices.len());
    let mut device_keys: Vec<Option<String>> = Vec::with_capacity(devices.len());
    for device in devices {
        if device.is_active == 0 {
            device_keys.push(None);
            continue;
        }
        let key = devices::online_key(device.user_id, &connection_route_id(device));
        if seen.insert(key.clone()) {
            keys.push(key.clone());
        }
        device_keys.push(Some(key));
    }
    let online = cache_manager_mget(state, keys).await?;
    let mut statuses = Vec::with_capacity(devices.len());
    for (index, device) in devices.iter().enumerate() {
        let info = device_keys[index].as_ref().and_then(|key| online.get(key));
        let device_type = DeviceType::from_device(device);
        let info = if matches!(device_type, DeviceType::Local | DeviceType::App) {
            let spec = spec(device).value.unwrap_or_default();
            matching_online_info(device_type, &spec, info)
        } else {
            info
        };
        let raw_status = match info {
            Some(info) => info.status.as_deref().unwrap_or("online"),
            None => "offline",
        };
        statuses.push(
            match raw_status {
                "online" | "busy" => "online",
                _ => "offline",
            }
            .to_string(),
        );
    }
    Ok(statuses)
}

/// `matching_online_info`: a shared Redis key is not proof that this database
/// Runtime is online.
fn matching_online_info<'a>(
    device_type: DeviceType,
    spec: &DeviceSpec,
    info: Option<&'a OnlineStateInput>,
) -> Option<&'a OnlineStateInput> {
    let info = info?;
    let persisted = non_null(spec.runtime_instance_id.as_ref());
    let observed = non_null(info.runtime_instance_id.as_ref());
    if device_type == DeviceType::App && !persisted.is_some_and(python_truthy) {
        return None;
    }
    if persisted != observed
        && (persisted.is_some_and(python_truthy) || device_type == DeviceType::App)
    {
        return None;
    }
    Some(info)
}

/// Python `None` for both a missing key and an explicit JSON `null`.
fn non_null(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

fn python_truthy(value: &Value) -> bool {
    brz_json::adapters::python_truthy(value)
}

/// Source `cache_manager.mget`: one batched read of the online keys. A
/// transport or decode failure raises in the source, so it renders as the
/// unhandled 500 instead of an all-offline device list.
async fn cache_manager_mget(
    state: &AppState,
    keys: Vec<String>,
) -> Result<HashMap<String, OnlineStateInput>, FastApiError> {
    if keys.is_empty() {
        return Ok(HashMap::new());
    }
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!("device online state unavailable: no Redis service");
        return Err(FastApiError::unhandled());
    };
    let values = redis
        .mget::<_, RedisBytes>(keys.clone())
        .await
        .map_err(|error| {
            tracing::error!(%error, "device online state read failure");
            FastApiError::unhandled()
        })?;
    let mut online = HashMap::with_capacity(keys.len());
    for (key, bytes) in keys.into_iter().zip(values) {
        let Some(bytes) = bytes else {
            continue;
        };
        let parsed: OnlineStateInput = serde_json::from_slice(bytes.as_ref()).map_err(|error| {
            tracing::error!(%error, "device online state decode failure");
            FastApiError::unhandled()
        })?;
        online.insert(key, parsed);
    }
    Ok(online)
}

/// Decoded `device:online:*` document used by the status projection.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct OnlineStateInput {
    pub status: Option<String>,
    #[serde(rename = "runtime_instance_id")]
    pub runtime_instance_id: Option<Value>,
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
        let environment = personal_environment_values(&row, "online", &user(), Some(Vec::new()));
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
        let environment = personal_environment_values(&row, "offline", &user(), Some(Vec::new()));
        assert_eq!(environment.kind, "local_device");
        assert_eq!(environment.name, "some-device");
        assert_eq!(environment.device_key, "some-device");
        assert_eq!(
            environment.coding_tools,
            vec!["claude_code".to_string(), "codex".to_string()]
        );
        assert_eq!(environment.app_device_id, None);
    }

    /// The App device projection carries the physical installation id and the
    /// `app-record-<id>` route the recording exposes.
    #[test]
    fn projects_app_device_identity_from_spec() {
        let row = device(
            302385,
            "e8b26478-0381-4c63-b969-58e8a22b50b1",
            serde_json::json!({
                "kind": "Device",
                "spec": {
                    "deviceType": "app",
                    "deviceId": "e8b26478-0381-4c63-b969-58e8a22b50b1",
                    "appDeviceId": "electron-76ee0007-fecb-49d6-bf80-fd4637f4591b",
                    "displayName": "Jun's WorkStation",
                    "runtimeInstanceId": "runtime-f673044a9db2b18662bb7eff",
                    "bindShell": "claudecode",
                },
            }),
        );
        let environment = personal_environment_values(&row, "online", &user(), Some(Vec::new()));
        assert_eq!(environment.id, "302385");
        assert_eq!(environment.device_key, "app-record-302385");
        assert_eq!(
            environment.app_device_id.as_deref(),
            Some("electron-76ee0007-fecb-49d6-bf80-fd4637f4591b")
        );
        assert_eq!(environment.name, "Jun's WorkStation");
        assert_eq!(environment.kind, "local_device");
        assert_eq!(environment.updated_at, "2026-09-20T18:54:27");
    }

    /// An App Runtime whose reported instance does not match the persisted one
    /// is not online even though the shared Redis key is present.
    #[test]
    fn matching_online_info_rejects_a_stale_runtime() {
        let spec = DeviceSpec {
            device_type: Some("app".to_string()),
            runtime_instance_id: Some(serde_json::json!("runtime-current")),
            ..DeviceSpec::default()
        };
        let stale = OnlineStateInput {
            status: Some("online".to_string()),
            runtime_instance_id: Some(serde_json::json!("runtime-previous")),
        };
        assert!(matching_online_info(DeviceType::App, &spec, Some(&stale)).is_none());
        let current = OnlineStateInput {
            status: Some("online".to_string()),
            runtime_instance_id: Some(serde_json::json!("runtime-current")),
        };
        assert!(matching_online_info(DeviceType::App, &spec, Some(&current)).is_some());
    }

    /// An App row without a persisted Runtime instance id is offline.
    #[test]
    fn matching_online_info_requires_persisted_app_identity() {
        let spec = DeviceSpec {
            device_type: Some("app".to_string()),
            ..DeviceSpec::default()
        };
        let info = OnlineStateInput {
            status: Some("online".to_string()),
            runtime_instance_id: Some(serde_json::json!("runtime-any")),
        };
        assert!(matching_online_info(DeviceType::App, &spec, Some(&info)).is_none());
    }

    /// A local device without a persisted Runtime instance id keeps the
    /// recorded online state (the source only gates App rows).
    #[test]
    fn matching_online_info_keeps_local_without_identity() {
        let spec = DeviceSpec {
            device_type: Some("local".to_string()),
            ..DeviceSpec::default()
        };
        let info = OnlineStateInput {
            status: Some("busy".to_string()),
            runtime_instance_id: Some(serde_json::json!("runtime-any")),
        };
        assert!(matching_online_info(DeviceType::Local, &spec, Some(&info)).is_some());
    }
}
