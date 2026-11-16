// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn with_components(manifest: Value, extra: Option<(&str, &str)>) -> CountedPackages {
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let manifest = manifest.to_string();
    let mut entries = vec![
        // Preserve native Codex fields; Claude conversion intentionally drops unsupported fields.
        (".codex-plugin/plugin.json", manifest.as_str()),
        (
            "skills/feature/SKILL.md",
            "---\nname: feature\ndescription: Test\n---\n# Feature\n",
        ),
    ];
    entries.extend(extra);
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

#[tokio::test]
async fn pure_skill_membership_reloads_in_both_protocols_and_runtime_layouts() {
    for codex_only in [false, true] {
        for ordered in [false, true] {
            for enabled in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let mut store = store(root.path());
                store.codex_only_plugins = codex_only;
                let provider = skill_packages("v1");
                let handler = CapabilitySyncHandler::with_package_provider(
                    "",
                    store.clone(),
                    provider.clone(),
                    std::sync::Arc::new(crate::NoRunningSessions),
                );
                let mut payload = plugin_payload(&provider, ordered, 1);
                payload["plugins"][0]["enabled"] = json!(enabled);
                let installed = sync(&handler, payload.clone(), true, true).await;
                assert_eq!(installed["requires_restart"], false, "{installed}");
                assert!(codex_runtime(&store)
                    .join("skills/feature/SKILL.md")
                    .is_file());
                payload["plugins"] = json!([]);
                next_generation(&mut payload, 2);
                let removed = sync(&handler, payload.clone(), true, true).await;
                assert_eq!(removed["requires_restart"], false, "{removed}");
                assert!(store.manifest.load().unwrap()["plugins"]
                    .get("demo@wegent")
                    .is_none());
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
                assert!(config["plugins"].get("demo@wegent").is_none());
                next_generation(&mut payload, 3);
                assert_eq!(
                    sync(&handler, payload, true, false).await["requires_restart"],
                    false
                );
            }
        }
    }
}

#[tokio::test]
async fn mixed_skill_packages_keep_restart_policy_for_install_and_removal() {
    for (field, value, extra) in [
        ("mcpServers", json!({"service":{"command":"echo"}}), None),
        ("hooks", json!({}), None),
        ("apps", json!([]), None),
        ("futureCapability", json!(true), None),
        (
            "skills",
            json!("./skills/"),
            Some((".mcp.json", "{\"mcpServers\":{}}")),
        ),
        (
            "skills",
            json!("./skills/"),
            Some(("hooks/hooks.json", "{}")),
        ),
        ("skills", json!("./skills/"), Some((".app.json", "{}"))),
        (
            "skills",
            json!("./skills/"),
            Some(("commands/test.md", "Test command")),
        ),
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let mut manifest = json!({"name":"demo","version":"1.0","skills":"./skills/"});
        manifest[field] = value;
        let provider = with_components(manifest, extra);
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store,
            provider.clone(),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let mut payload = plugin_payload(&provider, true, 1);
        let installed = sync(&handler, payload.clone(), true, true).await;
        assert_eq!(
            installed["requires_restart"], true,
            "{field} {extra:?}: {installed}"
        );
        payload["plugins"] = json!([]);
        next_generation(&mut payload, 2);
        let removed = sync(&handler, payload, true, true).await;
        assert_eq!(
            removed["requires_restart"], true,
            "{field} {extra:?}: {removed}"
        );
    }
}

#[tokio::test]
async fn pure_skill_package_updates_and_unknown_selectors_still_restart() {
    for change in ["version", "checksum", "unknown_skill", "mcp_selector"] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let provider = skill_packages("v1");
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            provider.clone(),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let mut payload = plugin_payload(&provider, true, 1);
        if change == "unknown_skill" {
            payload["plugins"][0]["component_states"] = json!({"skill:missing":false});
        }
        if change == "mcp_selector" {
            payload["plugins"][0]["component_states"] = json!({"mcp:service":false});
        }
        let installed = sync(&handler, payload.clone(), true, true).await;
        if ["unknown_skill", "mcp_selector"].contains(&change) {
            assert_eq!(installed["requires_restart"], true, "{change}: {installed}");
            continue;
        }
        assert_eq!(installed["requires_restart"], false);
        let provider = skill_packages("v2");
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store,
            provider.clone(),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        payload["plugins"][0]["checksum"] = json!(sha256_digest(&provider.package.plugin));
        if change == "version" {
            payload["plugins"][0]["version"] = json!("2.0");
        }
        next_generation(&mut payload, 2);
        let updated = sync(&handler, payload, true, true).await;
        assert_eq!(updated["requires_restart"], true, "{change}: {updated}");
    }
}

#[tokio::test]
async fn pure_skill_uninstall_does_not_hide_unrelated_metadata_or_mcp_changes() {
    use super::super::super::activation_revision::ActivationRevision;
    for change in [
        "mcp",
        "config",
        "marketplace_policy",
        "cleanup",
        "stale_registration",
    ] {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let provider = skill_packages("v1");
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            provider.clone(),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        sync(&handler, plugin_payload(&provider, true, 1), true, true).await;
        let _activation = crate::services::capability_activation::activate().await;
        let _publication = store.lock_shared_manifest().unwrap();
        let mut manifest = store.manifest.load().unwrap();
        let removed =
            PluginSyncSpec::from_manifest_entry("demo@wegent", &manifest["plugins"]["demo@wegent"]);
        let mut activation = ActivationRevision::begin(&store, &[removed], &[]).unwrap();
        manifest["plugins"]
            .as_object_mut()
            .unwrap()
            .remove("demo@wegent");
        if change == "mcp" {
            manifest["mcps"] = json!({"new":{"command":"echo"}});
        }
        store.manifest.save(manifest).unwrap();
        if change != "stale_registration" {
            let config = store
                .codex_plugins_dir
                .parent()
                .unwrap()
                .join("config.toml");
            let mut document = fs::read_to_string(&config)
                .unwrap()
                .parse::<toml_edit::DocumentMut>()
                .unwrap();
            document["plugins"]
                .as_table_like_mut()
                .unwrap()
                .remove("demo@wegent");
            fs::write(config, document.to_string()).unwrap();
        }
        match change {
            "config" => {
                let config = store
                    .codex_plugins_dir
                    .parent()
                    .unwrap()
                    .join("config.toml");
                let mut document = fs::read_to_string(&config)
                    .unwrap()
                    .parse::<toml_edit::DocumentMut>()
                    .unwrap();
                document["plugins"]["unrelated@wegent"]["enabled"] = toml_edit::value(false);
                fs::write(config, document.to_string()).unwrap();
            }
            "marketplace_policy" => {
                let path = store
                    .codex_marketplace_dir("wegent")
                    .join(".agents/plugins/marketplace.json");
                let mut catalog: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                catalog["plugins"][0]["policy"]["authentication"] = json!("CHANGED");
                write_json(&path, &catalog).unwrap();
            }
            "cleanup" => {
                let path = store
                    .codex_plugins_dir
                    .join("cache/wegent/orphan/1.0/SKILL.md");
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, "orphan").unwrap();
                activation.observe_cleanup_path(&path);
                fs::remove_file(path).unwrap();
            }
            _ => (),
        }
        let changed = activation
            .finish_with_skill_reload(&crate::NoRunningSessions)
            .await
            .unwrap();
        assert!(changed.changed && changed.requires_restart, "{change}");
    }
}
