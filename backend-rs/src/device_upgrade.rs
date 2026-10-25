// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/devices/{device_id}/upgrade`: send one remote upgrade command
//! to an online device through the Socket.IO Redis adapter.
//!
//! Mirrors `app.api.endpoints.devices.trigger_device_upgrade`:
//!
//! 1. `device_service.get_device_by_device_id` resolves the owned device from
//!    any registered identity (`resolve_owned_device_alias`);
//! 2. `DeviceProviderFactory.get_provider(...).get_status(...)` produces the
//!    online status and running-task list — the cloud and remote providers
//!    read `device:online:<user_id>:<route>` twice (status, then slot usage)
//!    and `executor:latest_version`, while local and app devices read the
//!    online payload once and filter it through `matching_online_info`;
//! 3. `device_service.get_device_online_info` re-reads
//!    `device:online:<user_id>:<submitted device id>` for the target socket;
//! 4. `DeviceNamespace.emit_upgrade_command` publishes the `device:upgrade`
//!    emit to that socket's room on the `/local-executor` namespace.
//!
//! Every Redis read here is `cache_manager.get_or_raise`: a connection failure
//! surfaces as the application's unhandled-exception body. Only the publish
//! failure is converted, because the source's emit wrapper turns it into
//! `False` and the endpoint then raises inside its own `try`.

use brz_mysql::MysqlError;
use brz_redis::Redis as _;
use serde_json::Value;

use crate::auth::SessionUser;
use crate::device_identity::{
    DeviceKindRow, KINDS_DEVICE_QUERY, record_id_from_route, resolve_owned_device_alias,
};
use crate::device_online_state::read_online_state;
use crate::device_running_tasks::list_running_tasks;
use crate::executor_version::latest_executor_version;
use crate::http_compat::FastApiError;
use crate::socketio_emit::{SOCKETIO_CHANNEL, emit_message};
use crate::state::AppState;

/// The device namespace the upgrade event is emitted on
/// (`DeviceNamespace("/local-executor")`).
const LOCAL_EXECUTOR_NAMESPACE: &str = "/local-executor";

/// `DeviceType.LOCAL.value`: the default `spec.deviceType` of a Device CRD.
const DEFAULT_DEVICE_TYPE: &str = "local";

/// `emit_upgrade_command`'s event name.
const UPGRADE_EVENT: &str = "device:upgrade";

/// Success body of `trigger_device_upgrade`.
const UPGRADE_SENT_MESSAGE: &str = "Upgrade command sent to device";

/// The publish failure detail. The source raises the inner
/// `HTTPException(500, "Failed to send upgrade command to device")` inside
/// its own `try`, so the outer handler re-wraps it and `str(exc)` becomes
/// `"500: <inner detail>"`.
const TRIGGER_FAILED_DETAIL: &str =
    "Failed to trigger upgrade: 500: Failed to send upgrade command to device";

/// `DeviceUpgradeRequest` (`app/api/endpoints/devices.py`). Pydantic fills the
/// model defaults for absent members, including `auto_confirm=True`; unknown
/// members are ignored by both models.
#[derive(Debug, serde::Deserialize)]
struct DeviceUpgradeRequest {
    #[serde(default)]
    force: bool,
    #[serde(default = "default_auto_confirm")]
    auto_confirm: bool,
    #[serde(default)]
    verbose: bool,
    #[serde(default)]
    force_stop_tasks: bool,
    #[serde(default)]
    registry: Option<String>,
    #[serde(default)]
    registry_token: Option<String>,
}

/// `auto_confirm: bool = Field(default=True, ...)`.
const fn default_auto_confirm() -> bool {
    true
}

/// `DeviceUpgradeResponse`: pydantic serializes the fields in declaration
/// order.
#[derive(Debug, serde::Serialize)]
struct DeviceUpgradeResponse {
    success: bool,
    message: &'static str,
}

/// `app.schemas.device.DeviceType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeviceType {
    Local,
    App,
    Cloud,
    Remote,
}

impl DeviceType {
    /// `DeviceType(value)`: only the four lowercase member values parse; any
    /// other value raises `ValueError` and reaches the unhandled handler.
    fn parse(value: &str) -> Option<Self> {
        match value {
            "local" => Some(Self::Local),
            "app" => Some(Self::App),
            "cloud" => Some(Self::Cloud),
            "remote" => Some(Self::Remote),
            _ => None,
        }
    }

    const fn value(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::App => "app",
            Self::Cloud => "cloud",
            Self::Remote => "remote",
        }
    }
}

/// The `spec` members the upgrade path consumes. Every `deviceId` stays a raw
/// JSON value so the provider's Python truthiness fallback
/// (`spec.get("deviceId") or cloud_config.get("deviceId") or name`) can be
/// reproduced.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct DeviceSpecInput {
    /// Kept as `Option<Value>` with an explicit presence-aware deserializer so
    /// a present `null` stays distinct from a missing member: `DeviceType(None)`
    /// raises, while a missing member takes the `local` default.
    #[serde(rename = "deviceType", deserialize_with = "present_value")]
    device_type: Option<Value>,
    #[serde(rename = "deviceId")]
    device_id: Option<Value>,
    #[serde(rename = "cloudConfig")]
    cloud_config: Option<Value>,
    #[serde(rename = "runtimeInstanceId")]
    runtime_instance_id: Option<Value>,
}

/// Deserialize any JSON value, including `null`, as `Some`.
fn present_value<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    <Value as serde::Deserialize>::deserialize(deserializer).map(Some)
}

impl DeviceSpecInput {
    /// `spec.get("deviceType")` as a string, or `None` for a missing,
    /// `null`, or non-string value.
    fn device_type_value(&self) -> Option<&str> {
        self.device_type.as_ref().and_then(Value::as_str)
    }

    /// The cloud transport identity
    /// (`identity.py::device_connection_route_id`): `spec.deviceId`,
    /// then `spec.cloudConfig.deviceId`, then the Kind name.
    fn cloud_route_id(&self, name: &str) -> Result<String, FastApiError> {
        if let Some(value) = self.device_id.as_ref() {
            match value {
                Value::String(text) if !text.is_empty() => return Ok(text.clone()),
                Value::String(_) | Value::Null => {}
                _ => return Err(unhandled()),
            }
        }
        if let Some(cloud_config) = self.cloud_config.as_ref() {
            // The source normalizes a falsy `cloudConfig` with `or {}` and
            // then indexes it as a dict; a truthy non-dict raises.
            match cloud_config {
                Value::Object(configured) => {
                    if let Some(value) = configured
                        .get("deviceId")
                        .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
                    {
                        return Ok(value.as_str().expect("checked string").to_string());
                    }
                }
                Value::Null | Value::Bool(false) => {}
                Value::String(text) if text.is_empty() => {}
                Value::Array(items) if items.is_empty() => {}
                Value::Number(number) if number.as_f64() == Some(0.0) => {}
                _ => return Err(unhandled()),
            }
        }
        Ok(name.to_string())
    }

    /// `identity.py::matching_online_info`: a shared Redis key is not proof
    /// that this database Runtime is online.
    fn matching_online_info(&self, info: Option<OnlineState>) -> Option<OnlineState> {
        let info = info?;
        let persisted = self
            .runtime_instance_id
            .as_ref()
            .filter(|value| !value.is_null());
        let observed = info.runtime_instance_id.as_ref();
        let is_app = self.device_type_value() == Some("app");
        if is_app && persisted.is_none() {
            return None;
        }
        if persisted != observed && (persisted.is_some() || is_app) {
            return None;
        }
        Some(info)
    }
}

/// The consumed members of the Redis online-state document.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct OnlineState {
    socket_id: Option<String>,
    status: Option<String>,
    running_task_ids: Option<Vec<Value>>,
    runtime_instance_id: Option<Value>,
}

impl OnlineState {
    /// `online_info.get("status", "online")`.
    fn status_value(&self) -> &str {
        self.status.as_deref().unwrap_or("online")
    }

    /// The reported running task ids the provider passes to
    /// `task_store.list_by_ids`; a non-list value cannot select tasks.
    fn running_task_ids(&self) -> Vec<i64> {
        self.running_task_ids
            .as_ref()
            .map(|ids| ids.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default()
    }
}

/// The provider `get_status` members the endpoint consumes.
struct ProviderStatus {
    status: String,
    running_tasks: usize,
}

/// POST /api/devices/{device_id}/upgrade: the handler free function.
#[brz_http_server::post("/api/devices/:device_id/upgrade")]
async fn trigger_device_upgrade(
    #[inject(state)] state: &AppState,
    device_id: String,
    request: DeviceUpgradeRequest,
    #[header("x-request-id")] request_id: Option<String>,
    #[auth] user: SessionUser,
) -> Result<DeviceUpgradeResponse, FastApiError> {
    upgrade_device(
        state,
        i64::from(user.0.id),
        &device_id,
        &request,
        request_id.as_deref(),
    )
    .await
}

/// `trigger_device_upgrade`'s business body.
async fn upgrade_device(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    request: &DeviceUpgradeRequest,
    request_id: Option<&str>,
) -> Result<DeviceUpgradeResponse, FastApiError> {
    // `device_service.get_device_by_device_id`.
    let device = match resolve_owned_device_alias(&state.mysql, user_id, device_id).await {
        Ok(device) => device,
        Err(error) => return Err(mysql_failure(error, "device identity lookup failed")),
    };
    let Some(device) = device else {
        tracing::warn!(user_id, device_id, "device upgrade: device not found");
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::NOT_FOUND,
            "Device not found or access denied",
        ));
    };

    let device_type = provider_type(&device)?;
    let Some(status) = provider_status(state, user_id, device_id, device_type, request_id).await?
    else {
        // The source indexes the provider's `None` result and raises
        // `AttributeError`, which the application renders as an unhandled 500.
        tracing::error!(user_id, device_id, "device upgrade: provider has no status");
        return Err(unhandled());
    };

    if status.status != "online" {
        tracing::warn!(
            user_id,
            device_id,
            status = status.status,
            "device upgrade: device is offline"
        );
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Device is offline",
        ));
    }
    if status.running_tasks > 0 && !request.force_stop_tasks {
        tracing::warn!(
            user_id,
            device_id,
            running_tasks = status.running_tasks,
            "device upgrade: device has running tasks"
        );
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            format!(
                "Device has {} running task(s). Wait for tasks to complete or use \
                 force_stop_tasks=true",
                status.running_tasks
            ),
        ));
    }

    // `device_service.get_device_online_info`: the local provider key built
    // from the submitted id.
    let Some(online) = read_online_state::<OnlineState>(state, user_id, device_id).await? else {
        tracing::error!(
            user_id,
            device_id,
            "device upgrade: online info missing from Redis"
        );
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Device online information not found",
        ));
    };
    let Some(socket_id) = online.socket_id.filter(|value| !value.is_empty()) else {
        tracing::error!(user_id, device_id, "device upgrade: socket id missing");
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Device socket information not found",
        ));
    };

    publish_upgrade_command(state, user_id, device_id, &socket_id, request).await?;

    tracing::info!(
        user_id,
        device_id,
        socket_id,
        "device upgrade: upgrade command sent"
    );
    Ok(DeviceUpgradeResponse {
        success: true,
        message: UPGRADE_SENT_MESSAGE,
    })
}

/// `DeviceType(device_kind.json.get("spec", {}).get("deviceType",
/// DeviceType.LOCAL.value))`. A non-object document, a non-object `spec`, or
/// an unknown value all raise in the source.
fn provider_type(device: &DeviceKindRow) -> Result<DeviceType, FastApiError> {
    let spec = device_spec(device)?;
    match spec.device_type.as_ref() {
        None => Ok(DeviceType::Local),
        Some(Value::String(value)) => DeviceType::parse(value).ok_or_else(unhandled),
        Some(_) => Err(unhandled()),
    }
}

/// `device.json.get("spec", {})` as a typed projection.
fn device_spec(device: &DeviceKindRow) -> Result<DeviceSpecInput, FastApiError> {
    let Some(document) = device.json.as_object() else {
        return Err(unhandled());
    };
    match document.get("spec") {
        None => Ok(DeviceSpecInput::default()),
        Some(Value::Object(spec)) => {
            serde_json::from_value(Value::Object(spec.clone())).map_err(|_| unhandled())
        }
        Some(_) => Err(unhandled()),
    }
}

/// `DeviceProviderFactory.get_provider(device_type).get_status(...)` reduced
/// to the status and running-task count the endpoint reads.
async fn provider_status(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    device_type: DeviceType,
    request_id: Option<&str>,
) -> Result<Option<ProviderStatus>, FastApiError> {
    match device_type {
        DeviceType::Cloud | DeviceType::Remote => {
            status_by_name(state, user_id, device_id, device_type, request_id).await
        }
        DeviceType::Local | DeviceType::App => {
            status_for_owned(state, user_id, device_id, device_type, request_id).await
        }
    }
}

/// `CloudDeviceProvider.get_status` / `RemoteDeviceProvider.get_status`: the
/// provider's own `Kind` read by the submitted name, then two Redis reads
/// (status, slot usage) and the executor version lookup.
async fn status_by_name(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    device_type: DeviceType,
    request_id: Option<&str>,
) -> Result<Option<ProviderStatus>, FastApiError> {
    let device: Option<DeviceKindRow> = state
        .mysql
        .fetch_optional(KINDS_DEVICE_BY_NAME_QUERY, (user_id, device_id))
        .await
        .map_err(|error| mysql_failure(error, "device status lookup failed"))?;
    let Some(device) = device else {
        return Ok(None);
    };
    let spec = device_spec(&device)?;
    // The by-name providers compare `spec.get("deviceType")` with no default.
    if spec.device_type_value() != Some(device_type.value()) {
        return Ok(None);
    }

    let route_id = match device_type {
        DeviceType::Cloud => spec.cloud_route_id(&device.name)?,
        _ => device_id.to_string(),
    };
    let online = read_online_state::<OnlineState>(state, user_id, &route_id).await?;
    // `get_slot_usage` re-reads the online payload.
    let slot_online = read_online_state::<OnlineState>(state, user_id, &route_id).await?;
    let running_tasks = running_task_count(state, user_id, slot_online.as_ref()).await?;
    // `get_latest_version() or settings.EXECUTOR_LATEST_VERSION`; the value
    // itself is not part of the endpoint contract, but the read is.
    let _ = latest_executor_version(state, request_id).await;

    Ok(Some(ProviderStatus {
        status: online.as_ref().map_or_else(
            || "offline".to_string(),
            |info| info.status_value().to_string(),
        ),
        running_tasks,
    }))
}

/// `LocalDeviceProvider.get_status` (shared by local and app devices):
/// `owned_active_device`, one Redis read filtered through
/// `matching_online_info`, and slot usage from that same payload.
async fn status_for_owned(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    device_type: DeviceType,
    request_id: Option<&str>,
) -> Result<Option<ProviderStatus>, FastApiError> {
    let Some(device) = owned_active_device(state, user_id, device_id).await? else {
        return Ok(None);
    };
    let spec = device_spec(&device)?;
    // `spec.get("deviceType", DeviceType.LOCAL.value) != self.device_type.value`.
    let persisted = spec.device_type_value().unwrap_or(DEFAULT_DEVICE_TYPE);
    if persisted != device_type.value() {
        return Ok(None);
    }

    let online =
        read_online_state::<OnlineState>(state, user_id, &record_route_id(&device, &spec)?).await?;
    let online = spec.matching_online_info(online);
    let running_tasks = running_task_count(state, user_id, online.as_ref()).await?;
    let _ = latest_executor_version(state, request_id).await;

    Ok(Some(ProviderStatus {
        status: online.as_ref().map_or_else(
            || "offline".to_string(),
            |info| info.status_value().to_string(),
        ),
        running_tasks,
    }))
}

/// `identity.py::owned_active_device`: the record route selects one row by
/// id, otherwise the exact Kind name selects at most two rows so a duplicate
/// identity raises `DeviceIdentityConflictError`.
async fn owned_active_device(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<Option<DeviceKindRow>, FastApiError> {
    if let Some(record_id) = record_id_from_route(device_id) {
        let sql = format!("{KINDS_DEVICE_QUERY} AND kinds.id = ?");
        let device: Option<DeviceKindRow> = state
            .mysql
            .fetch_optional(sql, (user_id, record_id))
            .await
            .map_err(|error| mysql_failure(error, "device record lookup failed"))?;
        return match device {
            Some(device) if provider_type(&device)? == DeviceType::App => Ok(Some(device)),
            _ => Ok(None),
        };
    }
    let sql = format!("{KINDS_DEVICE_QUERY} AND kinds.name = ? LIMIT 2");
    let devices: Vec<DeviceKindRow> = state
        .mysql
        .fetch_all(sql, (user_id, device_id))
        .await
        .map_err(|error| mysql_failure(error, "device name lookup failed"))?;
    if devices.len() > 1 {
        tracing::error!(
            user_id,
            device_id,
            "device status: duplicate active device identity"
        );
        return Err(unhandled());
    }
    Ok(devices.into_iter().next())
}

/// `identity.py::record_route_id` for the already-parsed document: app
/// devices use the record route, every other type the Kind name.
fn record_route_id(device: &DeviceKindRow, spec: &DeviceSpecInput) -> Result<String, FastApiError> {
    match provider_type_from_spec(spec)? {
        DeviceType::App => Ok(format!("app-record-{}", device.id)),
        _ => Ok(device.name.clone()),
    }
}

/// The re-usable `DeviceType(...)` conversion inside the identity helpers,
/// where the missing member already defaults to `local`.
fn provider_type_from_spec(spec: &DeviceSpecInput) -> Result<DeviceType, FastApiError> {
    match spec.device_type.as_ref() {
        None => Ok(DeviceType::Local),
        Some(Value::String(value)) => DeviceType::parse(value).ok_or_else(unhandled),
        Some(_) => Err(unhandled()),
    }
}

/// `task_store.list_by_ids` for the payload's reported ids. The source skips
/// the read for an empty list.
async fn running_task_count(
    state: &AppState,
    user_id: i64,
    online: Option<&OnlineState>,
) -> Result<usize, FastApiError> {
    let Some(online) = online else {
        return Ok(0);
    };
    let task_ids = online.running_task_ids();
    if task_ids.is_empty() {
        return Ok(0);
    }
    list_running_tasks(&*state.task_store, user_id, task_ids)
        .await
        .map(|tasks| tasks.len())
        .map_err(|error| mysql_failure(error, "running task lookup failed"))
}

/// `DeviceNamespace.emit_upgrade_command`: serialize the parameters with
/// CPython's `json.dumps` defaults and `PUBLISH` the `device:upgrade` emit to
/// the target socket's room.
async fn publish_upgrade_command(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    socket_id: &str,
    request: &DeviceUpgradeRequest,
) -> Result<(), FastApiError> {
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!(user_id, device_id, "device upgrade: no Redis service");
        return Err(emit_failed());
    };
    let message = upgrade_message(socket_id, request);
    match redis.publish(SOCKETIO_CHANNEL, message).await {
        Ok(_) => Ok(()),
        Err(error) => {
            tracing::error!(%error, user_id, device_id, "device upgrade: emit failed");
            Err(emit_failed())
        }
    }
}

/// The serialized `AsyncPubSubManager.emit` message for one upgrade command.
fn upgrade_message(socket_id: &str, request: &DeviceUpgradeRequest) -> String {
    let params = serde_json::json!({
        "force": request.force,
        "auto_confirm": request.auto_confirm,
        "verbose": request.verbose,
        "force_stop_tasks": request.force_stop_tasks,
        "registry": request.registry,
        "registry_token": request.registry_token,
    });
    let data = crate::internal_callback::py_json::python_dumps(&Value::Array(vec![params]));
    emit_message(UPGRADE_EVENT, &data, LOCAL_EXECUTOR_NAMESPACE, socket_id)
}

/// `HTTPException(500, detail="Failed to trigger upgrade: 500: Failed to
/// send upgrade command to device")`.
fn emit_failed() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        TRIGGER_FAILED_DETAIL,
    )
}

/// `python_exception_handler`'s unhandled-exception body.
fn unhandled() -> FastApiError {
    FastApiError::unhandled()
}

/// A database failure reaches the application's unhandled handler.
fn mysql_failure(error: MysqlError, context: &'static str) -> FastApiError {
    tracing::error!(%error, "{context}");
    unhandled()
}

/// `CloudDeviceProvider.get_status` / `RemoteDeviceProvider.get_status`:
/// `Kind.name` is filtered before `is_active`, matching the source
/// `filter(Kind.user_id, Kind.kind, Kind.namespace, Kind.name,
/// Kind.is_active).first()` rendering.
const KINDS_DEVICE_BY_NAME_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at FROM kinds \
     WHERE kinds.user_id = ? AND kinds.kind = 'Device' \
     AND kinds.namespace = 'default' AND kinds.name = ? \
     AND kinds.is_active = true LIMIT 1";

#[cfg(test)]
mod tests {
    use super::*;

    fn request(body: &str) -> DeviceUpgradeRequest {
        serde_json::from_str(body).expect("request body")
    }

    #[test]
    fn registered_route_keeps_python_ownership() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == "/api/devices/:device_id/upgrade"
                    && rule.methods.iter().any(|method| method == "POST")),
            "POST /api/devices/:device_id/upgrade must remain on Python until cutover"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::POST, "/api/devices/abc/upgrade"));
        assert!(!table.matches(&http::Method::GET, "/api/devices/abc/upgrade"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == "/api/devices/:device_id/upgrade" && route.methods & POST != 0);
        assert!(
            registered,
            "POST /api/devices/:device_id/upgrade must be registered by the router"
        );
    }

    #[test]
    fn absent_members_take_the_pydantic_defaults() {
        let body = request(r#"{"auto_confirm": true}"#);
        assert!(!body.force);
        assert!(body.auto_confirm);
        assert!(!body.verbose);
        assert!(!body.force_stop_tasks);
        assert!(body.registry.is_none());
        assert!(body.registry_token.is_none());

        // An empty object leaves `auto_confirm` at its `True` default.
        let body = request("{}");
        assert!(body.auto_confirm);
    }

    #[test]
    fn upgrade_message_matches_the_source_socketio_emit_shape() {
        let body = request(r#"{"auto_confirm": true}"#);
        let message = upgrade_message("socket-room", &body);
        let prefix = "{\"method\": \"emit\", \"event\": \"device:upgrade\", \"data\": \
             [{\"force\": false, \"auto_confirm\": true, \"verbose\": false, \
             \"force_stop_tasks\": false, \"registry\": null, \"registry_token\": null}], \
             \"binary\": false, \"namespace\": \"/local-executor\", \
             \"room\": \"socket-room\", \"skip_sid\": null, \"callback\": null, \
             \"host_id\": \"";
        assert!(message.starts_with(prefix), "{message}");
        let host = message
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix("\"}"))
            .expect("host_id suffix");
        assert_eq!(host.len(), 32);
    }

    #[test]
    fn upgrade_message_serializes_supplied_registry_options() {
        let body = request(
            r#"{"force": true, "auto_confirm": false, "verbose": true,
                "force_stop_tasks": true, "registry": "harbor.example.com"}"#,
        );
        let message = upgrade_message("sid", &body);
        assert!(
            message.contains(
                "\"data\": [{\"force\": true, \"auto_confirm\": false, \"verbose\": true, \
                 \"force_stop_tasks\": true, \"registry\": \"harbor.example.com\", \
                 \"registry_token\": null}]"
            ),
            "{message}"
        );
    }

    #[test]
    fn response_body_matches_the_source_field_order() {
        let body = serde_json::to_string(&DeviceUpgradeResponse {
            success: true,
            message: UPGRADE_SENT_MESSAGE,
        })
        .unwrap();
        assert_eq!(
            body,
            r#"{"success":true,"message":"Upgrade command sent to device"}"#
        );
    }

    #[test]
    fn device_type_parsing_matches_the_enum_contract() {
        assert_eq!(DeviceType::parse("cloud"), Some(DeviceType::Cloud));
        assert_eq!(DeviceType::parse("app"), Some(DeviceType::App));
        assert_eq!(DeviceType::parse("local"), Some(DeviceType::Local));
        assert_eq!(DeviceType::parse("remote"), Some(DeviceType::Remote));
        assert_eq!(DeviceType::parse("CLOUD"), None);
        assert_eq!(DeviceType::parse(""), None);
    }

    fn row(json: Value) -> DeviceKindRow {
        DeviceKindRow {
            id: 260081,
            name: "device-a".to_string(),
            json,
        }
    }

    #[test]
    fn provider_type_defaults_to_local_and_rejects_unknown_values() {
        let spec = serde_json::json!({"spec": {}});
        assert_eq!(
            provider_type(&row(spec)).expect("default type"),
            DeviceType::Local
        );
        let spec = serde_json::json!({"spec": {"deviceType": "cloud"}});
        assert_eq!(
            provider_type(&row(spec)).expect("cloud type"),
            DeviceType::Cloud
        );
        let spec = serde_json::json!({"spec": {"deviceType": "tablet"}});
        assert!(provider_type(&row(spec)).is_err());
        let spec = serde_json::json!({"spec": {"deviceType": null}});
        assert!(provider_type(&row(spec)).is_err());
        let spec = serde_json::json!({"spec": null});
        assert!(provider_type(&row(spec)).is_err());
    }

    #[test]
    fn cloud_route_id_prefers_spec_then_cloud_config_then_name() {
        let spec: DeviceSpecInput =
            serde_json::from_value(serde_json::json!({"deviceId": "runtime-a"})).unwrap();
        assert_eq!(spec.cloud_route_id("name").unwrap(), "runtime-a");

        let spec: DeviceSpecInput = serde_json::from_value(serde_json::json!({
            "deviceId": "",
            "cloudConfig": {"deviceId": "config-b"}
        }))
        .unwrap();
        assert_eq!(spec.cloud_route_id("name").unwrap(), "config-b");

        let spec: DeviceSpecInput = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(spec.cloud_route_id("name").unwrap(), "name");
    }

    #[test]
    fn matching_online_info_rejects_a_mismatched_runtime_instance() {
        let spec: DeviceSpecInput =
            serde_json::from_value(serde_json::json!({"runtimeInstanceId": "one"})).unwrap();
        let matching: OnlineState =
            serde_json::from_value(serde_json::json!({"runtime_instance_id": "one"})).unwrap();
        assert!(spec.matching_online_info(Some(matching)).is_some());

        let other: OnlineState =
            serde_json::from_value(serde_json::json!({"runtime_instance_id": "two"})).unwrap();
        assert!(spec.matching_online_info(Some(other)).is_none());

        // No persisted instance: an unpinned local device still matches, an
        // app device does not.
        let spec: DeviceSpecInput = serde_json::from_value(serde_json::json!({})).unwrap();
        let observed: OnlineState =
            serde_json::from_value(serde_json::json!({"runtime_instance_id": "two"})).unwrap();
        assert!(spec.matching_online_info(Some(observed)).is_some());
        let app: DeviceSpecInput =
            serde_json::from_value(serde_json::json!({"deviceType": "app"})).unwrap();
        let observed: OnlineState =
            serde_json::from_value(serde_json::json!({"runtime_instance_id": "two"})).unwrap();
        assert!(app.matching_online_info(Some(observed)).is_none());
    }

    #[test]
    fn by_name_query_keeps_the_source_filter_order() {
        // Recorded `CloudDeviceProvider.get_status` statement: the name filter
        // precedes `is_active`, and the provider selects a single row.
        assert!(
            KINDS_DEVICE_BY_NAME_QUERY
                .ends_with("AND kinds.name = ? AND kinds.is_active = true LIMIT 1"),
            "{KINDS_DEVICE_BY_NAME_QUERY}"
        );
        assert!(KINDS_DEVICE_BY_NAME_QUERY.contains("kinds.namespace = 'default'"));
    }

    #[test]
    fn failure_details_match_the_source_messages() {
        let emit = emit_failed();
        assert_eq!(
            emit.status(),
            brz_http_server::StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            emit.validation_detail(),
            r#""Failed to trigger upgrade: 500: Failed to send upgrade command to device""#
        );
    }
}
