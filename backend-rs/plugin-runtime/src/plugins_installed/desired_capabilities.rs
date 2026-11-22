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

mod plugin_payload;

use brz_mysql::{Mysql, MysqlError, MysqlResult};
use chrono::{Duration, Utc};
use serde_json::{Map, Value};

use crate::device_identity::plugin_device_id_on;
use crate::plugins_marketplace::db::{
    DEVICE_COLUMNS, InstalledKindRow, KIND_COLUMNS, PluginReleaseRow, RELEASE_COLUMNS,
};
use wegent_backend_persistence::mysql_query::MysqlQuery;
use wegent_plugin_store::{PluginDeviceInstallationRow, coalesce_plugin_device_rows_on};
use wegent_storage::s3_presign;

/// `PLUGIN_AUTO_UPDATE_FAILURE_LIMIT` (`app/core/constants.py`).
const AUTO_UPDATE_FAILURE_LIMIT: i64 = 3;
/// `settings.PLUGIN_PACKAGE_URL_EXPIRES_SECONDS`.
const PLUGIN_PACKAGE_URL_EXPIRES_SECONDS: u64 = 600;

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
    let mut query = mysql;
    build_desired_capabilities_on(&mut query, user_id, device_id, mode).await
}

/// [`build_desired_capabilities`] over a pool or an open transaction.
pub(crate) async fn build_desired_capabilities_on<Q>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
    mode: &str,
) -> Result<Value, BuildError>
where
    Q: MysqlQuery,
{
    let skills = load_installed_skills(query, user_id).await?;
    let plugins = load_installed_plugins(query, user_id, device_id).await?;
    let mcps = load_installed_mcps(query, user_id).await?;
    let mut payload = Map::new();
    payload.insert("mode".to_string(), Value::String(mode.to_string()));
    payload.insert("skills".to_string(), Value::Array(skills));
    payload.insert("plugins".to_string(), Value::Array(plugins));
    payload.insert("mcps".to_string(), Value::Array(mcps));
    Ok(Value::Object(payload))
}

/// Source `build_desired_capabilities` for the registration-time sync.
///
/// The registration path passes `include_plugins`: when plugin coordination
/// is unavailable the source loads no plugins and falls back to `mode="merge"`
/// so existing client plugins are preserved. Key order matches the source
/// dict (`mode`, `skills`, `mcps`, then `plugins`).
pub async fn build_desired_capabilities_for_registration<M>(
    mysql: &M,
    user_id: i64,
    device_id: &str,
    include_plugins: bool,
) -> Result<Value, BuildError>
where
    M: Mysql,
{
    let mut query = mysql;
    build_desired_capabilities_for_registration_on(&mut query, user_id, device_id, include_plugins)
        .await
}

/// [`build_desired_capabilities_for_registration`] over a pool or an open
/// transaction. The plugin-sync protocol loads the snapshot inside its own
/// transaction, so this variant must share the caller's connection.
pub(crate) async fn build_desired_capabilities_for_registration_on<Q>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
    include_plugins: bool,
) -> Result<Value, BuildError>
where
    Q: MysqlQuery,
{
    let skills = load_installed_skills(query, user_id).await?;
    let plugins = if include_plugins {
        load_installed_plugins(query, user_id, device_id).await?
    } else {
        Vec::new()
    };
    let mcps = load_installed_mcps(query, user_id).await?;
    let mut payload = Map::new();
    payload.insert(
        "mode".to_string(),
        Value::String(if include_plugins { "replace" } else { "merge" }.to_string()),
    );
    payload.insert("skills".to_string(), Value::Array(skills));
    payload.insert("mcps".to_string(), Value::Array(mcps));
    if include_plugins {
        payload.insert("plugins".to_string(), Value::Array(plugins));
    }
    Ok(Value::Object(payload))
}

/// Source `build_desired_plugins`: the plugins-only merge payload used by the
/// reconcile branch. It never loads skills or MCPs. The reconcile flow owns a
/// write transaction, so the builder always runs on the caller's session.
pub(crate) async fn build_desired_plugins_on<Q>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
) -> Result<Value, BuildError>
where
    Q: MysqlQuery,
{
    let plugins = load_installed_plugins(query, user_id, device_id).await?;
    let mut payload = Map::new();
    payload.insert("mode".to_string(), Value::String("merge".to_string()));
    payload.insert("scope".to_string(), Value::String("plugins".to_string()));
    payload.insert("plugins".to_string(), Value::Array(plugins));
    Ok(Value::Object(payload))
}

/// Read the account's managed plugins on the caller's primary transaction.
/// Device overrides and object-store signing do not participate in local HTTP sync.
pub(super) async fn build_local_plugins<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
) -> Result<(Value, Value), BuildError> {
    let started = std::time::Instant::now();
    let rows: Vec<InstalledKindRow> = query.fetch_all(format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE user_id = ? AND kind = 'InstalledPlugin' AND namespace = 'default' ORDER BY id ASC"
    ), (user_id,)).await?;
    let installation_count = rows.len();
    let mut prepared = Vec::new();
    let mut revisions = Map::new();
    for row in rows {
        let json = row.json.0.to_value();
        if let Ok(revision) = super::write_coordination::business_revision(&json) {
            revisions.insert(row.id.to_string(), Value::from(revision));
        }
        if row.is_active && is_synced_install(&json) {
            prepared.push(plugin_payload::prepare(&row, &json, None, true));
        }
    }
    let mut release_ids: Vec<_> = prepared
        .iter()
        .filter_map(|payload| payload.release_id())
        .collect();
    release_ids.sort_unstable();
    release_ids.dedup();
    let installations_loaded = started.elapsed();
    let releases: HashMap<_, _> =
        crate::plugins_marketplace::db::list_release_rows_by_ids_on(query, &release_ids)
            .await?
            .into_iter()
            .map(|row| (row.id, row))
            .collect();
    let releases_loaded = started.elapsed();
    let plugins: Vec<_> = prepared
        .into_iter()
        .map(|payload| {
            let release = payload.release_id().and_then(|id| releases.get(&id));
            payload.render(release)
        })
        .collect::<Result<_, _>>()?;
    tracing::debug!(
        installations = installation_count,
        plugins = plugins.len(),
        releases = releases.len(),
        installations_ms = installations_loaded.as_secs_f64() * 1000.0,
        releases_ms = (releases_loaded - installations_loaded).as_secs_f64() * 1000.0,
        render_ms = (started.elapsed() - releases_loaded).as_secs_f64() * 1000.0,
        "local plugin snapshot batch projection"
    );
    Ok((
        serde_json::json!({"mode":"merge", "scope":"plugins", "plugins":plugins}),
        Value::Object(revisions),
    ))
}

/// Restrict a mutation to one owned installation; full reconciliation remains
/// responsible for discovering unrelated account changes and implicit removals.
pub(super) async fn restrict_local_plugin<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    installed_id: i64,
    payload: &mut Value,
) -> Result<Value, BuildError> {
    let Some(row) = query.fetch_optional::<_,_,InstalledKindRow>(format!("SELECT {KIND_COLUMNS} FROM kinds WHERE id = ? AND user_id = ? AND kind = 'InstalledPlugin' AND namespace = 'default'"), (installed_id,user_id)).await? else {
        return Err(brz_mysql::MysqlError::InvalidQuery{reason:"SNAPSHOT_NOT_OWNED".into()}.into());
    };
    let mut plugins = Vec::new();
    if row.is_active && is_synced_install(&row.json.0.to_value()) {
        plugins.push(plugin_payload(query, &row, None, true).await?);
    }
    let mut removed = Vec::new();
    if plugins.is_empty() {
        let document = row.json.0.to_value();
        let spec = object_or_empty(document.get("spec"));
        let source = object_or_empty(spec.get("source"));
        removed.push(serde_json::json!({"installed_plugin_id":installed_id,"name":plugin_payload_name(&row,&document,&spec,&source),"marketplace":spec.get("marketplace").or_else(||source.get("marketplace"))}));
    }
    payload["scope"] = Value::String("plugin_delta".into());
    payload["plugins"] = Value::Array(plugins);
    payload["removed_plugins"] = Value::Array(removed);
    let revision = super::write_coordination::business_revision(&row.json.0.to_value())?;
    Ok(serde_json::json!({installed_id.to_string():revision}))
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
async fn installed_kind_rows<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    kind: &str,
) -> MysqlResult<Vec<InstalledKindRow>> {
    let sql = format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.kind = '{kind}' \
         AND kinds.namespace = 'default'"
    );
    query.fetch_all(&sql, (user_id,)).await
}

/// One `db.query(Kind).filter(user_id, kind, namespace='default', id IN ids)`
/// read, with SQLAlchemy's empty-list guard.
async fn installed_kind_rows_for_ids<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    kind: &str,
    only_ids: &[i64],
) -> MysqlResult<Vec<InstalledKindRow>> {
    let (filter, id_arguments) = crate::sql_support::id_in_clause("kinds.id", only_ids);
    let sql = format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.kind = '{kind}' \
         AND kinds.namespace = 'default' AND {filter}"
    );
    let mut arguments = vec![crate::sql_support::StatementArg::Int(user_id)];
    arguments.extend(id_arguments);
    query.fetch_all(&sql, arguments).await
}

/// `_get_user_kind`: one active install row the caller owns.
pub(super) async fn get_user_kind<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    kind: &str,
    kind_id: i64,
) -> MysqlResult<Option<InstalledKindRow>> {
    let sql = format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.id = ? AND kinds.user_id = ? AND \
         kinds.kind = '{kind}' AND kinds.namespace = 'default' AND kinds.is_active = true LIMIT 1"
    );
    query.fetch_optional(&sql, (kind_id, user_id)).await
}

/// `db.get(PluginRelease, id)`.
pub(super) async fn get_release<Q: MysqlQuery>(
    query: &mut Q,
    id: i64,
) -> MysqlResult<Option<PluginReleaseRow>> {
    let sql = format!("SELECT {RELEASE_COLUMNS} FROM plugin_releases WHERE plugin_releases.id = ?");
    query.fetch_optional(&sql, (id,)).await
}

/// Source `_load_enabled_installed_skills`.
async fn load_installed_skills<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
) -> Result<Vec<Value>, BuildError> {
    let rows = installed_kind_rows(query, user_id, "InstalledSkill").await?;
    let enabled: Vec<i64> = rows
        .iter()
        .filter(|row| row.is_active && is_enabled_install(&row.json.0.to_value()))
        .map(|row| row.id)
        .collect();
    resolve_installed_skills(query, user_id, &enabled).await
}

/// `_resolve_skill_payloads`'s installed-id branch (`strict=False`).
async fn resolve_installed_skills<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    installed_ids: &[i64],
) -> Result<Vec<Value>, BuildError> {
    let mut payloads = Vec::new();
    let mut seen = Vec::new();
    for installed_id in installed_ids {
        let Some(installed) =
            get_user_kind(query, user_id, "InstalledSkill", *installed_id).await?
        else {
            continue;
        };
        let Some(skill) = resolve_installed_skill_ref(query, user_id, &installed).await? else {
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
async fn resolve_installed_skill_ref<Q: MysqlQuery>(
    query: &mut Q,
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
    query.fetch_optional(&sql, (name, namespace, owner)).await
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
        "bind_shells".to_string(),
        wegent_execution_preparation::skills::project_runtime_skill_shells(
            &json,
            skill.user_id,
            &skill.namespace,
            &skill.name,
        )
        .map_or(Value::Null, |shells| {
            Value::Array(shells.into_iter().map(Value::String).collect())
        }),
    );
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
async fn load_installed_plugins<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
) -> Result<Vec<Value>, BuildError> {
    let rows = installed_kind_rows(query, user_id, "InstalledPlugin").await?;
    let installed_ids: Vec<i64> = rows
        .iter()
        .filter(|row| row.is_active && is_synced_install(&row.json.0.to_value()))
        .map(|row| row.id)
        .collect();
    let overrides = device_release_overrides(query, user_id, device_id, &rows).await?;
    resolve_plugin_payloads(query, user_id, &installed_ids, &overrides).await
}

/// `_load_installed_plugins(only_ids=...)`: the same desired-plugin payloads
/// restricted to one id list, used by the versioned recording.
pub(crate) async fn load_installed_plugins_for_ids<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
    only_ids: &[i64],
) -> Result<Vec<Value>, BuildError> {
    let rows = installed_kind_rows_for_ids(query, user_id, "InstalledPlugin", only_ids).await?;
    let installed_ids: Vec<i64> = rows
        .iter()
        .filter(|row| row.is_active && is_synced_install(&row.json.0.to_value()))
        .map(|row| row.id)
        .collect();
    let overrides = device_release_overrides(query, user_id, device_id, &rows).await?;
    resolve_plugin_payloads(query, user_id, &installed_ids, &overrides).await
}

/// `_device_release_overrides`: preserve an exhausted retry's actual release.
async fn device_release_overrides<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    device_id: &str,
    installed_rows: &[InstalledKindRow],
) -> Result<HashMap<i64, i64>, BuildError> {
    if device_id.is_empty() || installed_rows.is_empty() {
        return Ok(HashMap::new());
    }
    let canonical_id = plugin_device_id_on(query, user_id, device_id).await?;
    let rows: Vec<PluginDeviceInstallationRow> = query
        .fetch_all(
            USER_DEVICE_ROWS_QUERY.replace("{cols}", DEVICE_COLUMNS),
            (user_id,),
        )
        .await?;
    let selected = coalesce_plugin_device_rows_on(query, rows).await?;
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
async fn resolve_plugin_payloads<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
    installed_ids: &[i64],
    overrides: &HashMap<i64, i64>,
) -> Result<Vec<Value>, BuildError> {
    let mut payloads = Vec::new();
    let mut seen = Vec::new();
    for installed_id in installed_ids {
        let Some(installed) =
            get_user_kind(query, user_id, "InstalledPlugin", *installed_id).await?
        else {
            continue;
        };
        if seen.contains(&installed.id) {
            continue;
        }
        payloads.push(
            plugin_payload(
                query,
                &installed,
                overrides.get(&installed.id).copied(),
                false,
            )
            .await?,
        );
        seen.push(installed.id);
    }
    Ok(payloads)
}

/// `_plugin_payload`.
async fn plugin_payload<Q: MysqlQuery>(
    query: &mut Q,
    installed: &InstalledKindRow,
    release_id_override: Option<i64>,
    local_http: bool,
) -> Result<Value, BuildError> {
    let json = installed.json.0.to_value();
    let payload = plugin_payload::prepare(installed, &json, release_id_override, local_http);
    let release = match payload.release_id() {
        Some(id) => get_release(query, id).await?,
        None => None,
    };
    payload.render(release.as_ref())
}

/// `plugin_package_storage.presign_download`: a MinIO SigV4 query URL plus the
/// source's independent UTC expiry read.
fn presign_download(storage_key: &str) -> Result<(String, String), DependencyFailure> {
    let config = wegent_storage::plugin_package::plugin_storage_config();
    if config.host().is_empty() || config.access_key.is_empty() || config.secret_key.is_empty() {
        return Err(DependencyFailure(
            "MinIO configuration not set. Set ATTACHMENT_S3_ENDPOINT, \
             ATTACHMENT_S3_ACCESS_KEY, and ATTACHMENT_S3_SECRET_KEY environment variables."
                .to_string(),
        ));
    }
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let url = s3_presign::presign(
        config.scheme(),
        config.host(),
        "GET",
        &format!("/{}/{}", config.bucket, storage_key.trim_start_matches('/')),
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
async fn load_installed_mcps<Q: MysqlQuery>(
    query: &mut Q,
    user_id: i64,
) -> Result<Vec<Value>, BuildError> {
    let rows = installed_kind_rows(query, user_id, "InstalledMCP").await?;
    let enabled: Vec<i64> = rows
        .iter()
        .filter(|row| row.is_active && is_enabled_install(&row.json.0.to_value()))
        .map(|row| row.id)
        .collect();
    let mut payloads = Vec::new();
    for installed_id in enabled {
        let Some(installed) = get_user_kind(query, user_id, "InstalledMCP", installed_id).await?
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
mod tests;

#[cfg(test)]
mod batch_mysql_tests;

#[cfg(test)]
mod local_plugin_tests;
