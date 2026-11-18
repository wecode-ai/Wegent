// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use brz_mysql::MysqlError;

#[test]
fn record_id_from_route_matches_source() {
    assert_eq!(record_id_from_route("app-record-268663"), Some(268663));
    assert_eq!(record_id_from_route("app-record-0"), None);
    assert_eq!(record_id_from_route("app-record-abc"), None);
    assert_eq!(record_id_from_route("electron-abc"), None);
    assert_eq!(record_id_from_route(""), None);
}

#[test]
fn binding_accepts_cloud_config_route_without_changing_logical_aliases() {
    let rows = [DeviceKindRow {
        id: 1,
        name: "cloud-name".into(),
        json: serde_json::json!({
            "spec": {"deviceType": "cloud", "cloudConfig": {"deviceId": "cloud-route"}}
        }),
    }];
    assert!(resolve_device_alias(&rows, "cloud-route").is_none());
    assert_eq!(
        resolve_device_for_binding(&rows, "cloud-route").map(|row| row.id),
        Some(1)
    );
    assert_eq!(
        resolve_device_for_binding(&rows, "cloud-name").map(|row| row.id),
        Some(1)
    );
}

#[test]
fn active_device_connection_matches_local_route_even_with_same_name_app() {
    let app = app_device(1, "electron-1");
    let local = DeviceKindRow {
        id: 2,
        name: app.name.clone(),
        json: serde_json::json!({"spec": {"deviceType": "local", "runtimeInstanceId": ""}}),
    };
    let route = local.name.clone();
    assert!(matches_device_connection(&local, &route, None));
    assert!(!matches_device_connection(&app, &route, None));
    assert!(!matches_device_connection(
        &local,
        &route,
        Some("old-runtime")
    ));
}

#[test]
fn app_device_canonical_id_is_record_route() {
    let row = DeviceKindRow {
        id: 268663,
        name: "local-device".to_string(),
        json: serde_json::json!({
            "spec": {"deviceType": "app", "appDeviceId": "electron-xyz"}
        }),
    };
    assert_eq!(canonical_device_id(&row), "app-record-268663");
}

#[test]
fn local_device_canonical_id_is_name() {
    let row = DeviceKindRow {
        id: 239058,
        name: "3d66bfaa".to_string(),
        json: serde_json::json!({
            "spec": {"deviceType": "local", "deviceId": "3d66bfaa"}
        }),
    };
    assert_eq!(canonical_device_id(&row), "3d66bfaa");
}

#[test]
fn cloud_device_canonical_id_is_name() {
    let row = DeviceKindRow {
        id: 241960,
        name: "8afb8635".to_string(),
        json: serde_json::json!({
            "spec": {"deviceType": "cloud", "deviceId": "8afb8635", "cloudConfig": {}}
        }),
    };
    assert_eq!(canonical_device_id(&row), "8afb8635");
}

fn app_device(id: i64, app_id: &str) -> DeviceKindRow {
    DeviceKindRow {
        id,
        name: "logical-device".to_owned(),
        json: serde_json::json!({
            "spec": {
                "deviceType": "app",
                "deviceId": "runtime-device",
                "appDeviceId": app_id,
            }
        }),
    }
}

#[test]
fn session_aliases_resolve_both_app_and_record_addresses() {
    let devices = [app_device(7, "electron-app")];
    for submitted in ["electron-app", "app-record-7", "logical-device"] {
        let aliases = unambiguous_device_identity_ids(&devices, submitted);
        assert_eq!(aliases.first().map(String::as_str), Some(submitted));
        for expected in [
            "electron-app",
            "app-record-7",
            "logical-device",
            "runtime-device",
        ] {
            assert!(aliases.iter().any(|alias| alias == expected));
        }
        assert_eq!(aliases.len(), 4);
    }
}

#[test]
fn session_aliases_exclude_shared_names_of_distinct_app_installations() {
    let devices = [
        app_device(7, "electron-first"),
        app_device(8, "electron-second"),
    ];
    assert_eq!(
        unambiguous_device_identity_ids(&devices, "app-record-7"),
        ["app-record-7", "electron-first"]
    );
    assert_eq!(
        unambiguous_device_identity_ids(&devices, "electron-second"),
        ["electron-second", "app-record-8"]
    );
    for ambiguous in ["logical-device", "runtime-device"] {
        assert_eq!(
            unambiguous_device_identity_ids(&devices, ambiguous),
            [ambiguous]
        );
    }
}

#[test]
fn session_aliases_preserve_the_existing_unique_app_preference() {
    let devices = [
        app_device(7, "electron-app"),
        DeviceKindRow {
            id: 8,
            name: "logical-device".to_owned(),
            json: serde_json::json!({"spec": {"deviceType": "local"}}),
        },
    ];
    assert_eq!(
        resolve_device_alias(&devices, "logical-device").unwrap().id,
        7
    );
    assert!(
        unambiguous_device_identity_ids(&devices, "app-record-7")
            .iter()
            .any(|alias| alias == "logical-device")
    );
}

#[test]
fn session_aliases_keep_unknown_and_foreign_record_addresses_exact() {
    let devices = [app_device(7, "electron-app")];
    for submitted in ["app-record-8", " unknown-device ", ""] {
        assert_eq!(
            unambiguous_device_identity_ids(&devices, submitted),
            [submitted]
        );
    }
}

#[tokio::test]
async fn session_aliases_load_only_the_owners_active_default_devices() {
    let mysql = crate::sql_test_support::KindQueryCapture::default();
    assert_eq!(
        owned_device_identity_ids(&mysql, 19, "electron-app")
            .await
            .unwrap(),
        ["electron-app"]
    );
    let queries = mysql.queries();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0].first_integer, Some(19));
    assert_eq!(queries[0].args, 1);
    for filter in [
        "kinds.user_id = ?",
        "kinds.kind = 'Device'",
        "kinds.namespace = 'default'",
        "kinds.is_active = true",
    ] {
        assert!(queries[0].sql.contains(filter));
    }
}

#[test]
fn runtime_route_identity_reduces_the_source_members() {
    let row = DeviceKindRow {
        id: 241960,
        name: "8afb8635".to_string(),
        json: serde_json::json!({
            "spec": {
                "deviceType": "cloud",
                "deviceId": "8afb8635",
                "cloudConfig": {"deviceId": "sb-1"}
            }
        }),
    };
    let identity = identity_from_device(&row).expect("cloud identity");
    assert_eq!(identity.logical_device_id, "8afb8635");
    assert_eq!(identity.runtime_device_id, "8afb8635");
    assert_eq!(identity.runtime_instance_id, None);
    assert_eq!(identity.device_type, DeviceType::Cloud);
    assert_eq!(identity.device_type.value(), "cloud");

    // App devices keep the record route as their logical identity.
    let app = DeviceKindRow {
        id: 268663,
        name: "local-device".to_string(),
        json: serde_json::json!({"spec": {"deviceType": "app", "appDeviceId": "electron-host"}}),
    };
    let identity = identity_from_device(&app).expect("app identity");
    assert_eq!(identity.logical_device_id, "app-record-268663");
    assert_eq!(identity.runtime_device_id, "app-record-268663");
    assert_eq!(identity.app_device_id.as_deref(), Some("electron-host"));
    assert_eq!(identity.device_type, DeviceType::App);

    // No runtime route id means no identity, like `_identity_from_device`.
    let unroutable = DeviceKindRow {
        id: 9,
        name: String::new(),
        json: serde_json::json!({"spec": {"deviceType": "local"}}),
    };
    assert!(identity_from_device(&unroutable).is_none());
}

fn installation_row(id: i64, device_id: &str) -> PluginDeviceInstallationRow {
    PluginDeviceInstallationRow {
        id,
        installed_kind_id: 9,
        user_id: 3,
        device_id: device_id.to_string(),
        desired_release_id: 4,
        actual_release_id: 0,
        state: "pending".into(),
        error_code: String::new(),
        error_message: String::new(),
        attempt_count: 0,
        last_sync_at: NaiveDateTime::default(),
        updated_at: NaiveDateTime::default(),
    }
}

struct SecondCheckFails {
    calls: std::sync::atomic::AtomicUsize,
}

impl LeaseCheck for SecondCheckFails {
    fn check<'a>(
        &'a self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = MysqlResult<()>> + Send + 'a>> {
        let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        Box::pin(async move {
            if call >= 2 {
                Err(MysqlError::InvalidQuery {
                    reason: "plugin_write_lease_lost".into(),
                })
            } else {
                Ok(())
            }
        })
    }
}

/// The alias DELETE runs under the first guard; the canonical `device_id`
/// assignment is not executed when the second guard rejects.
#[tokio::test]
async fn a_rejected_post_delete_guard_skips_the_canonical_update() {
    // The retained row still carries a legacy alias, so a successful run
    // must issue the canonical UPDATE.
    let retained = installation_row(1, "retained-legacy");
    let alias = installation_row(2, "legacy-alias");
    let rows = vec![retained.clone(), alias];
    let selected = vec![((1_i64, "canonical".to_string()), retained)];
    let guard = SecondCheckFails {
        calls: std::sync::atomic::AtomicUsize::new(0),
    };
    let capture = crate::sql_test_support::KindQueryCapture::writing();
    let mut session = &capture;
    let error = converge_plugin_device_rows(&mut session, rows, &selected, Some(&guard))
        .await
        .unwrap_err();
    assert!(matches!(error, MysqlError::InvalidQuery { .. }));
    let writes = capture.writes();
    assert_eq!(writes.len(), 1, "only the DELETE ran");
    assert!(
        writes[0]
            .sql
            .starts_with("DELETE FROM plugin_device_installations")
    );
}
