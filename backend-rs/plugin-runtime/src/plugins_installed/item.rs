// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Stored `kinds` payload normalization for `GET /api/plugins/installed`.
//!
//! Source `installed_plugin_service._kind_to_installed_plugin` passes the
//! stored JSON through pydantic `InstalledPlugin.model_validate`, which drops
//! unknown fields, injects `metadata.labels.id`, and materializes every model
//! default. These helpers reproduce the resulting model shape.

use super::KindRow;
use serde_json::{Map, Value};

/// Convert one kinds row to the API item exactly like
/// `_kind_to_installed_plugin` plus `InstalledPlugin.model_validate`.
///
/// The stored payload is passed through pydantic, which:
/// - injects `metadata.labels.id` from the row id;
/// - fills every `InstalledPluginSpec` model default (`spec.author`,
///   `spec.version`, `spec.pluginId`, `spec.releaseId`,
///   `spec.desiredVersion`, `spec.packageRef`, `spec.sourcePayload`,
///   `spec.interface` as explicit null plus the defaulted scalars) and
///   normalizes `spec.source`, `spec.components`, and `spec.interface`
///   into their model shapes; and
/// - validates `status` through `InstalledPluginStatus`, defaulting a
///   missing `status` to `{"state": "Available", "devices": []}` and
///   filling either member when the stored object omits it.
pub fn kind_to_item(row: &KindRow) -> Option<Value> {
    let mut payload = row.json.as_object()?.clone();
    let metadata = payload
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let metadata_map = metadata.as_object_mut()?;
    let labels = metadata_map
        .entry("labels".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Some(labels_map) = labels.as_object_mut() {
        labels_map.insert("id".to_string(), Value::String(row.id.to_string()));
    }
    payload
        .entry("apiVersion".to_string())
        .or_insert_with(|| Value::String("agent.wecode.io/v1".to_string()));
    payload
        .entry("kind".to_string())
        .or_insert_with(|| Value::String("InstalledPlugin".to_string()));
    normalize_spec(payload.get_mut("spec")?)?;
    normalize_status(&mut payload);
    Some(Value::Object(payload))
}

/// Normalize `status` into the `InstalledPluginStatus` model shape.
///
/// Pydantic emits every model field: a missing `status` becomes the
/// `InstalledPluginStatus()` default, and a stored `{"state": "Available"}`
/// gains `devices: []` (observed for upload-sourced plugins whose device
/// installation rows were never created).
fn normalize_status(payload: &mut Map<String, Value>) {
    let status = payload
        .entry("status".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !status.is_object() {
        *status = Value::Object(Map::new());
    }
    let status = status.as_object_mut().expect("checked object");
    status
        .entry("state".to_string())
        .or_insert_with(|| Value::String("Available".to_string()));
    status
        .entry("devices".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
}

/// Normalize `spec` into the `InstalledPluginSpec` model shape.
fn normalize_spec(spec: &mut Value) -> Option<()> {
    let spec_map = spec.as_object_mut()?;
    // Defaulted scalars, maps, and null-optional fields pydantic emits.
    spec_map.entry("author".to_string()).or_insert(Value::Null);
    spec_map.entry("version".to_string()).or_insert(Value::Null);
    spec_map
        .entry("pluginId".to_string())
        .or_insert(Value::Null);
    spec_map
        .entry("releaseId".to_string())
        .or_insert(Value::Null);
    spec_map
        .entry("desiredVersion".to_string())
        .or_insert(Value::Null);
    spec_map
        .entry("packageRef".to_string())
        .or_insert(Value::Null);
    spec_map
        .entry("sourcePayload".to_string())
        .or_insert(Value::Null);
    spec_map
        .entry("description".to_string())
        .or_insert_with(|| Value::String(String::new()));
    spec_map
        .entry("componentStates".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    spec_map
        .entry("manifest".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    spec_map
        .entry("installState".to_string())
        .or_insert_with(|| Value::String("installed".to_string()));
    spec_map
        .entry("enabled".to_string())
        .or_insert_with(|| Value::from(true));
    spec_map
        .entry("updatePolicy".to_string())
        .or_insert_with(|| Value::String("manual".to_string()));
    spec_map
        .entry("sourceProvider".to_string())
        .or_insert_with(|| Value::String("wegent".to_string()));
    spec_map
        .entry("sourceLabel".to_string())
        .or_insert_with(|| Value::String("Wegent 官方".to_string()));
    spec_map
        .entry("visibility".to_string())
        .or_insert_with(|| Value::String("workspace".to_string()));
    spec_map
        .entry("origin".to_string())
        .or_insert_with(|| Value::String("market".to_string()));
    normalize_source(spec_map.get_mut("source")?);
    normalize_components(spec_map);
    normalize_interface(spec_map);
    Some(())
}

/// Normalize `spec.source` into the `InstalledPluginSource` model shape.
fn normalize_source(source: &mut Value) {
    if !source.is_object() {
        *source = Value::Object(Map::new());
    }
    let map = source.as_object_mut().expect("checked object");
    map.entry("type".to_string())
        .or_insert_with(|| Value::String("upload".to_string()));
    map.entry("providerKey".to_string())
        .or_insert_with(|| Value::String("codex-local".to_string()));
    map.entry("catalogItemId".to_string())
        .or_insert(Value::Null);
    map.entry("marketplace".to_string()).or_insert(Value::Null);
}

/// Normalize `spec.components` into `InstalledPluginComponents` shape.
fn normalize_components(spec: &mut Map<String, Value>) {
    let entry = spec
        .entry("components".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    let components = entry.as_object_mut().expect("checked object");
    for list_field in [
        "skills",
        "commands",
        "agents",
        "hooks",
        "mcps",
        "connectors",
        "lsps",
        "monitors",
        "bins",
    ] {
        components
            .entry(list_field.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
    }
    components
        .entry("settings".to_string())
        .or_insert(Value::Null);
    components
        .entry("workbench".to_string())
        .or_insert(Value::Null);
    if let Some(connectors) = components
        .get_mut("connectors")
        .and_then(Value::as_array_mut)
    {
        for connector in connectors.iter_mut() {
            normalize_connector(connector);
        }
    }
}

/// Normalize one `spec.components.connectors` entry into the
/// `PluginConnectorComponent` model shape.
fn normalize_connector(connector: &mut Value) {
    if !connector.is_object() {
        return;
    }
    let map = connector.as_object_mut().expect("checked object");
    map.entry("authPolicy".to_string())
        .or_insert_with(|| Value::String("optional".to_string()));
    match map.get_mut("localAuth") {
        Some(local_auth) if local_auth.is_object() => {
            normalize_local_auth(local_auth);
        }
        _ => {}
    }
}

/// Normalize `localAuth` into the `PluginLocalAuthDefinition` model shape.
///
/// Missing fields are defaulted by pydantic on validation, so the API
/// response always carries them (e.g. `tool: null`, `okValues: ["ok"]`).
fn normalize_local_auth(local_auth: &mut Value) {
    let map = local_auth.as_object_mut().expect("checked object");
    map.entry("kind".to_string())
        .or_insert_with(|| Value::String("local_qr".to_string()));
    for field in ["health", "start", "poll", "logout"] {
        map.entry(field.to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
    }
    map.entry("tool".to_string()).or_insert(Value::Null);
    map.entry("qrField".to_string())
        .or_insert_with(|| Value::String("qr_path".to_string()));
    map.entry("statusField".to_string())
        .or_insert_with(|| Value::String("status".to_string()));
    map.entry("okValues".to_string())
        .or_insert_with(|| Value::Array(vec![Value::String("ok".to_string())]));
    map.entry("pollIntervalSeconds".to_string())
        .or_insert_with(|| Value::from(2));
    map.entry("timeoutSeconds".to_string())
        .or_insert_with(|| Value::from(45));
    map.entry("logoutOnUninstall".to_string())
        .or_insert_with(|| Value::from(true));
    if let Some(tool) = map.get_mut("tool") {
        normalize_local_auth_tool(tool);
    }
}

/// Normalize `localAuth.tool` into the `PluginLocalAuthToolDefinition`
/// model shape when present.
fn normalize_local_auth_tool(tool: &mut Value) {
    if !tool.is_object() {
        return;
    }
    let map = tool.as_object_mut().expect("checked object");
    map.entry("version".to_string()).or_insert(Value::Null);
    map.entry("artifacts".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
}

/// Normalize `spec.interface` into `PluginInterface` shape.
///
/// A missing key becomes an explicit null like the `Optional[PluginInterface]`
/// default; a stored null stays null.
fn normalize_interface(spec: &mut Map<String, Value>) {
    let interface = spec.entry("interface".to_string()).or_insert(Value::Null);
    if interface.is_null() {
        return;
    }
    if !interface.is_object() {
        *interface = Value::Object(Map::new());
    }
    let interface = interface.as_object_mut().expect("checked object");
    for field in [
        "displayName",
        "shortDescription",
        "longDescription",
        "developerName",
        "category",
        "websiteUrl",
        "privacyPolicyUrl",
        "termsOfServiceUrl",
        "defaultPrompt",
        "brandColor",
        "composerIcon",
        "logo",
        "logoDark",
    ] {
        interface.entry(field.to_string()).or_insert(Value::Null);
    }
    interface
        .entry("capabilities".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    interface
        .entry("screenshots".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_row(id: i64, spec: Value, status: Value) -> KindRow {
        KindRow {
            id,
            json: serde_json::json!({
                "apiVersion": "agent.example.io/v1",
                "kind": "InstalledPlugin",
                "metadata": {"name": "p", "namespace": "default"},
                "spec": spec,
                "status": status,
            }),
        }
    }

    #[test]
    fn kind_conversion_injects_id_and_defaults() {
        let row = kind_row(
            273373,
            serde_json::json!({
                "source": {"type": "marketplace", "pluginKey": "k", "catalogItemId": "18"},
                "displayName": "d",
                "interface": {"displayName": "d"},
            }),
            serde_json::json!({"state": "PendingSync"}),
        );
        let item = kind_to_item(&row).expect("conversion");
        assert_eq!(item["metadata"]["labels"]["id"].as_str(), Some("273373"));
        // A stored value is preserved; the default only fills a missing key.
        assert_eq!(item["apiVersion"], "agent.example.io/v1");
        assert_eq!(item["kind"], "InstalledPlugin");
        let spec = &item["spec"];
        assert_eq!(spec["author"], Value::Null);
        assert_eq!(spec["version"], Value::Null);
        assert_eq!(spec["pluginId"], Value::Null);
        assert_eq!(spec["releaseId"], Value::Null);
        assert_eq!(spec["desiredVersion"], Value::Null);
        assert_eq!(spec["packageRef"], Value::Null);
        assert_eq!(spec["sourcePayload"], Value::Null);
        assert_eq!(spec["description"], "");
        assert_eq!(spec["componentStates"], serde_json::json!({}));
        assert_eq!(spec["manifest"], serde_json::json!({}));
        assert_eq!(spec["installState"], "installed");
        assert_eq!(spec["enabled"], true);
        assert_eq!(spec["updatePolicy"], "manual");
        assert_eq!(spec["sourceProvider"], "wegent");
        assert_eq!(spec["sourceLabel"], "Wegent 官方");
        assert_eq!(spec["visibility"], "workspace");
        assert_eq!(spec["origin"], "market");
        assert!(spec["components"]["skills"].is_array());
        assert_eq!(spec["components"]["settings"], Value::Null);
        let interface = &spec["interface"];
        assert_eq!(interface["websiteUrl"], Value::Null);
        assert_eq!(interface["screenshots"], serde_json::json!([]));
        assert_eq!(item["status"]["state"], "PendingSync");
        assert_eq!(item["status"]["devices"], serde_json::json!([]));
    }

    #[test]
    fn missing_optional_spec_fields_become_explicit_null() {
        // Stored shape of an upload-sourced plugin whose device installation
        // rows were never created (the recorded nonpassing case).
        let row = kind_row(
            254688,
            serde_json::json!({
                "source": {"type": "upload", "providerKey": "claude-code", "pluginKey": "superpowers"},
                "displayName": "superpowers",
                "description": "d",
                "version": "5.0.7",
                "author": "Jesse Vincent <jesse@fsck.com>",
                "installState": "installed",
                "enabled": true,
                "componentStates": {},
                "manifest": {},
                "components": {},
                "packageRef": {"storageKey": "k", "checksum": "c", "sizeBytes": 1},
                "sourcePayload": {"filename": "superpowers.zip"},
            }),
            serde_json::json!({"state": "Available"}),
        );
        let item = kind_to_item(&row).expect("conversion");
        let spec = &item["spec"];
        assert_eq!(spec["interface"], Value::Null);
        assert_eq!(spec["pluginId"], Value::Null);
        assert_eq!(spec["releaseId"], Value::Null);
        assert_eq!(spec["desiredVersion"], Value::Null);
        assert_eq!(item["status"]["state"], "Available");
        assert_eq!(item["status"]["devices"], serde_json::json!([]));
    }

    #[test]
    fn missing_status_is_defaulted() {
        let mut json = serde_json::json!({
            "apiVersion": "agent.wecode.io/v1",
            "kind": "InstalledPlugin",
            "metadata": {"name": "p", "namespace": "default"},
            "spec": {
                "source": {"pluginKey": "k"},
                "displayName": "d",
            },
        });
        let json_object = json.as_object_mut().expect("object");
        json_object.remove("status");
        json_object.remove("apiVersion");
        json_object.remove("kind");
        let row = KindRow { id: 7, json };
        let item = kind_to_item(&row).expect("conversion");
        assert_eq!(item["apiVersion"], "agent.wecode.io/v1");
        assert_eq!(item["kind"], "InstalledPlugin");
        assert_eq!(item["status"]["state"], "Available");
        assert_eq!(item["status"]["devices"], serde_json::json!([]));
    }

    #[test]
    fn connector_local_auth_defaults_are_filled() {
        let row = kind_row(
            1,
            serde_json::json!({
                "source": {"type": "marketplace", "pluginKey": "k"},
                "displayName": "d",
                "components": {"connectors": [{
                    "slug": "example-email",
                    "localAuth": {
                        "kind": "browser_oauth",
                        "start": ["scripts/local-auth.sh", "login"],
                        "health": ["scripts/local-auth.sh", "health"],
                        "logout": ["scripts/local-auth.sh", "logout"],
                        "timeoutSeconds": 420,
                        "logoutOnUninstall": true
                    },
                    "authPolicy": "on_install"
                }]},
            }),
            serde_json::json!({"state": "PendingSync"}),
        );
        let item = kind_to_item(&row).expect("conversion");
        let connector = &item["spec"]["components"]["connectors"][0];
        assert_eq!(connector["authPolicy"], "on_install");
        let local_auth = &connector["localAuth"];
        assert_eq!(local_auth["kind"], "browser_oauth");
        assert_eq!(local_auth["tool"], Value::Null);
        assert_eq!(local_auth["poll"], serde_json::json!([]));
        assert_eq!(local_auth["qrField"], "qr_path");
        assert_eq!(local_auth["statusField"], "status");
        assert_eq!(local_auth["okValues"], serde_json::json!(["ok"]));
        assert_eq!(local_auth["pollIntervalSeconds"], 2);
        assert_eq!(local_auth["timeoutSeconds"], 420);
        assert_eq!(local_auth["logoutOnUninstall"], true);
    }
}
