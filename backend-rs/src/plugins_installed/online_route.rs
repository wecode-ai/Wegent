// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `RuntimeRouteResolver.resolve` for the capability-sync dispatchers.
//!
//! Source: `app/services/device/runtime_route.py` (identity resolution, the
//! online document read, the socket-id requirement, and the stale Runtime
//! installation guard). The HTTP sync-device endpoint and the registration
//! follow-up share this resolution so both address the same route.

use serde_json::Value;

use crate::device_identity::DeviceKindRow;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// A resolved, online Runtime route.
pub(crate) struct OnlineRoute {
    /// Record-scoped route the executor registry addresses
    /// (`runtime_route.runtime_device_route_id`).
    pub runtime_device_id: String,
    /// Current socket from the online document.
    pub socket_id: String,
    /// The online document the route was resolved from.
    pub online: Value,
}

/// One route resolution outcome; `Unavailable` carries the source's failure
/// text for the capability-sync dispatchers.
pub(crate) enum OnlineRouteResolution {
    Ready(OnlineRoute),
    Unavailable(&'static str),
}

/// Source `RuntimeRouteResolver.resolve`: owned Device identity, current online
/// document, socket id, and the stale-Runtime-instance guard.
pub(super) async fn resolve_online_route(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<OnlineRouteResolution, FastApiError> {
    let device =
        crate::device_identity::resolve_owned_device_alias(&state.mysql, user_id, device_id)
            .await
            .map_err(|error| {
                tracing::error!(%error, user_id, "runtime route identity read failed");
                FastApiError::unhandled()
            })?;
    let Some(device) = device else {
        return Ok(OnlineRouteResolution::Unavailable(
            "device not found or access denied",
        ));
    };
    let runtime_device_id = runtime_device_route_id(&device);
    if runtime_device_id.is_empty() {
        return Ok(OnlineRouteResolution::Unavailable(
            "device not found or access denied",
        ));
    }
    let online: Option<Value> = crate::devices::cache_manager_get(
        state,
        &format!("device:online:{user_id}:{runtime_device_id}"),
    )
    .await;
    let Some(online) = online.filter(Value::is_object) else {
        return Ok(OnlineRouteResolution::Unavailable("device is offline"));
    };
    let socket_id = online
        .get("socket_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|socket_id| !socket_id.is_empty());
    // The source requires a stored socket id before dispatching, so a document
    // without one is still "device is offline".
    let Some(socket_id) = socket_id else {
        return Ok(OnlineRouteResolution::Unavailable("device is offline"));
    };
    if !runtime_instance_matches(&device, &online) {
        return Ok(OnlineRouteResolution::Unavailable("device is offline"));
    }
    Ok(OnlineRouteResolution::Ready(OnlineRoute {
        runtime_device_id,
        socket_id: socket_id.to_owned(),
        online,
    }))
}

/// Source `supports_plugin_delta`: resolve the route and inspect the advertised
/// plugin-sync protocol.
///
/// A device that advertises `runtime_features.pluginSync.protocolVersion = 2`
/// receives the versioned snapshot; every other device keeps the legacy
/// desired-state payload.
pub(super) async fn negotiated_plugin_sync_version(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Option<i64> {
    match resolve_online_route(state, user_id, device_id).await {
        Ok(OnlineRouteResolution::Ready(route)) => {
            super::plugin_sync_protocol::plugin_sync_version(route.online.get("runtime_features"))
        }
        Ok(OnlineRouteResolution::Unavailable(_)) | Err(_) => None,
    }
}

/// Source `runtime_route.runtime_device_route_id`.
fn runtime_device_route_id(device: &DeviceKindRow) -> String {
    let spec = device.json.get("spec");
    let device_type = spec
        .and_then(|spec| spec.get("deviceType"))
        .and_then(Value::as_str)
        .unwrap_or("local");
    if device_type == "app" {
        return format!("app-record-{}", device.id);
    }
    spec.and_then(|spec| spec.get("deviceId"))
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::trim)
        .map(str::to_string)
        .or_else(|| {
            spec.and_then(|spec| spec.get("cloudConfig"))
                .and_then(|cloud| cloud.get("deviceId"))
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(str::trim)
                .map(str::to_string)
        })
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| device.name.trim().to_string())
}

/// `RuntimeRouteResolver.resolve`'s stale-instance guard.
fn runtime_instance_matches(device: &DeviceKindRow, online: &Value) -> bool {
    let expected = device
        .json
        .get("spec")
        .and_then(|spec| spec.get("runtimeInstanceId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let Some(expected) = expected else {
        return true;
    };
    let reported = online
        .get("runtime_instance_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    !reported.is_empty() && reported == expected
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn device_row(json: Value) -> DeviceKindRow {
        DeviceKindRow {
            id: 7,
            name: "route-name".into(),
            json,
        }
    }

    #[test]
    fn app_routes_use_the_record_scoped_identity() {
        let device = device_row(json!({"spec": {"deviceType": "app"}}));
        assert_eq!(runtime_device_route_id(&device), "app-record-7");
    }

    #[test]
    fn other_routes_prefer_the_reported_device_id() {
        let device = device_row(json!({
            "spec": {"deviceType": "local", "deviceId": " d-1 "}
        }));
        assert_eq!(runtime_device_route_id(&device), "d-1");
        let cloud = device_row(json!({
            "spec": {"deviceType": "cloud", "cloudConfig": {"deviceId": "c-1"}}
        }));
        assert_eq!(runtime_device_route_id(&cloud), "c-1");
    }

    #[test]
    fn the_stale_instance_guard_requires_a_matching_report() {
        let device = device_row(json!({"spec": {"runtimeInstanceId": "runtime-1"}}));
        assert!(runtime_instance_matches(
            &device,
            &json!({"runtime_instance_id": "runtime-1"})
        ));
        assert!(!runtime_instance_matches(
            &device,
            &json!({"runtime_instance_id": "runtime-2"})
        ));
        assert!(!runtime_instance_matches(&device, &json!({})));
        let unpinned = device_row(json!({"spec": {}}));
        assert!(runtime_instance_matches(&unpinned, &json!({})));
    }
}
