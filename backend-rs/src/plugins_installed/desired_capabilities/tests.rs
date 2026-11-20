// SPDX-License-Identifier: Apache-2.0

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
fn skill_payload_writes_runtime_bind_shells() {
    // Source `_skill_payload` (`capability_payloads.py:348`) always writes
    // `bind_shells` from `get_runtime_skill_shells`, null when the package
    // declares none. The recorded `device:sync_capabilities` payload proves
    // `"bind_shells": ["ClaudeCode"]` for the installed `projects` skill.
    let skill_row = |json: Value| InstalledKindRow {
        id: 253867,
        user_id: 157,
        kind: "Skill".to_string(),
        name: "projects".to_string(),
        namespace: "default".to_string(),
        json: brz_mysql::Json(brz_json::OpaqueJson::from_serializable(json)),
        is_active: true,
        created_at: chrono::NaiveDateTime::default(),
        updated_at: chrono::NaiveDateTime::default(),
    };
    let declared = skill_payload(
        &skill_row(json!({"spec": {"bindShells": ["ClaudeCode"]}})),
        Some(253869),
    );
    assert_eq!(declared["bind_shells"], json!(["ClaudeCode"]));
    let undeclared = skill_payload(&skill_row(json!({"spec": {}})), None);
    assert_eq!(undeclared["bind_shells"], Value::Null);
    assert!(undeclared.get("bind_shells").is_some());
    // An explicit empty list stays `[]`; only an absent key becomes null.
    let empty = skill_payload(&skill_row(json!({"spec": {"bindShells": []}})), None);
    assert_eq!(empty["bind_shells"], json!([]));
    assert!(empty.get("bind_shells").is_some());
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
