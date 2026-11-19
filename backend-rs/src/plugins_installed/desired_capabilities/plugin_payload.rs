// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! One shared projection for pooled and transaction-local plugin payloads.
use super::{
    BuildError, InstalledKindRow, PluginReleaseRow, cloud_plugin_id, json_truthy, object_or_empty,
    plugin_payload_name, presign_download, value_or_name,
};
use serde_json::{Map, Value};

/// Retain only rendered fields and release lookup inputs, not the parsed manifest.
pub(super) struct PreparedPluginPayload {
    payload: Map<String, Value>,
    installed_id: i64,
    has_package: bool,
    release_id: Option<i64>,
    release_override: bool,
    local_http: bool,
}

pub(super) fn prepare(
    installed: &InstalledKindRow,
    json: &Value,
    release_id_override: Option<i64>,
    local_http: bool,
) -> PreparedPluginPayload {
    let empty = Map::new();
    let spec = json
        .get("spec")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let package_ref = spec
        .get("packageRef")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let has_package = !package_ref.is_empty();
    let mut payload = base_payload(installed, json, spec, local_http);
    if has_package {
        payload.insert(
            "checksum".into(),
            package_ref.get("checksum").cloned().unwrap_or(Value::Null),
        );
    }
    PreparedPluginPayload {
        payload,
        installed_id: installed.id,
        has_package,
        release_id: has_package
            .then(|| release_id_override.or_else(|| spec.get("releaseId").and_then(Value::as_i64)))
            .flatten(),
        release_override: release_id_override.is_some(),
        local_http,
    }
}

fn base_payload(
    installed: &InstalledKindRow,
    json: &Value,
    spec: &Map<String, Value>,
    local_http: bool,
) -> Map<String, Value> {
    let source = object_or_empty(spec.get("source"));
    let mut payload = Map::new();
    payload.insert("installed_plugin_id".to_string(), Value::from(installed.id));
    payload.insert(
        "name".to_string(),
        Value::String(plugin_payload_name(installed, json, spec, &source)),
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
    let version = spec.get("version").cloned().unwrap_or(Value::Null);
    // Legacy uploaded/builtin manifests use the installer's default version.
    let version = if local_http && version.as_str().is_none_or(str::is_empty) {
        Value::String("latest".into())
    } else {
        version
    };
    payload.insert("version".to_string(), version);
    if let Some(id) = cloud_plugin_id(spec, &source) {
        payload.insert("cloud_plugin_id".to_string(), Value::from(id));
    }
    payload.insert("source".to_string(), Value::Object(source));
    for (field, output) in [
        ("componentStates", "component_states"),
        ("components", "components"),
    ] {
        if let Some(value) = spec.get(field).filter(|value| json_truthy(value)) {
            payload.insert(output.to_string(), value.clone());
        }
    }
    payload
}

impl PreparedPluginPayload {
    pub(super) fn release_id(&self) -> Option<i64> {
        self.release_id
    }

    pub(super) fn render(
        mut self,
        release: Option<&PluginReleaseRow>,
    ) -> Result<Value, BuildError> {
        if !self.has_package {
            return Ok(Value::Object(self.payload));
        }
        let ready =
            release.filter(|release| release.status == "ready" && release.scan_status == "passed");
        if let Some(release) = ready {
            if self.release_override {
                self.payload
                    .insert("version".into(), Value::String(release.version.clone()));
                self.payload.insert(
                    "checksum".into(),
                    Value::String(format!("sha256:{}", release.sha256)),
                );
                if let Some(components) = release
                    .scan_report_json
                    .0
                    .to_value()
                    .get("components")
                    .filter(|value| json_truthy(value))
                {
                    self.payload.insert("components".into(), components.clone());
                }
            }
            let (download_path, expires_at) = if self.local_http {
                (
                    download_path(self.installed_id, Some(release.id)),
                    String::new(),
                )
            } else {
                presign_download(&release.storage_key)?
            };
            self.payload
                .insert("download_path".into(), Value::String(download_path));
            self.payload
                .insert("download_url_expires_at".into(), Value::String(expires_at));
            self.payload
                .insert("release_id".into(), Value::from(release.id));
        } else {
            self.payload.insert(
                "download_path".into(),
                Value::String(download_path(
                    self.installed_id,
                    self.local_http.then_some(self.release_id).flatten(),
                )),
            );
        }
        Ok(Value::Object(self.payload))
    }
}

fn download_path(installed_id: i64, release_id: Option<i64>) -> String {
    match release_id {
        Some(id) => {
            format!("/api/plugins/installed/{installed_id}/download?expected_release_id={id}")
        }
        None => format!("/api/plugins/installed/{installed_id}/download"),
    }
}
