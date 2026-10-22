// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `device_capability_sync_service.build_desired_capabilities`.
//!
//! Source: `app/services/device/capability_sync_service.py` (`build_desired_
//! capabilities` at line 98 and the `_load_*`, `_resolve_*`, `_device_release_
//! overrides`, `_plugin_payload`, `_skill_payload`, and `_mcp` helpers).
//!
//! Builds the full desired capability snapshot for one account and device in
//! the source's query order: installed skills, installed plugins (including the
//! device's preserved release overrides), then installed MCPs.

use std::collections::HashMap;

use brz_mysql::{Mysql, MysqlError, MysqlResult};
use chrono::{Duration, Utc};
use serde_json::{Map, Value};

use crate::config::env_or_dotenv;
use crate::device_identity::{
    PluginDeviceInstallationRow, coalesce_plugin_device_rows, plugin_device_id,
};
use crate::plugins_marketplace::db::{
    DEVICE_COLUMNS, InstalledKindRow, KIND_COLUMNS, PluginReleaseRow, RELEASE_COLUMNS,
};
use crate::workspace_archive::s3_presign;

/// `PLUGIN_AUTO_UPDATE_FAILURE_LIMIT` (`app/core/constants.py`).
const AUTO_UPDATE_FAILURE_LIMIT: i64 = 3;
/// `settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS`.
const PLUGIN_PACKAGE_URL_EXPIRES_SECONDS: u64 = 600;
/// `settings.PLUGIN_STORAGE_BUCKET`.
const DEFAULT_PLUGIN_BUCKET: &str = "wegent";

/// `db.query(PluginDeviceInstallation).filter(user_id=...)`.
const USER_DEVICE_ROWS_QUERY: &str = "SELECT {cols} FROM plugin_device_installations WHERE \
     plugin_device_installations.user_id = ?";

/// A desired-state build failure: a MySQL read or the source's presign client.
#[derive(Debug)]
pub enum BuildError {
    /// A recorded database read failed.
    Mysql(MysqlError),
    /// `object_storage_presign_service` rejected its configuration or signing.
    Dependency(DependencyFailure),
}

impl From<MysqlError> for BuildError {
    fn from(error: MysqlError) -> Self {
        Self::Mysql(error)
    }
}

impl From<DependencyFailure> for BuildError {
    fn from(error: DependencyFailure) -> Self {
        Self::Dependency(error)
    }
}

impl std::fmt::Display for BuildError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Mysql(error) => write!(formatter, "{error}"),
            Self::Dependency(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for BuildError {}

/// Build `{"mode", "skills", "plugins", "mcps"}` for one account and device.
///
/// `mode` is validated like `_validate_mode`; this route always passes
/// `replace`.
pub async fn build_desired_capabilities<M>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
    mode: &str,
) -> Result<Value, BuildError>
where
    M: Mysql,
{
    let skills = load_installed_skills(mysql, user_id).await?;
    let plugins = load_installed_plugins(mysql, user_id, device_id).await?;
    let mcps = load_installed_mcps(mysql, user_id).await?;
    let mut payload = Map::new();
    payload.insert("mode".to_string(), Value::String(mode.to_string()));
    payload.insert("skills".to_string(), Value::Array(skills));
    payload.insert("plugins".to_string(), Value::Array(plugins));
    payload.insert("mcps".to_string(), Value::Array(mcps));
    Ok(Value::Object(payload))
}

/// Source `build_desired_plugins`: the plugins-only merge payload used by the
/// reconcile branch. It never loads skills or MCPs.
pub async fn build_desired_plugins<M>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
) -> Result<Value, BuildError>
where
    M: Mysql,
{
    let plugins = load_installed_plugins(mysql, user_id, device_id).await?;
    let mut payload = Map::new();
    payload.insert("mode".to_string(), Value::String("merge".to_string()));
    payload.insert("scope".to_string(), Value::String("plugins".to_string()));
    payload.insert("plugins".to_string(), Value::Array(plugins));
    Ok(Value::Object(payload))
}

/// Source `capability_snapshot`: the stable desired state represented by a
/// payload. Signed download URLs and their expirations change on every build,
/// so they are excluded before comparing two snapshots.
#[must_use]
pub fn capability_snapshot(payload: &Value) -> Value {
    fn normalized_items(items: Option<&Value>, identity: &[&str]) -> Value {
        let mut values: Vec<(String, Value)> = items
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let Value::Object(item) = item else {
                            return None;
                        };
                        let mut projected = Map::new();
                        for (key, value) in item {
                            if key != "download_path" && key != "download_url_expires_at" {
                                projected.insert(key.clone(), value.clone());
                            }
                        }
                        let key = identity
                            .iter()
                            .map(|field| {
                                projected.get(*field).map_or_else(String::new, python_text)
                            })
                            .collect::<Vec<_>>()
                            .join("\u{1f}");
                        Some((key, Value::Object(projected)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        values.sort_by(|left, right| left.0.cmp(&right.0));
        Value::Array(values.into_iter().map(|(_, value)| value).collect())
    }
    let mut snapshot = Map::new();
    snapshot.insert(
        "mode".to_string(),
        payload.get("mode").cloned().unwrap_or(Value::Null),
    );
    snapshot.insert(
        "scope".to_string(),
        payload.get("scope").cloned().unwrap_or(Value::Null),
    );
    snapshot.insert(
        "skills".to_string(),
        normalized_items(
            payload.get("skills"),
            &["installed_skill_id", "skill_id", "name"],
        ),
    );
    snapshot.insert(
        "plugins".to_string(),
        normalized_items(
            payload.get("plugins"),
            &["installed_plugin_id", "name", "marketplace"],
        ),
    );
    snapshot.insert(
        "mcps".to_string(),
        normalized_items(payload.get("mcps"), &["installed_mcp_id", "name"]),
    );
    Value::Object(snapshot)
}

/// Python `str(value or "")` for snapshot identity tuples.
fn python_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(value) => (if *value { "True" } else { "False" }).to_string(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

/// One `db.query(Kind).filter(user_id, kind, namespace='default')` read.
async fn installed_kind_rows<M: Mysql>(
    mysql: &M,
    user_id: i64,
    kind: &str,
) -> MysqlResult<Vec<InstalledKindRow>> {
    let sql = format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.kind = '{kind}' \
         AND kinds.namespace = 'default'"
    );
    mysql.fetch_all(&sql, (user_id,)).await
}

/// `_get_user_kind`: one active install row the caller owns.
async fn get_user_kind<M: Mysql>(
    mysql: &M,
    user_id: i64,
    kind: &str,
    kind_id: i64,
) -> MysqlResult<Option<InstalledKindRow>> {
    let sql = format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.id = ? AND kinds.user_id = ? AND \
         kinds.kind = '{kind}' AND kinds.is_active = true LIMIT 1"
    );
    mysql.fetch_optional(&sql, (kind_id, user_id)).await
}

/// `db.get(PluginRelease, id)`.
async fn get_release<M: Mysql>(mysql: &M, id: i64) -> MysqlResult<Option<PluginReleaseRow>> {
    let sql = format!("SELECT {RELEASE_COLUMNS} FROM plugin_releases WHERE plugin_releases.id = ?");
    mysql.fetch_optional(&sql, (id,)).await
}

/// Source `_load_enabled_installed_skills`.
async fn load_installed_skills<M: Mysql>(
    mysql: &M,
    user_id: i64,
) -> Result<Vec<Value>, BuildError> {
    let rows = installed_kind_rows(mysql, user_id, "InstalledSkill").await?;
    let enabled: Vec<i64> = rows
        .iter()
        .filter(|row| row.is_active && is_enabled_install(&row.json.0.to_value()))
        .map(|row| row.id)
        .collect();
    resolve_installed_skills(mysql, user_id, &enabled).await
}

/// `_resolve_skill_payloads`'s installed-id branch (`strict=False`).
async fn resolve_installed_skills<M: Mysql>(
    mysql: &M,
    user_id: i64,
    installed_ids: &[i64],
) -> Result<Vec<Value>, BuildError> {
    let mut payloads = Vec::new();
    let mut seen = Vec::new();
    for installed_id in installed_ids {
        let Some(installed) =
            get_user_kind(mysql, user_id, "InstalledSkill", *installed_id).await?
        else {
            continue;
        };
        let Some(skill) = resolve_installed_skill_ref(mysql, user_id, &installed).await? else {
            continue;
        };
        if seen.contains(&skill.id) {
            continue;
        }
        payloads.push(skill_payload(&skill, Some(installed.id)));
        seen.push(skill.id);
    }
    Ok(payloads)
}

/// `_resolve_installed_skill_ref`: the `Skill` Kind named by `spec.skillRef`.
async fn resolve_installed_skill_ref<M: Mysql>(
    mysql: &M,
    user_id: i64,
    installed: &InstalledKindRow,
) -> MysqlResult<Option<InstalledKindRow>> {
    let json = installed.json.0.to_value();
    let reference = json.get("spec").and_then(|spec| spec.get("skillRef"));
    let Some(reference) = reference.filter(|value| json_truthy(value)) else {
        return Ok(None);
    };
    let name = reference.get("name");
    let namespace = reference
        .get("namespace")
        .cloned()
        .unwrap_or_else(|| Value::String("default".to_string()));
    let owner = reference
        .get("user_id")
        .and_then(Value::as_i64)
        .unwrap_or(user_id);
    let sql = format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.kind = 'Skill' AND kinds.name = ? AND \
         kinds.namespace = ? AND kinds.user_id = ? AND kinds.is_active = true LIMIT 1"
    );
    let name = name.and_then(Value::as_str).unwrap_or_default();
    let namespace = namespace.as_str().unwrap_or("default");
    mysql.fetch_optional(&sql, (name, namespace, owner)).await
}

/// `_skill_payload`.
fn skill_payload(skill: &InstalledKindRow, installed_skill_id: Option<i64>) -> Value {
    let json = skill.json.0.to_value();
    let metadata = json.get("metadata");
    let name = metadata
        .and_then(|metadata| metadata.get("name"))
        .and_then(Value::as_str)
        .unwrap_or(&skill.name);
    let namespace = metadata
        .and_then(|metadata| metadata.get("namespace"))
        .and_then(Value::as_str)
        .unwrap_or(&skill.namespace);
    let file_hash = json
        .get("status")
        .and_then(|status| status.get("fileHash"))
        .and_then(Value::as_str);
    let mut payload = Map::new();
    payload.insert("id".to_string(), Value::from(skill.id));
    payload.insert("skill_id".to_string(), Value::from(skill.id));
    payload.insert(
        "installed_skill_id".to_string(),
        installed_skill_id.map_or(Value::Null, Value::from),
    );
    payload.insert("name".to_string(), Value::String(name.to_string()));
    payload.insert(
        "namespace".to_string(),
        Value::String(namespace.to_string()),
    );
    payload.insert("is_public".to_string(), Value::Bool(skill.user_id == 0));
    payload.insert(
        "content_hash".to_string(),
        file_hash.map_or(Value::Null, |hash| Value::String(format!("sha256:{hash}"))),
    );
    payload.insert(
        "download_path".to_string(),
        Value::String(format!(
            "/api/v1/kinds/skills/{}/download?namespace={namespace}",
            skill.id
        )),
    );
    Value::Object(payload)
}

/// Source `_load_installed_plugins`.
async fn load_installed_plugins<M: Mysql>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
) -> Result<Vec<Value>, BuildError> {
    let rows = installed_kind_rows(mysql, user_id, "InstalledPlugin").await?;
    let installed_ids: Vec<i64> = rows
        .iter()
        .filter(|row| row.is_active && is_synced_install(&row.json.0.to_value()))
        .map(|row| row.id)
        .collect();
    let overrides = device_release_overrides(mysql, user_id, device_id, &rows).await?;
    resolve_plugin_payloads(mysql, user_id, &installed_ids, &overrides).await
}

/// `_device_release_overrides`: preserve an exhausted retry's actual release.
async fn device_release_overrides<M: Mysql>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
    installed_rows: &[InstalledKindRow],
) -> Result<HashMap<i64, i64>, BuildError> {
    if device_id.is_empty() || installed_rows.is_empty() {
        return Ok(HashMap::new());
    }
    let canonical_id = plugin_device_id(mysql, user_id, device_id).await?;
    let rows: Vec<PluginDeviceInstallationRow> = mysql
        .fetch_all(
            USER_DEVICE_ROWS_QUERY.replace("{cols}", DEVICE_COLUMNS),
            (user_id,),
        )
        .await?;
    let selected = coalesce_plugin_device_rows(mysql, rows).await?;
    let rows_by_installed: HashMap<i64, PluginDeviceInstallationRow> = selected
        .into_iter()
        .filter(|((_, canonical), _)| canonical == &canonical_id)
        .map(|((installed_id, _), row)| (installed_id, row))
        .collect();
    let mut overrides = HashMap::new();
    for installed in installed_rows {
        let Some(release_id) = integer_release_id(&installed.json.0.to_value()) else {
            continue;
        };
        if let Some(preserved) =
            auto_update_blocked_release_id(rows_by_installed.get(&installed.id), release_id)
        {
            overrides.insert(installed.id, preserved);
        }
    }
    Ok(overrides)
}

/// `_resolve_plugin_payloads` (`strict=True`, but unresolved ids only skip).
async fn resolve_plugin_payloads<M: Mysql>(
    mysql: &M,
    user_id: i64,
    installed_ids: &[i64],
    overrides: &HashMap<i64, i64>,
) -> Result<Vec<Value>, BuildError> {
    let mut payloads = Vec::new();
    let mut seen = Vec::new();
    for installed_id in installed_ids {
        let Some(installed) =
            get_user_kind(mysql, user_id, "InstalledPlugin", *installed_id).await?
        else {
            continue;
        };
        if seen.contains(&installed.id) {
            continue;
        }
        payloads
            .push(plugin_payload(mysql, &installed, overrides.get(&installed.id).copied()).await?);
        seen.push(installed.id);
    }
    Ok(payloads)
}

/// `_plugin_payload`.
async fn plugin_payload<M: Mysql>(
    mysql: &M,
    installed: &InstalledKindRow,
    release_id_override: Option<i64>,
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
        let release = match release_id {
            Some(release_id) => get_release(mysql, release_id).await?,
            None => None,
        };
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
            let (download_path, expires_at) = presign_download(&release.storage_key)?;
            payload.insert("download_path".to_string(), Value::String(download_path));
            payload.insert(
                "download_url_expires_at".to_string(),
                Value::String(expires_at),
            );
            payload.insert("release_id".to_string(), Value::from(release.id));
        } else {
            payload.insert(
                "download_path".to_string(),
                Value::String(format!("/api/plugins/installed/{}/download", installed.id)),
            );
        }
    }
    Ok(Value::Object(payload))
}

/// `plugin_package_storage.presign_download`: a MinIO SigV4 query URL plus the
/// source's independent UTC expiry read.
fn presign_download(storage_key: &str) -> Result<(String, String), DependencyFailure> {
    let config = crate::smart_apps_download::artifact::plugin_storage_config();
    if config.host().is_empty() || config.access_key.is_empty() || config.secret_key.is_empty() {
        return Err(DependencyFailure(
            "MinIO configuration not set. Set ATTACHMENT_S3_ENDPOINT, \
             ATTACHMENT_S3_ACCESS_KEY, and ATTACHMENT_S3_SECRET_KEY environment variables."
                .to_string(),
        ));
    }
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let bucket = env_or_dotenv("PLUGIN_STORAGE_BUCKET")
        .filter(|bucket| !bucket.is_empty())
        .unwrap_or_else(|| DEFAULT_PLUGIN_BUCKET.to_string());
    let url = s3_presign::presign(
        config.scheme(),
        config.host(),
        "GET",
        &format!("/{bucket}/{}", storage_key.trim_start_matches('/')),
        &config.access_key,
        &config.secret_key,
        &config.region,
        &amz_date,
        PLUGIN_PACKAGE_URL_EXPIRES_SECONDS,
    );
    let expires_at = now + Duration::seconds(PLUGIN_PACKAGE_URL_EXPIRES_SECONDS as i64);
    Ok((
        url,
        expires_at.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string(),
    ))
}

/// A dependency failure the source renders as an unhandled 500.
pub struct DependencyFailure(pub String);

impl std::fmt::Display for DependencyFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::fmt::Debug for DependencyFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for DependencyFailure {}

/// Source `_plugin_payload_name`.
fn plugin_payload_name(
    installed: &InstalledKindRow,
    json: &Value,
    spec: &Map<String, Value>,
    source: &Map<String, Value>,
) -> String {
    let candidates = [
        source.get("pluginKey"),
        source.get("plugin"),
        spec.get("manifest")
            .and_then(|manifest| manifest.get("name")),
        json.get("metadata")
            .and_then(|metadata| metadata.get("name")),
    ];
    for candidate in candidates.into_iter().flatten() {
        if let Some(name) = candidate.as_str().filter(|name| !name.is_empty()) {
            return name.to_string();
        }
    }
    installed.name.clone()
}

/// `_load_enabled_installed_mcps`.
async fn load_installed_mcps<M: Mysql>(mysql: &M, user_id: i64) -> Result<Vec<Value>, BuildError> {
    let rows = installed_kind_rows(mysql, user_id, "InstalledMCP").await?;
    let enabled: Vec<i64> = rows
        .iter()
        .filter(|row| row.is_active && is_enabled_install(&row.json.0.to_value()))
        .map(|row| row.id)
        .collect();
    let mut payloads = Vec::new();
    for installed_id in enabled {
        let Some(installed) = get_user_kind(mysql, user_id, "InstalledMCP", installed_id).await?
        else {
            continue;
        };
        let json = installed.json.0.to_value();
        let spec = object_or_empty(json.get("spec"));
        let mut payload = Map::new();
        payload.insert("installed_mcp_id".to_string(), Value::from(installed.id));
        payload.insert("name".to_string(), Value::String(installed.name.clone()));
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
            "source".to_string(),
            spec.get("source")
                .filter(|value| json_truthy(value))
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new())),
        );
        payload.insert(
            "server".to_string(),
            spec.get("server")
                .filter(|value| json_truthy(value))
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new())),
        );
        payloads.push(Value::Object(payload));
    }
    Ok(payloads)
}

/// `_is_enabled_install`: `spec.enabled` (default true) and the persisted
/// install state still `installed`.
fn is_enabled_install(json: &Value) -> bool {
    let spec = json.get("spec");
    let enabled = spec
        .and_then(|spec| spec.get("enabled"))
        .is_none_or(json_truthy);
    enabled && install_state(spec) == "installed"
}

/// `_should_sync_installed_plugin`: only the persisted install state matters.
fn is_synced_install(json: &Value) -> bool {
    install_state(json.get("spec")) == "installed"
}

fn install_state(spec: Option<&Value>) -> &str {
    spec.and_then(|spec| spec.get("installState"))
        .and_then(Value::as_str)
        .unwrap_or("installed")
}

/// Python truthiness for a JSON value.
fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(values) => !values.is_empty(),
        Value::Object(values) => !values.is_empty(),
    }
}

fn object_or_empty(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(object)) if !object.is_empty() => object.clone(),
        _ => Map::new(),
    }
}

fn value_or_name(value: Option<&Value>, name: &str) -> Value {
    match value.filter(|value| json_truthy(value)) {
        Some(value) => value.clone(),
        None => Value::String(name.to_string()),
    }
}

/// `spec.releaseId` when it is an integer (`isinstance(release_id, int)`).
fn integer_release_id(json: &Value) -> Option<i64> {
    json.get("spec")
        .and_then(|spec| spec.get("releaseId"))
        .and_then(Value::as_i64)
}

/// `_device_release_overrides`'s `auto_update_blocked_release_id`.
fn auto_update_blocked_release_id(
    row: Option<&PluginDeviceInstallationRow>,
    desired_release_id: i64,
) -> Option<i64> {
    let row = row?;
    (row.state == "failed"
        && row.attempt_count >= AUTO_UPDATE_FAILURE_LIMIT
        && row.actual_release_id != 0
        && row.actual_release_id != desired_release_id
        && row.desired_release_id == desired_release_id)
        .then_some(row.actual_release_id)
}

/// `spec.pluginId or source.catalogItemId`, projected as an integer when the
/// source's `bool`/`int`/ASCII-decimal-string checks accept it.
fn cloud_plugin_id(spec: &Map<String, Value>, source: &Map<String, Value>) -> Option<i64> {
    let candidate = spec
        .get("pluginId")
        .filter(|value| json_truthy(value))
        .or_else(|| {
            source
                .get("catalogItemId")
                .filter(|value| json_truthy(value))
        })?;
    let value = match candidate {
        Value::Bool(_) => return None,
        Value::Number(number) => number.as_i64()?,
        Value::String(text)
            if text.is_ascii() && text.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            text.parse().ok()?
        }
        _ => return None,
    };
    (value > 0).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn install_filters_match_the_source_predicates() {
        assert!(is_enabled_install(
            &json!({"spec": {"enabled": true, "installState": "installed"}})
        ));
        assert!(is_enabled_install(&json!({"spec": {}})));
        assert!(!is_enabled_install(
            &json!({"spec": {"enabled": false, "installState": "installed"}})
        ));
        assert!(!is_enabled_install(
            &json!({"spec": {"installState": "uninstalled"}})
        ));
        assert!(is_synced_install(&json!({"spec": {"enabled": false}})));
        assert!(!is_synced_install(
            &json!({"spec": {"installState": "uninstalled"}})
        ));
    }

    #[test]
    fn cloud_plugin_id_follows_the_source_type_checks() {
        assert_eq!(
            cloud_plugin_id(&object_or_empty(Some(&json!({"pluginId": 2}))), &Map::new()),
            Some(2)
        );
        assert_eq!(
            cloud_plugin_id(
                &object_or_empty(Some(&json!({"pluginId": "2"}))),
                &Map::new()
            ),
            Some(2)
        );
        assert_eq!(
            cloud_plugin_id(
                &object_or_empty(Some(&json!({"pluginId": true}))),
                &Map::new()
            ),
            None
        );
        assert_eq!(
            cloud_plugin_id(
                &object_or_empty(Some(&json!({"pluginId": "x"}))),
                &Map::new()
            ),
            None
        );
    }

    #[test]
    fn auto_update_blocked_release_matches_the_source_rule() {
        let row = PluginDeviceInstallationRow {
            id: 1,
            installed_kind_id: 2,
            user_id: 3,
            device_id: "d".to_string(),
            desired_release_id: 5,
            actual_release_id: 4,
            state: "failed".to_string(),
            error_code: String::new(),
            error_message: String::new(),
            attempt_count: AUTO_UPDATE_FAILURE_LIMIT,
            last_sync_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        };
        assert_eq!(auto_update_blocked_release_id(Some(&row), 5), Some(4));
        assert_eq!(auto_update_blocked_release_id(None, 5), None);
    }

    #[test]
    fn capability_snapshot_ignores_generated_download_values_and_order() {
        let first = json!({
            "mode": "replace",
            "scope": null,
            "skills": [],
            "mcps": [],
            "plugins": [
                {"installed_plugin_id": 2, "name": "b", "marketplace": "wegent",
                 "download_path": "http://s3/a?signature=1", "download_url_expires_at": "1"},
                {"installed_plugin_id": 1, "name": "a", "marketplace": "wegent",
                 "download_path": "http://s3/b?signature=2", "download_url_expires_at": "2"}
            ]
        });
        let second = json!({
            "mode": "replace",
            "scope": null,
            "skills": [],
            "mcps": [],
            "plugins": [
                {"installed_plugin_id": 1, "name": "a", "marketplace": "wegent",
                 "download_path": "http://s3/b?signature=3", "download_url_expires_at": "3"},
                {"installed_plugin_id": 2, "name": "b", "marketplace": "wegent",
                 "download_path": "http://s3/a?signature=4", "download_url_expires_at": "4"}
            ]
        });
        assert_eq!(capability_snapshot(&first), capability_snapshot(&second));
        let changed = json!({"mode": "replace", "plugins": [{"installed_plugin_id": 3}]});
        assert_ne!(capability_snapshot(&first), capability_snapshot(&changed));
    }

    #[test]
    fn plugin_payload_name_prefers_the_marketplace_key() {
        let installed = InstalledKindRow {
            id: 1,
            user_id: 2,
            kind: "InstalledPlugin".to_string(),
            name: "fallback".to_string(),
            namespace: "default".to_string(),
            json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(json!({}))),
            is_active: true,
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        };
        assert_eq!(
            plugin_payload_name(
                &installed,
                &json!({}),
                &object_or_empty(Some(&json!({}))),
                &object_or_empty(Some(&json!({"pluginKey": "dingtalk"})))
            ),
            "dingtalk"
        );
    }
}
