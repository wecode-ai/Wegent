// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    env, fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use toml_edit::DocumentMut;
use wegent_executor::{
    config::device::{ConnectionConfig, DeviceConfig},
    local::capabilities::{
        default_manifest_path, get_project_id, is_project_task,
        restore_enabled_claude_plugin_cache, CapabilityPackageProvider, CapabilityPluginRuntime,
        CapabilitySyncError, CapabilitySyncHandler, GlobalCapabilityReporter,
        GlobalCapabilityStore, ManagedCapabilityManifest, PluginSyncSpec, SkillSyncSpec,
    },
    protocol::ExecutionRequest,
};

#[test]
fn plugin_store_uses_manifest_home_without_changing_skill_store() {
    let temp = TempRoot::new("plugin-store-home");
    let executor_home = temp.path().join(".wework");
    let legacy_store = temp.path().join(".wegent-executor/capabilities/store");
    let canonical_store = executor_home.join("capabilities/store");
    let package_name = "9-wegent-dev-tools-0.1.0";
    let legacy_package = legacy_store.join("plugins").join(package_name);
    let canonical_package = canonical_store.join("plugins").join(package_name);
    let manifest_path = executor_home.join("capabilities/manifest.json");
    write_test_plugin_package(&legacy_package, "legacy-authoritative");
    write_test_plugin_package(&canonical_package, "stale-canonical");
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 7,
            "skills": {},
            "plugins": {
                "dev-tools@wegent": {
                    "managed": true,
                    "name": "dev-tools",
                    "marketplace": "wegent",
                    "version": "0.1.0",
                    "store_path": legacy_package.display().to_string(),
                },
            },
            "mcps": {},
        })
        .to_string(),
    )
    .unwrap();
    let store =
        GlobalCapabilityStore::new(manifest_path.clone(), temp.path().join(".claude/skills"));

    assert_eq!(store.store_dir, legacy_store);
    store.reconcile_managed_claude_plugins().unwrap();

    let migrated_manifest = read_json(&manifest_path);
    assert_eq!(
        migrated_manifest["plugins"]["dev-tools@wegent"]["store_path"],
        canonical_package.display().to_string()
    );
    assert_eq!(migrated_manifest["revision"], 8);
    assert_eq!(
        fs::read_to_string(canonical_package.join("payload.txt")).unwrap(),
        "legacy-authoritative"
    );
    assert!(!legacy_package.exists());
    assert!(canonical_store.join(".plugin-store-layout.json").is_file());

    assert!(store.reconcile_managed_claude_plugins().unwrap().is_empty());
    assert_eq!(read_json(manifest_path)["revision"], 8);
}

#[test]
fn legacy_store_path_rewrites_after_desktop_home_was_already_moved() {
    let temp = TempRoot::new("capability-store-moved-home");
    let executor_home = temp.path().join(".wework");
    let legacy_package = temp
        .path()
        .join(".wegent-executor/capabilities/store/plugins/9-default-dev-tools");
    let canonical_package = executor_home.join("capabilities/store/plugins/9-default-dev-tools");
    let manifest_path = executor_home.join("capabilities/manifest.json");
    write_test_plugin_package(&canonical_package, "already-moved");
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 2,
            "skills": {},
            "plugins": {
                "dev-tools@wegent": {
                    "managed": true,
                    "name": "dev-tools",
                    "marketplace": "wegent",
                    "version": "0.1.0",
                    "checksum": "stale-checksum",
                    "store_path": legacy_package.display().to_string(),
                },
            },
            "mcps": {},
        })
        .to_string(),
    )
    .unwrap();
    let store =
        GlobalCapabilityStore::new(manifest_path.clone(), temp.path().join(".claude/skills"));

    store.reconcile_managed_claude_plugins().unwrap();

    let plugin = &read_json(manifest_path)["plugins"]["dev-tools@wegent"];
    assert_eq!(
        plugin["store_path"],
        canonical_package.display().to_string()
    );
    assert!(plugin.get("checksum").is_none());
    assert!(canonical_package.is_dir());
}

#[test]
fn missing_legacy_package_does_not_bind_unverified_canonical_leftover() {
    let temp = TempRoot::new("capability-store-unverified-canonical");
    let executor_home = temp.path().join(".wework");
    let legacy_package = temp
        .path()
        .join(".wegent-executor/capabilities/store/plugins/9-default-dev-tools");
    let canonical_package = executor_home.join("capabilities/store/plugins/9-default-dev-tools");
    let manifest_path = executor_home.join("capabilities/manifest.json");
    fs::create_dir_all(&canonical_package).unwrap();
    fs::write(canonical_package.join("payload.txt"), "leftover").unwrap();
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 2,
            "skills": {},
            "plugins": {
                "dev-tools@wegent": {
                    "managed": true,
                    "name": "dev-tools",
                    "marketplace": "wegent",
                    "version": "0.1.0",
                    "checksum": "stale-checksum",
                    "store_path": legacy_package.display().to_string(),
                },
            },
            "mcps": {},
        })
        .to_string(),
    )
    .unwrap();
    let store =
        GlobalCapabilityStore::new(manifest_path.clone(), temp.path().join(".claude/skills"));

    store.reconcile_managed_claude_plugins().unwrap();

    let plugin = &read_json(manifest_path)["plugins"]["dev-tools@wegent"];
    assert_eq!(plugin["store_path"], legacy_package.display().to_string());
    assert_eq!(plugin["checksum"], "stale-checksum");
}

#[test]
fn plugin_reconciliation_does_not_migrate_skill_store_paths() {
    let temp = TempRoot::new("plugin-migration-skill-boundary");
    let executor_home = temp.path().join(".wework");
    let legacy_skill = temp
        .path()
        .join(".wegent-executor/capabilities/store/skills/42-default-image-gen");
    let manifest_path = executor_home.join("capabilities/manifest.json");
    fs::create_dir_all(&legacy_skill).unwrap();
    fs::write(legacy_skill.join("SKILL.md"), "unchanged").unwrap();
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 5,
            "skills": {
                "image-gen": {
                    "managed": true,
                    "store_path": legacy_skill.display().to_string(),
                },
            },
            "plugins": {},
            "mcps": {},
        })
        .to_string(),
    )
    .unwrap();
    let store =
        GlobalCapabilityStore::new(manifest_path.clone(), temp.path().join(".claude/skills"));

    assert!(store.reconcile_managed_claude_plugins().unwrap().is_empty());

    let manifest = read_json(manifest_path);
    assert_eq!(
        manifest["skills"]["image-gen"]["store_path"],
        legacy_skill.display().to_string()
    );
    assert_eq!(manifest["revision"], 5);
    assert!(legacy_skill.is_dir());
    assert!(!executor_home
        .join("capabilities/store/skills/42-default-image-gen")
        .exists());
}

#[tokio::test]
async fn skill_and_mcp_updates_do_not_trigger_plugin_store_migration() {
    let temp = TempRoot::new("plugin-migration-non-plugin-boundary");
    let executor_home = temp.path().join(".wework");
    let legacy_plugin = temp
        .path()
        .join(".wegent-executor/capabilities/store/plugins/9-wegent-dev-tools-0.1.0");
    let canonical_plugin =
        executor_home.join("capabilities/store/plugins/9-wegent-dev-tools-0.1.0");
    let manifest_path = executor_home.join("capabilities/manifest.json");
    write_test_plugin_package(&legacy_plugin, "legacy-active");
    write_test_plugin_package(&canonical_plugin, "stale-canonical");
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 6,
            "skills": {},
            "plugins": {
                "dev-tools@wegent": {
                    "managed": true,
                    "name": "dev-tools",
                    "marketplace": "wegent",
                    "version": "0.1.0",
                    "store_path": legacy_plugin.display().to_string(),
                },
            },
            "mcps": {},
        })
        .to_string(),
    )
    .unwrap();
    let store =
        GlobalCapabilityStore::new(manifest_path.clone(), temp.path().join(".claude/skills"));
    store
        .record_skill(json!({
            "name": "image-gen",
            "skill_id": 42,
            "namespace": "default",
        }))
        .unwrap();
    let handler = CapabilitySyncHandler::new("token", store);

    handler
        .apply_sync(json!({
            "mode": "merge",
            "skills": [],
            "plugins": [],
            "mcps": [{
                "name": "docs",
                "installed_mcp_id": 7,
                "server": {"type": "streamable-http", "url": "https://example.com/mcp"},
            }],
        }))
        .await
        .unwrap();

    let manifest = read_json(manifest_path);
    assert_eq!(
        manifest["plugins"]["dev-tools@wegent"]["store_path"],
        legacy_plugin.display().to_string()
    );
    assert!(legacy_plugin.is_dir());
    assert_eq!(
        fs::read_to_string(canonical_plugin.join("payload.txt")).unwrap(),
        "stale-canonical"
    );
    assert!(!executor_home
        .join("capabilities/store/.plugin-store-layout.json")
        .exists());
}

#[tokio::test]
async fn plugin_sync_migrates_authoritative_legacy_package_before_reconciliation() {
    let temp = TempRoot::new("plugin-sync-store-migration");
    let executor_home = temp.path().join(".wework");
    let legacy_plugin = temp
        .path()
        .join(".wegent-executor/capabilities/store/plugins/9-wegent-dev-tools-0.1.0");
    let canonical_plugin =
        executor_home.join("capabilities/store/plugins/9-wegent-dev-tools-0.1.0");
    let manifest_path = executor_home.join("capabilities/manifest.json");
    write_test_plugin_package(&legacy_plugin, "legacy-authoritative");
    write_test_plugin_package(&canonical_plugin, "stale-canonical");
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 6,
            "skills": {},
            "plugins": {
                "dev-tools@wegent": {
                    "managed": true,
                    "name": "dev-tools",
                    "marketplace": "wegent",
                    "version": "0.1.0",
                    "store_path": legacy_plugin.display().to_string(),
                },
            },
            "mcps": {},
        })
        .to_string(),
    )
    .unwrap();
    let store =
        GlobalCapabilityStore::new(manifest_path.clone(), temp.path().join(".claude/skills"));
    let handler = CapabilitySyncHandler::new("token", store);

    let result = handler
        .apply_sync(json!({
            "mode": "merge",
            "skills": [],
            "plugins": [{
                "installed_plugin_id": 9,
                "name": "dev-tools",
                "marketplace": "wegent",
                "version": "0.1.0",
            }],
            "mcps": [],
        }))
        .await
        .unwrap();

    assert_eq!(result["plugins"][0]["status"], "synced");
    assert_eq!(
        fs::read_to_string(canonical_plugin.join("payload.txt")).unwrap(),
        "legacy-authoritative"
    );
    assert!(!legacy_plugin.exists());
    assert_eq!(
        read_json(manifest_path)["plugins"]["dev-tools@wegent"]["store_path"],
        canonical_plugin.display().to_string()
    );
}

#[test]
fn offline_migration_keeps_unavailable_legacy_package_reference() {
    let temp = TempRoot::new("capability-store-offline-migration");
    let executor_home = temp.path().join(".wework");
    let legacy_package = temp
        .path()
        .join(".wegent-executor/capabilities/store/plugins/9-default-dev-tools");
    let manifest_path = executor_home.join("capabilities/manifest.json");
    fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 4,
            "skills": {},
            "plugins": {
                "dev-tools@wegent": {
                    "managed": true,
                    "store_path": legacy_package.display().to_string(),
                },
            },
            "mcps": {},
        })
        .to_string(),
    )
    .unwrap();
    let store =
        GlobalCapabilityStore::new(manifest_path.clone(), executor_home.join(".claude/skills"));

    assert!(store.reconcile_managed_claude_plugins().unwrap().is_empty());

    let manifest = read_json(manifest_path);
    assert_eq!(
        manifest["plugins"]["dev-tools@wegent"]["store_path"],
        legacy_package.display().to_string()
    );
    assert_eq!(manifest["revision"], 4);
    assert!(!executor_home
        .join("capabilities/store/.plugin-store-layout.json")
        .exists());
}

#[tokio::test]
async fn replace_sync_records_skill_and_mcp_and_removes_only_stale_managed_skill() {
    let temp = TempRoot::new("capability-sync-skill");
    let skills_dir = temp.path().join(".claude/skills");
    let codex_skills_dir = temp.path().join(".codex/skills");
    let store_dir = temp.path().join("store");
    let manifest_path = temp.path().join("capabilities.json");
    let old_store_skill = store_dir.join("skills/1-default-old-managed");
    fs::create_dir_all(&old_store_skill).unwrap();
    fs::write(
        old_store_skill.join("SKILL.md"),
        "---\nname: old-managed\n---\n",
    )
    .unwrap();
    fs::create_dir_all(&skills_dir).unwrap();
    fs::create_dir_all(&codex_skills_dir).unwrap();
    symlink_dir(&old_store_skill, &skills_dir.join("old-managed"));
    symlink_dir(&old_store_skill, &codex_skills_dir.join("old-managed"));
    fs::create_dir_all(skills_dir.join("local-user")).unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 1,
            "skills": {
                "old-managed": {"name": "old-managed", "managed": true},
            },
            "plugins": {},
            "mcps": {},
        })
        .to_string(),
    )
    .unwrap();
    let provider =
        StaticPackageProvider::default().with_skill("image-gen", "---\nname: image-gen\n---\n");
    let store = GlobalCapabilityStore::new(manifest_path.clone(), skills_dir.clone())
        .with_codex_skills_dir(codex_skills_dir.clone())
        .with_store_dir(store_dir.clone());
    let handler = CapabilitySyncHandler::with_package_provider("token", store, provider);

    let result = handler
        .apply_sync(json!({
            "mode": "replace",
            "skills": [{"name": "image-gen", "skill_id": 42, "namespace": "default"}],
            "plugins": [],
            "mcps": [{
                "name": "docs",
                "installed_mcp_id": 7,
                "server": {"type": "streamable-http", "url": "https://example.com/mcp"},
            }],
        }))
        .await
        .unwrap();

    assert_eq!(result["success"], true);
    assert_eq!(
        result["skills"],
        json!([{"id": 42, "name": "image-gen", "status": "synced"}])
    );
    assert!(!skills_dir.join("old-managed").exists());
    assert!(!codex_skills_dir.join("old-managed").exists());
    assert!(skills_dir.join("local-user").is_dir());
    let store_path = store_dir.join("skills/42-default-image-gen");
    assert_eq!(
        fs::read_to_string(store_path.join("SKILL.md")).unwrap(),
        "---\nname: image-gen\n---\n"
    );
    assert!(skills_dir.join("image-gen").is_symlink());
    assert_eq!(
        fs::canonicalize(skills_dir.join("image-gen")).unwrap(),
        fs::canonicalize(&store_path).unwrap()
    );
    assert!(codex_skills_dir.join("image-gen").is_symlink());

    let manifest = read_json(&manifest_path);
    assert_eq!(manifest["skills"]["image-gen"]["skill_id"], 42);
    assert_eq!(
        manifest["skills"]["image-gen"]["store_path"],
        store_path.display().to_string()
    );
    assert_eq!(manifest["mcps"]["docs"]["installed_mcp_id"], 7);
    assert!(manifest["skills"].get("old-managed").is_none());
}

#[tokio::test]
async fn concurrent_syncs_serialize_manifest_updates() {
    let temp = TempRoot::new("capability-sync-concurrent");
    let skills_dir = temp.path().join(".claude/skills");
    let codex_skills_dir = temp.path().join(".codex/skills");
    let store_dir = temp.path().join("store");
    let manifest_path = temp.path().join("capabilities.json");
    let provider = StaticPackageProvider::default()
        .with_skill_delay(Duration::from_millis(50))
        .with_skill("first", "---\nname: first\n---\n")
        .with_skill("second", "---\nname: second\n---\n");
    let store = GlobalCapabilityStore::new(manifest_path.clone(), skills_dir)
        .with_codex_skills_dir(codex_skills_dir)
        .with_store_dir(store_dir);
    let handler = Arc::new(CapabilitySyncHandler::with_package_provider(
        "token", store, provider,
    ));

    let first = {
        let handler = Arc::clone(&handler);
        tokio::spawn(async move {
            handler
                .apply_sync(json!({
                    "mode": "merge",
                    "skills": [{"name": "first", "skill_id": 1, "namespace": "default"}],
                    "plugins": [],
                    "mcps": [],
                }))
                .await
        })
    };
    let second = {
        let handler = Arc::clone(&handler);
        tokio::spawn(async move {
            handler
                .apply_sync(json!({
                    "mode": "merge",
                    "skills": [{"name": "second", "skill_id": 2, "namespace": "default"}],
                    "plugins": [],
                    "mcps": [],
                }))
                .await
        })
    };

    let (first, second) = tokio::join!(first, second);
    assert_eq!(first.unwrap().unwrap()["success"], true);
    assert_eq!(second.unwrap().unwrap()["success"], true);

    let manifest = read_json(manifest_path);
    assert_eq!(manifest["skills"]["first"]["skill_id"], 1);
    assert_eq!(manifest["skills"]["second"]["skill_id"], 2);
}

#[tokio::test]
async fn sync_redownloads_broken_managed_skill_and_reports_local_user_conflicts() {
    let temp = TempRoot::new("capability-sync-broken-skill");
    let skills_dir = temp.path().join(".claude/skills");
    let codex_skills_dir = temp.path().join(".codex/skills");
    let store_dir = temp.path().join("store");
    let manifest_path = temp.path().join("capabilities.json");
    let missing_store_skill = store_dir.join("skills/42-default-image-gen");
    fs::create_dir_all(&skills_dir).unwrap();
    symlink_dir(&missing_store_skill, &skills_dir.join("image-gen"));
    fs::create_dir_all(skills_dir.join("browser")).unwrap();
    fs::write(
        skills_dir.join("browser/SKILL.md"),
        "---\nname: browser\n---\n",
    )
    .unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 1,
            "skills": {
                "image-gen": {
                    "name": "image-gen",
                    "skill_id": 42,
                    "namespace": "default",
                    "managed": true,
                    "store_path": missing_store_skill.display().to_string(),
                    "runtime": {"claude_link": skills_dir.join("image-gen").display().to_string()}
                }
            },
            "plugins": {},
            "mcps": {},
        })
        .to_string(),
    )
    .unwrap();
    let provider = StaticPackageProvider::default()
        .with_skill("image-gen", "---\nname: image-gen\n---\n")
        .with_skill("browser", "---\nname: browser\n---\n");
    let store = GlobalCapabilityStore::new(manifest_path.clone(), skills_dir.clone())
        .with_codex_skills_dir(codex_skills_dir)
        .with_store_dir(store_dir);
    let handler = CapabilitySyncHandler::with_package_provider("token", store, provider);

    let result = handler
        .apply_sync(json!({
            "mode": "replace",
            "skills": [
                {"name": "image-gen", "skill_id": 42, "namespace": "default"},
                {"name": "browser", "skill_id": 101, "namespace": "default"}
            ],
            "plugins": [],
            "mcps": [],
        }))
        .await
        .unwrap();

    assert_eq!(result["success"], false);
    assert_eq!(
        result["skills"],
        json!([
            {"id": 42, "name": "image-gen", "status": "synced"},
            {
                "id": 101,
                "name": "browser",
                "status": "failed",
                "error": "Runtime Skill path is occupied by a local user item"
            }
        ])
    );
    assert!(missing_store_skill.join("SKILL.md").exists());
    assert!(skills_dir.join("image-gen").is_symlink());
    assert!(skills_dir.join("browser").is_dir());
    assert!(!skills_dir.join("browser").is_symlink());
}

#[tokio::test]
async fn plugin_sync_accepts_claude_package_and_installs_both_runtimes() {
    let temp = TempRoot::new("capability-sync-plugin");
    let skills_dir = temp.path().join("skills");
    let plugins_dir = temp.path().join(".claude/plugins");
    let codex_plugins_dir = temp.path().join(".codex/plugins");
    let store_dir = temp.path().join("store");
    let manifest_path = temp.path().join("capabilities.json");
    let store_plugin_path = store_dir.join("plugins/9-market-context7-1.0.0");
    fs::create_dir_all(store_plugin_path.join(".codex-plugin")).unwrap();
    fs::write(
        store_plugin_path.join(".codex-plugin/plugin.json"),
        r#"{"name":"context7"}"#,
    )
    .unwrap();
    fs::write(store_plugin_path.join("old.txt"), "old").unwrap();
    fs::create_dir_all(&plugins_dir).unwrap();
    fs::write(
        plugins_dir.join("installed_plugins.json"),
        json!({
            "version": 2,
            "plugins": {
                "context7@market": [{
                    "scope": "user",
                    "installPath": plugins_dir.join("cache/market/context7/1.0.0").display().to_string(),
                    "installedPluginId": 9,
                    "checksum": "sha256:old",
                    "version": "1.0.0"
                }]
            }
        })
        .to_string(),
    )
    .unwrap();
    fs::create_dir_all(codex_plugins_dir.parent().unwrap()).unwrap();
    fs::write(
        codex_plugins_dir.parent().unwrap().join("config.toml"),
        "[features]\napps = true\n",
    )
    .unwrap();
    let package = zip_bytes(&[
        (
            "context7/.claude-plugin/plugin.json",
            r#"{"name":"context7","displayName":"Context 7","commands":["./commands/test.md"]}"#,
        ),
        ("context7/commands/test.md", "# Test"),
        ("context7/new.txt", "new"),
    ]);
    let checksum = sha256_hex(&package);
    let provider =
        StaticPackageProvider::default().with_plugin("/api/plugins/installed/9/download", package);
    let store = GlobalCapabilityStore::new(manifest_path.clone(), skills_dir)
        .with_plugins_dir(plugins_dir.clone())
        .with_codex_plugins_dir(codex_plugins_dir.clone())
        .with_store_dir(store_dir.clone());
    let handler = CapabilitySyncHandler::with_package_provider("token", store, provider);

    let result = handler
        .apply_sync(json!({
            "mode": "replace",
            "skills": [],
            "plugins": [{
                "installed_plugin_id": 9,
                "name": "context7",
                "marketplace": "market",
                "version": "1.0.0",
                "download_path": "/api/plugins/installed/9/download",
                "checksum": checksum
            }],
            "mcps": [],
        }))
        .await
        .unwrap();

    assert_eq!(result["success"], true);
    assert_eq!(
        result["plugins"],
        json!([{"id": 9, "name": "context7", "status": "synced"}])
    );
    assert!(!store_plugin_path.join("old.txt").exists());
    assert_eq!(
        fs::read_to_string(store_plugin_path.join("new.txt")).unwrap(),
        "new"
    );
    let runtime_link = plugins_dir.join("cache/market/context7/1.0.0");
    assert!(runtime_link.is_dir());
    assert!(!runtime_link.is_symlink());
    assert_eq!(
        fs::read_to_string(runtime_link.join("new.txt")).unwrap(),
        "new"
    );
    assert!(runtime_link.join(".claude-plugin/plugin.json").is_file());
    let claude_codex_manifest = read_json(runtime_link.join(".codex-plugin/plugin.json"));
    assert_eq!(
        claude_codex_manifest["interface"]["displayName"],
        "Context 7"
    );
    assert!(claude_codex_manifest.get("commands").is_none());
    let codex_runtime = codex_plugins_dir.join("cache/market/context7/1.0.0");
    assert!(codex_runtime.is_dir());
    assert!(!codex_runtime.is_symlink());
    assert_eq!(
        fs::read_to_string(codex_runtime.join("new.txt")).unwrap(),
        "new"
    );
    assert!(codex_runtime.join(".codex-plugin/plugin.json").is_file());
    assert!(codex_runtime.join(".claude-plugin/plugin.json").is_file());
    assert!(codex_plugins_dir
        .join("marketplaces/market/plugins/context7")
        .is_symlink());
    let codex_marketplace =
        read_json(codex_plugins_dir.join("marketplaces/market/.agents/plugins/marketplace.json"));
    assert_eq!(
        codex_marketplace["plugins"],
        json!([{
            "name": "context7",
            "source": {"source": "local", "path": "./plugins/context7"},
            "policy": {
                "installation": "AVAILABLE",
                "authentication": "ON_INSTALL",
                "products": ["CODEX"]
            }
        }])
    );
    let codex_config = read_toml(codex_plugins_dir.parent().unwrap().join("config.toml"));
    assert_eq!(codex_config["features"]["apps"].as_bool(), Some(true));
    assert_eq!(
        codex_config["marketplaces"]["market"]["source_type"].as_str(),
        Some("local")
    );
    assert_eq!(
        codex_config["marketplaces"]["market"]["source"].as_str(),
        Some(
            codex_plugins_dir
                .join("marketplaces/market")
                .to_string_lossy()
                .as_ref()
        )
    );
    assert_eq!(
        codex_config["plugins"]["context7@market"]["enabled"].as_bool(),
        Some(true)
    );
    let installed = read_json(plugins_dir.join("installed_plugins.json"));
    assert_eq!(
        installed["plugins"]["context7@market"][0]["checksum"],
        checksum
    );
    assert_eq!(
        installed["plugins"]["context7@market"][0]["installPath"],
        runtime_link.display().to_string()
    );
    let settings = read_json(plugins_dir.parent().unwrap().join("settings.json"));
    assert_eq!(settings["enabledPlugins"]["context7@market"], true);
    let manifest = read_json(&manifest_path);
    assert_eq!(
        manifest["plugins"]["context7@market"]["store_path"],
        store_plugin_path.display().to_string()
    );
}

#[tokio::test]
async fn plugin_sync_accepts_a_pure_codex_plugin_package() {
    let temp = TempRoot::new("capability-sync-codex-plugin");
    let skills_dir = temp.path().join("skills");
    let plugins_dir = temp.path().join(".claude/plugins");
    let codex_plugins_dir = temp.path().join(".codex/plugins");
    let store_dir = temp.path().join("store");
    let manifest_path = temp.path().join("capabilities.json");
    let package = zip_bytes(&[
        (
            "gitlab/.codex-plugin/plugin.json",
            r#"{"name":"gitlab","version":"1.0.0"}"#,
        ),
        ("gitlab/skills/review/SKILL.md", "---\nname: review\n---\n"),
    ]);
    let checksum = sha256_hex(&package);
    let provider =
        StaticPackageProvider::default().with_plugin("/api/plugins/installed/20/download", package);
    let store = GlobalCapabilityStore::new(manifest_path, skills_dir)
        .with_plugins_dir(plugins_dir)
        .with_codex_plugins_dir(codex_plugins_dir.clone())
        .with_store_dir(store_dir.clone());
    let handler = CapabilitySyncHandler::with_package_provider("token", store, provider);

    let result = handler
        .apply_sync(json!({
            "mode": "replace",
            "skills": [],
            "plugins": [{
                "installed_plugin_id": 20,
                "name": "gitlab",
                "marketplace": "wegent",
                "version": "1.0.0",
                "download_path": "/api/plugins/installed/20/download",
                "checksum": checksum
            }],
            "mcps": [],
        }))
        .await
        .unwrap();

    assert_eq!(result["success"], true);
    assert!(store_dir
        .join("plugins/20-wegent-gitlab-1.0.0/.codex-plugin/plugin.json")
        .is_file());
    let codex_runtime = codex_plugins_dir.join("cache/wegent/gitlab/1.0.0");
    assert!(codex_runtime.is_dir());
    assert!(!codex_runtime.is_symlink());
    assert!(codex_runtime.join(".codex-plugin/plugin.json").is_file());
}

#[tokio::test]
async fn plugin_sync_uses_codex_app_server_runtime_as_install_and_uninstall_authority() {
    let temp = TempRoot::new("capability-sync-app-server");
    let skills_dir = temp.path().join("skills");
    let plugins_dir = temp.path().join(".claude/plugins");
    let codex_plugins_dir = temp.path().join(".codex/plugins");
    let store_dir = temp.path().join("store");
    let manifest_path = temp.path().join("capabilities.json");
    let gitlab_package = zip_bytes(&[(
        "gitlab/.codex-plugin/plugin.json",
        r#"{"name":"gitlab","version":"1.0.0"}"#,
    )]);
    let github_package = zip_bytes(&[(
        "github/.codex-plugin/plugin.json",
        r#"{"name":"github","version":"2.0.0"}"#,
    )]);
    let gitlab_checksum = sha256_hex(&gitlab_package);
    let github_checksum = sha256_hex(&github_package);
    let provider = StaticPackageProvider::default()
        .with_plugin("https://objects/gitlab.zip", gitlab_package)
        .with_plugin("https://objects/github.zip", github_package);
    let runtime = RecordingPluginRuntime::default();
    let calls = runtime.calls.clone();
    let store = GlobalCapabilityStore::new(manifest_path.clone(), skills_dir)
        .with_plugins_dir(plugins_dir.clone())
        .with_codex_plugins_dir(codex_plugins_dir.clone())
        .with_store_dir(store_dir);
    let handler = CapabilitySyncHandler::with_package_provider("token", store, provider)
        .with_plugin_runtime(runtime);

    let installed = handler
        .apply_sync(json!({
            "mode": "replace",
            "skills": [],
            "plugins": [
                {
                    "installed_plugin_id": 20,
                    "name": "gitlab",
                    "marketplace": "wegent",
                    "version": "1.0.0",
                    "download_path": "https://objects/gitlab.zip",
                    "checksum": gitlab_checksum
                },
                {
                    "installed_plugin_id": 21,
                    "name": "github",
                    "marketplace": "wegent",
                    "enabled": false,
                    "version": "2.0.0",
                    "download_path": "https://objects/github.zip",
                    "checksum": github_checksum
                }
            ],
            "mcps": [],
        }))
        .await
        .unwrap();

    assert_eq!(installed["success"], true);
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        &[
            format!(
                "install:gitlab:true:{}",
                plugins_dir
                    .join("marketplaces/wegent/.agents/plugins/marketplace.json")
                    .display()
            ),
            format!(
                "install:github:false:{}",
                plugins_dir
                    .join("marketplaces/wegent/.agents/plugins/marketplace.json")
                    .display()
            ),
        ]
    );
    assert!(!codex_plugins_dir.join("gitlab-wegent").exists());
    assert_eq!(
        read_json(&manifest_path)["plugins"]["gitlab@wegent"]["install_authority"],
        "codex_app_server"
    );
    assert_eq!(
        read_json(&manifest_path)["plugins"]["github@wegent"]["enabled"],
        false
    );
    assert_eq!(
        read_json(plugins_dir.join("marketplaces/wegent/.claude-plugin/marketplace.json"))
            ["plugins"],
        json!([
            {
                "description": "",
                "name": "gitlab",
                "source": "./plugins/gitlab-wegent",
                "version": "1.0.0"
            },
            {
                "description": "",
                "name": "github",
                "source": "./plugins/github-wegent",
                "version": "2.0.0"
            }
        ])
    );
    assert_eq!(
        read_json(plugins_dir.join("marketplaces/wegent/.agents/plugins/marketplace.json")),
        json!({
            "name": "wegent",
            "interface": {"displayName": "Wegent"},
            "plugins": [
                {
                    "name": "gitlab",
                    "source": {
                        "source": "local",
                        "path": "./plugins/gitlab-wegent"
                    },
                    "policy": {
                        "installation": "AVAILABLE",
                        "authentication": "ON_INSTALL"
                    }
                },
                {
                    "name": "github",
                    "source": {
                        "source": "local",
                        "path": "./plugins/github-wegent"
                    },
                    "policy": {
                        "installation": "AVAILABLE",
                        "authentication": "ON_INSTALL"
                    }
                }
            ]
        })
    );

    handler
        .apply_sync(json!({
            "mode": "replace",
            "skills": [],
            "plugins": [],
            "mcps": [],
        }))
        .await
        .unwrap();
    let calls = calls.lock().unwrap();
    assert!(calls.contains(&"uninstall:gitlab:wegent".to_owned()));
    assert!(calls.contains(&"uninstall:github:wegent".to_owned()));
}

#[tokio::test]
async fn plugin_sync_links_existing_package_and_downloads_uploaded_plugin_to_wegent_store() {
    let temp = TempRoot::new("capability-sync-uploaded-plugin");
    let skills_dir = temp.path().join("skills");
    let plugins_dir = temp.path().join(".claude/plugins");
    let codex_plugins_dir = temp.path().join(".codex/plugins");
    let store_dir = temp.path().join("store");
    let manifest_path = temp.path().join("capabilities.json");
    let context7_store = store_dir.join("plugins/9-claude-plugins-official-context7-1057d02c5307");
    fs::create_dir_all(context7_store.join(".codex-plugin")).unwrap();
    fs::write(
        context7_store.join(".codex-plugin/plugin.json"),
        r#"{"name":"context7"}"#,
    )
    .unwrap();
    let uploaded = zip_bytes(&[
        (
            "superpowers/5.0.7/.codex-plugin/plugin.json",
            r#"{"name":"superpowers","version":"5.0.7"}"#,
        ),
        ("superpowers/5.0.7/skills/debugging/SKILL.md", "# Debug"),
    ]);
    let checksum = sha256_hex(&uploaded);
    let provider = StaticPackageProvider::default()
        .with_plugin("/api/plugins/installed/302/download", uploaded);
    let store = GlobalCapabilityStore::new(manifest_path.clone(), skills_dir)
        .with_plugins_dir(plugins_dir.clone())
        .with_codex_plugins_dir(codex_plugins_dir.clone())
        .with_store_dir(store_dir.clone());
    let handler = CapabilitySyncHandler::with_package_provider("token", store, provider);

    let result = handler
        .apply_sync(json!({
            "mode": "replace",
            "skills": [],
            "plugins": [
                {
                    "installed_plugin_id": 9,
                    "name": "context7",
                    "marketplace": "claude-plugins-official",
                    "version": "1057d02c5307",
                    "source": {"type": "marketplace", "marketplace": "claude-plugins-official"}
                },
                {
                    "installed_plugin_id": 302,
                    "name": "superpowers",
                    "version": "5.0.7",
                    "source": {
                        "type": "upload",
                        "providerKey": "claude-code",
                        "pluginKey": "superpowers"
                    },
                    "download_path": "/api/plugins/installed/302/download",
                    "checksum": checksum
                }
            ],
            "mcps": [],
        }))
        .await
        .unwrap();

    assert_eq!(result["success"], true);
    assert_eq!(
        result["plugins"],
        json!([
            {"id": 9, "name": "context7", "status": "synced"},
            {"id": 302, "name": "superpowers", "status": "synced"}
        ])
    );
    let context7_runtime = plugins_dir.join("cache/claude-plugins-official/context7/1057d02c5307");
    assert!(context7_runtime.is_dir());
    assert!(!context7_runtime.is_symlink());
    let context7_codex_runtime =
        codex_plugins_dir.join("cache/claude-plugins-official/context7/1057d02c5307");
    assert!(context7_codex_runtime.is_dir());
    assert!(!context7_codex_runtime.is_symlink());
    let uploaded_store = store_dir.join("plugins/302-wegent-superpowers-5.0.7");
    assert_eq!(
        fs::read_to_string(uploaded_store.join("skills/debugging/SKILL.md")).unwrap(),
        "# Debug"
    );
    let uploaded_claude_runtime = plugins_dir.join("cache/wegent/superpowers/5.0.7");
    assert!(uploaded_claude_runtime.is_dir());
    assert!(!uploaded_claude_runtime.is_symlink());
    assert_eq!(
        fs::read_to_string(uploaded_claude_runtime.join("skills/debugging/SKILL.md")).unwrap(),
        "# Debug"
    );
    let uploaded_codex_runtime = codex_plugins_dir.join("cache/wegent/superpowers/5.0.7");
    assert!(uploaded_codex_runtime.is_dir());
    assert!(!uploaded_codex_runtime.is_symlink());
    let manifest = read_json(manifest_path);
    assert_eq!(
        manifest["plugins"]["superpowers@wegent"]["store_path"],
        uploaded_store.display().to_string()
    );
}

#[test]
fn extract_plugin_zip_normalizes_roots_ignores_macos_metadata_and_keeps_existing_on_invalid() {
    let temp = TempRoot::new("capability-sync-plugin-zip");
    let install_path = temp.path().join("plugins/superpowers");
    fs::create_dir_all(install_path.join(".codex-plugin")).unwrap();
    fs::write(
        install_path.join(".codex-plugin/plugin.json"),
        r#"{"name":"superpowers"}"#,
    )
    .unwrap();
    fs::write(install_path.join("old.txt"), "old").unwrap();
    let store = GlobalCapabilityStore::new(
        temp.path().join("manifest.json"),
        temp.path().join("skills"),
    );
    let handler = CapabilitySyncHandler::new("token", store);

    let invalid = zip_bytes(&[("README.md", "missing manifest")]);
    let error = handler
        .extract_plugin_zip(&invalid, &install_path)
        .unwrap_err();
    assert!(error.to_string().contains("plugin.json"));
    assert_eq!(
        fs::read_to_string(install_path.join("old.txt")).unwrap(),
        "old"
    );

    let mismatched = zip_bytes(&[
        (
            "superpowers/.codex-plugin/plugin.json",
            r#"{"name":"superpowers"}"#,
        ),
        (
            "superpowers/.claude-plugin/plugin.json",
            r#"{"name":"another-plugin"}"#,
        ),
    ]);
    let error = handler
        .extract_plugin_zip(&mismatched, &install_path)
        .unwrap_err();
    assert!(error.to_string().contains("manifest names must match"));
    assert_eq!(
        fs::read_to_string(install_path.join("old.txt")).unwrap(),
        "old"
    );

    let claude_only = zip_bytes(&[
        (
            "superpowers/.claude-plugin/plugin.json",
            r#"{"name":"superpowers","displayName":"Superpowers","commands":["./commands/test.md"]}"#,
        ),
        ("superpowers/commands/test.md", "# Test"),
    ]);
    handler
        .extract_plugin_zip(&claude_only, &install_path)
        .unwrap();
    assert!(install_path.join(".claude-plugin/plugin.json").is_file());
    let generated_codex = read_json(install_path.join(".codex-plugin/plugin.json"));
    assert_eq!(generated_codex["interface"]["displayName"], "Superpowers");
    assert!(generated_codex.get("commands").is_none());
    let normalized_claude = read_json(install_path.join(".claude-plugin/plugin.json"));
    assert!(normalized_claude.get("displayName").is_none());

    let valid = zip_bytes(&[
        (
            "superpowers/5.0.7/.codex-plugin/plugin.json",
            r#"{"name":"superpowers","version":"5.0.7","interface":{"displayName":"Superpowers"}}"#,
        ),
        (
            "superpowers/5.0.7/hooks/claude/session-start-hook.cmd",
            "#!/bin/sh\n",
        ),
        ("superpowers/5.0.7/skills/debugging/SKILL.md", "# Debug"),
        ("__MACOSX/._superpowers", ""),
        ("__MACOSX/superpowers/._debugging", ""),
    ]);
    handler.extract_plugin_zip(&valid, &install_path).unwrap();

    assert!(install_path.join(".codex-plugin/plugin.json").exists());
    let generated_claude = read_json(install_path.join(".claude-plugin/plugin.json"));
    assert!(generated_claude.get("displayName").is_none());
    assert!(generated_claude.get("interface").is_none());
    assert_eq!(
        fs::read_to_string(install_path.join("skills/debugging/SKILL.md")).unwrap(),
        "# Debug"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = fs::metadata(install_path.join("hooks/claude/session-start-hook.cmd"))
            .unwrap()
            .permissions()
            .mode();
        assert_ne!(mode & 0o111, 0);
    }
    assert!(!install_path.join("superpowers").exists());
    assert!(!install_path.join("__MACOSX").exists());
    assert!(!install_path.join("old.txt").exists());
}

#[test]
fn extract_plugin_zip_rejects_duplicate_paths() {
    let temp = TempRoot::new("capability-sync-plugin-zip-duplicate");
    let install_path = temp.path().join("plugins/duplicate");
    fs::create_dir_all(&install_path).unwrap();
    let store = GlobalCapabilityStore::new(
        temp.path().join("manifest.json"),
        temp.path().join("skills"),
    );
    let handler = CapabilitySyncHandler::new("token", store);
    let duplicate = zip_bytes(&[
        (
            "duplicate/.claude-plugin/plugin.json",
            r#"{"name":"duplicate"}"#,
        ),
        ("duplicate/skills/a/SKILL.md", "# A"),
        ("duplicate/skills/a/SKILL.md", "# B"),
    ]);
    let error = handler
        .extract_plugin_zip(&duplicate, &install_path)
        .unwrap_err();
    assert!(error.to_string().contains("Duplicate path"));
}

#[cfg(unix)]
#[test]
fn restore_enabled_claude_plugin_cache_repairs_existing_hook_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempRoot::new("capability-sync-plugin-hook-permissions");
    let claude_dir = temp.path().join(".claude");
    let plugins_dir = claude_dir.join("plugins");
    let install_path = plugins_dir.join("cache/wegent/superpowers/5.0.7");
    let hook_path = install_path.join("hooks/run-hook.cmd");
    fs::create_dir_all(hook_path.parent().unwrap()).unwrap();
    fs::write(&hook_path, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&hook_path, fs::Permissions::from_mode(0o644)).unwrap();
    fs::create_dir_all(&plugins_dir).unwrap();
    fs::write(
        claude_dir.join("settings.json"),
        json!({"enabledPlugins": {"superpowers@wegent": true}}).to_string(),
    )
    .unwrap();
    fs::write(
        plugins_dir.join("installed_plugins.json"),
        json!({
            "version": 2,
            "plugins": {
                "superpowers@wegent": [{
                    "installPath": install_path.display().to_string(),
                    "version": "5.0.7"
                }]
            }
        })
        .to_string(),
    )
    .unwrap();

    let restored = restore_enabled_claude_plugin_cache(&claude_dir).unwrap();

    assert!(restored.is_empty());
    let mode = fs::metadata(&hook_path).unwrap().permissions().mode();
    assert_ne!(mode & 0o111, 0);
}

#[test]
fn restore_enabled_claude_plugin_cache_recovers_managed_plugin_from_store() {
    let temp = TempRoot::new("capability-sync-plugin-store-restore");
    let claude_dir = temp.path().join(".claude");
    let plugins_dir = claude_dir.join("plugins");
    let install_path = plugins_dir.join("cache/wegent/wegent-sites/1.0.0");
    let store_path = temp
        .path()
        .join(".wegent-executor/capabilities/store/plugins/9-wegent-wegent-sites-1.0.0");
    fs::create_dir_all(store_path.join(".claude-plugin")).unwrap();
    fs::create_dir_all(store_path.join("skills/sites-building")).unwrap();
    fs::write(
        store_path.join(".claude-plugin/plugin.json"),
        r#"{"name":"wegent-sites","version":"1.0.0","displayName":"Sites"}"#,
    )
    .unwrap();
    fs::write(
        store_path.join("skills/sites-building/SKILL.md"),
        "---\nname: sites-building\n---\n",
    )
    .unwrap();
    fs::create_dir_all(install_path.join(".claude-plugin")).unwrap();
    fs::write(
        install_path.join(".claude-plugin/plugin.json"),
        r#"{"name":"wegent-sites","displayName":"Stale Sites"}"#,
    )
    .unwrap();
    ManagedCapabilityManifest::new(
        temp.path()
            .join(".wegent-executor/capabilities/manifest.json"),
    )
    .save(json!({
        "version": 1,
        "revision": 1,
        "skills": {},
        "plugins": {
            "wegent-sites@wegent": {
                "managed": true,
                "name": "wegent-sites",
                "marketplace": "wegent",
                "version": "1.0.0",
                "store_path": store_path.display().to_string(),
                "runtime": {
                    "claude_link": install_path.display().to_string()
                }
            }
        },
        "mcps": {}
    }))
    .unwrap();

    let restored = restore_enabled_claude_plugin_cache(&claude_dir).unwrap();

    assert_eq!(restored, vec!["wegent-sites@wegent"]);
    assert!(install_path.is_dir());
    assert!(!install_path.is_symlink());
    assert!(install_path
        .join("skills/sites-building/SKILL.md")
        .is_file());
    assert!(install_path.join(".codex-plugin/plugin.json").is_file());
    let claude_manifest = read_json(install_path.join(".claude-plugin/plugin.json"));
    assert!(claude_manifest.get("displayName").is_none());
    let installed = read_json(plugins_dir.join("installed_plugins.json"));
    assert_eq!(
        installed["plugins"]["wegent-sites@wegent"][0]["installPath"],
        install_path.display().to_string()
    );
    let settings = read_json(claude_dir.join("settings.json"));
    assert_eq!(settings["enabledPlugins"]["wegent-sites@wegent"], true);
    assert_eq!(
        settings["extraKnownMarketplaces"]["wegent"]["source"]["source"],
        "directory"
    );
    let marketplace =
        read_json(plugins_dir.join("marketplaces/wegent/.claude-plugin/marketplace.json"));
    assert_eq!(marketplace["name"], "wegent");
    assert_eq!(marketplace["owner"]["name"], "Wegent Team");
    assert_eq!(marketplace["plugins"][0]["name"], "wegent-sites");
}

#[tokio::test]
async fn replace_sync_removes_stale_managed_plugin_but_keeps_local_user_plugin() {
    let temp = TempRoot::new("capability-sync-remove-plugin");
    let skills_dir = temp.path().join("skills");
    let plugins_dir = temp.path().join("plugins");
    let codex_plugins_dir = temp.path().join(".codex/plugins");
    let manifest_path = temp.path().join("capabilities.json");
    let keep_path = plugins_dir.join("cache/market/keep-plugin/1.0.0");
    fs::create_dir_all(&keep_path).unwrap();
    fs::create_dir_all(&plugins_dir).unwrap();
    let old_claude_link = plugins_dir.join("cache/market/old-plugin/1.0.0");
    let old_codex_link = codex_plugins_dir.join("old-plugin-market");
    let old_store_plugin = temp.path().join("store/plugins/old-plugin");
    let orphan_store_plugin = temp.path().join("store/plugins/orphan-plugin");
    fs::create_dir_all(&old_store_plugin).unwrap();
    fs::create_dir_all(&orphan_store_plugin).unwrap();
    fs::create_dir_all(&old_claude_link).unwrap();
    fs::write(old_claude_link.join("plugin.txt"), "managed copy").unwrap();
    fs::create_dir_all(&old_codex_link).unwrap();
    fs::write(old_codex_link.join("plugin.txt"), "managed copy").unwrap();
    fs::write(
        plugins_dir.join("installed_plugins.json"),
        json!({
            "version": 2,
            "plugins": {
                "old-plugin@market": [{"scope": "user", "installPath": old_claude_link.display().to_string(), "version": "1.0.0"}],
                "keep-plugin@market": [{"scope": "user", "installPath": keep_path.display().to_string(), "version": "1.0.0"}],
                "local-plugin@market": [{"scope": "user", "installPath": plugins_dir.join("cache/market/local-plugin/1.0.0").display().to_string(), "version": "1.0.0"}]
            }
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 1,
            "skills": {},
            "plugins": {
                "old-plugin@market": {
                    "managed": true,
                    "store_path": old_store_plugin.display().to_string(),
                    "runtime": {
                        "claude_link": old_claude_link.display().to_string(),
                        "codex_link": old_codex_link.display().to_string()
                    }
                },
                "keep-plugin@market": {"managed": true}
            },
            "mcps": {}
        })
        .to_string(),
    )
    .unwrap();
    let store = GlobalCapabilityStore::new(manifest_path, skills_dir)
        .with_plugins_dir(plugins_dir.clone())
        .with_codex_plugins_dir(codex_plugins_dir);
    let handler = CapabilitySyncHandler::new("token", store);

    let result = handler
        .apply_sync(json!({
            "mode": "replace",
            "skills": [],
            "plugins": [{"name": "keep-plugin", "marketplace": "market", "version": "1.0.0"}],
            "mcps": [],
        }))
        .await
        .unwrap();

    assert_eq!(result["success"], true);
    let installed = read_json(plugins_dir.join("installed_plugins.json"));
    assert!(installed["plugins"].get("old-plugin@market").is_none());
    assert!(installed["plugins"].get("keep-plugin@market").is_some());
    assert!(installed["plugins"].get("local-plugin@market").is_some());
    assert!(!old_claude_link.exists());
    assert!(!old_codex_link.exists());
    assert!(!old_store_plugin.exists());
    assert!(!orphan_store_plugin.exists());
}

#[test]
fn reconcile_managed_plugins_restores_claude_codex_marketplace_and_enablement() {
    let temp = TempRoot::new("capability-sync-reconcile-plugin");
    let skills_dir = temp.path().join(".claude/skills");
    let plugins_dir = temp.path().join(".claude/plugins");
    let codex_plugins_dir = temp.path().join(".codex/plugins");
    let store_dir = temp.path().join("store");
    let manifest_path = temp.path().join("capabilities.json");
    let store_plugin_path = store_dir.join("plugins/1614-wegent-superpowers-5.0.7");
    fs::create_dir_all(store_plugin_path.join(".codex-plugin")).unwrap();
    fs::write(
        store_plugin_path.join(".codex-plugin/plugin.json"),
        r#"{"name":"superpowers","version":"5.0.7"}"#,
    )
    .unwrap();
    fs::create_dir_all(store_plugin_path.join("skills/systematic-debugging")).unwrap();
    fs::write(
        store_plugin_path.join("skills/systematic-debugging/SKILL.md"),
        "---\nname: systematic-debugging\ndescription: Use when encountering bugs.\n---\n",
    )
    .unwrap();
    fs::create_dir_all(&plugins_dir).unwrap();
    fs::write(
        plugins_dir.join("installed_plugins.json"),
        json!({"version": 2, "plugins": {}}).to_string(),
    )
    .unwrap();
    fs::write(
        plugins_dir.parent().unwrap().join("settings.json"),
        json!({"enabledPlugins": {"context7@market": true}}).to_string(),
    )
    .unwrap();
    let claude_marketplace_path =
        plugins_dir.join("marketplaces/wegent/.claude-plugin/marketplace.json");
    fs::create_dir_all(claude_marketplace_path.parent().unwrap()).unwrap();
    fs::write(
        &claude_marketplace_path,
        json!({
            "name": "wegent",
            "owner": {"name": "Wegent Team"},
            "plugins": [{
                "description": "",
                "name": "context7",
                "source": "./plugins/context7-wegent",
                "version": "latest"
            }]
        })
        .to_string(),
    )
    .unwrap();
    fs::write(
        &manifest_path,
        json!({
            "version": 1,
            "revision": 1,
            "skills": {},
            "plugins": {
                "superpowers@wegent": {
                    "name": "superpowers",
                    "key": "superpowers@wegent",
                    "installed_plugin_id": 1614,
                    "marketplace": "wegent",
                    "version": "5.0.7",
                    "checksum": "sha256:abc",
                    "component_states": {"skill:systematic-debugging": true},
                    "store_path": store_plugin_path.display().to_string(),
                    "runtime": {
                        "claude_link": plugins_dir.join("cache/wegent/superpowers/5.0.7").display().to_string(),
                        "codex_link": codex_plugins_dir.join("superpowers-wegent").display().to_string()
                    },
                    "managed": true
                }
            },
            "mcps": {}
        })
        .to_string(),
    )
    .unwrap();
    let legacy_codex_link = codex_plugins_dir.join("superpowers-wegent");
    fs::create_dir_all(legacy_codex_link.parent().unwrap()).unwrap();
    symlink_dir(&store_plugin_path, &legacy_codex_link);
    let stale_store_plugin = store_dir.join("plugins/1614-wegent-superpowers-5.0.6");
    fs::create_dir_all(stale_store_plugin.join(".codex-plugin")).unwrap();
    let referenced_legacy_zip = plugins_dir.join("cache/wegent/superpowers.zip");
    let stale_legacy_zip = plugins_dir.join("cache/wegent/dingtalk.zip");
    let external_cache_target = temp.path().join("external-cache-target");
    let unreferenced_cache_symlink = plugins_dir.join("cache/wegent/evil-plugin");
    fs::create_dir_all(referenced_legacy_zip.parent().unwrap()).unwrap();
    fs::write(&referenced_legacy_zip, b"legacy package").unwrap();
    fs::write(&stale_legacy_zip, b"stale package").unwrap();
    fs::create_dir_all(&external_cache_target).unwrap();
    fs::write(external_cache_target.join("must-survive.txt"), b"safe").unwrap();
    symlink_dir(&external_cache_target, &unreferenced_cache_symlink);
    let stale_claude_version = plugins_dir.join("cache/wegent/superpowers/5.0.6");
    let stale_codex_version = codex_plugins_dir.join("cache/wegent/superpowers/5.0.6");
    let stale_codex_plugin = codex_plugins_dir.join("cache/wegent/dingtalk/0.2.2");
    let stale_public_plugin = codex_plugins_dir.join("cache/wework/lark/0.1.0");
    let personal_plugin = codex_plugins_dir.join("cache/wework-personal/dev-tools/1.0.0");
    let openai_plugin = codex_plugins_dir.join("cache/openai-curated/github/1.0.0");
    for path in [
        &stale_claude_version,
        &stale_codex_version,
        &stale_codex_plugin,
        &stale_public_plugin,
        &personal_plugin,
        &openai_plugin,
    ] {
        fs::create_dir_all(path).unwrap();
    }
    let stale_claude_marketplace_link =
        plugins_dir.join("marketplaces/wegent/plugins/context7-wegent");
    let stale_codex_marketplace_link =
        codex_plugins_dir.join("marketplaces/wegent/plugins/context7");
    symlink_dir(&stale_store_plugin, &stale_claude_marketplace_link);
    symlink_dir(&stale_store_plugin, &stale_codex_marketplace_link);
    let claude_agents_marketplace_path =
        plugins_dir.join("marketplaces/wegent/.agents/plugins/marketplace.json");
    fs::create_dir_all(claude_agents_marketplace_path.parent().unwrap()).unwrap();
    fs::write(
        &claude_agents_marketplace_path,
        json!({"name": "wegent", "plugins": [{"name": "context7"}]}).to_string(),
    )
    .unwrap();
    let codex_agents_marketplace_path =
        codex_plugins_dir.join("marketplaces/wegent/.agents/plugins/marketplace.json");
    fs::create_dir_all(codex_agents_marketplace_path.parent().unwrap()).unwrap();
    fs::write(
        &codex_agents_marketplace_path,
        json!({"name": "wegent", "plugins": [{"name": "context7"}]}).to_string(),
    )
    .unwrap();
    fs::write(
        codex_plugins_dir.parent().unwrap().join("config.toml"),
        r#"
[plugins."superpowers@wegent"]
enabled = true

[plugins."dingtalk@wegent"]
enabled = true

[plugins."lark@wework"]
enabled = true

[plugins."dev-tools@wework-personal"]
enabled = true

[plugins."github@openai-curated"]
enabled = true
"#,
    )
    .unwrap();
    let store = GlobalCapabilityStore::new(manifest_path, skills_dir)
        .with_plugins_dir(plugins_dir.clone())
        .with_codex_plugins_dir(codex_plugins_dir.clone())
        .with_store_dir(store_dir);

    let restored = store.reconcile_managed_plugins().unwrap();

    assert_eq!(restored, vec!["superpowers@wegent"]);
    let runtime_link = plugins_dir.join("cache/wegent/superpowers/5.0.7");
    assert!(runtime_link.is_dir());
    assert!(!runtime_link.is_symlink());
    assert!(runtime_link
        .join("skills/systematic-debugging/SKILL.md")
        .is_file());
    let codex_runtime = codex_plugins_dir.join("cache/wegent/superpowers/5.0.7");
    assert!(codex_runtime.is_dir());
    assert!(!codex_runtime.is_symlink());
    assert!(codex_runtime
        .join("skills/systematic-debugging/SKILL.md")
        .is_file());
    assert!(!stale_store_plugin.exists());
    assert!(!stale_claude_version.exists());
    assert!(!stale_codex_version.exists());
    assert!(!stale_codex_plugin.exists());
    assert!(!stale_public_plugin.exists());
    assert!(referenced_legacy_zip.is_file());
    assert!(!stale_legacy_zip.exists());
    assert!(!unreferenced_cache_symlink.exists());
    assert_eq!(
        fs::read_to_string(external_cache_target.join("must-survive.txt")).unwrap(),
        "safe"
    );
    assert!(personal_plugin.is_dir());
    assert!(openai_plugin.is_dir());
    assert!(!stale_claude_marketplace_link.exists());
    assert!(!stale_codex_marketplace_link.exists());
    assert!(codex_plugins_dir
        .join("marketplaces/wegent/plugins/superpowers")
        .is_symlink());
    assert!(!legacy_codex_link.exists());
    let codex_config = read_toml(codex_plugins_dir.parent().unwrap().join("config.toml"));
    assert_eq!(
        codex_config["marketplaces"]["wegent"]["source"].as_str(),
        Some(
            codex_plugins_dir
                .join("marketplaces/wegent")
                .to_string_lossy()
                .as_ref()
        )
    );
    assert_eq!(
        codex_config["plugins"]["superpowers@wegent"]["enabled"].as_bool(),
        Some(true)
    );
    // Reconciliation never rewrites the complete Codex config. App Server owns
    // plugin config mutations so concurrent policy writes cannot be lost.
    assert_eq!(
        codex_config["plugins"]["dingtalk@wegent"]["enabled"].as_bool(),
        Some(true)
    );
    assert_eq!(
        codex_config["plugins"]["lark@wework"]["enabled"].as_bool(),
        Some(true)
    );
    assert_eq!(
        codex_config["plugins"]["dev-tools@wework-personal"]["enabled"].as_bool(),
        Some(true)
    );
    assert_eq!(
        codex_config["plugins"]["github@openai-curated"]["enabled"].as_bool(),
        Some(true)
    );
    let installed = read_json(plugins_dir.join("installed_plugins.json"));
    assert_eq!(
        installed["plugins"]["superpowers@wegent"][0]["checksum"],
        "sha256:abc"
    );
    assert_eq!(
        installed["plugins"]["superpowers@wegent"][0]["componentStates"],
        json!({"skill:systematic-debugging": true})
    );
    let settings = read_json(plugins_dir.parent().unwrap().join("settings.json"));
    assert_eq!(settings["enabledPlugins"]["context7@market"], true);
    assert_eq!(settings["enabledPlugins"]["superpowers@wegent"], true);
    assert_eq!(
        settings["extraKnownMarketplaces"]["wegent"]["source"],
        json!({
            "source": "directory",
            "path": plugins_dir.join("marketplaces/wegent").display().to_string()
        })
    );
    let known = read_json(plugins_dir.join("known_marketplaces.json"));
    assert_eq!(
        known["wegent"]["installLocation"],
        plugins_dir
            .join("marketplaces/wegent")
            .display()
            .to_string()
    );
    assert_eq!(
        known["wegent"]["source"],
        json!({
            "source": "directory",
            "path": plugins_dir.join("marketplaces/wegent").display().to_string()
        })
    );
    assert!(known["wegent"]["lastUpdated"].as_str().is_some());
    let marketplace_link = plugins_dir.join("marketplaces/wegent/plugins/superpowers-wegent");
    assert!(marketplace_link.is_symlink());
    let marketplace = read_json(claude_marketplace_path);
    assert_eq!(marketplace["name"], "wegent");
    assert_eq!(marketplace["owner"], json!({"name": "Wegent Team"}));
    assert_eq!(
        marketplace["plugins"],
        json!([
            {
                "description": "",
                "name": "superpowers",
                "source": "./plugins/superpowers-wegent",
                "version": "5.0.7"
            }
        ])
    );
    assert_eq!(
        read_json(claude_agents_marketplace_path)["plugins"],
        json!([{"name": "superpowers", "source": {"source": "local", "path": "./plugins/superpowers-wegent"}, "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"}}])
    );
    assert_eq!(
        read_json(codex_agents_marketplace_path)["plugins"],
        json!([{"name": "superpowers", "source": {"source": "local", "path": "./plugins/superpowers"}, "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL", "products": ["CODEX"]}}])
    );
}

#[test]
fn reconcile_managed_plugins_refuses_a_symlinked_cache_root() {
    let temp = TempRoot::new("capability-sync-symlinked-cache-root");
    let skills_dir = temp.path().join(".claude/skills");
    let plugins_dir = temp.path().join(".claude/plugins");
    let codex_plugins_dir = temp.path().join(".codex/plugins");
    let external_cache = temp.path().join("external-cache");
    fs::create_dir_all(&plugins_dir).unwrap();
    fs::create_dir_all(&external_cache).unwrap();
    fs::write(external_cache.join("must-survive.txt"), b"safe").unwrap();
    symlink_dir(&external_cache, &plugins_dir.join("cache"));
    let store = GlobalCapabilityStore::new(temp.path().join("capabilities.json"), skills_dir)
        .with_plugins_dir(plugins_dir)
        .with_codex_plugins_dir(codex_plugins_dir)
        .with_store_dir(temp.path().join("store"));

    let error = store.reconcile_managed_plugins().unwrap_err();

    assert!(error.to_string().contains("managed path symlink"));
    assert_eq!(
        fs::read_to_string(external_cache.join("must-survive.txt")).unwrap(),
        "safe"
    );
}

#[test]
fn reporter_marks_local_and_managed_capabilities_and_falls_back_to_plugin_store() {
    let temp = TempRoot::new("capability-sync-report");
    let skills_dir = temp.path().join(".claude/skills");
    let plugins_dir = temp.path().join(".claude/plugins");
    let store_dir = temp.path().join(".wegent-executor/capabilities/store");
    let manifest_path = temp
        .path()
        .join(".wegent-executor/capabilities/manifest.json");
    fs::create_dir_all(skills_dir.join("local-review-helper")).unwrap();
    fs::write(
        skills_dir.join("local-review-helper/SKILL.md"),
        "---\nname: local-review-helper\n---\n",
    )
    .unwrap();
    fs::create_dir_all(skills_dir.join("browser")).unwrap();
    fs::write(
        skills_dir.join("browser/SKILL.md"),
        "---\nname: browser\n---\n",
    )
    .unwrap();
    let plugin_install_path =
        plugins_dir.join("cache/claude-plugins-official/context7/1057d02c5307");
    fs::create_dir_all(plugin_install_path.join("skills/context7")).unwrap();
    fs::write(
        plugin_install_path.join("skills/context7/SKILL.md"),
        "---\nname: context7\ndescription: Look up version-specific documentation.\n---\n# Context7\n",
    )
    .unwrap();
    let missing_cache_path = plugins_dir.join("cache/wegent/superpowers/5.0.7");
    let store_plugin_path = store_dir.join("plugins/1614-wegent-superpowers-5.0.7");
    fs::create_dir_all(store_plugin_path.join("skills/systematic-debugging")).unwrap();
    fs::write(
        store_plugin_path.join("skills/systematic-debugging/SKILL.md"),
        "---\nname: systematic-debugging\ndescription: Use when encountering bugs.\n---\n# Systematic Debugging\n",
    )
    .unwrap();
    fs::create_dir_all(&plugins_dir).unwrap();
    fs::write(
        plugins_dir.join("installed_plugins.json"),
        json!({
            "version": 2,
            "plugins": {
                "context7@claude-plugins-official": [{
                    "scope": "user",
                    "installPath": plugin_install_path.display().to_string(),
                    "version": "1057d02c5307",
                    "installedAt": "2026-01-30T05:59:58.844Z",
                    "lastUpdated": "2026-04-10T06:11:01.715Z"
                }],
                "superpowers@wegent": [{
                    "scope": "user",
                    "installPath": missing_cache_path.display().to_string(),
                    "version": "5.0.7",
                    "installedAt": "2026-06-09T08:45:55.290Z",
                    "lastUpdated": "2026-06-09T08:45:55.290Z"
                }]
            }
        })
        .to_string(),
    )
    .unwrap();
    let manifest = ManagedCapabilityManifest::new(manifest_path);
    manifest
        .save(json!({
            "version": 1,
            "revision": 1,
            "skills": {
                "browser": {"skill_id": 101, "namespace": "default", "managed": true}
            },
            "plugins": {
                "superpowers@wegent": {
                    "installed_plugin_id": 1614,
                    "managed": true,
                    "store_path": store_plugin_path.display().to_string(),
                    "version": "5.0.7",
                    "component_states": {"skill:systematic-debugging": true}
                }
            },
            "mcps": {
                "wegent__old_docs": {
                    "installed_mcp_id": 7,
                    "server": {"url": "https://example.com/mcp"}
                }
            }
        }))
        .unwrap();
    let reporter = GlobalCapabilityReporter::new(skills_dir, plugins_dir, manifest);

    let report = reporter.build_report(true).unwrap();

    assert_eq!(report["full"], true);
    assert_eq!(
        report["skills"],
        json!([
            {"name": "browser", "skill_id": 101, "namespace": "default", "source": "wegent"},
            {"name": "local-review-helper", "source": "local_user"}
        ])
    );
    assert_eq!(
        report["mcps"],
        json!([{
            "name": "wegent__old_docs",
            "installed_mcp_id": 7,
            "server": {"url": "https://example.com/mcp"},
            "source": "wegent"
        }])
    );
    assert_eq!(report["plugins"][0]["name"], "context7");
    assert_eq!(report["plugins"][0]["source"], "local_user");
    assert_eq!(
        report["plugins"][0]["skills"][0]["description"],
        "Look up version-specific documentation."
    );
    assert_eq!(report["plugins"][1]["name"], "superpowers");
    assert_eq!(report["plugins"][1]["source"], "wegent");
    assert_eq!(report["plugins"][1]["installed_plugin_id"], 1614);
    assert_eq!(
        report["plugins"][1]["skills"][0]["name"],
        "systematic-debugging"
    );
}

#[test]
fn global_capability_helpers_match_project_and_device_config_contract() {
    let temp = TempRoot::new("capability-sync-global");
    let _home = EnvGuard::set("HOME", temp.path().display().to_string());
    let _executor_home = EnvGuard::remove("WEGENT_EXECUTOR_HOME");
    assert_eq!(
        default_manifest_path(),
        temp.path()
            .join(".wegent-executor/capabilities/manifest.json")
    );

    let mut frontend_device_chat = ExecutionRequest::default();
    frontend_device_chat
        .extra
        .insert("project_id".to_owned(), json!(0));
    assert_eq!(get_project_id(&frontend_device_chat), "");
    assert!(!is_project_task(&frontend_device_chat));

    let mut standalone_chat = ExecutionRequest::default();
    standalone_chat
        .extra
        .insert("project_id".to_owned(), json!(0));
    standalone_chat
        .extra
        .insert("standalone_chat_workspace".to_owned(), json!(true));
    assert_eq!(get_project_id(&standalone_chat), "0");
    assert!(is_project_task(&standalone_chat));

    let mut workspace_project = ExecutionRequest::default();
    workspace_project.extra.insert(
        "workspace".to_owned(),
        json!({"project": {"project_id": 42}}),
    );
    assert_eq!(get_project_id(&workspace_project), "42");
    assert!(is_project_task(&workspace_project));

    let device = DeviceConfig {
        connection: ConnectionConfig {
            auth_token: "device-config-token".to_owned(),
            ..ConnectionConfig::default()
        },
        ..DeviceConfig::default()
    };
    let store = GlobalCapabilityStore::new(
        temp.path().join("manifest.json"),
        temp.path().join("skills"),
    );
    let handler = CapabilitySyncHandler::from_device_config(&device, store);
    assert_eq!(handler.auth_token(), "device-config-token");
}

#[derive(Clone, Default)]
struct RecordingPluginRuntime {
    calls: Arc<Mutex<Vec<String>>>,
}

impl CapabilityPluginRuntime for RecordingPluginRuntime {
    fn install_plugin<'a>(
        &'a self,
        spec: &'a PluginSyncSpec,
        marketplace_path: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        self.calls.lock().unwrap().push(format!(
            "install:{}:{}:{}",
            spec.name,
            spec.enabled,
            marketplace_path.display()
        ));
        Box::pin(std::future::ready(Ok(())))
    }

    fn uninstall_plugin<'a>(
        &'a self,
        name: &'a str,
        marketplace: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        self.calls
            .lock()
            .unwrap()
            .push(format!("uninstall:{name}:{marketplace}"));
        Box::pin(std::future::ready(Ok(())))
    }
}

#[derive(Default)]
struct StaticPackageProvider {
    skills: BTreeMap<String, String>,
    plugins: BTreeMap<String, Vec<u8>>,
    skill_calls: Mutex<Vec<String>>,
    plugin_calls: Mutex<Vec<String>>,
    skill_delay: Option<Duration>,
}

impl StaticPackageProvider {
    fn with_skill(mut self, name: &str, content: &str) -> Self {
        self.skills.insert(name.to_owned(), content.to_owned());
        self
    }

    fn with_plugin(mut self, path: &str, bytes: Vec<u8>) -> Self {
        self.plugins.insert(path.to_owned(), bytes);
        self
    }

    fn with_skill_delay(mut self, delay: Duration) -> Self {
        self.skill_delay = Some(delay);
        self
    }
}

impl CapabilityPackageProvider for StaticPackageProvider {
    fn stage_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
        target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            if let Some(delay) = self.skill_delay {
                tokio::time::sleep(delay).await;
            }
            self.skill_calls.lock().unwrap().push(spec.name.clone());
            match self.skills.get(&spec.name) {
                Some(content) => fs::create_dir_all(target)
                    .and_then(|()| fs::write(target.join("SKILL.md"), content))
                    .map_err(CapabilitySyncError::from),
                None => Err(CapabilitySyncError::invalid_payload(format!(
                    "missing test skill {}",
                    spec.name
                ))),
            }
        })
    }

    fn download_plugin<'a>(
        &'a self,
        download_path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        let result = {
            self.plugin_calls
                .lock()
                .unwrap()
                .push(download_path.to_owned());
            self.plugins.get(download_path).cloned().ok_or_else(|| {
                CapabilitySyncError::invalid_payload(format!("missing test plugin {download_path}"))
            })
        };
        Box::pin(std::future::ready(result))
    }
}

struct TempRoot {
    path: PathBuf,
}

impl TempRoot {
    fn new(label: &str) -> Self {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let path = env::temp_dir().join(format!("wegent-{label}-{}-{millis}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct EnvGuard {
    name: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(name: &'static str, value: String) -> Self {
        let previous = env::var(name).ok();
        env::set_var(name, value);
        Self { name, previous }
    }

    fn remove(name: &'static str) -> Self {
        let previous = env::var(name).ok();
        env::remove_var(name);
        Self { name, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            env::set_var(self.name, previous);
        } else {
            env::remove_var(self.name);
        }
    }
}

fn write_test_plugin_package(path: &Path, payload: &str) {
    fs::create_dir_all(path.join(".claude-plugin")).unwrap();
    fs::write(
        path.join(".claude-plugin/plugin.json"),
        r#"{"name":"dev-tools","version":"0.1.0"}"#,
    )
    .unwrap();
    fs::write(path.join("payload.txt"), payload).unwrap();
}

fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn read_toml(path: impl AsRef<Path>) -> DocumentMut {
    fs::read_to_string(path).unwrap().parse().unwrap()
}

fn symlink_dir(target: &Path, link: &Path) {
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    let _ = fs::remove_file(link);
    let _ = fs::remove_dir_all(link);
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(target, link).unwrap();
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity("sha256:".len() + digest.len() * 2);
    output.push_str("sha256:");
    for byte in digest {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

fn zip_bytes(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, content) in entries {
        let offset = out.len() as u32;
        let name_bytes = name.as_bytes();
        let data = content.as_bytes();
        let crc = crc32(data);
        write_u32(&mut out, 0x0403_4b50);
        write_u16(&mut out, 20);
        write_u16(&mut out, 0);
        write_u16(&mut out, 0);
        write_u16(&mut out, 0);
        write_u16(&mut out, 0);
        write_u32(&mut out, crc);
        write_u32(&mut out, data.len() as u32);
        write_u32(&mut out, data.len() as u32);
        write_u16(&mut out, name_bytes.len() as u16);
        write_u16(&mut out, 0);
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        write_u32(&mut central, 0x0201_4b50);
        write_u16(&mut central, 20);
        write_u16(&mut central, 20);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u32(&mut central, crc);
        write_u32(&mut central, data.len() as u32);
        write_u32(&mut central, data.len() as u32);
        write_u16(&mut central, name_bytes.len() as u16);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u32(&mut central, 0);
        write_u32(&mut central, offset);
        central.extend_from_slice(name_bytes);
    }
    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    out.extend_from_slice(&central);
    write_u32(&mut out, 0x0605_4b50);
    write_u16(&mut out, 0);
    write_u16(&mut out, 0);
    write_u16(&mut out, entries.len() as u16);
    write_u16(&mut out, entries.len() as u16);
    write_u32(&mut out, central_size);
    write_u32(&mut out, central_offset);
    write_u16(&mut out, 0);
    out
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn write_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn write_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}
