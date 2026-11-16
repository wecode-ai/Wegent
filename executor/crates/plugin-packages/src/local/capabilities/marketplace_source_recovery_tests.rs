// SPDX-License-Identifier: Apache-2.0

use super::*;

#[tokio::test]
async fn copied_sources_reinstall_after_repeated_uninstalled_home_relocation() {
    for codex_only in [true, false] {
        let fixture = Fixture::new(codex_only).await;
        uninstall(&fixture.store).await;
        let destination = tempfile::tempdir().unwrap();
        let mut current = fixture._root.path().to_path_buf();
        for name in ["first", "second"] {
            let moved = destination.path().join(name);
            fs::rename(&current, &moved).unwrap();
            let reopened = store(&moved, codex_only);
            let report = reopened.reconcile_managed_plugin_runtimes().unwrap();
            assert!(report.failed.is_empty(), "{:?}", report.failed);
            assert!(report.restored.is_empty());
            let manifest = reopened.manifest.load().unwrap();
            assert!(manifest["plugins"].as_object().unwrap().is_empty());
            let receipt = &manifest[RECEIPTS]["demo@wegent"];
            for entry in [receipt, &receipt["previous"]] {
                let spec = checked_spec("demo@wegent", entry).unwrap();
                for (path, field) in reopened.plugin_runtime_targets(&spec) {
                    assert_eq!(entry["runtime"][field], json!(path));
                    assert_eq!(
                        manifest["plugin_runtime_owners"][path.to_string_lossy().as_ref()],
                        "demo@wegent"
                    );
                }
            }
            current = moved;
        }
        // A fresh store must use persisted receipts, not in-memory relocation state.
        let reopened = store(&current, codex_only);
        let result = sync(&reopened, "0.9.12", 69).await;
        assert_eq!(result["success"], true, "{result}");
        for source in &fixture.sources {
            let moved = current.join(source.strip_prefix(fixture._root.path()).unwrap());
            assert!(fs::read_to_string(moved.join("skills/demo/SKILL.md"))
                .unwrap()
                .contains("0.9.12"));
        }
    }
}

#[tokio::test]
async fn relocation_does_not_authorize_unrelated_receipt_paths() {
    for alteration in ["outside-runtime", "wrong-key"] {
        let fixture = Fixture::new(true).await;
        uninstall(&fixture.store).await;
        let mut manifest = fixture.store.manifest.load().unwrap();
        if alteration == "outside-runtime" {
            manifest[RECEIPTS]["demo@wegent"]["runtime"]["codex_link"] =
                json!(fixture._root.path().join("foreign/0.1.6"));
        } else {
            manifest[RECEIPTS]["demo@wegent"]["name"] = json!("another");
        }
        let receipt = manifest[RECEIPTS]["demo@wegent"]["runtime"].clone();
        fixture.store.manifest.save(manifest).unwrap();
        let destination = tempfile::tempdir().unwrap();
        let moved = destination.path().join("moved");
        fs::rename(fixture._root.path(), &moved).unwrap();
        let reopened = store(&moved, true);
        reopened.reconcile_managed_plugin_runtimes().unwrap();
        assert_eq!(
            reopened.manifest.load().unwrap()[RECEIPTS]["demo@wegent"]["runtime"],
            receipt
        );
        let source = moved.join(
            fixture.sources[0]
                .strip_prefix(fixture._root.path())
                .unwrap(),
        );
        let before = tree_fingerprint(&source).unwrap();
        let result = sync(&reopened, "0.9.12", 69).await;
        assert_eq!(result["success"], false, "{alteration}: {result}");
        assert_eq!(tree_fingerprint(&source).unwrap(), before);
    }
}

fn use_previous_sources(fixture: &Fixture) -> Value {
    let manifest = fixture.store.manifest.load().unwrap();
    let previous = &manifest[RECEIPTS]["demo@wegent"]["previous"];
    assert_eq!(previous["version"], "0.9.12");
    let spec = checked_spec("demo@wegent", previous).unwrap();
    for ((runtime, _), source) in fixture
        .store
        .plugin_runtime_targets(&spec)
        .iter()
        .zip(&fixture.sources)
    {
        remove_existing_path(source).unwrap();
        copy_dir_recursive(runtime, source).unwrap();
        assert!(fixture
            .store
            .matches_old_managed_copy(source, previous, "demo@wegent")
            .unwrap());
    }
    manifest
}

fn damage_current_package(fixture: &Fixture, manifest: &Value, missing: bool) {
    let hash = manifest[RECEIPTS]["demo@wegent"]["checksum"]
        .as_str()
        .unwrap();
    let path = fixture.store.current_shared_plugin_path(hash).unwrap();
    if missing {
        fs::remove_dir_all(path).unwrap();
    } else {
        fs::write(path.join("skills/demo/SKILL.md"), "corrupted package").unwrap();
    }
}

#[tokio::test]
async fn unavailable_first_package_does_not_hide_verified_previous_sources() {
    for codex_only in [true, false] {
        for missing in [true, false] {
            let fixture = Fixture::new(codex_only).await;
            uninstall(&fixture.store).await;
            let manifest = use_previous_sources(&fixture);
            damage_current_package(&fixture, &manifest, missing);
            let result = sync(&fixture.store, "0.9.12", 69).await;
            assert_eq!(result["success"], true, "{result}");
            fixture.assert_version("0.9.12");
        }
    }
}

#[tokio::test]
async fn no_verified_candidate_preserves_sources_even_when_native_cache_matches() {
    for missing in [true, false] {
        let fixture = Fixture::new(true).await;
        uninstall(&fixture.store).await;
        let manifest = fixture.store.manifest.load().unwrap();
        damage_current_package(&fixture, &manifest, missing);
        let source = &fixture.sources[0];
        assert!(same_runtime_contents(source, &fixture.runtime).unwrap());
        let before = tree_fingerprint(source).unwrap();
        let result = sync(&fixture.store, "1.0.0", 69).await;
        assert_eq!(result["success"], false, "{result}");
        assert_eq!(tree_fingerprint(source).unwrap(), before);
        assert!(fixture.store.manifest.load().unwrap()["plugins"]
            .as_object()
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn invalid_source_content_still_fails_after_skipping_unavailable_package() {
    let fixture = Fixture::new(true).await;
    uninstall(&fixture.store).await;
    let manifest = use_previous_sources(&fixture);
    damage_current_package(&fixture, &manifest, true);
    let source = &fixture.sources[0];
    fs::write(source.join(CODEX_PLUGIN_MANIFEST_PATH), "invalid JSON").unwrap();
    let before = tree_fingerprint(source).unwrap();
    let requested = checked_spec(
        "demo@wegent",
        &manifest[RECEIPTS]["demo@wegent"]["previous"],
    )
    .unwrap();
    let error = fixture
        .store
        .owns_managed_marketplace_copy(&requested, source, "codex_link", &manifest)
        .unwrap_err();
    assert!(error.to_string().contains("expected value"));
    let result = sync(&fixture.store, "0.9.12", 69).await;
    assert_eq!(result["success"], false, "{result}");
    assert!(result["plugins"][0]["error"]
        .as_str()
        .unwrap()
        .contains("expected value"));
    assert_eq!(tree_fingerprint(source).unwrap(), before);
}

#[tokio::test]
async fn verified_package_proves_source_without_old_native_cache() {
    let fixture = Fixture::new(true).await;
    uninstall(&fixture.store).await;
    fs::remove_dir_all(&fixture.runtime).unwrap();
    let result = sync(&fixture.store, "0.9.12", 69).await;
    assert_eq!(result["success"], true, "{result}");
    fixture.assert_version("0.9.12");
}
