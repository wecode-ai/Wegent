// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[derive(Default)]
struct ScopeProvider {
    fail_skill: AtomicBool,
}

impl CapabilityPackageProvider for ScopeProvider {
    fn stage_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
        target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            if self.fail_skill.load(Ordering::SeqCst) {
                return Err(invalid("Test skill download failure"));
            }
            fs::create_dir_all(target)?;
            fs::write(target.join("SKILL.md"), format!("skill {}", spec.skill_id))?;
            Ok(())
        })
    }

    fn download_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move {
            if self.fail_skill.load(Ordering::SeqCst) {
                return Err(invalid("Test skill download failure"));
            }
            let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
            archive
                .start_file("SKILL.md", zip::write::FileOptions::default())
                .unwrap();
            archive
                .write_all(format!("skill {}", spec.skill_id).as_bytes())
                .unwrap();
            Ok(archive.finish().unwrap().into_inner())
        })
    }

    fn download_plugin<'a>(
        &'a self,
        path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async move { Ok(package(path.rsplit('/').next().unwrap())) })
    }
}

fn scope_fixture(shared: bool) -> (tempfile::TempDir, CapabilitySyncHandler<ScopeProvider>) {
    let root = tempfile::tempdir().unwrap();
    let mut store = GlobalCapabilityStore::new(
        root.path().join("state/manifest.json"),
        root.path().join(".claude/skills"),
    )
    .with_store_dir(root.path().join("store"));
    if shared {
        store = store.with_workbench_root(root.path().join("workbench"));
    }
    (
        root,
        CapabilitySyncHandler::with_package_provider("test", store, ScopeProvider::default()),
    )
}

fn full_all(generation: u64, plugins: Vec<Value>, value: i64) -> Value {
    json!({"mode":"replace", "plugins":plugins,
        "skills":[{"name":"global-skill", "skill_id":value}],
        "mcps":[{"name":"service", "installed_mcp_id":value,
            "server":{"command":format!("mcp-{value}")}}],
        "plugin_sync":{"version":2, "generation":generation, "complete":true}})
}

fn assert_non_plugin_state(handler: &CapabilitySyncHandler<ScopeProvider>, value: i64) {
    let manifest = handler.store.manifest.load().unwrap();
    assert_eq!(
        manifest["mcps"]["service"]["server"]["command"],
        format!("mcp-{value}")
    );
    assert_eq!(manifest["skills"]["global-skill"]["skill_id"], value);
    for root in [&handler.store.skills_dir, &handler.store.codex_skills_dir] {
        assert_eq!(
            fs::read_to_string(root.join("global-skill/SKILL.md")).unwrap(),
            format!("skill {value}"),
        );
    }
}

#[tokio::test]
async fn plugin_refresh_and_delta_do_not_supersede_non_plugin_capabilities() {
    for shared in [false, true] {
        for with_plugin in [false, true] {
            for plugin_complete in [true, false] {
                for plugin_first in [true, false] {
                    let (_root, handler) = scope_fixture(shared);
                    if with_plugin {
                        handler
                            .apply_sync(delta(1, vec![plugin("alpha", 1)], vec![]))
                            .await
                            .unwrap();
                    }
                    let full = full_all(
                        10,
                        if with_plugin {
                            vec![plugin("alpha", 1)]
                        } else {
                            vec![]
                        },
                        10,
                    );
                    let change = if plugin_complete {
                        complete(11, vec![])
                    } else if with_plugin {
                        delta(11, vec![], vec![plugin("alpha", 1)])
                    } else {
                        delta(11, vec![plugin("beta", 2)], vec![])
                    };
                    if plugin_first {
                        handler.apply_sync(change).await.unwrap();
                        handler.apply_sync(full).await.unwrap();
                    } else {
                        handler.apply_sync(full).await.unwrap();
                        handler.apply_sync(change).await.unwrap();
                    }
                    assert_non_plugin_state(&handler, 10);
                    let manifest = handler.store.manifest.load().unwrap();
                    assert_eq!(manifest["plugin_sync"]["full_generation"], 10);
                    assert_eq!(
                        manifest["plugin_sync"]["complete_generation"],
                        if plugin_complete { 11 } else { 10 }
                    );
                    assert!(manifest["plugins"].get("alpha@wework").is_none());
                    if !with_plugin && !plugin_complete {
                        assert_eq!(
                            manifest["plugins"]["beta@wework"]["plugin_sync_generation"],
                            11
                        );
                    }
                    if with_plugin && !plugin_complete {
                        assert_eq!(manifest["plugin_sync"]["removals"]["1"]["generation"], 11);
                    }
                }
            }
        }
    }
}

#[tokio::test]
async fn older_full_all_cannot_restore_replaced_or_removed_non_plugin_capabilities() {
    for shared in [false, true] {
        let (_root, handler) = scope_fixture(shared);
        handler.apply_sync(full_all(10, vec![], 10)).await.unwrap();
        handler.apply_sync(full_all(20, vec![], 20)).await.unwrap();
        let before = handler.store.manifest.load().unwrap();
        handler.apply_sync(full_all(15, vec![], 15)).await.unwrap();
        assert_non_plugin_state(&handler, 20);
        assert_eq!(handler.store.manifest.load().unwrap(), before);
        handler.apply_sync(complete(40, vec![])).await.unwrap();
        let mut clear = full_all(30, vec![], 30);
        clear["skills"] = json!([]);
        clear["mcps"] = json!([]);
        handler.apply_sync(clear).await.unwrap();
        let before = handler.store.manifest.load().unwrap();
        assert_eq!(before["plugin_sync"]["full_generation"], 30);
        assert_eq!(before["plugin_sync"]["complete_generation"], 40);
        assert!(before["skills"].as_object().unwrap().is_empty());
        assert!(before["mcps"].as_object().unwrap().is_empty());
        handler.apply_sync(full_all(25, vec![], 25)).await.unwrap();
        assert_eq!(handler.store.manifest.load().unwrap(), before);
        assert!(!handler.store.skills_dir.join("global-skill").exists());
        assert!(!handler.store.codex_skills_dir.join("global-skill").exists());
    }
}

#[tokio::test]
async fn failed_full_all_fences_older_state_and_allows_same_generation_retry() {
    for shared in [false, true] {
        let (_root, handler) = scope_fixture(shared);
        handler
            .package_provider
            .fail_skill
            .store(true, Ordering::SeqCst);
        let result = handler.apply_sync(full_all(20, vec![], 20)).await.unwrap();
        assert_eq!(result["success"], false);
        assert_eq!(
            handler.store.manifest.load().unwrap()["plugin_sync"]["full_generation"],
            20
        );
        handler.apply_sync(complete(30, vec![])).await.unwrap();
        handler
            .package_provider
            .fail_skill
            .store(false, Ordering::SeqCst);
        handler.apply_sync(full_all(10, vec![], 10)).await.unwrap();
        assert!(!handler.store.skills_dir.join("global-skill").exists());
        assert_eq!(
            handler.store.manifest.load().unwrap()["mcps"]["service"]["server"]["command"],
            "mcp-20"
        );
        assert_eq!(
            handler.apply_sync(full_all(20, vec![], 20)).await.unwrap()["success"],
            true
        );
        assert_non_plugin_state(&handler, 20);
        assert_eq!(
            handler.store.manifest.load().unwrap()["plugin_sync"]["complete_generation"],
            30
        );
    }
}

#[tokio::test]
async fn full_scope_fence_survives_restart_and_resets_on_account_switch() {
    for shared in [false, true] {
        let (_root, handler) = scope_fixture(shared);
        handler.apply_sync(full_all(30, vec![], 30)).await.unwrap();
        handler.apply_sync(complete(40, vec![])).await.unwrap();
        let restarted = CapabilitySyncHandler::with_package_provider(
            "test",
            handler.store.clone(),
            ScopeProvider::default(),
        );
        restarted
            .apply_sync(full_all(29, vec![], 29))
            .await
            .unwrap();
        assert_non_plugin_state(&restarted, 30);
        restarted
            .apply_sync(full_all(35, vec![], 35))
            .await
            .unwrap();
        assert_non_plugin_state(&restarted, 35);
        let manifest = restarted.store.manifest.load().unwrap();
        assert_eq!(manifest["plugin_sync"]["full_generation"], 35);
        assert_eq!(manifest["plugin_sync"]["complete_generation"], 40);
        restarted
            .apply_sync(delta(41, vec![], vec![plugin("alpha", 1)]))
            .await
            .unwrap();
        let account_b = CapabilitySyncHandler::with_package_provider(
            "other-account",
            handler.store.clone(),
            ScopeProvider::default(),
        );
        account_b.apply_sync(full_all(1, vec![], 1)).await.unwrap();
        assert_non_plugin_state(&account_b, 1);
        let manifest = account_b.store.manifest.load().unwrap();
        assert_eq!(manifest["plugin_sync"]["full_generation"], 1);
        assert_eq!(manifest["plugin_sync"]["complete_generation"], 1);
        assert!(manifest["plugin_sync"].get("removals").is_none());
    }
}
