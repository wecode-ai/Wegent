//! Recovery publication and journal ownership contracts.
use super::*;

#[tokio::test]
async fn every_atomic_file_publication_boundary_can_be_reentered() {
    let counter = tempfile::tempdir().unwrap();
    let sample = store(&counter.path().join("sample"), false);
    let spec = PluginSyncSpec::from_value(&payload("demo")["plugins"][0]).unwrap();
    let count = sample.runtime_state_paths(&spec).0.len();
    for published in 0..=count {
        let temp = tempfile::tempdir().unwrap();
        let store = installed(&temp.path().join("home"), false).await;
        let manifest = store.manifest.load().unwrap();
        let mut spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
        spec.enabled = true;
        let (files, _) = store.runtime_state_paths(&spec);
        let before = files
            .iter()
            .map(|path| (path.clone(), fs::read(path).unwrap()))
            .collect::<BTreeMap<_, _>>();
        let template = temp.path().join("template");
        copy_dir_recursive(&store.plugin_codex_link(&spec), &template).unwrap();
        let path = store.recovery_journal_path(&spec.key);
        let journal = RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
        journal.publish_prefix(&store, published).unwrap();
        store
            .recover_plugin_journal(&path, &spec, &manifest)
            .unwrap();
        for (file, bytes) in before {
            assert_eq!(fs::read(file).unwrap(), bytes, "boundary {published}");
        }
        assert!(!path.exists());
    }
}

#[tokio::test]
async fn publication_does_not_overwrite_configuration_changed_or_removed_after_planning() {
    for removed in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let store = installed(&temp.path().join("home"), true).await;
        let manifest = store.manifest.load().unwrap();
        let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
        let template = temp.path().join("template");
        copy_dir_recursive(&store.plugin_codex_link(&spec), &template).unwrap();
        let path = store.recovery_journal_path(&spec.key);
        let journal = RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
        let config = store
            .codex_plugins_dir
            .parent()
            .unwrap()
            .join("config.toml");
        if removed {
            fs::remove_file(&config).unwrap();
        } else {
            fs::write(&config, "# external change").unwrap();
        }
        assert!(journal.publish_files(&store).is_err());
        assert!(store
            .recover_plugin_journal(&path, &spec, &manifest)
            .is_err());
        assert!(path.exists());
        if removed {
            assert!(!config.exists());
        } else {
            assert_eq!(fs::read_to_string(&config).unwrap(), "# external change");
        }
    }
}

#[tokio::test]
async fn planned_publication_preserves_current_skill_selector_over_older_selector() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(&temp.path().join("home"), true);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut requested = payload("demo");
    // This migration case owns native selectors independently of cloud settings.
    requested["plugins"][0]["component_states"] = json!({});
    let result = handler.apply_sync(requested).await.unwrap();
    assert_eq!(result["success"], true, "{result}");
    let mut manifest = store.manifest.load().unwrap();
    let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
    let current = store.plugin_codex_link(&spec).join("skills/demo/SKILL.md");
    let historical = temp
        .path()
        .join("old/codex/plugins/cache/wegent/demo/1.0/skills/demo/SKILL.md");
    let config = store
        .codex_plugins_dir
        .parent()
        .unwrap()
        .join("config.toml");
    let mut text = fs::read_to_string(&config).unwrap();
    text.push_str(&format!("\n[[skills.config]]\npath = {}\nenabled = false\n\n[[skills.config]]\npath = {}\nenabled = true\n",serde_json::to_string(&historical).unwrap(),serde_json::to_string(&current).unwrap()));
    fs::write(&config, text).unwrap();
    manifest["plugins"]["demo@wegent"]["runtime"]["codex_link"] =
        json!(historical.ancestors().nth(3).unwrap());
    manifest["plugins"]["demo@wegent"]["runtime_recovery_error"] = json!("repair requested");
    store.manifest.save(manifest).unwrap();
    let report = store.reconcile_managed_plugin_runtimes().unwrap();
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let doc = fs::read_to_string(config)
        .unwrap()
        .parse::<DocumentMut>()
        .unwrap();
    let entries = doc["skills"]["config"].as_array_of_tables().unwrap();
    assert_eq!(entries.len(), 1);
    let selector = entries.get(0).unwrap();
    assert_eq!(
        selector["path"].as_str().map(Path::new),
        Some(current.as_path())
    );
    assert_eq!(selector["enabled"].as_bool(), Some(true));
}

#[cfg(unix)]
#[tokio::test]
async fn retained_runtime_owner_does_not_own_an_unrelated_same_suffix_marketplace_link() {
    let temp = tempfile::tempdir().unwrap();
    let store = installed(&temp.path().join("home"), true).await;
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    assert_eq!(
        handler
            .apply_sync(json!({"scope":"plugins","plugins":[]}))
            .await
            .unwrap()["success"],
        true
    );
    let personal = temp.path().join("personal/plugins/cache/wegent/demo/1.0");
    fs::create_dir_all(&personal).unwrap();
    fs::write(personal.join("source.txt"), "keep").unwrap();
    let market = store.codex_marketplace_dir("wegent").join("plugins/demo");
    remove_existing_path(&market).unwrap();
    std::os::unix::fs::symlink(&personal, &market).unwrap();
    let result = handler.apply_sync(payload("demo")).await.unwrap();
    assert_eq!(result["success"], false, "{result}");
    assert_eq!(fs::read_link(&market).unwrap(), personal);
    assert_eq!(
        fs::read_to_string(personal.join("source.txt")).unwrap(),
        "keep"
    );
}

#[tokio::test]
async fn authoritative_sync_supersedes_a_conflicting_pending_journal_without_losing_evidence() {
    for new_version in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let store = installed(&temp.path().join("home"), true).await;
        let manifest = store.manifest.load().unwrap();
        let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
        let template = temp.path().join("template");
        copy_dir_recursive(&store.plugin_codex_link(&spec), &template).unwrap();
        let path = store.recovery_journal_path(&spec.key);
        let journal = RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
        let config = store
            .codex_plugins_dir
            .parent()
            .unwrap()
            .join("config.toml");
        let mut doc = fs::read_to_string(&config)
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        doc["user_choice"] = value("keep");
        fs::write(&config, doc.to_string()).unwrap();
        assert!(store
            .recover_plugin_journal(&path, &spec, &manifest)
            .is_err());
        let mut request = payload("demo");
        request["plugins"][0]["enabled"] = json!(true);
        if new_version {
            request["plugins"][0]["version"] = json!("2.0");
        }
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive_payload("demo", "new content")),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let result = handler.apply_sync(request).await.unwrap();
        assert_eq!(result["success"], true, "{result}");
        let archive = store
            .manifest
            .path
            .parent()
            .unwrap()
            .join(".plugin-runtime-recovery-retained")
            .join(&journal.transaction_id);
        assert!(archive.join("journal.json").is_file());
        assert!(!path.exists());
        // Simulate process exit between the manifest receipt and the archive rename.
        fs::rename(&archive, &path).unwrap();
        let report = store.reconcile_managed_plugin_runtimes().unwrap();
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(!path.exists());
        assert!(archive.join("journal.json").is_file());
        let manifest = store.manifest.load().unwrap();
        assert_eq!(manifest["plugins"]["demo@wegent"]["enabled"], true);
        assert_eq!(
            fs::read_to_string(&config)
                .unwrap()
                .parse::<DocumentMut>()
                .unwrap()["user_choice"]
                .as_str(),
            Some("keep")
        );
    }
}

#[tokio::test]
async fn failed_authoritative_sync_does_not_supersede_a_pending_journal() {
    let temp = tempfile::tempdir().unwrap();
    let store = installed(&temp.path().join("home"), true).await;
    let manifest = store.manifest.load().unwrap();
    let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
    let template = temp.path().join("template");
    copy_dir_recursive(&store.plugin_codex_link(&spec), &template).unwrap();
    let path = store.recovery_journal_path(&spec.key);
    let journal = RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
    let config = store
        .codex_plugins_dir
        .parent()
        .unwrap()
        .join("config.toml");
    fs::write(&config, "invalid = [").unwrap();
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    assert_eq!(
        handler.apply_sync(payload("demo")).await.unwrap()["success"],
        false
    );
    assert!(path.join("journal.json").exists());
    assert!(store.manifest.load().unwrap()["plugins"]["demo@wegent"]
        .get("runtime_recovery_superseded")
        .is_none());
    assert!(!store
        .manifest
        .path
        .parent()
        .unwrap()
        .join(".plugin-runtime-recovery-retained")
        .join(&journal.transaction_id)
        .exists());
}
