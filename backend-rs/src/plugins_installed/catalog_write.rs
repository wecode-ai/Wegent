// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Write-side helpers of `reconcile_stale_installed_catalog_refs`: applying a
//! matched catalog reference to an `InstalledPlugin` kind, deactivating
//! duplicates and orphaned installs, and converging their device-installation
//! rows. Source: the `_apply_catalog_ref_to_installed_kind`,
//! `_detach_stale_catalog_ref_from_installed_kind`,
//! `_deactivate_orphaned_catalog_install`, `_deactivate_duplicate_installed_
//! kind`, `_clear_device_installations`, and `_reset_failed_device_
//! installations` helpers of `app/services/plugin_marketplace_service.py`.

use brz_mysql::{Mysql, MysqlResult};
use serde_json::Value;

use crate::plugins_marketplace::db::{InstalledKindRow, PluginReleaseRow, PluginRow};

use super::auto_update::{
    component_states, kind_name, marketplace_name_for_visibility, source_label, source_provider,
};
use super::catalog_reconcile::{DELETE_DEVICE_BY_KIND_QUERY, FAILED_DEVICE_ROWS_QUERY, spec_str};

/// The MySQL `DATETIME` literal shape (`YYYY-MM-DD HH:MM:SS.ffffff`).
fn now_literal() -> String {
    chrono::Utc::now()
        .naive_utc()
        .format("%Y-%m-%d %H:%M:%S%.6f")
        .to_string()
}

pub(super) async fn write_kind<M: Mysql>(
    mysql: &M,
    id: i64,
    json: &Value,
    name: Option<&str>,
    is_active: Option<bool>,
) -> MysqlResult<()> {
    let serialized = serde_json::to_string(json).expect("kind document serializes");
    let updated_at = now_literal();
    match (name, is_active) {
        (Some(name), Some(is_active)) => {
            mysql
                .execute(
                    "UPDATE kinds SET json=?, name=?, is_active=?, updated_at=? WHERE kinds.id = ?",
                    (serialized, name.to_string(), is_active, updated_at, id),
                )
                .await?;
        }
        (Some(name), None) => {
            mysql
                .execute(
                    "UPDATE kinds SET json=?, name=?, updated_at=? WHERE kinds.id = ?",
                    (serialized, name.to_string(), updated_at, id),
                )
                .await?;
        }
        _ => {
            mysql
                .execute(
                    "UPDATE kinds SET json=?, is_active=?, updated_at=? WHERE kinds.id = ?",
                    (serialized, is_active, updated_at, id),
                )
                .await?;
        }
    }
    Ok(())
}

/// `_apply_catalog_ref_to_installed_kind`.
pub(super) async fn apply_catalog_ref_to_installed_kind<M: Mysql>(
    mysql: &M,
    row: &InstalledKindRow,
    plugin: &PluginRow,
    release: &PluginReleaseRow,
) -> MysqlResult<()> {
    let mut document = row.json.0.to_value();
    let mut spec = document
        .get("spec")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut source = spec
        .get("source")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    source.insert("type".to_string(), Value::String("marketplace".to_string()));
    source.insert(
        "providerKey".to_string(),
        Value::String("wegent-market".to_string()),
    );
    source.insert("pluginKey".to_string(), Value::String(plugin.name.clone()));
    source.insert(
        "catalogItemId".to_string(),
        Value::String(plugin.id.to_string()),
    );
    source.insert(
        "marketplace".to_string(),
        Value::String(marketplace_name_for_visibility(&plugin.visibility).to_string()),
    );
    let package_ref = serde_json::json!({
        "storageKey": release.storage_key,
        "checksum": format!("sha256:{}", release.sha256),
        "sizeBytes": release.size_bytes,
    });
    let mut source_payload = spec
        .get("sourcePayload")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    source_payload.insert("releaseId".to_string(), Value::from(release.id));

    spec.insert("source".to_string(), Value::Object(source));
    spec.insert(
        "origin".to_string(),
        spec.get("origin")
            .cloned()
            .unwrap_or_else(|| Value::String("market".to_string())),
    );
    spec.insert("pluginId".to_string(), Value::from(plugin.id));
    spec.insert("releaseId".to_string(), Value::from(release.id));
    spec.insert(
        "desiredVersion".to_string(),
        Value::String(release.version.clone()),
    );
    spec.insert(
        "version".to_string(),
        Value::String(release.version.clone()),
    );
    if !plugin.display_name.is_empty() {
        spec.insert(
            "displayName".to_string(),
            Value::String(plugin.display_name.clone()),
        );
    }
    let description = if !plugin.summary.is_empty() {
        plugin.summary.clone()
    } else if !plugin.description_md.is_empty() {
        plugin.description_md.clone()
    } else {
        spec.get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    spec.insert("description".to_string(), Value::String(description));
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
        "installState".to_string(),
        Value::String("installed".to_string()),
    );
    if !release.manifest_json.0.is_null() {
        spec.insert("manifest".to_string(), release.manifest_json.0.to_value());
    }
    if !release.interface_json.0.is_null() {
        spec.insert("interface".to_string(), release.interface_json.0.to_value());
    }
    let scan_report = release.scan_report_json.0.to_value();
    let components = scan_report
        .get("components")
        .filter(|value| value.is_object())
        .cloned();
    if let Some(components) = components {
        spec.insert("components".to_string(), component_states(&components));
    }
    spec.insert("packageRef".to_string(), package_ref);
    spec.insert("sourcePayload".to_string(), Value::Object(source_payload));
    document
        .as_object_mut()
        .expect("kind document is an object")
        .insert("spec".to_string(), Value::Object(spec));

    let slug = if plugin.slug.is_empty() {
        plugin.name.as_str()
    } else {
        plugin.slug.as_str()
    };
    let name = kind_name(&plugin.catalog_namespace, slug);
    if let Some(metadata) = document.get_mut("metadata").and_then(Value::as_object_mut) {
        metadata.insert("name".to_string(), Value::String(name.clone()));
    }
    write_kind(mysql, row.id, &document, Some(&name), None).await
}

/// `_detach_stale_catalog_ref_from_installed_kind` applied in place.
pub(super) fn detach_stale_catalog_ref(document: &mut Value) {
    let Some(spec) = document.get_mut("spec").and_then(Value::as_object_mut) else {
        return;
    };
    if let Some(source) = spec.get_mut("source").and_then(Value::as_object_mut) {
        source.remove("catalogItemId");
    }
    spec.insert("pluginId".to_string(), Value::Null);
    spec.insert("releaseId".to_string(), Value::Null);
    spec.insert("packageRef".to_string(), Value::Null);
    spec.insert(
        "installState".to_string(),
        Value::String("installed".to_string()),
    );
    if let Some(source_payload) = spec.get_mut("sourcePayload").and_then(Value::as_object_mut) {
        source_payload.remove("releaseId");
    }
}

/// `_deactivate_orphaned_catalog_install`.
pub(super) async fn deactivate_orphaned_catalog_install<M: Mysql>(
    mysql: &M,
    row: &InstalledKindRow,
) -> MysqlResult<()> {
    let mut document = row.json.0.to_value();
    detach_stale_catalog_ref(&mut document);
    if let Some(spec) = document.get_mut("spec").and_then(Value::as_object_mut) {
        spec.insert("enabled".to_string(), Value::Bool(false));
        spec.insert(
            "installState".to_string(),
            Value::String("uninstalled".to_string()),
        );
    }
    write_kind(mysql, row.id, &document, None, Some(false)).await
}

/// `_deactivate_duplicate_installed_kind`. Returns whether the row changed.
pub(super) async fn deactivate_duplicate_installed_kind<M: Mysql>(
    mysql: &M,
    row: &InstalledKindRow,
) -> MysqlResult<bool> {
    let mut document = row.json.0.to_value();
    let install_state = spec_str(&document, "installState");
    if !row.is_active && install_state == "uninstalled" {
        return Ok(false);
    }
    if let Some(spec) = document.get_mut("spec").and_then(Value::as_object_mut) {
        spec.insert("enabled".to_string(), Value::Bool(false));
        spec.insert(
            "installState".to_string(),
            Value::String("uninstalled".to_string()),
        );
    }
    write_kind(mysql, row.id, &document, None, Some(false)).await?;
    clear_device_installations(mysql, row.id).await?;
    Ok(true)
}

/// `_clear_device_installations`.
pub(super) async fn clear_device_installations<M: Mysql>(
    mysql: &M,
    installed_kind_id: i64,
) -> MysqlResult<()> {
    mysql
        .execute(DELETE_DEVICE_BY_KIND_QUERY, (installed_kind_id,))
        .await?;
    Ok(())
}

/// `_reset_failed_device_installations`.
pub(super) async fn reset_failed_device_installations<M: Mysql>(
    mysql: &M,
    installed_kind_id: i64,
    release_id: i64,
) -> MysqlResult<()> {
    #[derive(Debug, brz_mysql::FromMysqlRow)]
    struct IdRow {
        plugin_device_installations_id: i64,
    }
    let rows: Vec<IdRow> = mysql
        .fetch_all(FAILED_DEVICE_ROWS_QUERY, (installed_kind_id,))
        .await?;
    let updated_at = now_literal();
    for row in rows {
        mysql
            .execute(
                "UPDATE plugin_device_installations SET state='pending', desired_release_id=?, \
                 error_code='', error_message='', attempt_count=0, updated_at=? WHERE \
                 plugin_device_installations.id = ?",
                (
                    release_id,
                    updated_at.clone(),
                    row.plugin_device_installations_id,
                ),
            )
            .await?;
    }
    Ok(())
}
