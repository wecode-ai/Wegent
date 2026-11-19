// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Batch enrichment for the installed-plugin GET without changing response semantics.
use super::{
    DeviceInstallationRow, append_device, device_has_materialized_release, installed_item_id,
    list_device_installations, list_plugins_by_ids, set_install_state,
};
use crate::device_identity::{DeviceIdentitySnapshot, coalesce_plugin_device_rows_resolved};
use brz_mysql::{Mysql, MysqlResult};
use serde_json::Value;
use std::collections::HashMap;
use std::time::Instant;

/// Preserve the device view and marketplace comparison with at most three reads.
#[tracing::instrument(name = "plugins_installed.enrich", skip_all)]
pub async fn enrich_installed_list<M: Mysql>(
    mysql: &M,
    items: &mut [Value],
    device_id: Option<&str>,
) -> MysqlResult<()> {
    let start = Instant::now();
    let items_by_id: HashMap<_, _> = items
        .iter()
        .enumerate()
        .filter_map(|(index, item)| installed_item_id(item).map(|id| (id, index)))
        .collect();
    let device_rows =
        list_device_installations(mysql, &items_by_id.keys().copied().collect::<Vec<_>>()).await?;
    let installation_count = device_rows.len();
    let installations_ms = start.elapsed().as_secs_f64() * 1000.0;
    let identity_start = Instant::now();
    let identities = device_rows
        .iter()
        .flat_map(|row| {
            std::iter::once((row.user_id, row.device_id.clone()))
                .chain(device_id.map(|id| (row.user_id, id.to_string())))
        })
        .collect();
    let mut snapshot = DeviceIdentitySnapshot::load(mysql, identities).await?;
    let coalesced =
        coalesce_plugin_device_rows_resolved(device_rows, |user, id| snapshot.resolve(user, id));
    let rows_by_install = append_devices(items, &items_by_id, &coalesced, &mut snapshot, device_id);
    let identity_ms = identity_start.elapsed().as_secs_f64() * 1000.0;
    let candidates = marketplace_candidates(items, &rows_by_install, device_id);
    let marketplace_start = Instant::now();
    let plugins =
        list_plugins_by_ids(mysql, candidates.iter().map(|(_, id)| *id).collect()).await?;
    let plugin_count = plugins.len();
    let plugins_by_id: HashMap<_, _> = plugins
        .into_iter()
        .map(|plugin| (plugin.id, plugin))
        .collect();
    for (index, plugin_id) in &candidates {
        let item = &mut items[*index];
        let release = item["spec"]["releaseId"].as_i64();
        if let Some(plugin) = plugins_by_id.get(plugin_id)
            && release.is_some_and(|id| plugin.latest_release_id != id)
        {
            set_install_state(item, "update_available");
        }
    }
    tracing::debug!(
        device_filtered = device_id.is_some(),
        item_count = items.len(),
        installation_count,
        coalesced_count = coalesced.len(),
        device_count = snapshot.device_count(),
        marketplace_candidate_count = candidates.len(),
        marketplace_plugin_count = plugin_count,
        installations_ms,
        identity_ms,
        marketplace_ms = marketplace_start.elapsed().as_secs_f64() * 1000.0,
        total_ms = start.elapsed().as_secs_f64() * 1000.0,
        "enriched installed plugins"
    );
    Ok(())
}

fn append_devices<'a>(
    items: &mut [Value],
    items_by_id: &HashMap<i64, usize>,
    coalesced: &'a [((i64, String), DeviceInstallationRow)],
    snapshot: &mut DeviceIdentitySnapshot,
    device_id: Option<&str>,
) -> HashMap<i64, &'a DeviceInstallationRow> {
    let mut rows_by_install = HashMap::new();
    for ((_, canonical_id), row) in coalesced {
        let Some(&index) = items_by_id.get(&row.installed_kind_id) else {
            continue;
        };
        let matches =
            device_id.is_some_and(|id| snapshot.resolve(row.user_id, id) == *canonical_id);
        let display = match device_id {
            Some(request_id) if matches => request_id,
            _ => canonical_id.as_str(),
        };
        append_device(items, index, row, display);
        if matches {
            rows_by_install.insert(row.installed_kind_id, row);
        }
    }
    rows_by_install
}

fn marketplace_candidates(
    items: &mut [Value],
    rows_by_install: &HashMap<i64, &DeviceInstallationRow>,
    device_id: Option<&str>,
) -> Vec<(usize, i64)> {
    let mut candidates = Vec::new();
    for (index, item) in items.iter_mut().enumerate() {
        let Some(plugin_id) = item
            .get("spec")
            .and_then(|spec| spec.get("pluginId"))
            .and_then(Value::as_i64)
        else {
            continue;
        };
        if let (Some(_), Some(installed_id)) = (device_id, installed_item_id(item)) {
            let row = rows_by_install.get(&installed_id).copied();
            if !device_has_materialized_release(row) {
                let state = if row.is_some_and(|row| row.state == "failed") {
                    "failed"
                } else {
                    "not_installed"
                };
                set_install_state(item, state);
                continue;
            }
            let row = row.expect("materialized implies present");
            if item["spec"]["releaseId"]
                .as_i64()
                .is_some_and(|id| row.actual_release_id != id)
            {
                set_install_state(item, "update_available");
                continue;
            }
            set_install_state(item, "installed");
        }
        candidates.push((index, plugin_id));
    }
    candidates
}
