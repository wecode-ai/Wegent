// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::{
    tests::{counted as packages, store, CountedPackages},
    *,
};
use std::{
    io::{Cursor, Write},
    sync::atomic::Ordering,
};

const BYTECODE_PATH: &str = "scripts/__pycache__/helper.cpython-313.pyc";

fn python_packages(published_bytecode: bool) -> CountedPackages {
    let mut entries = vec![
        (
            ".claude-plugin/plugin.json",
            r#"{"name":"demo","version":"1.0"}"#,
        ),
        ("payload.txt", "v1"),
        ("scripts/helper.py", "VALUE = 1\n"),
    ];
    if published_bytecode {
        entries.push((BYTECODE_PATH, "published-bytecode"));
    }
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, content) in entries {
        archive
            .start_file(path, zip::write::FileOptions::default())
            .unwrap();
        archive.write_all(content.as_bytes()).unwrap();
    }
    let mut provider = packages("v1");
    provider.package.plugin = archive.finish().unwrap().into_inner();
    provider
}

fn skill_packages(content: &str) -> CountedPackages {
    skill_packages_at(content, "feature", "skills/feature/SKILL.md")
}

fn skill_packages_at(content: &str, name: &str, skill_path: &str) -> CountedPackages {
    let skill_md = format!("---\nname: {name}\ndescription: Test feature\n---\n# Feature\n");
    skill_packages_with_document(content, skill_path, &skill_md)
}

fn skill_packages_with_document(
    content: &str,
    skill_path: &str,
    skill_md: &str,
) -> CountedPackages {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, contents) in [
        (
            ".claude-plugin/plugin.json",
            r#"{"name":"demo","version":"1.0","skills":"./skills/"}"#,
        ),
        (skill_path, skill_md),
        ("payload.txt", content),
    ] {
        archive
            .start_file(path, zip::write::FileOptions::default())
            .unwrap();
        archive.write_all(contents.as_bytes()).unwrap();
    }
    let mut provider = packages(content);
    provider.package.plugin = archive.finish().unwrap().into_inner();
    provider
}

#[tokio::test]
async fn plugins_without_skill_selectors_sync_duplicate_skill_names() {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, content) in [
        (
            ".claude-plugin/plugin.json",
            r#"{"name":"demo","version":"1.0","skills":"./skills/"}"#,
        ),
        ("skills/first/SKILL.md", "---\nname: feature\n---\n# First"),
        (
            "skills/group/second/SKILL.md",
            "---\nname: feature\n---\n# Second",
        ),
    ] {
        archive
            .start_file(path, zip::write::FileOptions::default())
            .unwrap();
        archive.write_all(content.as_bytes()).unwrap();
    }
    let mut provider = packages("v1");
    provider.package.plugin = archive.finish().unwrap().into_inner();
    for ordered in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), provider.clone());
        let mut payload = plugin_payload(&provider, ordered, 1);
        for (generation, enabled, states) in [
            (1, true, json!({})),
            (3, false, json!({"mcp:service":false})),
            (5, true, json!({"mcp:service":true})),
        ] {
            payload["plugins"][0]["enabled"] = json!(enabled);
            payload["plugins"][0]["component_states"] = states;
            next_generation(&mut payload, generation);

            let changed = sync(&handler, payload.clone(), true, true).await;

            assert_eq!(changed["requires_restart"], true, "{changed}");
            let config: Value = toml_edit::de::from_str(
                &fs::read_to_string(
                    store
                        .codex_plugins_dir
                        .parent()
                        .unwrap()
                        .join("config.toml"),
                )
                .unwrap(),
            )
            .unwrap();
            assert_eq!(config["plugins"]["demo@wegent"]["enabled"], enabled);
            assert!(config.get("skills").is_none());
            for relative in ["skills/first/SKILL.md", "skills/group/second/SKILL.md"] {
                assert!(codex_runtime(&store).join(relative).is_file());
            }
            next_generation(&mut payload, generation + 1);
            let repeated = sync(&handler, payload.clone(), true, false).await;
            assert_eq!(repeated["requires_restart"], false, "{repeated}");
        }
    }
    assert_eq!(provider.downloads.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn skill_scan_failure_after_publication_requires_invalidation_once() {
    use super::super::activation_revision::ActivationRevision;
    use crate::services::capability_activation;

    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let provider = skill_packages("v1");
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), provider.clone());
    let payload = plugin_payload(&provider, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let spec = PluginSyncSpec::from_value(&payload["plugins"][0]).unwrap();
    let requested = [spec];
    fs::write(
        codex_runtime(&store).join("skills/feature/SKILL.md"),
        [0xff],
    )
    .unwrap();
    let _activation = capability_activation::activate().await;
    let _publication = store.lock_shared_manifest().unwrap();
    let revision = capability_activation::revision();
    let mut activation = ActivationRevision::begin(&store, &requested, &[]).unwrap();
    let mut manifest = store.manifest.load().unwrap();
    manifest["plugins"]["demo@wegent"]["component_states"] = json!({"skill:feature":false});
    store.manifest.save(manifest).unwrap();

    let changed = activation.finish_with_skill_reload().await.unwrap();

    assert!(changed.changed);
    assert!(changed.requires_restart);
    assert_eq!(changed.plugins, ["demo@wegent"]);
    assert_eq!(capability_activation::revision(), revision + 1);
    assert!(!activation.finish_with_skill_reload().await.unwrap().changed);
    drop(activation);
    assert_eq!(capability_activation::revision(), revision + 1);
    assert_eq!(
        store.manifest.load().unwrap()["plugins"]["demo@wegent"]["component_states"],
        json!({"skill:feature":false})
    );
}

#[tokio::test]
async fn known_plugin_skill_toggles_reload_without_process_invalidation() {
    for skill_path in [
        "skills/feature/SKILL.md",
        "skills/group/feature/SKILL.md",
        "skills/group/nested/feature/SKILL.md",
        "skills/SKILL.md",
    ] {
        for (ordered, name) in [
            (false, "feature"),
            (true, "feature"),
            (false, "'feature'"),
            (true, "'feature'"),
            (false, "\"feature\""),
            (true, "\"feature\""),
        ] {
            let context = format!("path={skill_path} name={name} ordered={ordered}");
            let root = tempfile::tempdir().unwrap();
            let store = store(root.path());
            let provider = skill_packages_at("v1", name, skill_path);
            let handler =
                CapabilitySyncHandler::with_package_provider("", store.clone(), provider.clone());
            let mut payload = plugin_payload(&provider, ordered, 1);
            let installed = sync(&handler, payload.clone(), true, true).await;
            assert_eq!(
                installed["requires_restart"], true,
                "{context}: {installed}"
            );

            for (generation, states, expected) in [
                (2, json!({"skill:feature":false}), false),
                (4, json!({"skill:feature":true}), true),
                (6, json!({"skill:feature":false}), false),
                (8, json!({}), true),
            ] {
                payload["plugins"][0]["component_states"] = states;
                next_generation(&mut payload, generation);
                let changed = sync(&handler, payload.clone(), true, true).await;
                assert_eq!(changed["requires_restart"], false, "{context}: {changed}");
                let config: Value = toml_edit::de::from_str(
                    &fs::read_to_string(
                        store
                            .codex_plugins_dir
                            .parent()
                            .unwrap()
                            .join("config.toml"),
                    )
                    .unwrap(),
                )
                .unwrap();
                let skill = config["skills"]["config"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|entry| entry["path"] == json!(codex_runtime(&store).join(skill_path)))
                    .unwrap_or_else(|| panic!("{context}: native skill selector is missing"));
                assert_eq!(skill["enabled"], expected, "{context}");
                next_generation(&mut payload, generation + 1);
                let repeated = sync(&handler, payload.clone(), true, false).await;
                assert_eq!(repeated["requires_restart"], false, "{context}: {repeated}");
            }
            assert_eq!(provider.downloads.load(Ordering::SeqCst), 1, "{context}");
        }
    }
}

#[tokio::test]
async fn cleared_plugin_skill_states_restore_defaults_and_remain_idempotent() {
    for ordered in [false, true] {
        for (cleared, manifest_states) in [
            (None, None),
            (Some(json!(null)), Some(json!(null))),
            (Some(json!({})), None),
        ] {
            let root = tempfile::tempdir().unwrap();
            let store = store(root.path());
            let skill_path = "skills/group/renamed-directory/SKILL.md";
            let provider = skill_packages_at("v1", "feature", skill_path);
            let handler =
                CapabilitySyncHandler::with_package_provider("", store.clone(), provider.clone());
            let mut payload = plugin_payload(&provider, ordered, 1);
            payload["plugins"][0]["component_states"] = json!({"skill:feature":false});
            sync(&handler, payload.clone(), true, true).await;
            let config_path = store
                .codex_plugins_dir
                .parent()
                .unwrap()
                .join("config.toml");
            let config: Value =
                toml_edit::de::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
            let path = codex_runtime(&store).join(skill_path);
            assert_eq!(
                config["skills"]["config"],
                json!([{"path":path,"enabled":false}])
            );
            if let Some(states) = &cleared {
                payload["plugins"][0]["component_states"] = states.clone();
            } else {
                payload["plugins"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("component_states");
            }
            next_generation(&mut payload, 2);

            let changed = sync(&handler, payload.clone(), true, true).await;

            assert_eq!(
                changed["requires_restart"],
                cleared.as_ref().is_some_and(Value::is_null),
                "{changed}"
            );
            let restored = fs::read_to_string(&config_path).unwrap();
            let config: Value = toml_edit::de::from_str(&restored).unwrap();
            assert_eq!(
                config["skills"]["config"],
                json!([{"path":path,"enabled":true}])
            );
            assert_eq!(
                store.manifest.load().unwrap()["plugins"]["demo@wegent"].get("component_states"),
                manifest_states.as_ref()
            );
            next_generation(&mut payload, 3);
            let repeated = sync(&handler, payload, true, false).await;
            assert_eq!(repeated["requires_restart"], false, "{repeated}");
            assert_eq!(fs::read_to_string(config_path).unwrap(), restored);
            assert_eq!(provider.downloads.load(Ordering::SeqCst), 1);
        }
    }
}

#[tokio::test]
async fn skill_frontmatter_separator_whitespace_preserves_hot_toggle_identity() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let skill_path = "skills/group/renamed-directory/SKILL.md";
    let provider = skill_packages_with_document(
        "v1",
        skill_path,
        " \t---\t \nname: feature\ndescription: Test feature\n\t --- \t\n# Body\nname: body-name\n",
    );
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), provider.clone());
    let mut payload = plugin_payload(&provider, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    for (generation, enabled) in [(2, false), (4, true)] {
        payload["plugins"][0]["component_states"] = json!({"skill:feature":enabled});
        next_generation(&mut payload, generation);

        let changed = sync(&handler, payload.clone(), true, true).await;

        assert_eq!(changed["requires_restart"], false, "{changed}");
        let config: Value = toml_edit::de::from_str(
            &fs::read_to_string(
                store
                    .codex_plugins_dir
                    .parent()
                    .unwrap()
                    .join("config.toml"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            config["skills"]["config"],
            json!([{"path":codex_runtime(&store).join(skill_path),"enabled":enabled}])
        );
        next_generation(&mut payload, generation + 1);
        let repeated = sync(&handler, payload.clone(), true, false).await;
        assert_eq!(repeated["requires_restart"], false, "{repeated}");
    }
    assert_eq!(provider.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn skill_toggles_do_not_hide_other_capability_changes() {
    for change in [
        "plugin_enabled",
        "mcp",
        "unknown_skill",
        "non_boolean",
        "contents",
        "configuration",
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let provider = skill_packages("v1");
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), provider.clone());
        let mut payload = plugin_payload(&provider, true, 1);
        sync(&handler, payload.clone(), true, true).await;
        payload["plugins"][0]["component_states"] = json!({"skill:feature":false});
        match change {
            "plugin_enabled" => payload["plugins"][0]["enabled"] = json!(false),
            "mcp" => {
                payload["plugins"][0]["component_states"]["mcp:service"] = json!(false);
            }
            "unknown_skill" => {
                payload["plugins"][0]["component_states"]["skill:missing"] = json!(false);
            }
            "non_boolean" => {
                payload["plugins"][0]["component_states"]["skill:feature"] = json!("false");
            }
            "contents" => {
                fs::write(codex_runtime(&store).join("payload.txt"), "damaged").unwrap();
            }
            "configuration" => {
                let config = store
                    .codex_plugins_dir
                    .parent()
                    .unwrap()
                    .join("config.toml");
                let mut document = fs::read_to_string(&config)
                    .unwrap()
                    .parse::<toml_edit::DocumentMut>()
                    .unwrap();
                document["plugins"]["demo@wegent"]["enabled"] = toml_edit::value(false);
                fs::write(config, document.to_string()).unwrap();
            }
            _ => unreachable!(),
        }
        next_generation(&mut payload, 2);
        let changed = sync(&handler, payload, true, true).await;
        assert_eq!(changed["requires_restart"], true, "{change}: {changed}");
    }
}

fn plugin_package_and_runtimes(store: &GlobalCapabilityStore) -> [PathBuf; 3] {
    let manifest = store.manifest.load().unwrap();
    let entry = &manifest["plugins"]["demo@wegent"];
    [
        PathBuf::from(entry["store_path"].as_str().unwrap()),
        PathBuf::from(entry["runtime"]["claude_link"].as_str().unwrap()),
        PathBuf::from(entry["runtime"]["codex_link"].as_str().unwrap()),
    ]
}

#[tokio::test]
async fn legacy_gc_of_orphan_native_registration_changes_capabilities() {
    let root = tempfile::tempdir().unwrap();
    let mut store = store(root.path()).with_store_dir(root.path().join("private-store"));
    store.shared_packages = false;
    let market = store
        .codex_marketplace_dir("wegent")
        .join(".agents/plugins/marketplace.json");
    write_json(
        &market,
        &json!({"plugins":[{"name":"orphan","source":"./plugins/orphan"}]}),
    )
    .unwrap();
    let handler = CapabilitySyncHandler::with_package_provider("", store, packages("v1"));
    let payload = json!({"mode":"replace", "plugins":[]});
    sync(&handler, payload.clone(), true, true).await;
    assert_eq!(
        read_json_or_default(&market, || json!({})).unwrap()["plugins"],
        json!([])
    );
    sync(&handler, payload, true, false).await;
}

fn plugin_payload(packages: &CountedPackages, ordered: bool, generation: u64) -> Value {
    let mut payload = json!({
        "scope": "plugins", "mode": "replace",
        "plugins": [{"name": "demo", "installed_plugin_id": 1,
            "marketplace": "wegent", "version": "1.0", "enabled": true,
            "download_path": "/package", "checksum": sha256_digest(&packages.package.plugin)}],
    });
    if ordered {
        payload["plugin_sync"] = json!({"version": 2, "generation": generation, "complete": true});
    }
    payload
}

fn next_generation(payload: &mut Value, generation: u64) {
    if payload.get("plugin_sync").is_some() {
        payload["plugin_sync"]["generation"] = json!(generation);
    }
}

async fn sync<P: CapabilityPackageProvider>(
    handler: &CapabilitySyncHandler<P>,
    payload: Value,
    success: bool,
    changed: bool,
) -> Value {
    let result = handler.apply_sync(payload).await.unwrap();
    assert_eq!(result["success"], success, "{result}");
    assert_eq!(result["changed"], changed, "{result}");
    result
}

fn codex_runtime(store: &GlobalCapabilityStore) -> PathBuf {
    PathBuf::from(
        store.manifest.load().unwrap()["plugins"]["demo@wegent"]["runtime"]["codex_link"]
            .as_str()
            .unwrap(),
    )
}

fn age_publication_metadata(store: &GlobalCapabilityStore) {
    let mut manifest = store.manifest.load().unwrap();
    manifest["plugins"]["demo@wegent"]["updated_at"] = json!("946684800000");
    store.manifest.save(manifest).unwrap();

    let path = store.plugins_dir.join("installed_plugins.json");
    let mut installed: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let entry = &mut installed["plugins"]["demo@wegent"][0];
    entry["installedAt"] = json!("946684800000");
    entry["lastUpdated"] = json!("946684800000");
    write_json(&path, &installed).unwrap();

    let path = store.plugins_dir.join("known_marketplaces.json");
    let mut marketplaces: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    marketplaces["wegent"]["lastUpdated"] = json!("2000-01-01T00:00:00Z");
    write_json(&path, &marketplaces).unwrap();
}

#[tokio::test]
async fn legacy_and_ordered_reconnects_ignore_publication_metadata() {
    for ordered in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let packages = packages("v1");
        let mut payload = plugin_payload(&packages, ordered, 1);
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
        sync(&handler, payload.clone(), true, true).await;
        age_publication_metadata(&store);

        payload["plugins"][0]["download_path"] = json!("/package?renewed-signature");
        next_generation(&mut payload, 2);
        let reconnected =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
        sync(&reconnected, payload, true, false).await;
        assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
        assert_eq!(
            fs::read_to_string(codex_runtime(&store).join("payload.txt")).unwrap(),
            "v1"
        );

        if ordered {
            let manifest = store.manifest.load().unwrap();
            assert_eq!(manifest["plugin_sync"]["complete_generation"], 2);
            assert_eq!(
                manifest["plugin_sync"]["entries"]["demo@wegent"]["generation"],
                2
            );
            assert_eq!(
                manifest["plugins"]["demo@wegent"]["plugin_sync_generation"],
                2
            );
            assert_eq!(
                manifest["plugin_sync"]["entries"]["demo@wegent"]["pending"],
                false
            );
        }
    }
}

#[tokio::test]
async fn superseded_sync_and_removal_do_not_change_capabilities() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = packages("v1");
    let payload = plugin_payload(&packages, true, 10);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    sync(&handler, payload.clone(), true, true).await;

    let mut stale = payload.clone();
    stale["plugins"][0]["enabled"] = json!(false);
    next_generation(&mut stale, 9);
    let result = sync(&handler, stale, true, false).await;
    assert_eq!(result["plugins"][0]["status"], "superseded");

    let result = sync(
        &handler,
        json!({
            "scope": "plugin_delta", "mode": "merge", "plugins": [],
            "removed_plugins": [payload["plugins"][0].clone()],
            "plugin_sync": {"version": 2, "generation": 9, "complete": false},
        }),
        true,
        false,
    )
    .await;
    assert_eq!(result["plugins"][0]["status"], "superseded");
    assert_eq!(
        store.manifest.load().unwrap()["plugins"]["demo@wegent"]["enabled"],
        true
    );
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn same_name_and_version_with_new_package_content_changes_capabilities() {
    for ordered in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let first = packages("v1");
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), first.clone());
        sync(&handler, plugin_payload(&first, ordered, 1), true, true).await;

        let second = packages("v2");
        let updated =
            CapabilitySyncHandler::with_package_provider("", store.clone(), second.clone());
        let mut payload = plugin_payload(&second, ordered, 2);
        sync(&updated, payload.clone(), true, true).await;
        assert_eq!(
            fs::read_to_string(codex_runtime(&store).join("payload.txt")).unwrap(),
            "v2"
        );
        next_generation(&mut payload, 3);
        sync(&updated, payload, true, false).await;
    }
}

#[tokio::test]
async fn same_package_enable_and_component_state_changes_are_effective() {
    for ordered in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let packages = packages("v1");
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
        let mut payload = plugin_payload(&packages, ordered, 1);
        sync(&handler, payload.clone(), true, true).await;

        payload["plugins"][0]["enabled"] = json!(false);
        next_generation(&mut payload, 2);
        sync(&handler, payload.clone(), true, true).await;
        next_generation(&mut payload, 3);
        sync(&handler, payload.clone(), true, false).await;

        payload["plugins"][0]["component_states"] = json!({"skills": {"example": false}});
        next_generation(&mut payload, 4);
        sync(&handler, payload.clone(), true, true).await;
        next_generation(&mut payload, 5);
        sync(&handler, payload.clone(), true, false).await;

        payload["plugins"][0]["component_states"] = json!({});
        next_generation(&mut payload, 6);
        sync(&handler, payload.clone(), true, true).await;
        next_generation(&mut payload, 7);
        sync(&handler, payload, true, false).await;
        assert!(store.manifest.load().unwrap()["plugins"]["demo@wegent"]
            .get("component_states")
            .is_none());
        assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn repairing_runtime_contents_and_native_metadata_changes_capabilities() {
    for damage in ["contents", "manifest", "marketplace_link", "config"] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let packages = packages("v1");
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
        let mut payload = plugin_payload(&packages, true, 1);
        sync(&handler, payload.clone(), true, true).await;
        let runtime = codex_runtime(&store);
        match damage {
            "contents" => fs::write(runtime.join("payload.txt"), "damaged").unwrap(),
            "manifest" => fs::remove_file(runtime.join(CODEX_PLUGIN_MANIFEST_PATH)).unwrap(),
            "marketplace_link" => {
                remove_existing_path(&store.codex_marketplace_dir("wegent").join("plugins/demo"))
                    .unwrap()
            }
            "config" => fs::remove_file(
                store
                    .codex_plugins_dir
                    .parent()
                    .unwrap()
                    .join("config.toml"),
            )
            .unwrap(),
            _ => unreachable!(),
        }
        next_generation(&mut payload, 2);
        sync(&handler, payload.clone(), true, true).await;
        assert_eq!(
            fs::read_to_string(runtime.join("payload.txt")).unwrap(),
            "v1"
        );
        assert!(runtime.join(CODEX_PLUGIN_MANIFEST_PATH).is_file());
        next_generation(&mut payload, 3);
        sync(&handler, payload, true, false).await;
        assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
    }
}

#[tokio::test]
async fn generated_python_bytecode_is_not_an_effective_plugin_change() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = python_packages(false);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let paths = plugin_package_and_runtimes(&store);
    for path in &paths {
        let bytecode = path.join(BYTECODE_PATH);
        fs::create_dir_all(bytecode.parent().unwrap()).unwrap();
        fs::write(bytecode, "generated-bytecode").unwrap();
    }

    // Older shared links could also generate bytecode in the published source.
    // Verification and runtime copying may remove it without changing capability.
    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, false).await;
    for path in &paths {
        assert!(!path.join(BYTECODE_PATH).exists());
        assert_eq!(
            fs::read_to_string(path.join("scripts/helper.py")).unwrap(),
            "VALUE = 1\n"
        );
    }
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn python_source_inside_bytecode_directories_remains_an_effective_change() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = python_packages(false);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let paths = plugin_package_and_runtimes(&store);
    for path in &paths[1..] {
        let source = path.join("scripts/__pycache__/real.py");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(source, "VALUE = 'unexpected'\n").unwrap();
    }

    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, true).await;
    for path in &paths[1..] {
        assert!(!path.join("scripts/__pycache__/real.py").exists());
    }
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_bytecode_symlink_remains_an_effective_plugin_change() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = python_packages(false);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let paths = plugin_package_and_runtimes(&store);
    for path in &paths[1..] {
        let bytecode = path.join(BYTECODE_PATH);
        fs::create_dir_all(bytecode.parent().unwrap()).unwrap();
        symlink(path.join("scripts/helper.py"), bytecode).unwrap();
    }

    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, true).await;
    for path in &paths[1..] {
        assert!(fs::symlink_metadata(path.join(BYTECODE_PATH)).is_err());
    }
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
}

#[tokio::test]
async fn published_python_bytecode_corruption_is_an_effective_plugin_change() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = python_packages(true);
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let paths = plugin_package_and_runtimes(&store);
    for path in &paths[1..] {
        fs::write(path.join(BYTECODE_PATH), "damaged-bytecode").unwrap();
    }

    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, true).await;
    for path in &paths {
        assert_eq!(
            fs::read_to_string(path.join(BYTECODE_PATH)).unwrap(),
            "published-bytecode"
        );
    }
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
    assert_eq!(packages.downloads.load(Ordering::SeqCst), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn repairing_runtime_execute_bits_changes_capabilities() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = packages("v1");
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let file = codex_runtime(&store).join("payload.txt");
    let original = fs::metadata(&file).unwrap().permissions().mode() & 0o111;
    let mut permissions = fs::metadata(&file).unwrap().permissions();
    permissions.set_mode(permissions.mode() ^ 0o100);
    fs::set_permissions(&file, permissions).unwrap();

    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, true).await;
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o111,
        original
    );
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
}

#[cfg(unix)]
#[tokio::test]
async fn repairing_a_runtime_special_file_is_allowed_and_changes_capabilities() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = packages("v1");
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    let mut payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let runtime = codex_runtime(&store);
    let fifo_path = runtime.join("unexpected.pipe");
    let c_path = CString::new(fifo_path.as_os_str().as_bytes()).unwrap();
    // The NUL-terminated path stays alive for this call and belongs to the fixture.
    assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);

    next_generation(&mut payload, 2);
    sync(&handler, payload.clone(), true, true).await;
    assert!(!fifo_path.exists());
    assert_eq!(
        fs::read_to_string(runtime.join("payload.txt")).unwrap(),
        "v1"
    );
    next_generation(&mut payload, 3);
    sync(&handler, payload, true, false).await;
}

#[tokio::test]
async fn activation_guard_drop_and_finish_invalidate_exactly_once() {
    use super::super::activation_revision::ActivationRevision;
    use crate::services::capability_activation;

    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let packages = packages("v1");
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
    let payload = plugin_payload(&packages, true, 1);
    sync(&handler, payload.clone(), true, true).await;
    let spec = PluginSyncSpec::from_value(&payload["plugins"][0]).unwrap();
    let requested = [spec];
    let file = codex_runtime(&store).join("payload.txt");

    // Hold the writer while checking the global revision so other tests cannot
    // publish capabilities between this guard's baseline and assertions.
    let _activation = capability_activation::activate().await;
    let _publication = store.lock_shared_manifest().unwrap();
    let revision = capability_activation::revision();
    {
        let _guard = ActivationRevision::begin(&store, &requested, &[]).unwrap();
    }
    assert_eq!(capability_activation::revision(), revision);

    {
        let _guard = ActivationRevision::begin(&store, &requested, &[]).unwrap();
        fs::write(&file, "changed before an early return").unwrap();
    }
    assert_eq!(capability_activation::revision(), revision + 1);

    {
        let mut guard = ActivationRevision::begin(&store, &requested, &[]).unwrap();
        fs::write(&file, "changed before explicit finish").unwrap();
        assert!(guard.finish().changed);
        assert_eq!(capability_activation::revision(), revision + 2);
        assert!(!guard.finish().changed);
        assert_eq!(capability_activation::revision(), revision + 2);
    }
    assert_eq!(capability_activation::revision(), revision + 2);
}

#[tokio::test]
async fn deleting_plugins_changes_capabilities_once() {
    for ordered in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let packages = packages("v1");
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
        let mut payload = plugin_payload(&packages, ordered, 1);
        sync(&handler, payload.clone(), true, true).await;
        payload["plugins"] = json!([]);
        next_generation(&mut payload, 2);
        sync(&handler, payload.clone(), true, true).await;
        assert!(store.manifest.load().unwrap()["plugins"]
            .get("demo@wegent")
            .is_none());
        next_generation(&mut payload, 3);
        sync(&handler, payload, true, false).await;
    }
}

#[tokio::test]
async fn partial_failure_preserves_changes_and_failure_alone_is_unchanged() {
    for ordered in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let packages = packages("v1");
        let handler =
            CapabilitySyncHandler::with_package_provider("", store.clone(), packages.clone());
        let mut payload = plugin_payload(&packages, ordered, 1);
        let mut invalid = payload["plugins"][0].clone();
        invalid["name"] = json!("wrong-identity");
        invalid["installed_plugin_id"] = json!(2);
        payload["plugins"].as_array_mut().unwrap().push(invalid);
        let result = sync(&handler, payload.clone(), false, true).await;
        assert_eq!(result["plugins"][0]["status"], "synced");
        assert_eq!(result["plugins"][1]["status"], "failed");
        assert_eq!(
            fs::read_to_string(codex_runtime(&store).join("payload.txt")).unwrap(),
            "v1"
        );

        next_generation(&mut payload, 2);
        sync(&handler, payload, false, false).await;
    }
}

#[tokio::test]
async fn same_name_mcp_definition_changes_and_removal_are_effective() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let handler = CapabilitySyncHandler::with_package_provider("", store.clone(), packages("v1"));
    let mut payload = json!({"mode": "replace", "mcps": [
        {"name": "sample", "server": {"type": "http", "url": "https://example.invalid/v1"}}
    ]});
    sync(&handler, payload.clone(), true, true).await;
    sync(&handler, payload.clone(), true, false).await;
    payload["mcps"][0]["server"]["url"] = json!("https://example.invalid/v2");
    sync(&handler, payload.clone(), true, true).await;
    sync(&handler, payload.clone(), true, false).await;
    assert_eq!(
        store.manifest.load().unwrap()["mcps"]["sample"]["server"]["url"],
        "https://example.invalid/v2"
    );
    payload["mcps"] = json!([]);
    sync(&handler, payload.clone(), true, true).await;
    sync(&handler, payload, true, false).await;
}

#[derive(Clone)]
struct SkillPackages(CountedPackages);

impl CapabilityPackageProvider for SkillPackages {
    fn stage_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
        target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        self.0.stage_skill(spec, target)
    }

    fn download_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        self.0.package.download_skill(spec)
    }

    fn download_plugin<'a>(
        &'a self,
        path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        self.0.download_plugin(path)
    }
}

#[tokio::test]
async fn skill_content_links_and_removal_change_capabilities() {
    let root = tempfile::tempdir().unwrap();
    let store = store(root.path());
    let first = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        SkillPackages(packages("v1")),
    );
    let mut payload = json!({"mode": "replace", "skills": [{"name": "example", "skill_id": 1}]});
    sync(&first, payload.clone(), true, true).await;
    sync(&first, payload.clone(), true, false).await;
    remove_existing_path(&store.codex_skills_dir.join("example")).unwrap();
    sync(&first, payload.clone(), true, true).await;
    sync(&first, payload.clone(), true, false).await;

    let second = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        SkillPackages(packages("v2")),
    );
    sync(&second, payload.clone(), true, true).await;
    assert_eq!(
        fs::read_to_string(store.codex_skills_dir.join("example/SKILL.md")).unwrap(),
        "v2"
    );
    sync(&second, payload.clone(), true, false).await;
    payload["skills"] = json!([]);
    sync(&second, payload.clone(), true, true).await;
    sync(&second, payload, true, false).await;
}
