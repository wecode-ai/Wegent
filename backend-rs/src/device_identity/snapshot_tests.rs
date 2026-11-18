// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::device_identity::{PluginDeviceInstallationRow, coalesce_plugin_device_rows_resolved};
use chrono::NaiveDateTime;
use serde_json::json;

fn device(id: i64, name: &str, kind: &str, alias: &str) -> DeviceKindRow {
    DeviceKindRow {
        id,
        name: name.into(),
        json: json!({"spec": {"deviceType": kind, "deviceId": alias}}),
    }
}

#[test]
fn snapshot_preserves_alias_precedence_ambiguity_and_owner_boundaries() {
    let mut snapshot = DeviceIdentitySnapshot {
        devices_by_user: HashMap::from([
            (
                7,
                vec![
                    device(1, "app", "app", "shared"),
                    device(2, "local", "local", "shared"),
                    device(3, "app-a", "app", "ambiguous"),
                    device(4, "app-b", "app", "ambiguous"),
                    device(5, "local-name", "local", "local-alias"),
                    device(6, "cloud-name", "cloud", "cloud-alias"),
                    device(7, "remote-name", "remote", "remote-alias"),
                ],
            ),
            (8, vec![device(11, "app", "app", "shared")]),
        ]),
        ..Default::default()
    };
    for (owner, submitted, canonical) in [
        (7, "shared", "app-record-1"),
        (8, "shared", "app-record-11"),
        (9, "shared", "shared"),
        (7, " ambiguous ", "ambiguous"),
        (7, "local-alias", "local-name"),
        (7, "cloud-alias", "cloud-name"),
        (7, "remote-alias", "remote-name"),
        (7, "app-record-1", "app-record-1"),
        (7, "app-record-11", "app-record-11"),
        (7, "app-record-5", "app-record-5"),
        (7, " unknown ", "unknown"),
        (7, "", ""),
        (7, "   ", ""),
    ] {
        assert_eq!(snapshot.resolve(owner, submitted), canonical);
    }
    let cached = snapshot.identities.len();
    assert_eq!(snapshot.resolve(7, " unknown "), "unknown");
    assert_eq!(snapshot.resolve(7, "shared"), "app-record-1");
    assert_eq!(
        snapshot.identities.len(),
        cached,
        "unknown aliases are cached too"
    );
}

fn installation(
    id: i64,
    installed: i64,
    alias: &str,
    sync: i64,
    updated: i64,
) -> PluginDeviceInstallationRow {
    let epoch = NaiveDateTime::default();
    PluginDeviceInstallationRow {
        id,
        installed_kind_id: installed,
        user_id: 7,
        device_id: alias.into(),
        desired_release_id: 10,
        actual_release_id: 10,
        state: "installed".into(),
        error_code: String::new(),
        error_message: String::new(),
        attempt_count: 0,
        last_sync_at: epoch + chrono::Duration::seconds(sync),
        updated_at: epoch + chrono::Duration::seconds(updated),
    }
}

#[test]
fn pure_coalescing_preserves_selection_priority_and_first_key_order() {
    let rows = vec![
        installation(1, 10, "alias-a", 1, 1),
        installation(2, 20, "alias-b", 1, 1),
        installation(3, 10, "canonical", 1, 1),
        installation(4, 20, "alias-c", 1, 1),
        installation(5, 30, "canonical", 1, 100),
        installation(6, 30, "alias-a", 2, 0),
        installation(7, 40, "alias-a", 1, 1),
        installation(8, 40, "alias-b", 1, 2),
    ];
    let selected = coalesce_plugin_device_rows_resolved(rows, |_, _| "canonical".to_string());
    assert_eq!(
        selected
            .iter()
            .map(|((installed, id), row)| (*installed, id.as_str(), row.id))
            .collect::<Vec<_>>(),
        [
            (10, "canonical", 3),
            (20, "canonical", 2),
            (30, "canonical", 6),
            (40, "canonical", 8)
        ]
    );
}
