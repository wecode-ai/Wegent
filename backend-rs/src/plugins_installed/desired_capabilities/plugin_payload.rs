// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! One shared projection for pooled and transaction-local plugin payloads.
use super::{
    BuildError, InstalledKindRow, PluginReleaseRow, cloud_plugin_id, json_truthy, object_or_empty,
    plugin_payload_name, presign_download, value_or_name,
};
use serde_json::{Map, Value};

pub(super) fn release_id(installed: &InstalledKindRow, override_id: Option<i64>) -> Option<i64> {
    let json = installed.json.0.to_value();
    let spec = object_or_empty(json.get("spec"));
    if object_or_empty(spec.get("packageRef")).is_empty() {
        return None;
    }
    override_id.or_else(|| spec.get("releaseId").and_then(Value::as_i64))
}

pub(super) fn render(
    installed: &InstalledKindRow,
    release_id_override: Option<i64>,
    local_http: bool,
    release: Option<&PluginReleaseRow>,
) -> Result<Value, BuildError> {
    let json = installed.json.0.to_value();
    let spec = object_or_empty(json.get("spec"));
    let source = object_or_empty(spec.get("source")).clone();
    let package_ref = object_or_empty(spec.get("packageRef")).clone();
    let mut payload = Map::new();
    payload.insert("installed_plugin_id".to_string(), Value::from(installed.id));
    payload.insert(
        "name".to_string(),
        Value::String(plugin_payload_name(installed, &json, &spec, &source)),
    );
    payload.insert(
        "display_name".to_string(),
        value_or_name(spec.get("displayName"), &installed.name),
    );
    payload.insert(
        "description".to_string(),
        spec.get("description")
            .cloned()
            .unwrap_or_else(|| Value::String(String::new())),
    );
    payload.insert(
        "enabled".to_string(),
        spec.get("enabled").cloned().unwrap_or(Value::Bool(true)),
    );
    let marketplace = spec
        .get("marketplace")
        .filter(|value| json_truthy(value))
        .or_else(|| source.get("marketplace").filter(|value| json_truthy(value)))
        .cloned()
        .unwrap_or(Value::Null);
    payload.insert("marketplace".to_string(), marketplace);
    payload.insert(
        "version".to_string(),
        spec.get("version").cloned().unwrap_or(Value::Null),
    );
    // Legacy uploaded/builtin manifests may omit a version. Match the existing
    // installer default explicitly so receipts describe the same package key.
    if local_http && payload["version"].as_str().is_none_or(str::is_empty) {
        payload.insert("version".into(), Value::String("latest".into()));
    }
    if let Some(cloud_plugin_id) = cloud_plugin_id(&spec, &source) {
        payload.insert("cloud_plugin_id".to_string(), Value::from(cloud_plugin_id));
    }
    payload.insert("source".to_string(), Value::Object(source));
    if let Some(component_states) = spec
        .get("componentStates")
        .filter(|value| json_truthy(value))
    {
        payload.insert("component_states".to_string(), component_states.clone());
    }
    if let Some(components) = spec.get("components").filter(|value| json_truthy(value)) {
        payload.insert("components".to_string(), components.clone());
    }

    if !package_ref.is_empty() {
        payload.insert(
            "checksum".to_string(),
            package_ref.get("checksum").cloned().unwrap_or(Value::Null),
        );
        let release_id =
            release_id_override.or_else(|| spec.get("releaseId").and_then(Value::as_i64));
        let ready = release
            .as_ref()
            .is_some_and(|release| release.status == "ready" && release.scan_status == "passed");
        if let Some(release) = release.filter(|_| ready) {
            if let Some(_override) = release_id_override {
                payload.insert(
                    "version".to_string(),
                    Value::String(release.version.clone()),
                );
                payload.insert(
                    "checksum".to_string(),
                    Value::String(format!("sha256:{}", release.sha256)),
                );
                let components = release
                    .scan_report_json
                    .0
                    .to_value()
                    .get("components")
                    .filter(|value| json_truthy(value))
                    .cloned();
                if let Some(components) = components {
                    payload.insert("components".to_string(), components);
                }
            }
            let (download_path, expires_at) = if local_http {
                (
                    format!(
                        "/api/plugins/installed/{}/download?expected_release_id={}",
                        installed.id, release.id
                    ),
                    String::new(),
                )
            } else {
                presign_download(&release.storage_key)?
            };
            payload.insert("download_path".to_string(), Value::String(download_path));
            payload.insert(
                "download_url_expires_at".to_string(),
                Value::String(expires_at),
            );
            payload.insert("release_id".to_string(), Value::from(release.id));
        } else {
            payload.insert(
                "download_path".to_string(),
                Value::String(match (local_http, release_id) {
                    (true, Some(id)) => format!(
                        "/api/plugins/installed/{}/download?expected_release_id={id}",
                        installed.id
                    ),
                    _ => format!("/api/plugins/installed/{}/download", installed.id),
                }),
            );
        }
    }
    Ok(Value::Object(payload))
}
