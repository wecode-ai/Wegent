// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `plugin_marketplace_service.reconcile_stale_installed_catalog_refs`.
//!
//! Source: `app/services/plugin_marketplace_service.py::
//! reconcile_stale_installed_catalog_refs` (line 161) and the catalog-ref
//! helpers it calls (`_matching_published_plugin`, `_installed_kind_catalog_
//! score`, `_reconcile_installed_kind_catalog_ref`, `_apply_catalog_ref_to_
//! installed_kind`, `_deactivate_duplicate_installed_kind`,
//! `_deactivate_orphaned_catalog_install`, `_clear_device_installations`,
//! `_reset_failed_device_installations`).
//!
//! Repairs `InstalledPlugin` kinds rows whose catalog ids drifted after a DB
//! reimport: matches each marketplace install to the current published catalog
//! by pluginKey, remaps `pluginId`/`releaseId`, detaches orphaned cloud refs,
//! deactivates duplicate installs for one pluginKey, and drops leftover device
//! installation rows that no longer point at an active install. The source
//! commits only when at least one row changed.

use std::collections::{HashMap, HashSet};

use brz_mysql::{Mysql, MysqlResult};
use serde_json::Value;

use crate::permissions::EntityResolvers;
use crate::plugins_marketplace::db::{
    DEVICE_COLUMNS, DeviceInstallationRow, GRANT_COLUMNS, InstalledKindRow, KIND_COLUMNS,
    PLUGIN_COLUMNS, PluginReleaseRow, PluginRow, RELEASE_COLUMNS, ResourceMemberRow,
};

use super::auto_update::{can_access_plugin, load_access_context, marketplace_name_for_visibility};
use super::catalog_write::{
    apply_catalog_ref_to_installed_kind, clear_device_installations,
    deactivate_duplicate_installed_kind, deactivate_orphaned_catalog_install,
    reset_failed_device_installations,
};

/// One active `InstalledPlugin` kinds row (`_desired_installs` projection).
const LIST_INSTALLED_QUERY: &str = "SELECT {cols} FROM kinds WHERE kinds.user_id = ? AND \
     kinds.kind = 'InstalledPlugin' AND kinds.namespace = 'default' AND kinds.is_active IS true \
     ORDER BY kinds.id ASC";

/// `db.get(Plugin, id)` — the by-primary-key lookup the source uses for a
/// stored catalog id.
const PLUGIN_BY_ID_QUERY: &str = "SELECT {cols} FROM plugins WHERE plugins.id = ?";

/// `db.get(PluginRelease, id)`.
const RELEASE_BY_ID_QUERY: &str = "SELECT {cols} FROM plugin_releases WHERE plugin_releases.id = ?";

/// `_can_access_plugin`'s own grant read when no grants are preloaded.
const PLUGIN_GRANTS_QUERY: &str = "SELECT {cols} FROM resource_members WHERE \
     resource_members.resource_type IN ('Plugin', 'PLUGIN') AND resource_members.resource_id = ? \
     AND resource_members.status IN ('approved', 'APPROVED')";

/// `_published_plugin_by_key`: published, accessible plugins with the key as
/// name or slug.
const PUBLISHED_BY_KEY_QUERY: &str = "SELECT {cols} FROM plugins WHERE plugins.status = \
     'published' AND plugins.visibility IN ('personal', 'workspace', 'public') AND \
     (plugins.name = ? OR plugins.slug = ?) ORDER BY plugins.id DESC";

/// `reconcile_stale_installed_catalog_refs`'s `stale_device_rows` read.
const USER_DEVICE_ROWS_QUERY: &str =
    "SELECT {cols} FROM plugin_device_installations WHERE plugin_device_installations.user_id = ?";

/// `_clear_device_installations`.
pub(super) const DELETE_DEVICE_BY_KIND_QUERY: &str = "DELETE FROM plugin_device_installations WHERE plugin_device_installations.installed_kind_id = ?";

/// `db.delete(device_row)`.
const DELETE_DEVICE_BY_ID_QUERY: &str =
    "DELETE FROM plugin_device_installations WHERE plugin_device_installations.id = ?";

/// `_reset_failed_device_installations`'s failing-row read.
pub(super) const FAILED_DEVICE_ROWS_QUERY: &str = "SELECT plugin_device_installations.id AS \
     plugin_device_installations_id FROM plugin_device_installations WHERE \
     plugin_device_installations.installed_kind_id = ? AND plugin_device_installations.state = \
     'failed'";

/// The source's SQLAlchemy identity-map semantics for `Plugin` rows.
///
/// The identity map is weak: a `db.get(Plugin, id)` only avoids a query when
/// some live local still strongly references that row. The references that
/// matter, proven by the recorded sync-device exchanges:
///
/// - `reconcile_stale_installed_catalog_refs`'s `matched` local is reassigned
///   by each phase-A iteration (the previous plugin dies at reassignment) and
///   the last iteration's plugin stays referenced through phases B and C;
/// - `_reconcile_installed_kind_catalog_ref`'s own `plugin`, `release`, and
///   `matched` locals keep their rows alive only for that one call.
///
/// Every other `db.get` re-reads the row, so `get_plugin` takes the rows that
/// are strongly referenced at its call site instead of caching. Releases are
/// never referenced between helper calls; `get_release` always queries, and
/// `_latest_release` only reuses the caller's `release` local when both read
/// the same id.
async fn get_plugin<M: Mysql>(
    alive: &[Option<&PluginRow>],
    mysql: &M,
    id: i64,
) -> MysqlResult<Option<PluginRow>> {
    for row in alive.iter().flatten() {
        if row.id == id {
            return Ok(Some((*row).clone()));
        }
    }
    let row: Option<PluginRow> = mysql
        .fetch_optional(PLUGIN_BY_ID_QUERY.replace("{cols}", PLUGIN_COLUMNS), (id,))
        .await?;
    Ok(row)
}

/// `db.get(PluginRelease, id)`: never an identity-map hit between helper
/// calls, because no strong reference to a release row survives them.
async fn get_release<M: Mysql>(mysql: &M, id: i64) -> MysqlResult<Option<PluginReleaseRow>> {
    let row: Option<PluginReleaseRow> = mysql
        .fetch_optional(
            RELEASE_BY_ID_QUERY.replace("{cols}", RELEASE_COLUMNS),
            (id,),
        )
        .await?;
    Ok(row)
}

/// `_latest_release`'s `db.get(PluginRelease, plugin.latest_release_id)`:
/// an identity-map hit only when the caller's `release` local already holds
/// that row (both reads use the same id inside one
/// `_reconcile_installed_kind_catalog_ref` call).
async fn get_release_or_alive<M: Mysql>(
    alive_release: Option<&PluginReleaseRow>,
    mysql: &M,
    id: i64,
) -> MysqlResult<Option<PluginReleaseRow>> {
    if alive_release.is_some_and(|release| release.id == id) {
        return Ok(alive_release.cloned());
    }
    get_release(mysql, id).await
}

/// `spec.<key>` as a string (`str(value or "")`).
pub(super) fn spec_str(json: &Value, key: &str) -> String {
    json.get("spec")
        .and_then(|spec| spec.get(key))
        .map(as_python_str)
        .unwrap_or_default()
}

/// `spec.source.<key>` as a string.
fn source_str(json: &Value, key: &str) -> String {
    json.get("spec")
        .and_then(|spec| spec.get("source"))
        .and_then(|source| source.get(key))
        .map(as_python_str)
        .unwrap_or_default()
}

/// `str(value or "")` for the scalar shapes the stored documents use.
fn as_python_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Python `isinstance(value, int)` for a stored JSON scalar.
fn as_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        _ => None,
    }
}

/// `source.get("type")`.
fn source_type(json: &Value) -> Option<&str> {
    json.get("spec")
        .and_then(|spec| spec.get("source"))
        .and_then(|source| source.get("type"))
        .and_then(Value::as_str)
}

/// Build the value for a `{cols}` SQL template constant.
fn sql(template: &str, cols: &str) -> String {
    template.replace("{cols}", cols)
}

/// `_can_access_plugin` when the caller passes no preloaded grants/context.
async fn plugin_can_access<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    plugin: &PluginRow,
    user_id: i64,
) -> MysqlResult<bool>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    if plugin.visibility == "public" {
        return Ok(true);
    }
    if plugin.owner_user_id == user_id {
        return Ok(true);
    }
    let grants: Vec<ResourceMemberRow> = mysql
        .fetch_all(sql(PLUGIN_GRANTS_QUERY, GRANT_COLUMNS), (plugin.id,))
        .await?;
    if grants.is_empty() {
        return Ok(plugin.visibility == "workspace");
    }
    if grants
        .iter()
        .any(|grant| grant.entity_type == "user" && grant.entity_id == user_id.to_string())
    {
        return Ok(true);
    }
    let external_types: HashSet<String> =
        resolvers.external_types().map(ToOwned::to_owned).collect();
    let has_namespace = grants.iter().any(|grant| grant.entity_type == "namespace");
    let has_external = grants
        .iter()
        .any(|grant| external_types.contains(&grant.entity_type));
    if !has_namespace && !has_external {
        return Ok(false);
    }
    let mut by_plugin: HashMap<i64, Vec<ResourceMemberRow>> = HashMap::new();
    by_plugin.insert(plugin.id, grants);
    let context = load_access_context(mysql, redis, resolvers, user_id, &by_plugin).await?;
    let grants = by_plugin.get(&plugin.id).map(Vec::as_slice).unwrap_or(&[]);
    Ok(can_access_plugin(
        plugin,
        Some(user_id),
        grants,
        context.as_ref(),
    ))
}

/// `_published_plugin_by_key`.
async fn published_plugin_by_key<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    plugin_key: &str,
    marketplace: &str,
) -> MysqlResult<Option<PluginRow>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let normalized = plugin_key.trim();
    if normalized.is_empty() {
        return Ok(None);
    }
    let candidates: Vec<PluginRow> = mysql
        .fetch_all(
            sql(PUBLISHED_BY_KEY_QUERY, PLUGIN_COLUMNS),
            (normalized, normalized),
        )
        .await?;
    let normalized_marketplace = marketplace.trim().to_lowercase();
    for plugin in candidates {
        if !normalized_marketplace.is_empty()
            && marketplace_name_for_visibility(&plugin.visibility) != normalized_marketplace
        {
            continue;
        }
        if plugin_can_access(mysql, redis, resolvers, &plugin, user_id).await? {
            return Ok(Some(plugin));
        }
    }
    Ok(None)
}

/// One `_matching_published_plugin` lookup.
struct PluginMatch<'a> {
    user_id: i64,
    plugin_key: &'a str,
    plugin_id: Option<i64>,
    marketplace: &'a str,
}

/// `_matching_published_plugin`.
///
/// `caller_plugin` is the caller's live `plugin` local (when the caller is
/// `_reconcile_installed_kind_catalog_ref`, which reads the same plugin id
/// before matching); `matched_alive` is the enclosing function's `matched`
/// local. During the call both are strong references, so `db.get(Plugin, id)`
/// hits the identity map for either.
async fn matching_published_plugin<M, R>(
    matched_alive: Option<&PluginRow>,
    caller_plugin: Option<&PluginRow>,
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    request: &PluginMatch<'_>,
) -> MysqlResult<Option<PluginRow>>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let alive = [matched_alive, caller_plugin];
    let plugin = match request.plugin_id {
        Some(id) => get_plugin(&alive, mysql, id).await?,
        None => None,
    };
    if let Some(plugin) = plugin {
        let normalized_key = request.plugin_key.trim().to_lowercase();
        if normalized_key == plugin.name.to_lowercase()
            || normalized_key == plugin.slug.to_lowercase()
        {
            let accessible = plugin.status == "published"
                && matches!(
                    plugin.visibility.as_str(),
                    "personal" | "workspace" | "public"
                )
                && plugin_can_access(mysql, redis, resolvers, &plugin, request.user_id).await?;
            return Ok(accessible.then_some(plugin));
        }
    }
    published_plugin_by_key(
        mysql,
        redis,
        resolvers,
        request.user_id,
        request.plugin_key,
        request.marketplace,
    )
    .await
}

/// `_latest_release`: the plugin's latest release when it is ready and scanned.
/// `caller_release` is the caller's live `release` local, which keeps the row
/// in the identity map for the duration of one
/// `_reconcile_installed_kind_catalog_ref` call.
async fn latest_release<M: Mysql>(
    caller_release: Option<&PluginReleaseRow>,
    mysql: &M,
    plugin: &PluginRow,
) -> MysqlResult<Option<PluginReleaseRow>> {
    if plugin.latest_release_id == 0 {
        return Ok(None);
    }
    let release = get_release_or_alive(caller_release, mysql, plugin.latest_release_id).await?;
    Ok(release.filter(|release| release.status == "ready" && release.scan_status == "passed"))
}

/// `_installed_kind_catalog_score`: catalog-match scoring for the keeper
/// choice. The call's own `plugin`/`release` locals die at return, so only the
/// enclosing function's `matched` local can serve a plugin without a query.
async fn installed_kind_catalog_score<M: Mysql>(
    matched_alive: Option<&PluginRow>,
    mysql: &M,
    json: &Value,
    row_id: i64,
) -> MysqlResult<(i64, i64, i64)> {
    let plugin_key = source_str(json, "pluginKey").trim().to_lowercase();
    let plugin_id = json
        .get("spec")
        .and_then(|spec| spec.get("pluginId"))
        .and_then(as_int);
    let release_id = json
        .get("spec")
        .and_then(|spec| spec.get("releaseId"))
        .and_then(as_int);
    let plugin = match plugin_id {
        Some(id) => get_plugin(&[matched_alive], mysql, id).await?,
        None => None,
    };
    let release = match release_id {
        Some(id) => get_release(mysql, id).await?,
        None => None,
    };
    let key_ok = plugin.as_ref().is_some_and(|plugin| {
        !plugin_key.is_empty()
            && (plugin_key == plugin.name.to_lowercase()
                || plugin_key == plugin.slug.to_lowercase())
    });
    let release_ok = release.as_ref().is_some_and(|release| {
        plugin
            .as_ref()
            .is_some_and(|plugin| release.plugin_id == plugin.id)
    });
    Ok((i64::from(key_ok), i64::from(release_ok), row_id))
}

/// `_reconcile_installed_kind_catalog_ref`. Returns whether the row changed.
///
/// The call's `plugin`, `release`, and `matched` locals keep their rows in the
/// identity map for the duration of the call; all of them die at return.
async fn reconcile_installed_kind_catalog_ref<M, R>(
    matched_alive: Option<&PluginRow>,
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
    row: &InstalledKindRow,
    plugin_key: &str,
) -> MysqlResult<bool>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let json = row.json.0.to_value();
    if source_type(&json) != Some("marketplace") {
        return Ok(false);
    }
    let plugin_id = json
        .get("spec")
        .and_then(|spec| spec.get("pluginId"))
        .and_then(as_int);
    let release_id = json
        .get("spec")
        .and_then(|spec| spec.get("releaseId"))
        .and_then(as_int);
    let plugin = match plugin_id {
        Some(id) => get_plugin(&[matched_alive], mysql, id).await?,
        None => None,
    };
    let release = match release_id {
        Some(id) => get_release(mysql, id).await?,
        None => None,
    };
    let marketplace = source_str(&json, "marketplace");
    let matched = matching_published_plugin(
        matched_alive,
        plugin.as_ref(),
        mysql,
        redis,
        resolvers,
        &PluginMatch {
            user_id,
            plugin_key,
            plugin_id,
            marketplace: &marketplace,
        },
    )
    .await?;

    let key_mismatch = plugin.as_ref().is_some_and(|plugin| {
        !plugin_key.to_lowercase().eq(&plugin.name.to_lowercase())
            && !plugin_key.to_lowercase().eq(&plugin.slug.to_lowercase())
    });
    let release_missing = release_id.is_some() && release.is_none();
    let plugin_missing = plugin_id.is_some() && plugin.is_none();
    let release_wrong = matched.as_ref().is_some_and(|matched| {
        release
            .as_ref()
            .is_some_and(|release| release.plugin_id != matched.id)
    });
    let needs_repair = key_mismatch || release_missing || plugin_missing || release_wrong;

    if let Some(matched) = matched {
        let mut target = latest_release(release.as_ref(), mysql, &matched).await?;
        if let Some(release) = &release
            && release.plugin_id == matched.id
            && release.status == "ready"
            && release.scan_status == "passed"
        {
            target = Some(release.clone());
        }
        let Some(target) = target else {
            deactivate_orphaned_catalog_install(mysql, row).await?;
            clear_device_installations(mysql, row.id).await?;
            return Ok(true);
        };
        let expected_marketplace = marketplace_name_for_visibility(&matched.visibility);
        let catalog_item_id = source_str(&json, "catalogItemId");
        if !needs_repair
            && plugin_id == Some(matched.id)
            && release_id == Some(target.id)
            && catalog_item_id == matched.id.to_string()
            && marketplace == expected_marketplace
        {
            return Ok(false);
        }
        apply_catalog_ref_to_installed_kind(mysql, row, &matched, &target).await?;
        reset_failed_device_installations(mysql, row.id, target.id).await?;
        return Ok(true);
    }

    let has_cloud_ref = plugin_id.is_some()
        || release_id.is_some()
        || !source_str(&json, "catalogItemId").is_empty();
    if !(needs_repair || has_cloud_ref) {
        return Ok(false);
    }
    deactivate_orphaned_catalog_install(mysql, row).await?;
    clear_device_installations(mysql, row.id).await?;
    Ok(true)
}

/// Source `reconcile_stale_installed_catalog_refs`. Returns the changed count.
pub(super) async fn reconcile_stale_installed_catalog_refs<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user_id: i64,
) -> MysqlResult<usize>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let rows: Vec<InstalledKindRow> = mysql
        .fetch_all(sql(LIST_INSTALLED_QUERY, KIND_COLUMNS), (user_id,))
        .await?;
    if rows.is_empty() {
        return Ok(0);
    }
    let mut changed = 0usize;

    // Group marketplace installs by their catalog identity, preserving the
    // source's insertion order. `matched_local` mirrors the source's `matched`
    // local: reassigned at the end of each iteration, so the previous plugin
    // loses its last strong reference exactly then.
    let mut matched_local: Option<PluginRow> = None;
    let mut by_key: Vec<((String, String), Vec<usize>)> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let json = row.json.0.to_value();
        if source_type(&json) != Some("marketplace") {
            continue;
        }
        let plugin_key = source_str(&json, "pluginKey").trim().to_string();
        if plugin_key.is_empty() {
            continue;
        }
        let marketplace = source_str(&json, "marketplace");
        let plugin_id = json
            .get("spec")
            .and_then(|spec| spec.get("pluginId"))
            .and_then(as_int);
        let matched = matching_published_plugin(
            matched_local.as_ref(),
            None,
            mysql,
            redis,
            resolvers,
            &PluginMatch {
                user_id,
                plugin_key: &plugin_key,
                plugin_id,
                marketplace: &marketplace,
            },
        )
        .await?;
        // The source reassigns `matched` after the helper returns; the previous
        // plugin is garbage-collected at that point (weak identity map).
        matched_local = matched;
        let identity = match &matched_local {
            Some(plugin) => ("plugin".to_string(), plugin.id.to_string()),
            None => (marketplace.to_lowercase(), plugin_key.to_lowercase()),
        };
        match by_key.iter_mut().find(|(key, _)| *key == identity) {
            Some((_, group)) => group.push(index),
            None => by_key.push((identity, vec![index])),
        }
    }

    // Keep one row per identity (the best catalog score) and deactivate the rest.
    let mut keepers: Vec<usize> = Vec::new();
    for (_, group) in &by_key {
        let mut best = group[0];
        let mut best_score = installed_kind_catalog_score(
            matched_local.as_ref(),
            mysql,
            &rows[best].json.0.to_value(),
            rows[best].id,
        )
        .await?;
        for &index in &group[1..] {
            let score = installed_kind_catalog_score(
                matched_local.as_ref(),
                mysql,
                &rows[index].json.0.to_value(),
                rows[index].id,
            )
            .await?;
            if score > best_score {
                best = index;
                best_score = score;
            }
        }
        keepers.push(best);
        for &index in group {
            if index == best {
                continue;
            }
            if deactivate_duplicate_installed_kind(mysql, &rows[index]).await? {
                changed += 1;
            }
        }
    }

    for &index in &keepers {
        let plugin_key = source_str(&rows[index].json.0.to_value(), "pluginKey")
            .trim()
            .to_string();
        if plugin_key.is_empty() {
            continue;
        }
        if reconcile_installed_kind_catalog_ref(
            matched_local.as_ref(),
            mysql,
            redis,
            resolvers,
            user_id,
            &rows[index],
            &plugin_key,
        )
        .await?
        {
            changed += 1;
        }
    }

    // Drop device-install rows that no longer point at an active install.
    let device_rows: Vec<DeviceInstallationRow> = mysql
        .fetch_all(sql(USER_DEVICE_ROWS_QUERY, DEVICE_COLUMNS), (user_id,))
        .await?;
    let active: HashMap<i64, &InstalledKindRow> = rows.iter().map(|row| (row.id, row)).collect();
    for device_row in &device_rows {
        let keep = active
            .get(&device_row.installed_kind_id)
            .is_some_and(|kind| {
                kind.is_active && spec_str(&kind.json.0.to_value(), "installState") != "uninstalled"
            });
        if keep {
            continue;
        }
        mysql
            .execute(DELETE_DEVICE_BY_ID_QUERY, (device_row.id,))
            .await?;
        changed += 1;
    }

    if changed > 0 {
        mysql.execute("COMMIT", ()).await?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn python_str_and_int_shapes() {
        assert_eq!(as_python_str(&json!("x")), "x");
        assert_eq!(as_python_str(&json!(null)), "");
        assert_eq!(as_int(&json!(18)), Some(18));
        assert_eq!(as_int(&json!("18")), None);
        assert_eq!(as_int(&json!(true)), None);
    }

    #[test]
    fn catalog_identity_helpers_read_stored_documents() {
        let document = json!({
            "spec": {
                "source": {"type": "marketplace", "pluginKey": "Echo", "marketplace": "wegent"},
                "pluginId": 17,
            }
        });
        assert_eq!(source_type(&document), Some("marketplace"));
        assert_eq!(source_str(&document, "pluginKey"), "Echo");
        assert_eq!(spec_str(&document, "installState"), "");
        assert_eq!(
            document
                .get("spec")
                .and_then(|s| s.get("pluginId"))
                .and_then(as_int),
            Some(17)
        );
    }

    #[test]
    fn detach_stale_catalog_ref_clears_cloud_fields() {
        let mut document = json!({
            "spec": {
                "source": {"type": "marketplace", "catalogItemId": "17"},
                "pluginId": 17,
                "releaseId": 38,
                "packageRef": {"storageKey": "k"},
                "sourcePayload": {"releaseId": 38},
            }
        });
        crate::plugins_installed::catalog_write::detach_stale_catalog_ref(&mut document);
        let spec = &document["spec"];
        assert!(spec["source"].get("catalogItemId").is_none());
        assert_eq!(spec["pluginId"], Value::Null);
        assert_eq!(spec["releaseId"], Value::Null);
        assert_eq!(spec["packageRef"], Value::Null);
        assert_eq!(spec["installState"], "installed");
        assert!(spec["sourcePayload"].get("releaseId").is_none());
    }

    #[tokio::test]
    async fn release_reads_are_never_cached_across_passes() {
        // The recorded sync-device case has `plugin_releases.id = 38` read
        // twice: once in `_installed_kind_catalog_score` and once in
        // `_reconcile_installed_kind_catalog_ref`. The source's weak identity
        // map drops the release between the helper calls, so both reads reach
        // MySQL. The capture harness returns no rows, so each pass must issue
        // its own query for the same id.
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        assert!(get_release(&mysql, 38).await.unwrap().is_none());
        assert!(get_release(&mysql, 38).await.unwrap().is_none());
        let queries = mysql.queries();
        assert_eq!(queries.len(), 2);
        assert!(queries.iter().all(|query| {
            query.sql.contains("FROM plugin_releases")
                && query.sql.contains("plugin_releases.id = ?")
                && query.first_integer == Some(38)
        }));
    }

    #[tokio::test]
    async fn release_read_reuses_the_caller_local_for_latest_release() {
        // Inside one `_reconcile_installed_kind_catalog_ref` call, the
        // `release` local keeps the row alive, so `_latest_release`'s
        // `db.get(PluginRelease, latest_release_id)` does not re-query when
        // the ids are equal (recorded case: `plugin_releases.id = 150` read
        // once for both the spec release and the plugin's latest release).
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let release = release_row(150, 18);
        let resolved = get_release_or_alive(Some(&release), &mysql, 150)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(resolved.id, 150);
        assert_eq!(mysql.queries().len(), 0);
        // A different latest id must re-query.
        assert!(
            get_release_or_alive(Some(&release), &mysql, 144)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(mysql.queries().len(), 1);
    }

    #[tokio::test]
    async fn plugin_reads_hit_only_while_referenced() {
        // `db.get(Plugin, id)` avoids a query only while a live local holds
        // the row. The recorded sync-device sequence proves both sides: the
        // enclosing `matched` local serves later passes without a query
        // (plugin 10 in the recorded case), while every other pass re-reads
        // its plugin (plugin 18 re-read in the score and keeper passes).
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let alive = plugin_row(18);
        // Identity-map hit while the local is alive.
        let hit = get_plugin(&[Some(&alive)], &mysql, 18).await.unwrap();
        assert!(hit.is_some());
        assert_eq!(mysql.queries().len(), 0);
        // No strong reference: re-read.
        assert!(get_plugin(&[], &mysql, 18).await.unwrap().is_none());
        assert_eq!(mysql.queries().len(), 1);
        // A different id than the referenced row: re-read.
        assert!(
            get_plugin(&[Some(&alive)], &mysql, 10)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(mysql.queries().len(), 2);
    }

    /// A `PluginRow` with the fields the identity-map logic reads.
    fn plugin_row(id: i64) -> PluginRow {
        PluginRow {
            id,
            catalog_namespace: "enterprise".to_string(),
            slug: "slug".to_string(),
            name: "name".to_string(),
            display_name: "Display".to_string(),
            summary: "summary".to_string(),
            description_md: "md".to_string(),
            listing_type: "plugin".to_string(),
            source_type: "native".to_string(),
            source_provider: "wework".to_string(),
            owner_user_id: 0,
            origin_plugin_id: 0,
            category: String::new(),
            keywords_json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(
                Vec::<()>::new(),
            )),
            interface_json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(
                Vec::<()>::new(),
            )),
            visibility: "public".to_string(),
            allow_copy: false,
            status: "published".to_string(),
            latest_release_id: 0,
            featured_rank: 0,
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
            published_at: chrono::NaiveDateTime::default(),
        }
    }

    /// A `PluginReleaseRow` with the fields the identity-map logic reads.
    fn release_row(id: i64, plugin_id: i64) -> PluginReleaseRow {
        PluginReleaseRow {
            id,
            plugin_id,
            version: "1.0.0".to_string(),
            manifest_json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(
                Vec::<()>::new(),
            )),
            interface_json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(
                Vec::<()>::new(),
            )),
            release_notes: String::new(),
            storage_key: String::new(),
            sha256: String::new(),
            size_bytes: 0,
            status: "ready".to_string(),
            scan_status: "passed".to_string(),
            scan_report_json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(
                Vec::<()>::new(),
            )),
            created_by_user_id: 0,
            publication_revision_id: 0,
            source_commit_sha: String::new(),
            created_at: chrono::NaiveDateTime::default(),
            published_at: chrono::NaiveDateTime::default(),
        }
    }
}
