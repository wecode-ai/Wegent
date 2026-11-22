// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
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
