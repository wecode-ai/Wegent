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
use wegent_executor::{
    config::device::{ConnectionConfig, DeviceConfig},
    local::capabilities::{
        default_manifest_path, get_project_id, is_project_task, CapabilityPackageProvider,
        CapabilitySyncError, CapabilitySyncHandler, GlobalCapabilityReporter,
        GlobalCapabilityStore, ManagedCapabilityManifest, SkillSyncSpec,
    },
    protocol::ExecutionRequest,
};

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
async fn plugin_sync_downloads_changed_packages_links_runtimes_and_updates_claude_metadata() {
    let temp = TempRoot::new("capability-sync-plugin");
    let skills_dir = temp.path().join("skills");
    let plugins_dir = temp.path().join(".claude/plugins");
    let codex_plugins_dir = temp.path().join(".codex/plugins");
    let store_dir = temp.path().join("store");
    let manifest_path = temp.path().join("capabilities.json");
    let store_plugin_path = store_dir.join("plugins/9-market-context7-1.0.0");
    fs::create_dir_all(store_plugin_path.join(".claude-plugin")).unwrap();
    fs::write(
        store_plugin_path.join(".claude-plugin/plugin.json"),
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
    let package = zip_bytes(&[
        (
            "context7/.claude-plugin/plugin.json",
            r#"{"name":"context7"}"#,
        ),
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
    assert!(runtime_link.is_symlink());
    assert_eq!(
        fs::canonicalize(&runtime_link).unwrap(),
        fs::canonicalize(&store_plugin_path).unwrap()
    );
    assert!(codex_plugins_dir.join("context7-market").is_symlink());
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
async fn plugin_sync_links_existing_package_and_downloads_uploaded_plugin_to_wegent_store() {
    let temp = TempRoot::new("capability-sync-uploaded-plugin");
    let skills_dir = temp.path().join("skills");
    let plugins_dir = temp.path().join(".claude/plugins");
    let codex_plugins_dir = temp.path().join(".codex/plugins");
    let store_dir = temp.path().join("store");
    let manifest_path = temp.path().join("capabilities.json");
    let context7_store = store_dir.join("plugins/9-claude-plugins-official-context7-1057d02c5307");
    fs::create_dir_all(context7_store.join(".claude-plugin")).unwrap();
    fs::write(
        context7_store.join(".claude-plugin/plugin.json"),
        r#"{"name":"context7"}"#,
    )
    .unwrap();
    let uploaded = zip_bytes(&[
        (
            "superpowers/5.0.7/.claude-plugin/plugin.json",
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
    assert!(context7_runtime.is_symlink());
    assert_eq!(
        fs::canonicalize(&context7_runtime).unwrap(),
        fs::canonicalize(&context7_store).unwrap()
    );
    assert!(codex_plugins_dir
        .join("context7-claude-plugins-official")
        .is_symlink());
    let uploaded_store = store_dir.join("plugins/302-wegent-superpowers-5.0.7");
    assert_eq!(
        fs::read_to_string(uploaded_store.join("skills/debugging/SKILL.md")).unwrap(),
        "# Debug"
    );
    assert!(plugins_dir
        .join("cache/wegent/superpowers/5.0.7")
        .is_symlink());
    assert!(codex_plugins_dir.join("superpowers-wegent").is_symlink());
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
    fs::create_dir_all(install_path.join(".claude-plugin")).unwrap();
    fs::write(
        install_path.join(".claude-plugin/plugin.json"),
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

    let valid = zip_bytes(&[
        (
            "superpowers/5.0.7/.claude-plugin/plugin.json",
            r#"{"name":"superpowers","version":"5.0.7"}"#,
        ),
        ("superpowers/5.0.7/skills/debugging/SKILL.md", "# Debug"),
        ("__MACOSX/._superpowers", ""),
        ("__MACOSX/superpowers/._debugging", ""),
    ]);
    handler.extract_plugin_zip(&valid, &install_path).unwrap();

    assert!(install_path.join(".claude-plugin/plugin.json").exists());
    assert_eq!(
        fs::read_to_string(install_path.join("skills/debugging/SKILL.md")).unwrap(),
        "# Debug"
    );
    assert!(!install_path.join("superpowers").exists());
    assert!(!install_path.join("__MACOSX").exists());
    assert!(!install_path.join("old.txt").exists());
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
    fs::create_dir_all(&old_store_plugin).unwrap();
    fs::create_dir_all(old_claude_link.parent().unwrap()).unwrap();
    fs::create_dir_all(old_codex_link.parent().unwrap()).unwrap();
    symlink_dir(&old_store_plugin, &old_claude_link);
    symlink_dir(&old_store_plugin, &old_codex_link);
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
    fs::create_dir_all(store_plugin_path.join(".claude-plugin")).unwrap();
    fs::write(
        store_plugin_path.join(".claude-plugin/plugin.json"),
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
    let store = GlobalCapabilityStore::new(manifest_path, skills_dir)
        .with_plugins_dir(plugins_dir.clone())
        .with_codex_plugins_dir(codex_plugins_dir.clone())
        .with_store_dir(store_dir);

    let restored = store.reconcile_managed_plugins().unwrap();

    assert_eq!(restored, vec!["superpowers@wegent"]);
    let runtime_link = plugins_dir.join("cache/wegent/superpowers/5.0.7");
    assert!(runtime_link.is_symlink());
    assert_eq!(
        fs::canonicalize(&runtime_link).unwrap(),
        fs::canonicalize(&store_plugin_path).unwrap()
    );
    assert!(codex_plugins_dir.join("superpowers-wegent").is_symlink());
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
    let known = read_json(plugins_dir.join("known_marketplaces.json"));
    assert_eq!(
        known["wegent"]["installLocation"],
        plugins_dir
            .join("marketplaces/wegent")
            .display()
            .to_string()
    );
    let marketplace_link = plugins_dir.join("marketplaces/wegent/plugins/superpowers-wegent");
    assert!(marketplace_link.is_symlink());
    let marketplace =
        read_json(plugins_dir.join("marketplaces/wegent/.claude-plugin/marketplace.json"));
    assert_eq!(
        marketplace["plugins"],
        json!([{
            "description": "",
            "name": "superpowers",
            "source": "./plugins/superpowers-wegent",
            "version": "5.0.7"
        }])
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

fn read_json(path: impl AsRef<Path>) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
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
