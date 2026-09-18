// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Marketplace listing service logic.
//!
//! Query-level behavior mirrors `list_plugins`, `_can_access_plugin`,
//! `_load_user_plugin_access_context`, `_to_marketplace_item`, and the small
//! helpers `_matches_source`, `_search_text`, `_source_provider`,
//! `_source_label` from the source service.
#[cfg(test)]
use crate::json_compat::OpaqueJson;
use std::collections::{HashMap, HashSet};

use brz_mysql::Mysql;

use super::components::{StringItems, components, interface_object, plugin_interface};
use super::db::{
    DeviceInstallationRow, InstalledKindRow, NamespaceRow, PluginReleaseRow, PluginRow,
    ResourceMemberRow, UserRepository, UserRow, distinct_entity_resource_ids,
    resource_ids_by_entity_ids,
};
use super::models::{
    DeviceInstallationItem, MarketplaceItem, MarketplaceListResponse, unset_id, unset_str,
};
use crate::permissions::{EntityResolvers, ResolutionPurpose};

/// Optional request filters, mirroring the endpoint's query parameters.
#[derive(Debug, Default, Clone, serde::Deserialize)]
pub struct MarketplaceQuery {
    pub q: Option<String>,
    pub source: Option<String>,
    pub listing_type: Option<String>,
    pub device_id: Option<String>,
}

/// Preloaded user/namespace membership for one listing pass.
struct AccessContext {
    namespace_ids: HashSet<String>,
    namespace_names: Vec<String>,
    namespace_names_by_id: HashMap<String, String>,
    /// Plugins granted through matched application-supplied external entities.
    external_plugin_ids: HashSet<i64>,
    /// Entity types with a resolver registered by this application.
    external_entity_types: HashSet<String>,
}

/// One user's installed-plugin selection for a plugin ID.
struct InstalledSelection {
    kind_id: i64,
    is_active: bool,
    release_id: Option<i64>,
    enabled: Option<bool>,
}

fn is_featured_rank(value: i64) -> bool {
    value != 0
}

fn source_provider(plugin: &PluginRow) -> &'static str {
    if plugin.source_provider == "codex" {
        "codex"
    } else if plugin.source_type == "submission" {
        "user"
    } else {
        "wegent"
    }
}

fn source_label(plugin: &PluginRow) -> &'static str {
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

fn matches_source(plugin: &PluginRow, source: &str) -> bool {
    let normalized = source.trim().to_ascii_lowercase();
    let featured = if is_featured_rank(plugin.featured_rank) {
        "featured"
    } else {
        ""
    };
    normalized == plugin.source_provider.to_ascii_lowercase()
        || normalized == plugin.source_type.to_ascii_lowercase()
        || normalized == featured
}

fn search_text(plugin: &PluginRow) -> String {
    let keywords = plugin
        .keywords_json
        .0
        .project::<StringItems>()
        .unwrap_or_default()
        .0
        .join(" ");
    format!(
        "{} {} {} {}",
        plugin.name, plugin.display_name, plugin.summary, keywords
    )
    .to_ascii_lowercase()
}

fn device_installation_item(row: &DeviceInstallationRow) -> DeviceInstallationItem {
    DeviceInstallationItem {
        device_id: row.device_id.clone(),
        desired_release_id: row.desired_release_id,
        actual_release_id: unset_id(row.actual_release_id),
        state: row.state.clone(),
        error_code: unset_str(&row.error_code),
        error_message: unset_str(&row.error_message),
        attempt_count: row.attempt_count,
        last_sync_at: unset_datetime(row),
        updated_at: row.updated_at.format("%Y-%m-%dT%H:%M:%S%.6f").to_string(),
    }
}

fn unset_datetime(row: &DeviceInstallationRow) -> Option<String> {
    let epoch = chrono::DateTime::from_timestamp(0, 0).map(|value| value.naive_utc());
    if Some(row.last_sync_at) == epoch {
        None
    } else {
        Some(row.last_sync_at.format("%Y-%m-%dT%H:%M:%S%.6f").to_string())
    }
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct InstalledDocumentInput {
    spec: Option<InstalledSpecInput>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct InstalledSpecInput {
    #[serde(rename = "pluginId")]
    plugin_id: Option<i64>,
    source: Option<InstalledSourceInput>,
    #[serde(rename = "releaseId")]
    release_id: Option<i64>,
    enabled: Option<bool>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct InstalledSourceInput {
    #[serde(rename = "catalogItemId")]
    catalog_item_id: Option<String>,
}

fn installed_selection(row: &InstalledKindRow) -> Option<(i64, InstalledSelection)> {
    let spec = row.json.0.project::<InstalledDocumentInput>()?.spec?;
    let plugin_id = match spec.plugin_id {
        Some(plugin_id) => plugin_id,
        None => {
            let catalog_item_id = spec.source?.catalog_item_id?;
            if !catalog_item_id.bytes().all(|byte| byte.is_ascii_digit())
                || catalog_item_id.is_empty()
            {
                return None;
            }
            catalog_item_id.parse().ok()?
        }
    };
    Some((
        plugin_id,
        InstalledSelection {
            kind_id: row.id,
            is_active: row.is_active,
            release_id: spec.release_id,
            enabled: spec.enabled,
        },
    ))
}

fn can_access_plugin(
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

/// The inputs of one marketplace listing row: the plugin and release
/// documents, the requesting viewer, and the install state resolved by the
/// caller.
struct MarketplaceItemInput<'a> {
    plugin: &'a PluginRow,
    release: &'a PluginReleaseRow,
    user_id: Option<i64>,
    device_row: Option<&'a DeviceInstallationRow>,
    installed: Option<&'a InstalledSelection>,
    owner: Option<&'a UserRow>,
    grants: &'a [ResourceMemberRow],
    external_entity_types: &'a HashSet<String>,
}

fn marketplace_item(input: MarketplaceItemInput<'_>) -> MarketplaceItem {
    let MarketplaceItemInput {
        plugin,
        release,
        user_id,
        device_row,
        installed,
        owner,
        grants,
        external_entity_types,
    } = input;
    let installed_for_device = installed
        .map(|installed| {
            installed.is_active
                && device_row
                    .map(|row| row.actual_release_id != 0)
                    .unwrap_or(true)
        })
        .unwrap_or(false);
    let access_role = if user_id.is_some_and(|user_id| plugin.owner_user_id == user_id) {
        "owner"
    } else if plugin.visibility == "personal" {
        "recipient"
    } else {
        "catalog"
    };
    let update_available = installed_for_device
        && (installed
            .and_then(|installed| installed.release_id)
            .is_none_or(|release_id| release_id != release.id)
            || device_row.is_some_and(|row| row.actual_release_id != release.id));
    let interface = interface_object(plugin, release).map(plugin_interface);
    MarketplaceItem {
        id: plugin.id,
        catalog_namespace: plugin.catalog_namespace.clone(),
        origin_personal_plugin_id: unset_id(plugin.origin_plugin_id),
        remote_plugin_id: format!("wegent~Plugin_{}", plugin.id),
        name: plugin.name.clone(),
        display_name: plugin.display_name.clone(),
        description: if !plugin.summary.is_empty() {
            plugin.summary.clone()
        } else {
            plugin.description_md.clone()
        },
        version: Some(release.version.clone()),
        author: None,
        visibility: plugin.visibility.clone(),
        featured: is_featured_rank(plugin.featured_rank),
        installed: installed_for_device,
        installed_plugin_id: installed
            .filter(|installed| installed.is_active)
            .map(|installed| installed.kind_id),
        enabled: if installed_for_device {
            installed
                .and_then(|installed| installed.enabled)
                .unwrap_or(false)
        } else {
            false
        },
        source_type: "marketplace".to_owned(),
        interface,
        components: components(&release.scan_report_json.0),
        manifest: release.manifest_json.0.to_raw_value(),
        owner_user_id: plugin.owner_user_id,
        owner_display_name: owner
            .map(|owner| owner.user_name.clone())
            .unwrap_or_default(),
        access_role: access_role.to_owned(),
        allow_copy: plugin.allow_copy,
        grant_user_count: grants
            .iter()
            .filter(|grant| grant.entity_type == "user")
            .count() as i64,
        grant_namespace_count: grants
            .iter()
            .filter(|grant| {
                grant.entity_type == "namespace"
                    || external_entity_types.contains(&grant.entity_type)
            })
            .count() as i64,
        latest_release_id: Some(release.id),
        listing_type: plugin.listing_type.clone(),
        origin: "market".to_owned(),
        source_provider: source_provider(plugin).to_owned(),
        source_label: source_label(plugin).to_owned(),
        update_available,
        current_device_installation: device_row.map(device_installation_item),
    }
}

/// Build the marketplace listing response for one request.
///
/// Errors map to a 500-class failure; the source's request path has no other
/// failure mode for this endpoint.
pub async fn list_plugins<M, R>(
    mysql: &M,
    redis: Option<&R>,
    resolvers: &EntityResolvers<R>,
    user: Option<&UserRow>,
    query: &MarketplaceQuery,
) -> Result<MarketplaceListResponse, brz_mysql::MysqlError>
where
    M: Mysql,
    R: brz_redis::Redis,
{
    let user_id = user.map(|user| user.id);
    let external_entity_types: HashSet<String> =
        resolvers.external_types().map(ToOwned::to_owned).collect();

    let rows = UserRepository::list_published_plugins(mysql).await?;

    let normalized_query = query
        .q
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_ascii_lowercase();

    let installed_by_plugin_id: HashMap<i64, InstalledSelection> = match user_id {
        Some(user_id) => {
            let installed_rows = UserRepository::list_installed_kinds(mysql, user_id).await?;
            let mut by_plugin: HashMap<i64, Vec<InstalledSelection>> = HashMap::new();
            for row in &installed_rows {
                if let Some((plugin_id, selection)) = installed_selection(row) {
                    by_plugin.entry(plugin_id).or_default().push(selection);
                }
            }
            by_plugin
                .into_iter()
                .map(|(plugin_id, mut matches)| {
                    let selected = matches
                        .iter()
                        .position(|selection| selection.is_active)
                        .unwrap_or(0);
                    (plugin_id, matches.swap_remove(selected))
                })
                .collect()
        }
        None => HashMap::new(),
    };

    let release_ids: Vec<i64> = rows
        .iter()
        .map(|plugin| plugin.latest_release_id)
        .filter(|release_id| *release_id != 0)
        .collect();
    let releases_by_id: HashMap<i64, PluginReleaseRow> =
        UserRepository::list_releases_by_ids(mysql, &release_ids)
            .await?
            .into_iter()
            .map(|release| (release.id, release))
            .collect();

    // Source: `owner_ids = {plugin.owner_user_id for plugin in rows if
    // plugin.owner_user_id}` — a set, so each owner binds once. Keep the
    // first-seen row order; Replay compares IN lists without value order.
    let mut owner_ids: Vec<i64> = Vec::new();
    for owner_id in rows.iter().map(|plugin| plugin.owner_user_id) {
        if owner_id != 0 && !owner_ids.contains(&owner_id) {
            owner_ids.push(owner_id);
        }
    }
    let owners_by_id: HashMap<i64, UserRow> = UserRepository::list_users_by_ids(mysql, &owner_ids)
        .await?
        .into_iter()
        .map(|owner| (owner.id, owner))
        .collect();

    let plugin_ids: Vec<i64> = rows.iter().map(|plugin| plugin.id).collect();
    let grants_by_plugin_id = UserRepository::list_plugin_grants(mysql, &plugin_ids).await?;

    let access_context = match user_id {
        Some(user_id) => {
            let user_namespaces = UserRepository::list_user_namespaces(mysql, user_id).await?;
            // Source: `granted_namespace_ids` is a Python set of entity-id
            // strings, so each namespace id binds once. Keep first-seen
            // order; Replay compares IN lists without value order.
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
            // Resolve registered external entity grants through the
            // application provider. The public registry has no external
            // resolver, while the private startup registers departments.
            let mut external_plugin_ids = HashSet::new();
            for entity_type in &external_entity_types {
                if !grants_by_plugin_id
                    .values()
                    .flatten()
                    .any(|grant| grant.entity_type == *entity_type && !grant.entity_id.is_empty())
                {
                    continue;
                }
                let entity_ids = distinct_entity_resource_ids(mysql, "Plugin", entity_type).await?;
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
                    resource_ids_by_entity_ids(mysql, "Plugin", entity_type, &matched).await?,
                );
            }
            Some(AccessContext {
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
                external_entity_types: external_entity_types.clone(),
            })
        }
        None => None,
    };

    let installed_kind_ids: Vec<i64> = installed_by_plugin_id
        .values()
        .map(|selection| selection.kind_id)
        .collect();
    let device_rows_by_kind_id: HashMap<i64, DeviceInstallationRow> =
        match (query.device_id.as_deref(), installed_kind_ids.is_empty()) {
            (Some(device_id), false) => {
                UserRepository::list_device_installations(mysql, &installed_kind_ids, device_id)
                    .await?
                    .into_iter()
                    .map(|row| (row.installed_kind_id, row))
                    .collect()
            }
            _ => HashMap::new(),
        };

    let mut items = Vec::new();
    for plugin in &rows {
        let grants = grants_by_plugin_id
            .get(&plugin.id)
            .cloned()
            .unwrap_or_else(Vec::new);
        if !can_access_plugin(plugin, user_id, &grants, access_context.as_ref()) {
            continue;
        }
        if let Some(listing_type) = query.listing_type.as_deref()
            && plugin.listing_type != listing_type
        {
            continue;
        }
        if let Some(source) = query.source.as_deref()
            && !matches_source(plugin, source)
        {
            continue;
        }
        if !normalized_query.is_empty() && !search_text(plugin).contains(&normalized_query) {
            continue;
        }
        let Some(release) = releases_by_id.get(&plugin.latest_release_id) else {
            continue;
        };
        let installed = installed_by_plugin_id.get(&plugin.id);
        let device_row =
            installed.and_then(|installed| device_rows_by_kind_id.get(&installed.kind_id));
        items.push(marketplace_item(MarketplaceItemInput {
            plugin,
            release,
            user_id,
            device_row,
            installed,
            owner: owners_by_id.get(&plugin.owner_user_id),
            grants: &grants,
            external_entity_types: &external_entity_types,
        }));
    }
    Ok(MarketplaceListResponse { items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDateTime;

    fn epoch() -> NaiveDateTime {
        chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc()
    }

    fn grant_row() -> ResourceMemberRow {
        ResourceMemberRow {
            id: 1,
            resource_type: "Plugin".into(),
            resource_id: 1,
            entity_type: "user".into(),
            entity_id: "0".into(),
            entity_display_name: String::new(),
            user_id: 0,
            role: "member".into(),
            status: "approved".into(),
            invited_by_user_id: 0,
            share_link_id: 0,
            reviewed_by_user_id: 0,
            reviewed_at: epoch(),
            copied_resource_id: 0,
            requested_at: epoch(),
            created_at: epoch(),
            updated_at: epoch(),
        }
    }

    fn plugin(visibility: &str, owner: i64) -> PluginRow {
        PluginRow {
            id: 1,
            catalog_namespace: "enterprise".into(),
            slug: "slug".into(),
            name: "name".into(),
            display_name: "Display".into(),
            summary: "summary".into(),
            description_md: "md".into(),
            listing_type: "plugin".into(),
            source_type: "native".into(),
            source_provider: "wework".into(),
            owner_user_id: owner,
            origin_plugin_id: 0,
            category: String::new(),
            keywords_json: brz_mysql::Json(OpaqueJson::from_serializable(Vec::<()>::new())),
            interface_json: brz_mysql::Json(OpaqueJson::from_serializable(
                std::collections::BTreeMap::<String, ()>::new(),
            )),
            visibility: visibility.into(),
            allow_copy: false,
            status: "published".into(),
            latest_release_id: 7,
            featured_rank: 0,
            created_at: epoch(),
            updated_at: epoch(),
            published_at: epoch(),
        }
    }

    #[test]
    fn public_plugins_allow_anonymous_access() {
        let plugin = plugin("public", 0);
        assert!(can_access_plugin(&plugin, None, &[], None));
    }

    #[test]
    fn workspace_plugins_require_authentication_or_grant() {
        let plugin = plugin("workspace", 52);
        assert!(!can_access_plugin(&plugin, None, &[], None));
        assert!(can_access_plugin(&plugin, Some(9), &[], None));
    }

    #[test]
    fn owner_and_user_grants_allow_personal_plugins() {
        let plugin = plugin("personal", 52);
        assert!(can_access_plugin(&plugin, Some(52), &[], None));
        let grants = [ResourceMemberRow {
            resource_id: 1,
            entity_type: "user".into(),
            entity_id: "9".into(),
            ..grant_row()
        }];
        assert!(can_access_plugin(&plugin, Some(9), &grants, None));
        assert!(!can_access_plugin(&plugin, Some(10), &grants, None));
    }

    #[test]
    fn namespace_grants_follow_membership() {
        let plugin = plugin("personal", 52);
        let grants = [ResourceMemberRow {
            resource_id: 1,
            entity_type: "namespace".into(),
            entity_id: "277".into(),
            ..grant_row()
        }];
        let mut ids = HashSet::new();
        ids.insert("92".to_owned());
        let mut names_by_id = HashMap::new();
        names_by_id.insert("277".to_owned(), "wed-rd".to_owned());
        let context = AccessContext {
            namespace_ids: ids,
            namespace_names: vec!["example_client".into()],
            namespace_names_by_id: names_by_id,
            external_plugin_ids: HashSet::new(),
            external_entity_types: HashSet::new(),
        };
        assert!(!can_access_plugin(
            &plugin,
            Some(9),
            &grants,
            Some(&context)
        ));
        let mut allowed = context;
        allowed.namespace_ids.insert("277".to_owned());
        assert!(can_access_plugin(&plugin, Some(9), &grants, Some(&allowed)));
    }

    #[test]
    fn external_entity_grants_follow_registered_resolver() {
        let plugin = plugin("personal", 52);
        let grants = [ResourceMemberRow {
            resource_id: 1,
            entity_type: "org_department".into(),
            entity_id: "Z02122".into(),
            ..grant_row()
        }];
        let mut context = AccessContext {
            namespace_ids: HashSet::new(),
            namespace_names: Vec::new(),
            namespace_names_by_id: HashMap::new(),
            external_plugin_ids: HashSet::new(),
            external_entity_types: ["org_department".to_owned()].into_iter().collect(),
        };
        // No matched external entity: the plugin stays inaccessible.
        assert!(!can_access_plugin(
            &plugin,
            Some(9),
            &grants,
            Some(&context)
        ));
        // The registered resolver matched an entity granting plugin 1.
        context.external_plugin_ids.insert(1);
        assert!(can_access_plugin(&plugin, Some(9), &grants, Some(&context)));
    }

    #[test]
    fn source_matching_uses_provider_type_and_featured() {
        let mut plugin = plugin("workspace", 0);
        plugin.featured_rank = 3;
        assert!(matches_source(&plugin, "featured"));
        assert!(matches_source(&plugin, "wework"));
        plugin.source_type = "submission".into();
        assert!(matches_source(&plugin, "Submission"));
    }

    #[test]
    fn interface_defaults_add_missing_optional_fields() {
        let raw = serde_json::json!({"displayName": "公司邮箱"});
        let interface = plugin_interface(&OpaqueJson::from(raw));
        assert_eq!(interface.display_name.as_deref(), Some("公司邮箱"));
        assert!(interface.website_url.is_none());
        assert!(interface.capabilities.is_empty());
    }

    #[test]
    fn device_item_maps_sentinels_to_null() {
        let epoch = chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc();
        let row = DeviceInstallationRow {
            id: 1,
            installed_kind_id: 2,
            device_id: "d".into(),
            desired_release_id: 3,
            actual_release_id: 0,
            state: "pending".into(),
            error_code: String::new(),
            error_message: String::new(),
            attempt_count: 0,
            last_sync_at: epoch,
            updated_at: epoch,
        };
        let item = device_installation_item(&row);
        assert!(item.actual_release_id.is_none());
        assert!(item.error_code.is_none());
        assert!(item.last_sync_at.is_none());
    }
}
