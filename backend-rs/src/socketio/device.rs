// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `/local-executor` device registration, heartbeat and disconnect behavior.
//!
//! Source: `app/api/ws/device_namespace.py`
//! (`on_device_register`/`_register_device_session`, `on_device_heartbeat`,
//! `on_disconnect`) over `app/services/device_service.py` and
//! `app/services/device/local_provider.py`.
//!
//! Only the behavior the recorded sessions exercise is ported, with the source
//! SQL, payload shapes and error strings:
//!
//! - cloud devices match an existing CRD by `spec.cloudConfig.deviceId`, pin
//!   `runtimeInstanceId`, and update the runtime transfer route;
//! - other device types upsert the CRD by `(user_id, kind='Device', name)`;
//! - registration writes `device:online:<uid>:<route>` (JSON, TTL 90 s) and
//!   publishes `device:online` to `user:<uid>` and `wework:user:<uid>`;
//! - heartbeats pin the registered Runtime instance (mismatch is the source's
//!   `{"error": "Runtime instance ID mismatch"}` ack) and refresh the online
//!   state;
//! - disconnects clear the online state and broadcast `device:offline`.
//!
//! Remaining source behavior that the recordings do not exercise is listed in
//! the migration record rather than approximated here.

use brz_redis::{Redis, RedisResult, SetExpiration, SetOptions};
use serde_json::{Map, Value};

use crate::state::AppState;

pub use super::device_upsert::{match_cloud_device, upsert_device};

/// One active `kinds` Device row (`device_identity::DeviceKindRow` projection).
#[derive(Debug, Clone, brz_mysql::FromMysqlRow)]
pub struct DeviceKindRow {
    #[mysql(rename = "kinds_id")]
    pub id: i64,
    #[mysql(rename = "kinds_name")]
    pub name: String,
    #[mysql(rename = "kinds_json")]
    pub json: Value,
    /// `device.is_active`: `find_registration_device` selects inactive rows too
    /// so a returning installation can reuse (and reactivate) its record.
    #[mysql(rename = "kinds_is_active")]
    pub is_active: i8,
}

/// Device type discriminant (`spec.deviceType`, default `local`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DeviceType {
    Cloud,
    #[default]
    Local,
    App,
    Remote,
}

/// `BindShell` (`spec.bindShell`, default `claudecode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum BindShell {
    #[default]
    Claudecode,
    Openclaw,
}

impl BindShell {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "claudecode" => Some(Self::Claudecode),
            "openclaw" => Some(Self::Openclaw),
            _ => None,
        }
    }

    /// The serialized enum value.
    #[must_use]
    pub fn value(self) -> &'static str {
        match self {
            Self::Claudecode => "claudecode",
            Self::Openclaw => "openclaw",
        }
    }
}

impl DeviceType {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "cloud" => Some(Self::Cloud),
            "local" => Some(Self::Local),
            "app" => Some(Self::App),
            "remote" => Some(Self::Remote),
            _ => None,
        }
    }

    pub(crate) fn value(self) -> &'static str {
        match self {
            Self::Cloud => "cloud",
            Self::Local => "local",
            Self::App => "app",
            Self::Remote => "remote",
        }
    }
}

fn route_id(row: &DeviceKindRow, device_type: DeviceType) -> String {
    match device_type {
        DeviceType::App => format!("app-record-{}", row.id),
        _ => row.name.clone(),
    }
}

/// `EXECUTOR_SESSION_GATEWAY_DEFAULT_PORT`.
const DEFAULT_RUNTIME_TRANSFER_PORT: i64 = 17888;
/// `DEVICE_ONLINE_TTL`.
const ONLINE_TTL_SECONDS: u64 = 90;

/// `_match_cloud_device_sync`'s write of the matched cloud row: it only marks
/// `json` dirty, so `Kind.updated_at`'s ORM `onupdate=func.now()` renders the
/// database clock as `now()`.
pub(super) const UPDATE_DEVICE_JSON_QUERY: &str =
    "UPDATE kinds SET json=?, updated_at=now() WHERE kinds.id = ?";

/// `upsert_device_crd`'s existing-row write: the source assigns
/// `device_kind.updated_at = datetime.now()` before the flush, so the explicit
/// value wins over the ORM `onupdate` and SQLAlchemy binds a client-side local
/// timestamp instead of rendering `now()`.
pub(super) const UPDATE_REGISTERED_DEVICE_QUERY: &str =
    "UPDATE kinds SET json=?, updated_at=? WHERE kinds.id = ?";

/// [`UPDATE_REGISTERED_DEVICE_QUERY`] with the reactivated `is_active` column.
pub(super) const UPDATE_REGISTERED_DEVICE_REACTIVATE_QUERY: &str =
    "UPDATE kinds SET json=?, is_active=1, updated_at=? WHERE kinds.id = ?";

/// One `device:register` payload (`DeviceRegisterPayload`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RegisterPayload {
    pub device_id: String,
    pub name: String,
    pub device_type: DeviceType,
    pub bind_shell: BindShell,
    pub capabilities: Option<Value>,
    pub executor_version: Option<String>,
    pub client_ip: Option<String>,
    pub runtime_transfer_host: Option<String>,
    pub runtime_transfer_port: Option<i64>,
    /// Whether the client sent `runtime_transfer_port` at all
    /// (`model_fields_set` in the source model).
    pub runtime_transfer_port_set: bool,
    pub runtime_instance_id: Option<String>,
    pub app_device_id: Option<String>,
    pub runtime_features: Option<Value>,
}

/// A payload the source's pydantic model rejects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PayloadError(pub String);

impl std::fmt::Display for PayloadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// A registration rejected by the Runtime-instance pin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeInstanceMismatch(pub String);

impl std::fmt::Display for RuntimeInstanceMismatch {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl RegisterPayload {
    /// Parses and validates one `device:register` payload.
    ///
    /// # Errors
    ///
    /// Returns the pydantic-equivalent rejection message.
    pub fn parse(data: &Value) -> Result<Self, PayloadError> {
        let object = data
            .as_object()
            .ok_or_else(|| PayloadError("Invalid payload: value is not an object".into()))?;
        let device_id = required_string(object, "device_id", 100)?;
        let name = required_string(object, "name", 100)?;
        let device_type = match object.get("device_type").and_then(Value::as_str) {
            None => DeviceType::Local,
            Some(value) => DeviceType::parse(value).ok_or_else(|| {
                PayloadError(format!(
                    "Invalid payload: {value} is not a valid device type"
                ))
            })?,
        };
        let bind_shell = match object.get("bind_shell").and_then(Value::as_str) {
            None => BindShell::Claudecode,
            Some(value) => BindShell::parse(value).ok_or_else(|| {
                PayloadError(format!(
                    "Invalid payload: {value} is not a valid bind shell"
                ))
            })?,
        };
        let runtime_transfer_port_set = object.contains_key("runtime_transfer_port");
        Ok(Self {
            device_id,
            name,
            device_type,
            bind_shell,
            capabilities: object.get("capabilities").cloned().filter(|v| !v.is_null()),
            executor_version: optional_string(object, "executor_version", 50)?,
            client_ip: optional_string(object, "client_ip", 50)?,
            runtime_transfer_host: optional_string(object, "runtime_transfer_host", 255)?,
            runtime_transfer_port: match object.get("runtime_transfer_port") {
                None | Some(Value::Null) => None,
                Some(value) => match value.as_i64() {
                    Some(port) if port >= 1 => Some(port),
                    _ => {
                        return Err(PayloadError(
                            "Invalid payload: runtime_transfer_port must be at least 1".into(),
                        ));
                    }
                },
            },
            runtime_transfer_port_set,
            runtime_instance_id: optional_string(object, "runtime_instance_id", 255)?,
            app_device_id: optional_string(object, "app_device_id", 255)?,
            // `_normalize_runtime_features`: the source validates the report
            // through `RuntimeFeatures`, so only declared members reach the
            // online document.
            runtime_features: object
                .get("runtime_features")
                .and_then(super::runtime_features::normalize),
        })
    }

    /// `_registration_runtime_transfer_port`: the reported port or the legacy
    /// executor default when the field is absent.
    ///
    /// An explicitly null field stays `None`, exactly like the source's
    /// `model_fields_set` check.
    #[must_use]
    pub fn effective_transfer_port(&self) -> Option<i64> {
        if self.runtime_transfer_port_set {
            self.runtime_transfer_port
        } else {
            Some(DEFAULT_RUNTIME_TRANSFER_PORT)
        }
    }
}

fn required_string(
    object: &Map<String, Value>,
    field: &str,
    max: usize,
) -> Result<String, PayloadError> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| PayloadError(format!("Invalid payload: {field} is required")))?;
    if value.chars().count() > max {
        return Err(PayloadError(format!(
            "Invalid payload: {field} exceeds {max} characters"
        )));
    }
    Ok(value.to_owned())
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
    max: usize,
) -> Result<Option<String>, PayloadError> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let text = value.as_str().ok_or_else(|| {
                PayloadError(format!("Invalid payload: {field} must be a string"))
            })?;
            if text.chars().count() > max {
                return Err(PayloadError(format!(
                    "Invalid payload: {field} exceeds {max} characters"
                )));
            }
            Ok(Some(text.to_owned()))
        }
    }
}

/// Result of the registration section that precedes the acknowledgement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registered {
    /// Route id used for rooms and the online key (`record_route_id`).
    pub route_id: String,
    /// `execution_target_id` stored on the session.
    pub execution_target_id: String,
    pub display_name: String,
    pub device_type: DeviceType,
}

/// `validate_persistent_runtime_instance_id`.
pub(super) fn validate_runtime_instance(
    device_json: &Value,
    runtime_instance_id: Option<&str>,
    device_id: &str,
) -> Result<(), RuntimeInstanceMismatch> {
    let spec = device_json.get("spec").cloned().unwrap_or_default();
    let persisted = spec.get("runtimeInstanceId").and_then(Value::as_str);
    match persisted {
        Some(persisted) if Some(persisted) != runtime_instance_id => {
            let kind = spec
                .get("deviceType")
                .and_then(Value::as_str)
                .unwrap_or("local");
            Err(RuntimeInstanceMismatch(format!(
                "Runtime instance ID mismatch for persistent {kind} device {device_id}"
            )))
        }
        _ => Ok(()),
    }
}

/// Resolves the registration route and display name for the acknowledgement.
///
/// `cloud_matched` reports a registration that matched an existing cloud CRD
/// (`_match_cloud_device` returned a logical device id). The source skips the
/// CRD upsert for that branch, so `persisted_display_name` is the reported
/// `payload.name` rather than the CRD's `spec.displayName`.
#[must_use]
pub fn registered(
    row: &DeviceKindRow,
    payload: &RegisterPayload,
    cloud_matched: bool,
) -> Registered {
    let route_id = if cloud_matched {
        payload.device_id.clone()
    } else {
        route_id(row, payload.device_type)
    };
    let display_name = if cloud_matched {
        payload.name.clone()
    } else {
        row.json
            .get("spec")
            .and_then(|spec| spec.get("displayName"))
            .and_then(Value::as_str)
            .unwrap_or(&payload.name)
            .to_owned()
    };
    let execution_target_id = if payload.device_type == DeviceType::App {
        route_id.clone()
    } else {
        payload
            .app_device_id
            .clone()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| payload.device_id.clone())
    };
    Registered {
        route_id,
        execution_target_id,
        display_name,
        device_type: payload.device_type,
    }
}

/// `_normalize_runtime_transfer_host`.
#[must_use]
pub fn normalize_runtime_transfer_host(value: Option<&str>) -> Option<String> {
    let candidate = value?.trim();
    if candidate.is_empty() {
        return None;
    }
    let candidate = match candidate.split_once("://") {
        Some((scheme, rest)) if !scheme.is_empty() && !rest.is_empty() => {
            rest.split('/').next().unwrap_or(rest)
        }
        _ if candidate.contains('/') => return None,
        _ => candidate,
    };
    let trimmed = candidate.trim_matches(['[', ']']).trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// The executor-reported runtime-transfer fields carried into the `_set_online`
/// Redis document.
pub struct RuntimeTransfer<'a> {
    pub host: Option<&'a str>,
    pub port: Option<i64>,
    pub instance_id: Option<&'a str>,
    pub features: Option<&'a Value>,
}

/// `_set_online`'s Redis payload.
///
/// `client_ip` is the connection's own peer (`environ["REMOTE_ADDR"]` in the
/// source). The executor-reported `payload.client_ip` is only the
/// `runtimeTransferHost` fallback (`payload.runtime_transfer_host or
/// payload.client_ip`); `spec.clientIp` also stores the observed peer
/// (`session["client_ip"]`), never the reported address.
#[must_use]
pub fn online_payload(
    socket_id: &str,
    name: &str,
    client_ip: Option<&str>,
    payload: &RegisterPayload,
    runtime: &RuntimeTransfer<'_>,
    last_heartbeat: &str,
) -> Value {
    let mut data = Map::new();
    data.insert("socket_id".into(), Value::String(socket_id.into()));
    data.insert("name".into(), Value::String(name.into()));
    data.insert("status".into(), Value::String("online".into()));
    data.insert(
        "last_heartbeat".into(),
        Value::String(last_heartbeat.into()),
    );
    data.insert(
        "executor_version".into(),
        payload
            .executor_version
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    data.insert(
        "client_ip".into(),
        client_ip.map(Value::from).unwrap_or(Value::Null),
    );
    data.insert(
        "runtime_transfer_host".into(),
        runtime
            .host
            .map(|host| Value::String(host.into()))
            .unwrap_or(Value::Null),
    );
    data.insert(
        "runtime_transfer_port".into(),
        runtime.port.map(Value::from).unwrap_or(Value::Null),
    );
    data.insert(
        "runtime_instance_id".into(),
        runtime
            .instance_id
            .map(|value| Value::String(value.into()))
            .unwrap_or(Value::Null),
    );
    data.insert(
        "runtime_features".into(),
        runtime.features.cloned().unwrap_or(Value::Null),
    );
    Value::Object(data)
}

/// Source `cache_manager.set_or_raise` for the device provider caches:
/// `SET key value EX <ttl>`, with the orjson payload as the raw value.
///
/// `Redis::set_ex` would emit `SETEX key seconds value`; the source only ever
/// issues `SET ... EX`, so every device cache write goes through this helper.
///
/// # Errors
///
/// Returns the Redis command or connection error.
pub(crate) async fn set_with_ttl<R>(
    redis: &R,
    key: &str,
    seconds: u64,
    payload: String,
) -> RedisResult<()>
where
    R: Redis + ?Sized,
{
    redis
        .set_with(
            key,
            payload,
            SetOptions::default().with_expiration(SetExpiration::Seconds(seconds)),
        )
        .await
        .map(|_| ())
}

/// Writes the device online state (`cache_manager.set_or_raise` with TTL).
pub async fn set_online(state: &AppState, user_id: i64, route_id: &str, data: &Value) -> bool {
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!(user_id, "device online state unavailable: no Redis service");
        return false;
    };
    let payload = serde_json::to_string(data).expect("a JSON value serializes");
    match set_with_ttl(
        redis,
        crate::device_online_state::online_key(user_id, route_id).as_str(),
        ONLINE_TTL_SECONDS,
        payload,
    )
    .await
    {
        Ok(()) => true,
        Err(error) => {
            tracing::error!(%error, user_id, "device online state write failed");
            false
        }
    }
}

/// `LocalDeviceProvider.update_status`: read the online document, replace
/// `status` and `last_heartbeat`, then rewrite it with the online TTL. A
/// missing document leaves Redis untouched and returns `false`.
pub async fn update_online_status(
    state: &AppState,
    user_id: i64,
    route_id: &str,
    status: &str,
) -> bool {
    let Some(redis) = state.redis.as_ref() else {
        return false;
    };
    let Ok(Some(document)) =
        crate::device_online_state::read_online_state_with(redis, user_id, route_id).await
    else {
        return false;
    };
    let Value::Object(mut data) = document else {
        return false;
    };
    data.insert("status".into(), Value::String(status.into()));
    data.insert("last_heartbeat".into(), Value::String(local_isoformat()));
    redis
        .set_with(
            crate::device_online_state::online_key(user_id, route_id),
            Value::Object(data).to_string(),
            SetOptions::default()
                .with_expiration(SetExpiration::Seconds(ONLINE_TTL_SECONDS))
                .if_present(),
        )
        .await
        .unwrap_or_else(|error| {
            tracing::warn!(%error, user_id, "device status update failed");
            false
        })
}

/// Reads the device online state (`cache_manager.get_or_raise`).
pub async fn get_online(state: &AppState, user_id: i64, route_id: &str) -> Option<Value> {
    crate::devices::cache_manager_get(
        state,
        &crate::device_online_state::online_key(user_id, route_id),
    )
    .await
}

/// Clears the device online state (`set_device_offline`).
///
/// Returns `false` when the `DEL` failed: the source's `delete_or_raise`
/// surfaces that failure to the disconnect handler, which then skips the rest of
/// its cleanup instead of reporting a success it did not have.
pub async fn clear_online(state: &AppState, user_id: i64, route_id: &str) -> bool {
    let Some(redis) = state.redis.as_ref() else {
        return true;
    };
    use brz_redis::Redis as _;
    if let Err(error) = redis
        .del(crate::device_online_state::online_key(user_id, route_id).as_str())
        .await
    {
        tracing::error!(%error, user_id, "device online state delete failed");
        return false;
    }
    true
}

/// `emit_chat_user_event`: publishes one event to both personal chat rooms.
pub async fn publish_chat_user_event(
    state: &AppState,
    user_id: i64,
    event: &str,
    data: &str,
) -> bool {
    let Some(redis) = state.redis.as_ref() else {
        return false;
    };
    use brz_redis::Redis as _;
    let mut delivered = true;
    for room in [format!("user:{user_id}"), format!("wework:user:{user_id}")] {
        let message = crate::socketio_emit::emit_message(event, data, "/chat", &room);
        if let Err(error) = redis
            .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
            .await
        {
            tracing::error!(%error, user_id, event, "Socket.IO adapter publish failed");
            delivered = false;
        }
    }
    delivered
}

/// Serializes the `device:online` payload exactly like `DeviceOnlineEvent`.
#[must_use]
pub fn device_online_event(device_id: &str, name: &str) -> String {
    format!(
        "[{{\"device_id\": {}, \"name\": {}, \"status\": \"online\"}}]",
        json_string(device_id),
        json_string(name)
    )
}

/// Serializes the `device:offline` payload exactly like `DeviceOfflineEvent`.
#[must_use]
pub fn device_offline_event(device_id: &str) -> String {
    format!("[{{\"device_id\": {}}}]", json_string(device_id))
}

/// Python `json.dumps` string quoting for one value.
#[must_use]
pub fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("a string serializes")
}

/// Local wall-clock timestamp in Python's `datetime.isoformat()` shape.
#[must_use]
pub fn local_isoformat() -> String {
    chrono::Local::now()
        .format("%Y-%m-%dT%H:%M:%S%.6f")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads_require_the_source_identity_fields() {
        assert!(RegisterPayload::parse(&serde_json::json!({"name": "n"})).is_err());
        assert!(
            RegisterPayload::parse(&serde_json::json!({"device_id": "", "name": "n"})).is_err()
        );
        let payload = RegisterPayload::parse(&serde_json::json!({
            "device_id": "1ef7c115",
            "name": "executor",
            "device_type": "cloud",
            "executor_version": "2.0.10",
            "runtime_instance_id": "runtime-1",
            "runtime_transfer_host": "192.0.2.1"
        }))
        .unwrap();
        assert_eq!(payload.device_type, DeviceType::Cloud);
        assert_eq!(payload.bind_shell, BindShell::Claudecode);
        assert_eq!(
            payload.effective_transfer_port(),
            Some(DEFAULT_RUNTIME_TRANSFER_PORT)
        );
        let null_port = RegisterPayload::parse(&serde_json::json!({
            "device_id": "d-1",
            "name": "executor",
            "runtime_transfer_port": null
        }))
        .unwrap();
        assert_eq!(null_port.effective_transfer_port(), None);
    }

    #[test]
    fn runtime_transfer_hosts_are_normalized_like_the_source() {
        assert_eq!(
            normalize_runtime_transfer_host(Some(" 192.0.2.1 ")),
            Some("192.0.2.1".into())
        );
        assert_eq!(
            normalize_runtime_transfer_host(Some("http://192.0.2.1:17888/x")),
            Some("192.0.2.1:17888".into())
        );
        assert_eq!(normalize_runtime_transfer_host(Some("a/b")), None);
        assert_eq!(normalize_runtime_transfer_host(Some("   ")), None);
    }

    #[test]
    fn online_payload_matches_the_recorded_redis_value() {
        // The recorded register payload reports its own `client_ip`, while the
        // recorded Redis document keeps the connection peer; only the peer
        // reaches `_set_online`'s payload.
        let payload = RegisterPayload::parse(&serde_json::json!({
            "device_id": "1ef7c115-6a03-4873-8d11-22ae8f37e242",
            "name": "liyong5-executor",
            "device_type": "cloud",
            "executor_version": "2.0.10",
            "client_ip": "192.0.2.177"
        }))
        .unwrap();
        assert_eq!(payload.client_ip.as_deref(), Some("192.0.2.177"));
        let value = online_payload(
            "gac-GvHkXYLzlJDLAAAT",
            "liyong5-executor",
            Some("127.0.0.1"),
            &payload,
            &RuntimeTransfer {
                host: Some("192.0.2.1"),
                port: None,
                instance_id: Some("runtime-1"),
                features: None,
            },
            "2026-10-25T16:23:40.274869",
        );
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            "{\"socket_id\":\"gac-GvHkXYLzlJDLAAAT\",\"name\":\"liyong5-executor\",\
             \"status\":\"online\",\"last_heartbeat\":\"2026-10-25T16:23:40.274869\",\
             \"executor_version\":\"2.0.10\",\"client_ip\":\"127.0.0.1\",\
             \"runtime_transfer_host\":\"192.0.2.1\",\"runtime_transfer_port\":null,\
             \"runtime_instance_id\":\"runtime-1\",\"runtime_features\":null}"
        );
        assert_eq!(
            value["client_ip"],
            Value::String("127.0.0.1".into()),
            "the executor-reported client_ip must not reach the online document"
        );
    }

    #[test]
    fn online_events_keep_python_json_spacing() {
        assert_eq!(
            device_online_event("d-1", "executor"),
            "[{\"device_id\": \"d-1\", \"name\": \"executor\", \"status\": \"online\"}]"
        );
        assert_eq!(device_offline_event("d-1"), "[{\"device_id\": \"d-1\"}]");
    }

    #[test]
    fn runtime_instance_pinning_matches_the_source_message() {
        let json =
            serde_json::json!({"spec": {"deviceType": "cloud", "runtimeInstanceId": "runtime-1"}});
        assert!(validate_runtime_instance(&json, Some("runtime-1"), "sandbox-1").is_ok());
        assert_eq!(
            validate_runtime_instance(&json, None, "sandbox-1")
                .unwrap_err()
                .0,
            "Runtime instance ID mismatch for persistent cloud device sandbox-1"
        );
    }

    /// Records the flat argument list of every command the helper emits.
    #[derive(Default)]
    struct CommandCapture {
        commands: std::sync::Mutex<Vec<(String, Vec<String>)>>,
    }

    impl CommandCapture {
        fn captured(&self) -> Vec<(String, Vec<String>)> {
            self.commands.lock().expect("capture lock").clone()
        }
    }

    impl brz_redis::Redis for CommandCapture {
        async fn command<R>(&self, command: brz_redis::Cmd) -> brz_redis::RedisResult<R>
        where
            R: brz_redis::FromRedisValue + Send,
        {
            let arguments = (1..command.arg_count())
                .filter_map(|index| {
                    command
                        .arg_at(index)
                        .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
                })
                .collect();
            self.commands
                .lock()
                .expect("capture lock")
                .push((command.name().to_string(), arguments));
            R::from_redis_value(&brz_redis::Value::Okay)
        }

        async fn get<K, R>(&self, _key: K) -> brz_redis::RedisResult<Option<R>>
        where
            K: brz_redis::EncodeRedisArg + Send,
            R: brz_redis::FromRedisBulk + Send,
        {
            Ok(None)
        }

        async fn set<K, V>(&self, _key: K, _value: V) -> brz_redis::RedisResult<()>
        where
            K: brz_redis::EncodeRedisArg + Send,
            V: brz_redis::EncodeRedisArg + Send,
        {
            Ok(())
        }

        async fn mget<K, R>(&self, _keys: K) -> brz_redis::RedisResult<Vec<Option<R>>>
        where
            K: brz_redis::EncodeRedisArgs + Send,
            R: brz_redis::FromRedisBulk + Send,
        {
            Ok(Vec::new())
        }

        async fn del_many<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
        where
            K: brz_redis::EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn pfcount<K>(&self, _keys: K) -> brz_redis::RedisResult<i64>
        where
            K: brz_redis::EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn hget<K, F, R>(&self, _key: K, _field: F) -> brz_redis::RedisResult<Option<R>>
        where
            K: brz_redis::EncodeRedisArg + Send,
            F: brz_redis::EncodeRedisArg + Send,
            R: brz_redis::FromRedisBulk + Send,
        {
            Ok(None)
        }

        async fn hmget<K, F, R>(
            &self,
            _key: K,
            _fields: F,
        ) -> brz_redis::RedisResult<brz_redis::RedisValues<R>>
        where
            K: brz_redis::EncodeRedisArg + Send,
            F: brz_redis::EncodeRedisArgs + Send,
            R: brz_redis::FromRedisBulk + Send,
        {
            Err(brz_redis::RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "the capture fake serves no hash reads",
            ))
        }
    }

    #[tokio::test]
    async fn device_cache_writes_use_set_with_ex_not_setex() {
        let redis = CommandCapture::default();
        set_with_ttl(&redis, "device:online:1:d-1", 90, "{}".into())
            .await
            .unwrap();
        assert_eq!(
            redis.captured(),
            vec![(
                "SET".to_string(),
                vec![
                    "device:online:1:d-1".to_string(),
                    "{}".to_string(),
                    "EX".to_string(),
                    "90".to_string(),
                ],
            )]
        );
    }

    fn device_row(display_name: &str) -> DeviceKindRow {
        DeviceKindRow {
            id: 7,
            name: "d-1".into(),
            json: serde_json::json!({"spec": {"displayName": display_name}}),
            is_active: 1,
        }
    }

    fn cloud_payload(name: &str) -> RegisterPayload {
        RegisterPayload::parse(&serde_json::json!({
            "device_id": "d-1",
            "name": name,
            "device_type": "cloud"
        }))
        .unwrap()
    }

    #[test]
    fn cloud_registration_keeps_the_reported_name() {
        // `_register_device_session`'s `is_cloud_device` branch sets the
        // persisted name to `payload.name`, ignoring the CRD display name.
        let mut row = device_row("qingjieyun");
        row.name = "cloud-logical-name".into();
        let payload = cloud_payload("executor-a4b5");
        let registered = registered(&row, &payload, true);
        assert_eq!(registered.display_name, "executor-a4b5");
        assert_eq!(registered.route_id, "d-1");
    }

    #[test]
    fn upserted_registration_uses_the_persisted_display_name() {
        let row = device_row("qingjieyun");
        let payload = cloud_payload("executor-a4b5");
        let registered = registered(&row, &payload, false);
        assert_eq!(registered.display_name, "qingjieyun");
    }
}
