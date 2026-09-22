// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Device listing for `GET /api/devices`.
//!
//! Mirrors `app.api.endpoints.devices.get_all_devices`, which calls
//! `device_service.get_all_devices`: every registered device provider lists
//! its devices for the current user and the results are concatenated in
//! provider registration order — `cloud` (registered first by
//! the configured store), then `local`, `app`, and `remote`
//! (the configured store plus the factory defaults).
//!
//! - cloud devices (the configured store):
//!   one `kinds` query, then per device two Redis `GET`s of
//!   `device:online:<uid>:<device_id>` (online info, then slot usage) and one
//!   `GET executor:latest_version`;
//! - local and app devices (`LocalDeviceProvider.list_devices`): one `kinds`
//!   query, one batched Redis `MGET` of the online keys, then one
//!   `GET executor:latest_version`;
//! - remote devices (`RemoteDeviceProvider.list_devices`): one `kinds`
//!   query, one batched `MGET`, then one `GET executor:latest_version`.
//!
//! All Redis failures degrade to "offline" devices (source `cache_manager`
//! swallows Redis errors), and an empty provider group returns before the
//! `executor:latest_version` lookup.
#[cfg(test)]
use crate::json_compat::raw_json;
use crate::json_compat::{JsonProjection, OpaqueJson};
use brz_redis::Redis;
use serde::{de::DeserializeOwned, de::IgnoredAny};
#[cfg(test)]
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use serde_json::value::RawValue;

use crate::auth::{AuthFailure, UserRow, get_current_user};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// A device Kind row (`kinds` table), selected with the full labeled source
/// column list; only `id`, `name`, and `json` are consumed. The result
/// columns carry the `kinds_<column>` aliases, so every field is renamed.
#[derive(Debug, brz_mysql::FromMysqlRow)]
pub struct DeviceKindRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[mysql(rename = "kinds_json")]
    json: brz_mysql::Json<JsonProjection<DeviceDocumentInput>>,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_user_id")]
    pub user_id: i32,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_kind")]
    pub kind: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_namespace")]
    pub namespace: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_is_active")]
    pub is_active: i8,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_created_at")]
    pub created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_updated_at")]
    pub updated_at: chrono::NaiveDateTime,
}

/// Device type discriminant (`spec.deviceType`, default `local`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DeviceType {
    Cloud,
    Local,
    App,
    Remote,
}

impl DeviceType {
    fn from_spec(spec: &DeviceSpecInput) -> Self {
        match spec.device_type.as_deref() {
            Some("cloud") => Self::Cloud,
            Some("app") => Self::App,
            Some("remote") => Self::Remote,
            _ => Self::Local,
        }
    }
}

/// The source `kinds` query for one provider's listing (`Kind` model filter).
/// The projection mirrors the source SQLAlchemy labeled rendering
/// (`kinds.<column> AS kinds_<column>`) so the prepared statement matches the
/// recorded exchange.
const KINDS_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' \
     AND kinds.namespace = 'default' AND kinds.is_active = true";

/// Redis online-state key (`LocalDeviceProvider.generate_online_key`).
fn online_key(user_id: i64, device_id: &str) -> String {
    format!("device:online:{user_id}:{device_id}")
}

/// Source `record_route_id`: App devices use `app-record-<id>` as the transport
/// identity (Redis key, execution_target_id, socket_device_id); all other device
/// types use the Kind `name` (the logical device_id).
fn record_route_id(row: &DeviceKindRow, device_type: DeviceType) -> String {
    match device_type {
        DeviceType::App => format!("app-record-{}", row.id),
        _ => row.name.clone(),
    }
}

/// Redis key holding the cached latest executor version
/// (`ExecutorVersionService.EXECUTOR_VERSION_CACHE_KEY`).
const EXECUTOR_VERSION_KEY: &str = "executor:latest_version";

/// The value stored when a remote version fetch failed
/// (`EXECUTOR_VERSION_UNAVAILABLE`); callers treat it as "no version".
const EXECUTOR_VERSION_UNAVAILABLE: &str = "__unavailable__";

/// Default when neither Redis nor the checker produced a version
/// (`settings.EXECUTOR_LATEST_VERSION`).
const EXECUTOR_LATEST_VERSION_DEFAULT: &str = "1.0.0";

/// One device response item (`DeviceInfo` serialized by pydantic).
///
/// Field order follows the source model; missing keys use the same defaults
/// pydantic applies.
#[derive(serde::Serialize)]
struct DeviceItem {
    id: i64,
    execution_target_id: Option<String>,
    device_id: String,
    name: String,
    status: String,
    is_default: bool,
    last_heartbeat: Option<Box<RawValue>>,
    device_type: DeviceType,
    connection_mode: String,
    capabilities: Option<Box<RawValue>>,
    slot_used: i64,
    slot_max: i64,
    running_tasks: [(); 0],
    executor_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    client_ip: Option<Box<RawValue>>,
    runtime_transfer_host: Option<Box<RawValue>>,
    runtime_instance_id: Option<Box<RawValue>>,
    app_device_id: Option<Box<RawValue>>,
    socket_device_id: Option<String>,
    runtime_features: Option<RuntimeFeatures>,
    cloud_config: Option<Box<RawValue>>,
    remote_config: Option<Box<RawValue>>,
    bind_shell: String,
}

#[derive(serde::Serialize)]
struct DeviceListResponse {
    items: Vec<DeviceItem>,
    total: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeFeatures {
    schema_version: i64,
    runtime_task_create: Option<Box<RawValue>>,
    interactive_sessions: Option<Box<RawValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worktrees: Option<Box<RawValue>>,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
struct DeviceDocumentInput {
    spec: Option<DeviceSpecInput>,
}
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
struct DeviceSpecInput {
    #[serde(rename = "deviceType")]
    device_type: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    #[serde(rename = "isDefault")]
    is_default: Option<bool>,
    capabilities: Option<OpaqueJson>,
    #[serde(rename = "cloudConfig")]
    cloud_config: Option<OpaqueJson>,
    #[serde(rename = "remoteConfig")]
    remote_config: Option<OpaqueJson>,
    #[serde(rename = "bindShell")]
    bind_shell: Option<String>,
    #[serde(rename = "deviceId")]
    device_id: Option<String>,
    #[serde(rename = "connectionMode")]
    connection_mode: Option<String>,
    #[serde(rename = "clientIp")]
    client_ip: Option<OpaqueJson>,
    #[serde(rename = "runtimeTransferHost")]
    runtime_transfer_host: Option<OpaqueJson>,
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: Option<OpaqueJson>,
    #[serde(rename = "appDeviceId")]
    app_device_id: Option<OpaqueJson>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct OnlineStateInput {
    executor_version: Option<String>,
    status: Option<String>,
    last_heartbeat: Option<OpaqueJson>,
    running_task_ids: Option<Vec<IgnoredAny>>,
    runtime_features: Option<OpaqueJson>,
    runtime_capacity: Option<RuntimeCapacityInput>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct RuntimeFeatureInput {
    #[serde(rename = "schemaVersion")]
    schema_version: Option<i64>,
    #[serde(rename = "runtimeTaskCreate")]
    runtime_task_create: Option<OpaqueJson>,
    #[serde(rename = "interactiveSessions")]
    interactive_sessions: Option<OpaqueJson>,
    worktrees: Option<OpaqueJson>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct RuntimeCapacityInput {
    active: Option<i64>,
    limit: Option<i64>,
    active_task_ids: Option<Vec<String>>,
}

/// Runtime capacity slot values (`runtime_capacity_slot_values`): both the
/// active count and the limit are only trusted when the whole capacity
/// payload is internally consistent; otherwise slots are zero.
fn runtime_capacity_slot_values(
    online_info: Option<&JsonProjection<OnlineStateInput>>,
) -> (i64, i64) {
    let slots = || {
        let capacity = online_info?.value.as_ref()?.runtime_capacity.as_ref()?;
        let active = capacity.active?;
        let limit = capacity.limit?;
        let ids = capacity.active_task_ids.as_ref()?;
        if active < 0
            || !(1..=20).contains(&limit)
            || ids.len() as i64 != active
            || ids.iter().any(|id| id.is_empty())
        {
            return None;
        }
        if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() {
            return None;
        }
        Some((active, limit))
    };
    slots().unwrap_or((0, 0))
}

/// `_is_update_available`: absent current version means an update is
/// available; otherwise compare semantically and treat parse failures as no
/// update.
fn is_update_available(current: Option<&str>, latest: Option<&str>) -> bool {
    let Some(current) = current else {
        return true;
    };
    let Some(latest) = latest else {
        return false;
    };
    match (semver_parts(current), semver_parts(latest)) {
        (Some(current), Some(latest)) => current < latest,
        _ => false,
    }
}

/// Numeric semantic-version core (`packaging.version.parse` core numeric
/// comparison for the dotted versions used by the executor).
fn semver_parts(version: &str) -> Option<Vec<i64>> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = Vec::new();
    for part in core.split('.') {
        parts.push(part.trim().parse::<i64>().ok()?);
    }
    Some(parts)
}

/// `executor_version_service.get_latest_version() or
/// settings.EXECUTOR_LATEST_VERSION`: a cached value wins unless it is the
/// explicit unavailable marker; any Redis failure falls back to the settings
/// default (`EXECUTOR_LATEST_VERSION`, "1.0.0") exactly like the source's
/// `... or settings.EXECUTOR_LATEST_VERSION` expression.
async fn latest_executor_version(state: &AppState) -> Option<String> {
    // The source stores orjson-encoded values (`"2.0.16"` as a JSON string),
    // so decode the payload and keep only string results, exactly like
    // `cache_manager.get` returning the parsed value.
    let cached: Option<String> = cache_manager_get(state, EXECUTOR_VERSION_KEY).await;
    match cached.as_deref() {
        Some(value) if value == EXECUTOR_VERSION_UNAVAILABLE => {
            Some(EXECUTOR_LATEST_VERSION_DEFAULT.to_string())
        }
        Some(value) => Some(value.to_string()),
        None => Some(EXECUTOR_LATEST_VERSION_DEFAULT.to_string()),
    }
}

/// Source `cache_manager.get`: read one key and decode its orjson payload;
/// errors and missing keys degrade to `None`.
async fn cache_manager_get<T: DeserializeOwned>(state: &AppState, key: &str) -> Option<T> {
    state
        .redis
        .as_ref()?
        .get::<_, brz_redis::RedisBytes>(key)
        .await
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(bytes.as_ref()).ok())
}

/// Source `cache_manager.mget`: read a batch of keys over the shared pooled
/// connection; errors degrade to an all-missing map, which yields offline
/// devices exactly like the source's error swallow.
async fn cache_manager_mget<T: DeserializeOwned>(
    state: &AppState,
    keys: Vec<String>,
) -> Vec<Option<T>> {
    let Some(redis) = state.redis.as_ref() else {
        return keys.iter().map(|_| None).collect();
    };
    match redis.mget::<_, brz_redis::RedisBytes>(keys.clone()).await {
        Ok(values) => values
            .into_iter()
            .map(|bytes| bytes.and_then(|bytes| serde_json::from_slice(bytes.as_ref()).ok()))
            .collect(),
        Err(_) => keys.iter().map(|_| None).collect(),
    }
}

/// One Redis `GET device:online:<user_id>:<device_id>` decoded as JSON,
/// matching `LocalDeviceProvider._get_online_info`.
async fn get_online_info(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Option<JsonProjection<OnlineStateInput>> {
    cache_manager_get(state, &online_key(user_id, device_id)).await
}

/// Cloud listing (`application CloudDeviceProvider.list_devices`).
///
/// Per device: `GET` online info, `GET` online info again inside
/// `get_slot_usage`, then `GET executor:latest_version`. Slot usage is
/// derived from the second online payload: `used` is the number of running
/// task IDs and `max` is always 0 (`cloud device slot limit`).
async fn list_cloud_devices(
    state: &AppState,
    user_id: i64,
    kinds: &[DeviceKindRow],
) -> Vec<DeviceItem> {
    let cloud: Vec<&DeviceKindRow> = kinds
        .iter()
        .filter(|row| DeviceType::from_spec(&spec(row)) == DeviceType::Cloud)
        .collect();
    let mut result = Vec::new();
    for row in cloud {
        let spec = spec(row);
        let device_id = row.name.clone();
        let online = get_online_info(state, user_id, &device_id).await;
        let online_state = online.as_ref().and_then(|info| info.value.as_ref());
        // get_slot_usage re-reads the online payload from Redis.
        let slot_online = get_online_info(state, user_id, &device_id).await;
        let slot_used = slot_online.as_ref().map_or(0, online_running_count);
        let executor_version = online_state
            .as_ref()
            .and_then(|info| info.executor_version.clone());
        let latest_version = latest_executor_version(state).await;
        let update_available =
            is_update_available(executor_version.as_deref(), latest_version.as_deref());
        let status = online_status(online.as_ref());
        result.push(DeviceItem {
            id: row.id,
            execution_target_id: None,
            device_id,
            name: spec
                .display_name
                .clone()
                .unwrap_or_else(|| row.name.clone()),
            status,
            is_default: spec.is_default.unwrap_or(false),
            last_heartbeat: online_state
                .as_ref()
                .and_then(|info| info.last_heartbeat.as_ref().map(OpaqueJson::to_raw_value)),
            device_type: DeviceType::Cloud,
            connection_mode: "websocket".to_string(),
            capabilities: spec.capabilities.as_ref().map(OpaqueJson::to_raw_value),
            slot_used,
            slot_max: 0,
            running_tasks: [],
            executor_version,
            latest_version,
            update_available,
            client_ip: None,
            runtime_transfer_host: None,
            runtime_instance_id: None,
            app_device_id: None,
            socket_device_id: None,
            // The deployed cloud provider (the configured store)
            // result dict has no `runtime_features` key, so pydantic defaults
            // it to null even when the Redis online payload carries one.
            runtime_features: None,
            cloud_config: spec.cloud_config.as_ref().map(OpaqueJson::to_raw_value),
            remote_config: None,
            bind_shell: spec
                .bind_shell
                .clone()
                .unwrap_or_else(|| "claudecode".to_string()),
        });
    }
    result
}

/// The deployed cloud provider's slot `used` value: the length of the
/// reported `running_task_ids` list (`get_slot_usage`).
fn online_running_count(info: &JsonProjection<OnlineStateInput>) -> i64 {
    info.value
        .as_ref()
        .and_then(|info| info.running_task_ids.as_ref())
        .map(|ids| ids.len() as i64)
        .unwrap_or(0)
}

fn online_status(online: Option<&JsonProjection<OnlineStateInput>>) -> String {
    if online.is_some() {
        online
            .and_then(|info| info.value.as_ref())
            .and_then(|info| info.status.as_deref())
            .unwrap_or("online")
            .to_string()
    } else {
        "offline".to_string()
    }
}

/// Local/app/remote shared listing (`LocalDeviceProvider.list_devices`).
///
/// One batched `MGET` across the group's devices, then one
/// `executor:latest_version` lookup.
async fn list_mget_devices(
    state: &AppState,
    user_id: i64,
    kinds: &[DeviceKindRow],
    device_type: DeviceType,
) -> Vec<DeviceItem> {
    let group: Vec<&DeviceKindRow> = kinds
        .iter()
        .filter(|row| DeviceType::from_spec(&spec(row)) == device_type)
        .collect();
    if group.is_empty() {
        return Vec::new();
    }
    // Source `LocalDeviceProvider.list_devices` uses `record_route_id` for the
    // Redis online key: `app-record-<id>` for App devices, `Kind.name` otherwise.
    let route_ids: Vec<String> = group
        .iter()
        .map(|row| record_route_id(row, device_type))
        .collect();
    let keys: Vec<String> = route_ids
        .iter()
        .map(|rid| online_key(user_id, rid))
        .collect();
    let online_map: Vec<Option<JsonProjection<OnlineStateInput>>> =
        cache_manager_mget(state, keys.clone()).await;
    let latest_version = latest_executor_version(state).await;
    let mut result = Vec::new();
    for (row, online) in group.iter().zip(online_map.iter()) {
        let spec = spec(row);
        let online = online.as_ref();
        let online_state = online.and_then(|info| info.value.as_ref());
        let (slot_used, slot_max) = runtime_capacity_slot_values(online);
        let executor_version = online_state
            .as_ref()
            .and_then(|info| info.executor_version.clone());
        let update_available =
            is_update_available(executor_version.as_deref(), latest_version.as_deref());
        let status = online_status(online);
        // Source `LocalDeviceProvider.list_devices` sets execution_target_id and
        // socket_device_id to `record_route_id` for App devices, None otherwise.
        // `RemoteDeviceProvider.list_devices` overrides socket_device_id to
        // `spec.get("deviceId") or device_kind.name`.
        let (execution_target_id, socket_device_id, cloud_config, remote_config) = match device_type
        {
            DeviceType::App => {
                let rid = record_route_id(row, device_type);
                (Some(rid.clone()), Some(rid), None, None)
            }
            DeviceType::Remote => (
                None,
                Some(spec.device_id.clone().unwrap_or_else(|| row.name.clone())),
                None,
                spec.remote_config.as_ref().map(OpaqueJson::to_raw_value),
            ),
            DeviceType::Cloud => (
                None,
                Some(spec.device_id.clone().unwrap_or_else(|| row.name.clone())),
                spec.cloud_config.as_ref().map(OpaqueJson::to_raw_value),
                None,
            ),
            _ => (None, None, None, None),
        };
        result.push(DeviceItem {
            id: row.id,
            execution_target_id,
            device_id: row.name.clone(),
            name: spec
                .display_name
                .clone()
                .unwrap_or_else(|| row.name.clone()),
            status,
            is_default: spec.is_default.unwrap_or(false),
            last_heartbeat: online_state
                .as_ref()
                .and_then(|info| info.last_heartbeat.as_ref().map(OpaqueJson::to_raw_value)),
            device_type,
            connection_mode: spec
                .connection_mode
                .clone()
                .unwrap_or_else(|| "websocket".to_string()),
            capabilities: spec.capabilities.as_ref().map(OpaqueJson::to_raw_value),
            slot_used,
            slot_max,
            running_tasks: [],
            executor_version,
            latest_version: latest_version.clone(),
            update_available,
            client_ip: spec.client_ip.as_ref().map(OpaqueJson::to_raw_value),
            runtime_transfer_host: spec
                .runtime_transfer_host
                .as_ref()
                .map(OpaqueJson::to_raw_value),
            runtime_instance_id: spec
                .runtime_instance_id
                .as_ref()
                .map(OpaqueJson::to_raw_value),
            app_device_id: spec.app_device_id.as_ref().map(OpaqueJson::to_raw_value),
            socket_device_id,
            runtime_features: online_state.and_then(project_runtime_features),
            cloud_config,
            remote_config,
            bind_shell: spec
                .bind_shell
                .clone()
                .unwrap_or_else(|| "claudecode".to_string()),
        });
    }
    result
}

/// Extract the `spec` object from a Kind row's JSON column.
fn spec(row: &DeviceKindRow) -> DeviceSpecInput {
    row.json
        .0
        .value
        .as_ref()
        .and_then(|document| document.spec.clone())
        .unwrap_or_default()
}

/// Reproduce the source `DeviceInfo` projection of the Redis online-state
/// `runtime_features` dict.
///
/// The stored dict is `RuntimeFeatures.model_dump(by_alias=True,
/// exclude_none=True)`, so it may carry `schemaVersion`, `runtimeTaskCreate`,
/// `interactiveSessions`, and `worktrees`. The endpoint's `DeviceInfo` model
/// re-validates through `RuntimeFeatures` (extra="ignore") and FastAPI
/// serializes the response with `by_alias=True` (the framework default):
/// - `schemaVersion` is required (ge=1); an empty or invalid dict normalizes
///   to absent (None).
/// - `runtimeTaskCreate` is always emitted: the stored value round-trips, or
///   null when absent (the model's Optional default).
/// - `interactiveSessions` is always emitted: the stored value round-trips, or
///   null when absent (the model's Optional default).
/// - `worktrees` is emitted only when present.
/// - Any other stored key is dropped by `extra="ignore"`.
fn project_runtime_features(info: &OnlineStateInput) -> Option<RuntimeFeatures> {
    let features = info
        .runtime_features
        .as_ref()?
        .project::<RuntimeFeatureInput>()?;
    let schema_version = features.schema_version.filter(|version| *version >= 1)?;
    Some(RuntimeFeatures {
        schema_version,
        runtime_task_create: features
            .runtime_task_create
            .as_ref()
            .map(OpaqueJson::to_raw_value),
        interactive_sessions: features
            .interactive_sessions
            .as_ref()
            .map(OpaqueJson::to_raw_value),
        worktrees: features.worktrees.as_ref().map(OpaqueJson::to_raw_value),
    })
}

/// GET /api/devices: the devices free function, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/devices")]
async fn get_all_devices(
    #[inject(state)] state: &AppState,
    #[header] authorization: Option<&str>,
) -> Result<DeviceListResponse, FastApiError> {
    devices(state, authorization).await
}

/// Handler for `GET /api/devices`.
async fn devices(
    state: &AppState,
    authorization: Option<&str>,
) -> Result<DeviceListResponse, FastApiError> {
    let user: UserRow = match get_current_user(&state.auth, &state.mysql, authorization).await {
        Ok(user) => user,
        Err(AuthFailure::InvalidCredentials) => {
            return Err(FastApiError::unauthorized("Could not validate credentials"));
        }
        Err(AuthFailure::UserNotActivated) => {
            return Err(FastApiError::unauthorized("User not activated"));
        }
    };

    // Source queries `kinds` once per provider in registration order:
    // cloud, local, app, remote.
    let mut items: Vec<DeviceItem> = Vec::new();
    for device_type in [
        DeviceType::Cloud,
        DeviceType::Local,
        DeviceType::App,
        DeviceType::Remote,
    ] {
        let kinds: Result<Vec<DeviceKindRow>, _> =
            state.mysql.fetch_all(KINDS_QUERY, (user.id,)).await;
        let kinds = match kinds {
            Ok(rows) => rows,
            Err(error) => {
                tracing::error!(%error, "kinds database dependency failure");
                return Err(internal_error());
            }
        };
        match device_type {
            DeviceType::Cloud => {
                items.extend(list_cloud_devices(state, user.id.into(), &kinds).await)
            }
            other => items.extend(list_mget_devices(state, user.id.into(), &kinds, other).await),
        }
    }

    Ok(DeviceListResponse {
        total: items.len(),
        items,
    })
}

/// Source `python_exception_handler` 500 response shape.
fn internal_error() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        serde_json::json!({"error_code": 500, "detail": "Internal server error"}).to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device_type(value: Value) -> DeviceType {
        let spec = JsonProjection::<DeviceSpecInput>::from(value)
            .value
            .unwrap_or_default();
        DeviceType::from_spec(&spec)
    }

    fn runtime_features(value: &Value) -> Option<RuntimeFeatures> {
        let online = JsonProjection::<OnlineStateInput>::from_json(value)
            .value
            .unwrap_or_default();
        project_runtime_features(&online)
    }

    fn online_info(capacity: Option<Value>) -> Value {
        let mut info = json!({
            "socket_id": "s",
            "name": "n",
            "status": "online",
            "executor_version": "2.0.9",
        });
        if let Some(capacity) = capacity {
            info["runtime_capacity"] = capacity;
        }
        info
    }

    fn capacity_slots(value: Option<&Value>) -> (i64, i64) {
        let projected = value.cloned().map(JsonProjection::<OnlineStateInput>::from);
        runtime_capacity_slot_values(projected.as_ref())
    }

    #[test]
    fn slot_values_require_consistent_capacity() {
        let valid = online_info(Some(json!({
            "limit": 10, "active": 2, "active_task_ids": ["a", "b"],
        })));
        assert_eq!(capacity_slots(Some(&valid)), (2, 10));

        let missing_ids = online_info(Some(json!({"limit": 10, "active": 2})));
        assert_eq!(capacity_slots(Some(&missing_ids)), (0, 0));

        let count_mismatch = online_info(Some(json!({
            "limit": 10, "active": 3, "active_task_ids": ["a", "b"],
        })));
        assert_eq!(capacity_slots(Some(&count_mismatch)), (0, 0));

        let limit_out_of_range = online_info(Some(json!({
            "limit": 21, "active": 0, "active_task_ids": [],
        })));
        assert_eq!(capacity_slots(Some(&limit_out_of_range)), (0, 0));

        assert_eq!(runtime_capacity_slot_values(None), (0, 0));
    }

    #[test]
    fn update_available_matches_source_semantics() {
        assert!(is_update_available(None, Some("2.0.16")));
        assert!(is_update_available(Some("2.0.9"), Some("2.0.16")));
        assert!(!is_update_available(Some("2.0.16"), Some("2.0.16")));
        assert!(!is_update_available(Some("2.0.17"), Some("2.0.16")));
        assert!(!is_update_available(Some("x"), Some("2.0.16")));
        assert!(!is_update_available(Some("2.0.9"), Some("x")));
    }

    #[test]
    fn item_json_matches_device_info_shape() {
        let item = DeviceItem {
            id: 268602,
            execution_target_id: None,
            device_id: "local-device".to_string(),
            name: "local-device app".to_string(),
            status: "online".to_string(),
            is_default: false,
            last_heartbeat: Some(raw_json(&json!("2026-09-04T15:52:17.193124"))),
            device_type: DeviceType::App,
            connection_mode: "websocket".to_string(),
            capabilities: None,
            slot_used: 0,
            slot_max: 0,
            running_tasks: [],
            executor_version: Some("1.8.5".to_string()),
            latest_version: Some("2.0.16".to_string()),
            update_available: true,
            client_ip: Some(raw_json(&json!("127.0.0.1"))),
            runtime_transfer_host: None,
            runtime_instance_id: None,
            app_device_id: None,
            socket_device_id: None,
            runtime_features: None,
            cloud_config: None,
            remote_config: None,
            bind_shell: "claudecode".to_string(),
        };
        let value = crate::json_contract_tests::serialized(item).unwrap();
        crate::json_contract_tests::assert_fixture("device", &value);
        assert_eq!(value["device_type"], "app");
        assert_eq!(value["running_tasks"], json!([]));
        assert_eq!(value["socket_device_id"], Value::Null);
        assert_eq!(value["cloud_config"], Value::Null);
        assert_eq!(value["remote_config"], Value::Null);
        assert_eq!(value["bind_shell"], "claudecode");
    }

    #[test]
    fn device_type_defaults_to_local() {
        assert_eq!(
            device_type(json!({"deviceType": "cloud"})),
            DeviceType::Cloud
        );
        assert_eq!(
            device_type(json!({"deviceType": "remote"})),
            DeviceType::Remote
        );
        assert_eq!(device_type(json!({"deviceType": "app"})), DeviceType::App);
        assert_eq!(device_type(json!({})), DeviceType::Local);
        assert_eq!(
            device_type(json!({"deviceType": "unknown"})),
            DeviceType::Local
        );
    }

    #[test]
    fn runtime_features_includes_interactive_sessions() {
        let info = json!({
            "runtime_features": {
                "schemaVersion": 3,
                "runtimeTaskCreate": {"schemaVersions": [1, 2]},
                "interactiveSessions": {"codeServer": true, "terminal": true},
                "worktrees": {"version": 1, "managed": true},
            },
        });
        let projected =
            crate::json_contract_tests::serialized(runtime_features(&info).unwrap()).unwrap();
        assert_eq!(projected["schemaVersion"], 3);
        assert!(projected["runtimeTaskCreate"].is_object());
        assert!(projected["interactiveSessions"].is_object());
        assert!(projected["worktrees"].is_object());
    }

    #[test]
    fn runtime_features_null_interactive_sessions_when_absent() {
        let info = json!({
            "runtime_features": {
                "schemaVersion": 2,
                "runtimeTaskCreate": {"schemaVersions": [1, 2]},
            },
        });
        let projected =
            crate::json_contract_tests::serialized(runtime_features(&info).unwrap()).unwrap();
        assert_eq!(projected["schemaVersion"], 2);
        assert_eq!(projected["interactiveSessions"], Value::Null);
        assert_eq!(
            projected["runtimeTaskCreate"]["schemaVersions"],
            json!([1, 2])
        );
        // worktrees is absent when not stored
        assert!(projected.get("worktrees").is_none());
    }
}
