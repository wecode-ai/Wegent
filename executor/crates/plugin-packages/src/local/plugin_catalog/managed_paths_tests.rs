// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn resolves_the_current_shared_digest_without_accessing_old_home() {
    let temp = tempfile::tempdir().unwrap();
    let shared = temp.path().join("workbench/shared/plugins");
    let package = shared.join("a".repeat(64));
    fs::create_dir_all(&package).unwrap();
    let entry = json!({
        "managed": true, "name": "mail", "marketplace": "wegent",
        "checksum": format!("sha256:{}", "a".repeat(64)),
        "store_path": "/removed-home/shared/plugins/old"
    });
    assert_eq!(
        managed_plugin_root(&temp.path().join("capabilities"), &shared, &entry).unwrap(),
        package.canonicalize().unwrap()
    );
}

#[test]
fn keeps_unavailable_managed_installations_visible_and_preserves_user_intent() {
    let entry = json!({
        "managed": true, "name": "mail", "marketplace": "wegent",
        "installed_plugin_id": 42, "cloud_plugin_id": 9, "enabled": false,
        "version": "1.0.0", "runtime_recovery_error": "Verified package is missing"
    });
    let summary = unavailable_plugin_summary("mail@wegent", &entry, "missing").unwrap();
    assert!(!summary.enabled);
    assert_eq!(summary.installed_plugin_id, Some(42));
    assert_eq!(summary.cloud_plugin_id, Some(9));
    assert!(summary.plugin_path.is_empty());
    assert_eq!(
        summary.runtime_recovery_error.as_deref(),
        Some("Verified package is missing")
    );
    assert!(unavailable_plugin_summary("other@wegent", &entry, "missing").is_none());
    assert!(
        unavailable_plugin_summary("mail@wegent", &json!({"name":"mail"}), "missing").is_none()
    );
}

#[test]
fn a_missing_package_does_not_hide_itself_or_another_installed_plugin() {
    let temp = tempfile::tempdir().unwrap();
    let capabilities = temp.path().join("capabilities");
    let shared = temp.path().join("shared/plugins");
    let package = shared.join("a".repeat(64));
    fs::create_dir_all(package.join(".codex-plugin")).unwrap();
    fs::create_dir_all(&capabilities).unwrap();
    fs::write(
        package.join(".codex-plugin/plugin.json"),
        json!({"name":"good"}).to_string(),
    )
    .unwrap();
    let manifest = capabilities.join("manifest.json");
    fs::write(&manifest, json!({"plugins": {
        "good@wegent": {"managed":true,"name":"good","marketplace":"wegent","checksum":format!("sha256:{}","a".repeat(64)),"store_path":"/old/good"},
        "missing@wegent": {"managed":true,"name":"missing","marketplace":"wegent","checksum":format!("sha256:{}","b".repeat(64)),"store_path":"/old/missing","enabled":false,"installed_plugin_id":42}
    }}).to_string()).unwrap();
    let listed = list_wegent_store_plugins_from_roots(&manifest, &shared).unwrap();
    assert_eq!(listed.plugins.len(), 2);
    let missing = listed
        .plugins
        .iter()
        .find(|plugin| plugin.name == "missing")
        .unwrap();
    assert_eq!(missing.installed_plugin_id, Some(42));
    assert!(!missing.enabled);
    assert!(missing.runtime_recovery_error.is_some());
    assert!(listed
        .plugins
        .iter()
        .find(|plugin| plugin.name == "good")
        .unwrap()
        .runtime_recovery_error
        .is_none());
}

#[test]
fn a_deferred_installation_does_not_use_unverified_package_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let capabilities = temp.path().join("capabilities");
    let shared = temp.path().join("shared/plugins");
    let package = shared.join("a".repeat(64));
    fs::create_dir_all(package.join(".codex-plugin")).unwrap();
    fs::create_dir_all(&capabilities).unwrap();
    fs::write(
        package.join(".codex-plugin/plugin.json"),
        json!({"name":"unverified-name"}).to_string(),
    )
    .unwrap();
    let manifest = capabilities.join("manifest.json");
    fs::write(
        &manifest,
        json!({"plugins":{"owned@wegent":{
            "managed":true,"name":"owned","marketplace":"wegent",
            "checksum":format!("sha256:{}","a".repeat(64)),
            "runtime_recovery_error":"Package verification failed"
        }}})
        .to_string(),
    )
    .unwrap();
    let listed = list_wegent_store_plugins_from_roots(&manifest, &shared).unwrap();
    assert_eq!(listed.plugins.len(), 1);
    assert_eq!(listed.plugins[0].name, "owned");
    assert!(listed.plugins[0].plugin_path.is_empty());
}

#[test]
fn missing_digest_does_not_fall_back_to_an_unrelated_historical_directory() {
    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("foreign");
    fs::create_dir_all(&outside).unwrap();
    let entry = json!({
        "managed": true, "checksum": format!("sha256:{}", "a".repeat(64)),
        "store_path": outside
    });
    assert!(managed_plugin_root(
        &temp.path().join("capabilities"),
        &temp.path().join("shared/plugins"),
        &entry
    )
    .is_err());
    assert!(outside.is_dir());
}

#[cfg(unix)]
#[test]
fn rejects_a_current_digest_symlink_even_when_old_record_claims_it() {
    let temp = tempfile::tempdir().unwrap();
    let shared = temp.path().join("shared/plugins");
    fs::create_dir_all(&shared).unwrap();
    let foreign = temp.path().join("foreign");
    fs::create_dir_all(&foreign).unwrap();
    let package = shared.join("a".repeat(64));
    std::os::unix::fs::symlink(&foreign, &package).unwrap();
    let entry =
        json!({"managed":true,"checksum":format!("sha256:{}","a".repeat(64)),"store_path":package});
    assert!(managed_plugin_root(&temp.path().join("capabilities"), &shared, &entry).is_err());
    assert!(foreign.is_dir());
}
