// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/plugins/installed/auto-update-batch` implementation.
//!
//! The endpoint advances at most one cloud-marketplace installation per call.
//! It coordinates the user's plugin writes through the shared Redis lease,
//! then reads the active `InstalledPlugin` kinds rows and keeps the rows
//! whose stored `spec.source.type == "marketplace"`, `spec.updatePolicy ==
//! "auto"` and whose `pluginId`/`releaseId` are integers, reloads those
//! plugins and their current/latest releases, then applies the same
//! marketplace access checks as `GET /api/plugins/marketplace`. A candidate is
//! eligible when its plugin is published and its installed release differs
//! from the plugin's latest release, and the latest release is ready and has
//! passed scanning. The first `AUTO_UPDATE_BATCH_SIZE` candidates are applied
//! through the shared installed-payload builder, preserving the row's
//! `enabled`, `componentStates` and `updatePolicy`. The endpoint always
//! commits one pinned transaction with business-record revision checks,
//! including an empty batch.

use std::collections::{HashMap, HashSet};

use brz_mysql::{Mysql, MysqlResult, MysqlTransaction};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::permissions::{EntityResolvers, ResolutionPurpose};
use crate::plugins_marketplace::db::{
    InstalledKindRow, KIND_COLUMNS, NamespaceRow, PLUGIN_COLUMNS, PluginReleaseRow, PluginRow,
    RELEASE_COLUMNS, ResourceMemberRow, UserRepository,
};
use crate::state::AppState;

use super::auth;
use super::write_coordination::{
    PluginWriteLease, business_revision, coordination_error, http_error,
};
use crate::http_compat::FastApiError;

/// Keep each poll bounded while draining updates across successive calls.
const AUTO_UPDATE_BATCH_SIZE: usize = 1;

/// Success-response model (`PluginAutoUpdateBatchResponse`) field order.
#[derive(Debug, Serialize)]
struct PluginAutoUpdateItem {
    #[serde(rename = "installedPluginId")]
    installed_plugin_id: i64,
    #[serde(rename = "pluginId")]
    plugin_id: i64,
    #[serde(rename = "fromReleaseId")]
    from_release_id: i64,
    #[serde(rename = "toReleaseId")]
    to_release_id: i64,
    version: String,
}

/// One bounded batch of automatic marketplace plugin updates.
#[derive(Debug, Serialize)]
struct PluginAutoUpdateBatchResponse {
    updated: Vec<PluginAutoUpdateItem>,
    #[serde(rename = "updatedCount")]
    updated_count: usize,
    #[serde(rename = "remainingCount")]
    remaining_count: usize,
}

impl PluginAutoUpdateBatchResponse {
    fn empty() -> Self {
        Self {
            updated: Vec::new(),
            updated_count: 0,
            remaining_count: 0,
        }
    }
}

/// POST /api/plugins/installed/auto-update-batch: the plugins-installed free
/// function, injecting the process-lifetime application state.
#[brz_http_server::post("/api/plugins/installed/auto-update-batch")]
async fn auto_update_installed_plugins(
    #[inject(state)] state: &AppState,
    #[auth] user: auth::InstalledPluginsUser,
) -> Result<PluginAutoUpdateBatchResponse, FastApiError> {
    auto_update_batch(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        user.id,
    )
    .await
    .map_err(http_error)
}

/// The lease serializes these rows with authentication and installation.
async fn list_installed_kinds<T>(
    transaction: &mut T,
    user_id: i64,
) -> MysqlResult<Vec<InstalledKindRow>>
where
    T: MysqlTransaction,
{
    transaction
        .fetch_all(
            format!(
                "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.user_id = ? AND kinds.kind = \
                 'InstalledPlugin' AND kinds.namespace = 'default' AND kinds.is_active IS true \
                 ORDER BY kinds.id ASC"
            ),
            (user_id,),
        )
        .await
}

/// `db.query(Plugin).filter(Plugin.id.in_(plugin_ids))`.
async fn list_plugins_by_ids<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<PluginRow>>
where
    M: Mysql,
{
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    mysql
        .fetch_all(
            format!("SELECT {PLUGIN_COLUMNS} FROM plugins WHERE plugins.id IN ({placeholders})"),
            ids.to_vec(),
        )
        .await
}

/// `db.query(PluginRelease).filter(PluginRelease.id.in_(release_ids))` — the
/// source does not filter by status here; readiness is checked per candidate.
async fn list_releases_by_ids<M>(mysql: &M, ids: &[i64]) -> MysqlResult<Vec<PluginReleaseRow>>
where
    M: Mysql,
{
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    mysql
        .fetch_all(
            format!(
                "SELECT {RELEASE_COLUMNS} FROM plugin_releases WHERE plugin_releases.id IN \
                 ({placeholders})"
            ),
            ids.to_vec(),
        )
        .await
}

/// One eligible installed row: its stored document plus the integers the
/// source requires (`spec.pluginId`, `spec.releaseId`).
struct EligibleRow<'a> {
    installed: &'a InstalledKindRow,
    plugin_id: i64,
    release_id: i64,
}

/// Keep marketplace rows set to auto update with integer plugin/release IDs.
fn eligible_rows(rows: &[InstalledKindRow]) -> Vec<EligibleRow<'_>> {
    let mut eligible = Vec::new();
    for installed in rows {
        let Some(document) = installed.json.0.project::<InstalledDocument>() else {
            continue;
        };
        let Some(spec) = document.spec else {
            continue;
        };
        let source_ok = spec
            .source
            .as_ref()
            .map(|source| source.type_value.as_deref() == Some("marketplace"))
            .unwrap_or(false);
        let update_policy = spec.update_policy.as_deref();
        let plugin_id = spec.plugin_id.as_ref().and_then(Value::as_i64);
        let release_id = spec.release_id.as_ref().and_then(Value::as_i64);
        if source_ok
            && update_policy == Some("auto")
            && let (Some(plugin_id), Some(release_id)) = (plugin_id, release_id)
        {
            eligible.push(EligibleRow {
                installed,
                plugin_id,
                release_id,
            });
        }
    }
    eligible
}

/// Stored installed-plugin document shape (only the fields this endpoint
/// reads).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct InstalledDocument {
    spec: Option<InstalledSpec>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct InstalledSpec {
    #[serde(rename = "pluginId")]
    plugin_id: Option<Value>,
    #[serde(rename = "releaseId")]
    release_id: Option<Value>,
    #[serde(rename = "updatePolicy")]
    update_policy: Option<String>,
    enabled: Option<Value>,
    #[serde(rename = "componentStates")]
    component_states: Option<Value>,
    source: Option<InstalledSource>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct InstalledSource {
    #[serde(rename = "type")]
    type_value: Option<String>,
}

/// Preloaded user/namespace membership for one access pass
/// (`_UserPluginAccessContext`).
pub(super) struct AccessContext {
    namespace_ids: HashSet<String>,
    namespace_names: Vec<String>,
    namespace_names_by_id: HashMap<String, String>,
    external_plugin_ids: HashSet<i64>,
    external_entity_types: HashSet<String>,
}

/// `auto_update_batch`: the complete observable flow of the endpoint.
async fn auto_update_batch<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
) -> MysqlResult<PluginAutoUpdateBatchResponse>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let lease = PluginWriteLease::acquire(redis, user_id).await?;
    let result = tokio::time::timeout_at(lease.deadline, async {
        lease.ensure_policy(mysql).await?;
        let (catalog_revision, installed_rows) = mysql
            .with_transaction(async |transaction| {
                let revision = lease.read_revision(transaction).await?;
                let installed_rows = list_installed_kinds(transaction, user_id).await?;
                Ok((revision, installed_rows))
            })
            .await?;
        // Catalog and permission resolvers may borrow additional pool
        // connections. Complete them before pinning the write connection.
        let catalog =
            load_auto_update_catalog(mysql, redis, resolvers, user_id, &installed_rows).await?;
        // The write transaction reads the shared parent before installation
        // state; its final CAS also detects commits from an expired worker.
        mysql
            .with_transaction(async |transaction| {
                lease.verify_owned().await?;
                let revision = lease.read_revision(transaction).await?;
                // Catalog loading releases its connection before permission
                // resolvers borrow from the pool. Reject it if any plugin
                // writer committed while those dependencies were loading.
                if revision != catalog_revision {
                    return Err(coordination_error("plugin_write_conflict"));
                }
                let response = if let Some(catalog) = catalog.as_ref() {
                    let installed_rows = list_installed_kinds(transaction, user_id).await?;
                    apply_auto_update_batch(transaction, catalog, &installed_rows, user_id).await?
                } else {
                    PluginAutoUpdateBatchResponse::empty()
                };
                lease.commit_revision(transaction, revision).await?;
                Ok(response)
            })
            .await
    })
    .await
    .unwrap_or_else(|_| Err(coordination_error("plugin_write_lease_lost")));
    lease.release().await;
    result
}

struct AutoUpdateCatalog {
    plugins_by_id: HashMap<i64, PluginRow>,
    releases_by_id: HashMap<i64, PluginReleaseRow>,
    grants_by_plugin_id: HashMap<i64, Vec<ResourceMemberRow>>,
    access_context: Option<AccessContext>,
}

async fn load_auto_update_catalog<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    installed_rows: &[InstalledKindRow],
) -> MysqlResult<Option<AutoUpdateCatalog>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let eligible = eligible_rows(installed_rows);
    if eligible.is_empty() {
        return Ok(None);
    }

    let plugin_ids = distinct_ids(eligible.iter().map(|row| row.plugin_id));
    let plugins = list_plugins_by_ids(mysql, &plugin_ids).await?;
    let plugins_by_id: HashMap<i64, PluginRow> = plugins
        .into_iter()
        .map(|plugin| (plugin.id, plugin))
        .collect();

    let mut release_ids = distinct_ids(eligible.iter().map(|row| row.release_id));
    for plugin in plugins_by_id.values() {
        if plugin.latest_release_id != 0 && !release_ids.contains(&plugin.latest_release_id) {
            release_ids.push(plugin.latest_release_id);
        }
    }
    let releases_by_id: HashMap<i64, PluginReleaseRow> = list_releases_by_ids(mysql, &release_ids)
        .await?
        .into_iter()
        .map(|release| (release.id, release))
        .collect();

    let catalog_plugin_ids: Vec<i64> = plugins_by_id.keys().copied().collect();
    let grants_by_plugin_id =
        UserRepository::list_plugin_grants(mysql, &catalog_plugin_ids).await?;
    let access_context =
        load_access_context(mysql, redis, resolvers, user_id, &grants_by_plugin_id).await?;

    Ok(Some(AutoUpdateCatalog {
        plugins_by_id,
        releases_by_id,
        grants_by_plugin_id,
        access_context,
    }))
}

async fn apply_auto_update_batch<T: MysqlTransaction>(
    transaction: &mut T,
    catalog: &AutoUpdateCatalog,
    installed_rows: &[InstalledKindRow],
    user_id: i64,
) -> MysqlResult<PluginAutoUpdateBatchResponse> {
    let eligible = eligible_rows(installed_rows);
    let candidates = candidates(
        &eligible,
        &catalog.plugins_by_id,
        &catalog.releases_by_id,
        user_id,
        &catalog.grants_by_plugin_id,
        catalog.access_context.as_ref(),
    );

    let mut updated: Vec<PluginAutoUpdateItem> = Vec::new();
    for (installed, plugin, release) in candidates.iter().take(AUTO_UPDATE_BATCH_SIZE) {
        let current_spec = installed_document(installed).unwrap_or_default();
        let Some(from_release_id) = current_spec.release_id.as_ref().and_then(Value::as_i64) else {
            continue;
        };
        let payload = installed_payload(plugin, release, &current_spec);
        advance_installation(transaction, installed, payload, user_id).await?;
        updated.push(PluginAutoUpdateItem {
            installed_plugin_id: installed.id,
            plugin_id: plugin.id,
            from_release_id,
            to_release_id: release.id,
            version: release.version.clone(),
        });
    }

    let remaining_count = candidates.len().saturating_sub(updated.len());
    Ok(PluginAutoUpdateBatchResponse {
        updated_count: updated.len(),
        updated,
        remaining_count,
    })
}

/// Keep installation CAS independent of the account policy CAS: both writes
/// must succeed in the same transaction before its response can be committed.
async fn advance_installation<T: MysqlTransaction>(
    transaction: &mut T,
    installed: &InstalledKindRow,
    mut payload: Value,
    user_id: i64,
) -> MysqlResult<()> {
    let revision = business_revision(&installed.json.0.to_value())?;
    payload["spec"]["revision"] = Value::from(revision + 1);
    let execution = transaction
        .execute(
            "UPDATE kinds SET json=?, updated_at=NOW() WHERE kinds.id = ? \
             AND user_id = ? AND kind = 'InstalledPlugin' AND namespace = 'default' \
             AND name = ? AND is_active IS true AND \
             COALESCE(JSON_EXTRACT(json, '$.spec.revision'), 0) = ?",
            (
                serde_json::to_string(&payload).expect("payload serializes"),
                installed.id,
                user_id,
                installed.name.as_str(),
                revision,
            ),
        )
        .await?;
    if execution.rows_affected != 1 {
        return Err(coordination_error("plugin_write_conflict"));
    }
    Ok(())
}

/// Select accessible published plugins with a ready, scanned newer release.
fn candidates<'a>(
    eligible: &'a [EligibleRow<'a>],
    plugins_by_id: &'a HashMap<i64, PluginRow>,
    releases_by_id: &'a HashMap<i64, PluginReleaseRow>,
    user_id: i64,
    grants_by_plugin_id: &'a HashMap<i64, Vec<ResourceMemberRow>>,
    access_context: Option<&'a AccessContext>,
) -> Vec<(&'a InstalledKindRow, &'a PluginRow, &'a PluginReleaseRow)> {
    let mut candidates = Vec::new();
    for row in eligible {
        let Some(plugin) = plugins_by_id.get(&row.plugin_id) else {
            continue;
        };
        let Some(current_release) = releases_by_id.get(&row.release_id) else {
            continue;
        };
        let grants = grants_by_plugin_id
            .get(&plugin.id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if current_release.plugin_id != row.plugin_id
            || plugin.status != "published"
            || plugin.latest_release_id == 0
            || plugin.latest_release_id == row.release_id
            || !can_access_plugin(plugin, Some(user_id), grants, access_context)
        {
            continue;
        }
        let Some(release) = releases_by_id.get(&plugin.latest_release_id) else {
            continue;
        };
        if release.plugin_id == plugin.id
            && release.status == "ready"
            && release.scan_status == "passed"
        {
            candidates.push((row.installed, plugin, release));
        }
    }
    candidates
}

fn distinct_ids(values: impl Iterator<Item = i64>) -> Vec<i64> {
    let mut ids = Vec::new();
    for value in values {
        if !ids.contains(&value) {
            ids.push(value);
        }
    }
    ids
}

fn installed_document(row: &InstalledKindRow) -> Option<InstalledSpec> {
    row.json
        .0
        .project::<InstalledDocument>()
        .and_then(|doc| doc.spec)
}

/// `_can_access_plugin`: public plugins are open; the owner always has
/// access; an empty grant set falls back to plain workspace visibility;
/// otherwise direct-user, namespace-membership and registered external-entity
/// grants decide.
pub(super) fn can_access_plugin(
    plugin: &PluginRow,
    user_id: Option<i64>,
    grants: &[ResourceMemberRow],
    access_context: Option<&AccessContext>,
) -> bool {
    if plugin.visibility == "public" {
        return true;
    }
    let Some(user_id) = user_id else {
        return false;
    };
    if plugin.owner_user_id == user_id {
        return true;
    }
    if grants.is_empty() {
        return plugin.visibility == "workspace";
    }
    if grants
        .iter()
        .any(|grant| grant.entity_type == "user" && grant.entity_id == user_id.to_string())
    {
        return true;
    }
    let granted_namespace_ids: HashSet<&str> = grants
        .iter()
        .filter(|grant| grant.entity_type == "namespace")
        .map(|grant| grant.entity_id.as_str())
        .collect();
    let Some(access_context) = access_context else {
        return false;
    };
    let has_external_grant = grants.iter().any(|grant| {
        access_context
            .external_entity_types
            .contains(&grant.entity_type)
    });
    if granted_namespace_ids.is_empty() && !has_external_grant {
        return false;
    }
    if access_context.external_plugin_ids.contains(&plugin.id) {
        return true;
    }
    if granted_namespace_ids.is_empty() {
        return false;
    }
    if granted_namespace_ids
        .iter()
        .any(|namespace_id| access_context.namespace_ids.contains(*namespace_id))
    {
        return true;
    }
    if access_context.namespace_names.is_empty() {
        return false;
    }
    let granted_names: Vec<&str> = granted_namespace_ids
        .iter()
        .filter_map(|namespace_id| {
            access_context
                .namespace_names_by_id
                .get(*namespace_id)
                .map(String::as_str)
        })
        .collect();
    access_context.namespace_names.iter().any(|member_name| {
        granted_names.iter().any(|granted_name| {
            member_name == granted_name || member_name.starts_with(&format!("{granted_name}/"))
        })
    })
}

/// `_load_user_plugin_access_context`: load namespace membership once, then
/// resolve registered external-entity grants for the eligible plugins.
pub(super) async fn load_access_context<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    grants_by_plugin_id: &HashMap<i64, Vec<ResourceMemberRow>>,
) -> MysqlResult<Option<AccessContext>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let user_namespaces = UserRepository::list_user_namespaces(mysql, user_id).await?;
    let mut granted_namespace_ids: Vec<i64> = Vec::new();
    for grant in grants_by_plugin_id.values().flatten() {
        if grant.entity_type != "namespace"
            || grant.entity_id.is_empty()
            || !grant.entity_id.bytes().all(|byte| byte.is_ascii_digit())
        {
            continue;
        }
        if let Ok(namespace_id) = grant.entity_id.parse()
            && !granted_namespace_ids.contains(&namespace_id)
        {
            granted_namespace_ids.push(namespace_id);
        }
    }
    let namespace_rows =
        UserRepository::list_namespaces_by_ids(mysql, &granted_namespace_ids).await?;

    let external_entity_types: HashSet<String> =
        resolvers.external_types().map(ToOwned::to_owned).collect();
    let mut external_plugin_ids = HashSet::new();
    for entity_type in &external_entity_types {
        if !grants_by_plugin_id
            .values()
            .flatten()
            .any(|grant| grant.entity_type == *entity_type && !grant.entity_id.is_empty())
        {
            continue;
        }
        let entity_ids = crate::plugins_marketplace::db::distinct_entity_resource_ids(
            mysql,
            "Plugin",
            entity_type,
        )
        .await?;
        if entity_ids.is_empty() {
            continue;
        }
        let matched = resolvers
            .match_bindings(
                redis,
                user_id,
                entity_type,
                &entity_ids,
                ResolutionPurpose::ResourceAccess,
            )
            .await?;
        external_plugin_ids.extend(
            crate::plugins_marketplace::db::resource_ids_by_entity_ids(
                mysql,
                "Plugin",
                entity_type,
                &matched,
            )
            .await?,
        );
    }

    Ok(Some(AccessContext {
        namespace_ids: user_namespaces
            .iter()
            .map(|row: &NamespaceRow| row.id.to_string())
            .collect(),
        namespace_names: user_namespaces.iter().map(|row| row.name.clone()).collect(),
        namespace_names_by_id: namespace_rows
            .iter()
            .map(|row| (row.id.to_string(), row.name.clone()))
            .collect(),
        external_plugin_ids,
        external_entity_types,
    }))
}

/// `marketplace_name_for_visibility` (`plugin_marketplace_identity.py`).
pub(super) fn marketplace_name_for_visibility(visibility: &str) -> &'static str {
    match visibility {
        "personal" => "wework-personal",
        "public" => "wework",
        _ => "wegent",
    }
}

/// `_source_provider`.
pub(super) fn source_provider(plugin: &PluginRow) -> &'static str {
    if plugin.source_provider == "codex" {
        "codex"
    } else if plugin.source_type == "submission" {
        "user"
    } else {
        "wegent"
    }
}

/// `_source_label`.
pub(super) fn source_label(plugin: &PluginRow) -> &'static str {
    if plugin.source_provider == "codex" {
        "Codex 官方 · Wework 镜像"
    } else if plugin.visibility == "personal" {
        "个人插件"
    } else if plugin.source_type == "submission" {
        "社区插件"
    } else {
        "Wegent 官方"
    }
}

/// `installed_plugin_kind_name`: `"{slug[:89]}-{sha256('{ns}:{slug}')[:10]}"`.
pub(super) fn kind_name(catalog_namespace: &str, slug: &str) -> String {
    let digest = Sha256::digest(format!("{catalog_namespace}:{slug}").as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let prefix: String = slug.chars().take(89).collect();
    format!("{prefix}-{}", &hex[..10])
}

/// `_component_states`: `{prefix:name: true}` over the scan report's component
/// lists.
pub(super) fn component_states(components: &Value) -> Value {
    let mut states = serde_json::Map::new();
    for (key, prefix) in [
        ("skills", "skill"),
        ("commands", "command"),
        ("agents", "agent"),
        ("hooks", "hook"),
        ("mcps", "mcp"),
        ("lsps", "lsp"),
        ("monitors", "monitor"),
        ("bins", "bin"),
    ] {
        let Some(items) = components.get(key).and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            if let Some(name) = item.get("name").and_then(Value::as_str)
                && !name.is_empty()
            {
                states.insert(format!("{prefix}:{name}"), Value::Bool(true));
            }
        }
    }
    Value::Object(states)
}

/// Build the advanced release document while preserving its runtime preferences.
fn installed_payload(
    plugin: &PluginRow,
    release: &PluginReleaseRow,
    current: &InstalledSpec,
) -> Value {
    let scan_report = release.scan_report_json.0.to_value();
    let components = scan_report
        .get("components")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    let interface = release.interface_json.0.to_value();

    let mut spec = serde_json::Map::new();
    spec.insert(
        "source".to_string(),
        serde_json::json!({
            "type": "marketplace",
            "providerKey": "wegent-market",
            "pluginKey": plugin.name,
            "catalogItemId": plugin.id.to_string(),
            "marketplace": marketplace_name_for_visibility(&plugin.visibility),
        }),
    );
    spec.insert("origin".to_string(), Value::String("market".to_string()));
    spec.insert("pluginId".to_string(), Value::from(plugin.id));
    spec.insert("releaseId".to_string(), Value::from(release.id));
    spec.insert(
        "desiredVersion".to_string(),
        Value::String(release.version.clone()),
    );
    spec.insert(
        "sourceProvider".to_string(),
        Value::String(source_provider(plugin).to_string()),
    );
    spec.insert(
        "sourceLabel".to_string(),
        Value::String(source_label(plugin).to_string()),
    );
    spec.insert(
        "visibility".to_string(),
        Value::String(plugin.visibility.clone()),
    );
    spec.insert(
        "displayName".to_string(),
        Value::String(plugin.display_name.clone()),
    );
    let description = if plugin.summary.is_empty() {
        plugin.description_md.clone()
    } else {
        plugin.summary.clone()
    };
    spec.insert("description".to_string(), Value::String(description));
    spec.insert(
        "version".to_string(),
        Value::String(release.version.clone()),
    );
    spec.insert(
        "installState".to_string(),
        Value::String("installed".to_string()),
    );
    spec.insert("manifest".to_string(), release.manifest_json.0.to_value());
    spec.insert("components".to_string(), components);
    spec.insert(
        "interface".to_string(),
        if interface.is_null() {
            Value::Null
        } else {
            interface
        },
    );
    spec.insert(
        "packageRef".to_string(),
        serde_json::json!({
            "storageKey": release.storage_key,
            "checksum": format!("sha256:{}", release.sha256),
            "sizeBytes": release.size_bytes,
        }),
    );
    spec.insert(
        "sourcePayload".to_string(),
        serde_json::json!({ "releaseId": release.id }),
    );

    // Preserve runtime preferences and legacy defaults: enabled defaults true,
    // `componentStates` falsy-to-`{}`, and `updatePolicy` restricted to
    // `manual`/`auto` (default `auto`).
    spec.insert(
        "enabled".to_string(),
        Value::Bool(current.enabled.as_ref().map(truthy).unwrap_or(true)),
    );
    let component_states = current
        .component_states
        .clone()
        .filter(truthy)
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    spec.insert("componentStates".to_string(), component_states);
    let update_policy = match current.update_policy.as_deref() {
        Some("manual") | Some("auto") => current.update_policy.clone().unwrap_or_default(),
        _ => "auto".to_string(),
    };
    spec.insert("updatePolicy".to_string(), Value::String(update_policy));

    serde_json::json!({
        "apiVersion": "agent.wecode.io/v1",
        "kind": "InstalledPlugin",
        "metadata": {
            "name": kind_name(&plugin.catalog_namespace, &plugin.slug),
            "namespace": "default",
        },
        "spec": Value::Object(spec),
        "status": { "state": "PendingSync" },
    })
}

/// Python truthiness for a stored JSON scalar (`bool(value)`).
use brz_json::adapters::python_truthy as truthy;

#[cfg(test)]
#[path = "auto_update_tests.rs"]
mod tests;
