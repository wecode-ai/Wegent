// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Cloud device `runtime_features` projection for `GET /api/devices`.
//!
//! Mirrors `wecode.service.cloud_device_provider.CloudDeviceProvider.
//! _project_runtime_features`: the internal cloud store reports the cached
//! Runtime feature document of the sandbox, raises its `schemaVersion` to the
//! internal contract so a client can decode the appended member, and
//! advertises the RFB desktop capability while the sandbox route is online.
//! `desktop` itself is the registered extension contract of
//! `wecode.schemas.vnc`, which the endpoint's `DeviceInfo` model keeps only
//! for a registered member.

use serde_json::{Map, Value, value::RawValue};
use wegent_backend_rs::devices::{
    CloudRuntimeFeatures, DeviceSpecInput, OnlineStateInput, RuntimeFeatures,
};

/// `max(schemaVersion, 4)`: the feature-document version the internal cloud
/// Runtime contract is decoded at.
const CLOUD_SCHEMA_VERSION: i64 = 4;

/// The registered extension member name (`wecode.schemas.vnc`).
const DESKTOP_FEATURE: &str = "desktop";

/// The clipboard mode the internal desktop contract advertises.
const DESKTOP_CLIPBOARD: &str = "text";

/// `CloudDeviceProvider._project_runtime_features`.
pub(crate) struct CloudDeviceRuntimeFeatures {
    /// `CloudDeviceProvider.is_configured()`: the Nevis client owns a base
    /// URL, an image id, and a token, so the deployment can reach a sandbox.
    desktop_available: bool,
}

impl CloudDeviceRuntimeFeatures {
    pub(crate) fn new(desktop_available: bool) -> Self {
        Self { desktop_available }
    }
}

impl CloudRuntimeFeatures for CloudDeviceRuntimeFeatures {
    fn project(
        &self,
        spec: &DeviceSpecInput,
        online: Option<&OnlineStateInput>,
    ) -> Option<RuntimeFeatures> {
        let mut features = stored_features(online);
        let schema_version = features
            .get("schemaVersion")
            .map_or(0, stored_schema_version)
            .max(CLOUD_SCHEMA_VERSION);
        features.insert("schemaVersion".to_string(), Value::from(schema_version));
        // The desktop capability follows the sandbox route: an offline device
        // or a CRD without a sandbox never advertises it.
        if online.is_some() && self.desktop_available && has_sandbox_id(spec) {
            features.insert(DESKTOP_FEATURE.to_string(), desktop_feature());
        } else {
            features.remove(DESKTOP_FEATURE);
        }
        Some(project_features(features))
    }
}

/// The stored feature document of one online payload
/// (`dict(raw_features) if isinstance(raw_features, dict) else {}`).
fn stored_features(online: Option<&OnlineStateInput>) -> Map<String, Value> {
    online
        .and_then(|state| state.runtime_features.as_ref())
        .and_then(|features| serde_json::to_value(features).ok())
        .and_then(|value| match value {
            Value::Object(features) => Some(features),
            _ => None,
        })
        .unwrap_or_default()
}

/// `int(features.get("schemaVersion") or 0)`: a value Python cannot convert to
/// an integer counts as zero.
fn stored_schema_version(value: &Value) -> i64 {
    match value {
        Value::Bool(flag) => i64::from(*flag),
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|float| float as i64))
            .unwrap_or(0),
        Value::String(text) => text.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// `str(cloud_config.get("sandboxId") or "").strip()`: the sandbox id only
/// gates the desktop member, so its truthiness is what the projection reads.
fn has_sandbox_id(spec: &DeviceSpecInput) -> bool {
    let Some(cloud_config) = spec
        .cloud_config
        .as_ref()
        .and_then(|config| serde_json::to_value(config).ok())
    else {
        return false;
    };
    match cloud_config.get("sandboxId") {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|value| value != 0.0),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(members)) => !members.is_empty(),
        _ => false,
    }
}

/// The `desktop` member the internal contract advertises
/// (`wecode.schemas.vnc.RuntimeDesktopFeatures`).
fn desktop_feature() -> Value {
    Value::Object(Map::from_iter([
        ("version".to_string(), Value::from(1)),
        ("available".to_string(), Value::Bool(true)),
        ("protocol".to_string(), Value::from("rfb")),
        ("transport".to_string(), Value::from("websocket")),
        ("clipboard".to_string(), Value::from(DESKTOP_CLIPBOARD)),
    ]))
}

/// The endpoint's `DeviceInfo` re-validation of the projected document: the
/// known members keep the stored value, the registered extension members
/// survive, and every other stored member is dropped
/// (`RuntimeFeatures.normalize_extensions`).
fn project_features(mut features: Map<String, Value>) -> RuntimeFeatures {
    let runtime_task_create = features.remove("runtimeTaskCreate").map(raw_value);
    let interactive_sessions = features.remove("interactiveSessions").map(raw_value);
    let worktrees = features.remove("worktrees").map(raw_value);
    let mut extensions = Map::new();
    if let Some(desktop) = features.remove(DESKTOP_FEATURE) {
        extensions.insert(DESKTOP_FEATURE.to_string(), desktop);
    }
    RuntimeFeatures {
        schema_version: features
            .get("schemaVersion")
            .and_then(Value::as_i64)
            .unwrap_or(1),
        runtime_task_create,
        interactive_sessions,
        worktrees,
        extensions,
    }
}

/// Keep one stored member as its original JSON text.
fn raw_value(value: Value) -> Box<RawValue> {
    serde_json::value::to_raw_value(&value).expect("JSON value serializes")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(cloud_config: Value) -> DeviceSpecInput {
        serde_json::from_value(serde_json::json!({"cloudConfig": cloud_config}))
            .expect("spec decodes")
    }

    fn online(runtime_features: Value) -> OnlineStateInput {
        serde_json::from_value(serde_json::json!({"runtime_features": runtime_features}))
            .expect("online state decodes")
    }

    fn projected(spec: &DeviceSpecInput, online: Option<&OnlineStateInput>) -> Value {
        let features = CloudDeviceRuntimeFeatures::new(true)
            .project(spec, online)
            .expect("the cloud store always projects features");
        serde_json::to_value(features).expect("features serialize")
    }

    fn desktop() -> Value {
        serde_json::json!({
            "version": 1,
            "available": true,
            "protocol": "rfb",
            "transport": "websocket",
            "clipboard": "text",
        })
    }

    #[test]
    fn online_sandbox_advertises_the_desktop_capability() {
        let spec = spec(serde_json::json!({"sandboxId": "sandbox-1"}));
        let online = online(serde_json::json!({"schemaVersion": 3}));
        assert_eq!(
            projected(&spec, Some(&online)),
            serde_json::json!({
                "schemaVersion": 4,
                "runtimeTaskCreate": null,
                "interactiveSessions": null,
                "worktrees": null,
                "desktop": desktop(),
            })
        );
    }

    #[test]
    fn offline_device_raises_the_schema_version_without_the_desktop() {
        let spec = spec(serde_json::json!({"sandboxId": "sandbox-1"}));
        assert_eq!(
            projected(&spec, None),
            serde_json::json!({
                "schemaVersion": 4,
                "runtimeTaskCreate": null,
                "interactiveSessions": null,
                "worktrees": null,
            })
        );
    }

    #[test]
    fn missing_sandbox_keeps_the_device_offline_only_features() {
        let spec = spec(serde_json::json!({}));
        let online = online(serde_json::json!(null));
        assert_eq!(
            projected(&spec, Some(&online)),
            serde_json::json!({
                "schemaVersion": 4,
                "runtimeTaskCreate": null,
                "interactiveSessions": null,
                "worktrees": null,
            })
        );
    }

    #[test]
    fn an_unconfigured_deployment_never_advertises_the_desktop() {
        let spec = spec(serde_json::json!({"sandboxId": "sandbox-1"}));
        let online = online(serde_json::json!({"schemaVersion": 2}));
        let features = CloudDeviceRuntimeFeatures::new(false)
            .project(&spec, Some(&online))
            .expect("the cloud store always projects features");
        let value = serde_json::to_value(features).expect("features serialize");
        assert_eq!(value["schemaVersion"], 4);
        assert_eq!(value.get("desktop"), None);
    }

    #[test]
    fn stored_members_round_trip_and_unknown_members_are_dropped() {
        let spec = spec(serde_json::json!({"sandboxId": "sandbox-1"}));
        let online = online(serde_json::json!({
            "schemaVersion": 5,
            "runtimeTaskCreate": {"schemaVersions": [1, 2]},
            "interactiveSessions": {"codeServer": true, "terminal": true},
            "worktrees": {"version": 1, "managed": true},
            "desktop": {"protocol": "http"},
            "unknown": true,
        }));
        assert_eq!(
            projected(&spec, Some(&online)),
            serde_json::json!({
                "schemaVersion": 5,
                "runtimeTaskCreate": {"schemaVersions": [1, 2]},
                "interactiveSessions": {"codeServer": true, "terminal": true},
                "worktrees": {"version": 1, "managed": true},
                "desktop": desktop(),
            })
        );
    }

    #[test]
    fn stored_schema_version_matches_the_python_conversion() {
        for (stored, expected) in [
            (serde_json::json!("3"), 3),
            (serde_json::json!(" 6 "), 6),
            (serde_json::json!(2), 2),
            (serde_json::json!(2.7), 2),
            (serde_json::json!(true), 1),
            (serde_json::json!("invalid"), 0),
            (serde_json::json!("2.7"), 0),
            (serde_json::json!({"version": 1}), 0),
            (serde_json::json!(null), 0),
        ] {
            assert_eq!(stored_schema_version(&stored), expected, "{stored}");
        }
    }
}
