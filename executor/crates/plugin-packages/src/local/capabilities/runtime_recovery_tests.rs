// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::services::workbench::publish_plugin_archive;
use std::io::{Cursor, Write};

#[derive(Clone)]
pub(super) struct Packages(pub(super) Vec<u8>);
impl CapabilityPackageProvider for Packages {
    fn download_skill<'a>(
        &'a self,
        _: &'a SkillSyncSpec,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async {
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            zip.start_file("SKILL.md", zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(b"a standalone skill").unwrap();
            Ok(zip.finish().unwrap().into_inner())
        })
    }
    fn stage_skill<'a>(
        &'a self,
        _: &'a SkillSyncSpec,
        _: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async { panic!("shared sync must request archive bytes") })
    }
    fn download_plugin<'a>(
        &'a self,
        _: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(async { Ok(self.0.clone()) })
    }
}
pub(super) fn archive(name: &str) -> Vec<u8> {
    archive_payload(name, "plugin capability")
}
pub(super) fn archive_payload(name: &str, content: &str) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, body) in [
        (
            ".codex-plugin/plugin.json",
            format!("{{\"name\":\"{name}\",\"version\":\"1.0\"}}"),
        ),
        ("skills/demo/SKILL.md", content.into()),
    ] {
        zip.start_file(path, zip::write::FileOptions::default())
            .unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
pub(super) fn store(root: &Path, codex_only: bool) -> GlobalCapabilityStore {
    let mut store = GlobalCapabilityStore::new(
        root.join("executor/capabilities/manifest-v2.json"),
        root.join("claude/skills"),
    )
    .with_plugins_dir(root.join("claude/plugins"))
    .with_codex_plugins_dir(root.join("codex/plugins"))
    .with_codex_skills_dir(root.join("codex/skills"))
    .with_workbench_root(root.join("workbench"));
    // Each matrix case owns its runtime target, including the dual-product case.
    store.codex_only_plugins = codex_only;
    store
}
pub(super) fn payload(name: &str) -> Value {
    json!({"scope":"plugins","plugins":[{"name":name,"marketplace":"wegent","installed_plugin_id":41,"cloud_plugin_id":7,"enabled":false,"version":"1.0","download_path":"/archive","component_states":{"skill:demo":false}}]})
}
pub(super) async fn installed(root: &Path, codex_only: bool) -> GlobalCapabilityStore {
    let store = store(root, codex_only);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let result = handler.apply_sync(payload("demo")).await.unwrap();
    assert_eq!(result["success"], true, "{result}");
    store
}

#[tokio::test]
async fn desktop_recovery_projects_only_package_owned_python_mcp_commands() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("before");
    let store = self::store(&home, true);
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let codex_manifest = json!({"name":"demo","version":"1.0"});
    let claude_manifest = json!({"name":"demo","version":"1.0","mcpServers":"./claude-mcp.json"});
    let claude_config = json!({
        "claude":{"cwd":"./","command":"python3","args":["scripts/server.py"],
            "startup_timeout_sec":1200.0}
    });
    let config = json!({"mcpServers":{
        "managed":{"cwd":"./","command":"python3","args":["scripts/server.py","two words"],
            "startup_timeout_ms":250,"env_vars":["PLUGIN_OPTION"]},
        "workspace":{"command":"python3","args":["scripts/server.py"]},
        "escape":{"cwd":"../outside","command":"python3","args":["scripts/server.py"]},
        "custom":{"cwd":"./","command":"python3","args":["scripts/server.py"],
            "env_vars":["PYTHONPATH"]},
        "venv":{"cwd":"./","command":"python3","args":["scripts/server.py"],
            "env":{"PATH":"./.venv/bin"}},
        "inherited_venv":{"cwd":"./","command":"python3","args":["scripts/server.py"],
            "env_vars":["PATH"]},
        "windows_venv":{"cwd":"./","command":"python.exe","args":["scripts/server.py"],
            "env_vars":[{"name":"Path","source":"local"}]},
        "node":{"cwd":"./","command":"node","args":["tools.mjs"]}
    }});
    for (path, body) in [
        (CODEX_PLUGIN_MANIFEST_PATH, codex_manifest.to_string()),
        (CLAUDE_PLUGIN_MANIFEST_PATH, claude_manifest.to_string()),
        (".mcp.json", config.to_string()),
        ("claude-mcp.json", claude_config.to_string()),
        ("scripts/server.py", "pass\n".to_owned()),
    ] {
        zip.start_file(path, zip::write::FileOptions::default())
            .unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    let archive = zip.finish().unwrap().into_inner();
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut request = payload("demo");
    request["plugins"][0]["enabled"] = json!(true);
    let result = handler.apply_sync(request).await.unwrap();
    assert_eq!(result["success"], true, "{result}");
    let entry = store.manifest.load().unwrap()["plugins"]["demo@wegent"].clone();
    let source = PathBuf::from(entry["store_path"].as_str().unwrap()).join(".mcp.json");
    let runtime = PathBuf::from(entry["runtime"]["codex_link"].as_str().unwrap());
    assert_eq!(
        fs::read(runtime.join(".mcp.json")).unwrap(),
        fs::read(&source).unwrap()
    );

    let python = home.join("managed-runtimes/python/bin/python");
    let desktop = store.with_managed_mcp_python(Some(python.clone()));
    let recovered = desktop.reconcile_managed_plugin_runtimes().unwrap();
    assert!(recovered.failed.is_empty(), "{:?}", recovered.failed);
    assert_eq!(recovered.restored, ["demo@wegent"]);
    let projected: Value =
        serde_json::from_slice(&fs::read(runtime.join(".mcp.json")).unwrap()).unwrap();
    let mut expected = config.clone();
    expected["mcpServers"]["managed"]["command"] = json!(python);
    expected["mcpServers"]["managed"]["args"] =
        json!(["plugin-python", "--mcp", "scripts/server.py", "two words"]);
    expected["mcpServers"]["managed"]["startup_timeout_sec"] = json!(970.0);
    expected["mcpServers"]["managed"]
        .as_object_mut()
        .unwrap()
        .remove("startup_timeout_ms");
    expected["mcpServers"]["managed"]["env_vars"] = json!([
        "PLUGIN_OPTION",
        "WEWORK_PYTHON_RUNTIME_URL",
        "WEWORK_PYTHON_RUNTIME_TOKEN",
        "WEGENT_PYTHON_PATH"
    ]);
    assert_eq!(projected, expected);
    let mut expected_claude = claude_config.clone();
    expected_claude["claude"]["command"] = json!(python);
    expected_claude["claude"]["args"] = json!(["plugin-python", "--mcp", "scripts/server.py"]);
    expected_claude["claude"]["env_vars"] = json!([
        "WEWORK_PYTHON_RUNTIME_URL",
        "WEWORK_PYTHON_RUNTIME_TOKEN",
        "WEGENT_PYTHON_PATH"
    ]);
    let projected_claude: Value =
        serde_json::from_slice(&fs::read(runtime.join("claude-mcp.json")).unwrap()).unwrap();
    assert_eq!(projected_claude, expected_claude);
    assert_eq!(
        fs::read_to_string(source.with_file_name("claude-mcp.json")).unwrap(),
        claude_config.to_string()
    );
    assert_eq!(fs::read_to_string(&source).unwrap(), config.to_string());
    assert_eq!(
        desktop.manifest.load().unwrap()["plugins"]["demo@wegent"]["runtime"]["managed_mcp_python"],
        json!(python)
    );
    assert_eq!(
        desktop.manifest.load().unwrap()["plugins"]["demo@wegent"]["enabled"],
        true
    );

    let spec = checked_spec("demo@wegent", &entry).unwrap();
    assert!(desktop
        .unchanged_plugin_runtime_paths(&spec, source.parent().unwrap())
        .unwrap()
        .contains(&runtime));
    assert!(desktop
        .reconcile_managed_plugin_runtimes()
        .unwrap()
        .restored
        .is_empty());

    let new_home = temp.path().join("after");
    fs::rename(&home, &new_home).unwrap();
    let next_python = new_home.join("managed-runtimes/python/bin/python");
    let moved = self::store(&new_home, true).with_managed_mcp_python(Some(next_python.clone()));
    let repaired = moved.reconcile_managed_plugin_runtimes().unwrap();
    assert!(repaired.failed.is_empty(), "{:?}", repaired.failed);
    assert_eq!(repaired.restored, ["demo@wegent"]);
    let next_runtime = new_home.join(runtime.strip_prefix(&home).unwrap());
    let rebuilt: Value =
        serde_json::from_slice(&fs::read(next_runtime.join(".mcp.json")).unwrap()).unwrap();
    assert_eq!(
        rebuilt["mcpServers"]["managed"]["command"],
        json!(next_python)
    );
}

#[tokio::test]
async fn relocated_v2_recovers_existing_caches_and_preserves_install_state() {
    for codex_only in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        let original = installed(&old, codex_only).await;
        let mut manifest = original.manifest.load().unwrap();
        manifest["plugins"]["demo@wegent"]["authorization_binding"] = json!({"account_id":"keep"});
        manifest["plugins"]["demo@wegent"]["runtime"]["authorization_binding"] =
            json!({"account_id":"runtime-keep"});
        original.manifest.save(manifest).unwrap();
        fs::rename(&old, &new).unwrap();
        let store = store(&new, codex_only);
        let result = store.reconcile_managed_plugin_runtimes().unwrap();
        assert!(result.failed.is_empty(), "{:?}", result.failed);
        assert_eq!(result.restored, vec!["demo@wegent"]);
        let manifest = store.manifest.load().unwrap();
        let entry = &manifest["plugins"]["demo@wegent"];
        assert_eq!(entry["enabled"], false);
        assert_eq!(entry["installed_plugin_id"], 41);
        assert_eq!(entry["cloud_plugin_id"], 7);
        assert_eq!(entry["component_states"]["skill:demo"], false);
        assert_eq!(entry["authorization_binding"]["account_id"], "keep");
        assert_eq!(
            entry["runtime"]["authorization_binding"]["account_id"],
            "runtime-keep"
        );
        assert!(Path::new(entry["runtime"]["codex_link"].as_str().unwrap()).starts_with(&new));
        assert_eq!(
            fs::read_to_string(
                Path::new(entry["runtime"]["codex_link"].as_str().unwrap())
                    .join("skills/demo/SKILL.md")
            )
            .unwrap(),
            "plugin capability"
        );
        assert!(!old.exists());
        let second = store.reconcile_managed_plugin_runtimes().unwrap();
        assert!(second.failed.is_empty());
        assert!(second.restored.is_empty());
        if codex_only {
            assert!(!new.join("claude").exists());
            assert!(entry["runtime"].get("claude_link").is_none());
        }
    }
}

#[tokio::test]
async fn cleared_component_states_stay_cleared_across_sync_and_recovery() {
    for codex_only in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let store = installed(&root, codex_only).await;
        let manifest = store.manifest.load().unwrap();
        assert_eq!(
            manifest["plugins"]["demo@wegent"]["component_states"]["skill:demo"],
            false
        );
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            store.clone(),
            Packages(archive("demo")),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let mut cleared = payload("demo");
        cleared["plugins"][0]
            .as_object_mut()
            .unwrap()
            .insert("component_states".to_owned(), json!({}));
        let result = handler.apply_sync(cleared).await.unwrap();
        assert_eq!(result["success"], true, "{result}");
        let manifest = store.manifest.load().unwrap();
        assert!(
            manifest["plugins"]["demo@wegent"]
                .get("component_states")
                .is_none(),
            "{manifest}"
        );
        if !codex_only {
            let installed_plugins: Value = serde_json::from_str(
                &fs::read_to_string(root.join("claude/plugins/installed_plugins.json")).unwrap(),
            )
            .unwrap();
            assert!(
                installed_plugins["plugins"]["demo@wegent"][0]
                    .get("componentStates")
                    .is_none(),
                "{installed_plugins}"
            );
        }
        let recovered = store.reconcile_managed_plugin_runtimes().unwrap();
        assert!(recovered.failed.is_empty(), "{:?}", recovered.failed);
        let manifest = store.manifest.load().unwrap();
        assert!(
            manifest["plugins"]["demo@wegent"]
                .get("component_states")
                .is_none(),
            "{manifest}"
        );
    }
}

#[tokio::test]
async fn failed_plugin_does_not_prevent_another_plugin_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = installed(&old, true).await;
    let mut manifest = original.manifest.load().unwrap();
    let mut bad = manifest["plugins"]["demo@wegent"].clone();
    bad["name"] = json!("missing");
    bad["key"] = json!("missing@wegent");
    bad["checksum"] = json!(format!("sha256:{}", "0".repeat(64)));
    manifest["plugins"]["missing@wegent"] = bad;
    original.manifest.save(manifest).unwrap();
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    let result = store.reconcile_managed_plugin_runtimes().unwrap();
    assert_eq!(result.restored, vec!["demo@wegent"]);
    assert!(result.failed.contains_key("missing@wegent"));
    let manifest = store.manifest.load().unwrap();
    assert!(manifest["plugins"]["missing@wegent"]["runtime_recovery_error"].is_string());
    assert_eq!(manifest["plugins"]["missing@wegent"]["enabled"], false);
}

#[tokio::test]
async fn unrelated_relocation_target_is_preserved() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    installed(&old, true).await;
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    let target = new.join("codex/plugins/cache/wegent/demo/1.0");
    fs::write(target.join("personal-source.txt"), "preserve").unwrap();
    let result = store.reconcile_managed_plugin_runtimes().unwrap();
    assert!(result.failed.contains_key("demo@wegent"));
    assert_eq!(
        fs::read_to_string(target.join("personal-source.txt")).unwrap(),
        "preserve"
    );
    assert!(!old.exists());
}

#[tokio::test]
async fn imported_v1_recovers_without_modifying_legacy_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = installed(&old, true).await;
    let mut value = original.manifest.load().unwrap();
    value["version"] = json!(1);
    let legacy = original.manifest.path.with_file_name("manifest.json");
    let bytes = serde_json::to_vec(&value).unwrap();
    fs::write(&legacy, &bytes).unwrap();
    fs::remove_file(&original.manifest.path).unwrap();
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    let result = store.reconcile_managed_plugin_runtimes().unwrap();
    assert!(result.failed.is_empty(), "{:?}", result.failed);
    assert_eq!(store.manifest.load().unwrap()["version"], 2);
    assert_eq!(
        fs::read(store.manifest.path.with_file_name("manifest.json")).unwrap(),
        bytes
    );
}

#[tokio::test]
async fn empty_cloud_inventory_removes_stale_record_without_rebuilding_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    installed(&old, true).await;
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    let target = new.join("codex/plugins/cache/wegent/demo/1.0");
    fs::remove_dir_all(&target).unwrap();
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let result = handler
        .apply_sync(json!({"scope":"plugins","plugins":[]}))
        .await
        .unwrap();
    assert_eq!(result["success"], true);
    assert!(store.manifest.load().unwrap()["plugins"]
        .as_object()
        .unwrap()
        .is_empty());
    assert!(!target.exists());
    assert!(!old.exists());
    assert!(!new.join("claude").exists());
}

#[tokio::test]
async fn pending_journal_rolls_back_and_published_journal_commits() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("home");
    let store = installed(&root, true).await;
    let manifest = store.manifest.load().unwrap();
    let entry = &manifest["plugins"]["demo@wegent"];
    let spec = checked_spec("demo@wegent", entry).unwrap();
    let target = store.plugin_codex_link(&spec);
    let template = temp.path().join("template");
    copy_dir_recursive(&target, &template).unwrap();
    let path = store.recovery_journal_path(&spec.key);
    let _journal = RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
    fs::remove_dir_all(&target).unwrap();
    store
        .recover_plugin_journal(&path, &spec, &manifest)
        .unwrap();
    assert!(target.join("skills/demo/SKILL.md").exists());
    assert!(!path.exists());
    let journal = RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
    let mut published = manifest.clone();
    published["revision"] = json!(manifest["revision"].as_i64().unwrap() + 1);
    published["plugins"][&spec.key]["runtime_recovery_id"] = json!(journal.transaction_id);
    store
        .recover_plugin_journal(&path, &spec, &published)
        .unwrap();
    assert!(!path.exists());
    assert!(target.exists());
}

#[tokio::test]
async fn interrupted_recovery_preserves_conflicting_new_directory_and_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    let store = installed(&temp.path().join("home"), true).await;
    let manifest = store.manifest.load().unwrap();
    let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
    let target = store.plugin_codex_link(&spec);
    let template = temp.path().join("template");
    copy_dir_recursive(&target, &template).unwrap();
    let path = store.recovery_journal_path(&spec.key);
    let _journal = RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
    fs::write(target.join("personal.txt"), "keep").unwrap();
    assert!(store
        .recover_plugin_journal(&path, &spec, &manifest)
        .is_err());
    assert!(path.join("journal.json").exists());
    assert_eq!(
        fs::read_to_string(target.join("personal.txt")).unwrap(),
        "keep"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_parent_never_changes_external_data() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    installed(&old, true).await;
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    let external = temp.path().join("personal");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("sentinel"), "keep").unwrap();
    fs::remove_dir_all(new.join("codex/plugins/cache")).unwrap();
    std::os::unix::fs::symlink(&external, new.join("codex/plugins/cache")).unwrap();
    let result = store.reconcile_managed_plugin_runtimes().unwrap();
    assert!(result.failed.contains_key("demo@wegent"));
    assert_eq!(
        fs::read_to_string(external.join("sentinel")).unwrap(),
        "keep"
    );
    assert!(!external.join("wegent").exists());
}

#[test]
fn package_identity_mismatch_is_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let package = publish_plugin_archive(temp.path(), &archive("another"), None).unwrap();
    let spec = PluginSyncSpec::from_value(&payload("demo")["plugins"][0]).unwrap();
    assert!(validate_package_identity(&package.path, &spec).is_err());
}

#[tokio::test]
async fn relocated_previous_does_not_authorize_an_unrelated_downgrade_target() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = installed(&old, true).await;
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        original.clone(),
        Packages(archive_payload("demo", "updated")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut update = payload("demo");
    update["plugins"][0]["version"] = json!("2.0");
    assert_eq!(handler.apply_sync(update).await.unwrap()["success"], true);
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    let unknown = new.join("codex/plugins/cache/wegent/demo/1.0");
    fs::remove_dir_all(&unknown).unwrap();
    fs::create_dir_all(&unknown).unwrap();
    fs::write(unknown.join("personal.txt"), "keep").unwrap();
    let report = store.reconcile_managed_plugin_runtimes().unwrap();
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let result = handler.apply_sync(payload("demo")).await.unwrap();
    assert_eq!(result["success"], false, "{result}");
    assert_eq!(
        fs::read_to_string(unknown.join("personal.txt")).unwrap(),
        "keep"
    );
}

#[tokio::test]
async fn pending_journal_preserves_changed_files_and_file_replaced_by_directory() {
    for directory in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let store = installed(&temp.path().join("home"), true).await;
        let manifest = store.manifest.load().unwrap();
        let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
        let template = temp.path().join("template");
        copy_dir_recursive(&store.plugin_codex_link(&spec), &template).unwrap();
        let path = store.recovery_journal_path(&spec.key);
        let _journal =
            RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
        let config = store
            .codex_plugins_dir
            .parent()
            .unwrap()
            .join("config.toml");
        if directory {
            fs::remove_file(&config).unwrap();
            fs::create_dir(&config).unwrap();
            fs::write(config.join("personal.txt"), "keep").unwrap();
        } else {
            fs::write(&config, "# changed after interruption").unwrap();
        }
        assert!(store
            .recover_plugin_journal(&path, &spec, &manifest)
            .is_err());
        assert!(path.join("journal.json").exists());
        if directory {
            assert_eq!(
                fs::read_to_string(config.join("personal.txt")).unwrap(),
                "keep"
            );
        } else {
            assert_eq!(
                fs::read_to_string(&config).unwrap(),
                "# changed after interruption"
            );
        }
    }
}

#[tokio::test]
async fn unrelated_revision_bump_does_not_commit_an_interrupted_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let store = installed(&temp.path().join("home"), true).await;
    let mut manifest = store.manifest.load().unwrap();
    let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
    let target = store.plugin_codex_link(&spec);
    let template = temp.path().join("template");
    copy_dir_recursive(&target, &template).unwrap();
    let path = store.recovery_journal_path(&spec.key);
    let _journal = RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
    fs::remove_dir_all(&target).unwrap();
    manifest["revision"] = json!(manifest["revision"].as_i64().unwrap() + 1);
    store
        .recover_plugin_journal(&path, &spec, &manifest)
        .unwrap();
    assert!(target.join("skills/demo/SKILL.md").exists());
    assert!(!path.exists());
}

#[cfg(unix)]
#[tokio::test]
async fn owned_runtime_with_nested_symlink_is_never_snapshotted_or_materialized() {
    let temp = tempfile::tempdir().unwrap();
    let store = installed(&temp.path().join("home"), true).await;
    let mut manifest = store.manifest.load().unwrap();
    let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
    let external = temp.path().join("private");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("sentinel"), "private").unwrap();
    let target = store.plugin_codex_link(&spec);
    std::os::unix::fs::symlink(&external, target.join("user-source")).unwrap();
    manifest["plugins"][&spec.key]["runtime"]["codex_link"] =
        json!(temp.path().join("old/codex/plugins/cache/wegent/demo/1.0"));
    manifest["plugins"][&spec.key]["runtime_recovery_error"] = json!("force recovery");
    store.manifest.save(manifest).unwrap();
    let report = store.reconcile_managed_plugin_runtimes().unwrap();
    assert!(report.failed.contains_key(&spec.key));
    assert!(target.join("user-source").is_symlink());
    assert_eq!(
        fs::read_to_string(external.join("sentinel")).unwrap(),
        "private"
    );
    assert!(!store.recovery_journal_path(&spec.key).exists());
}

#[tokio::test]
async fn personal_marketplace_directory_copy_can_be_updated_by_its_managed_install() {
    let temp = tempfile::tempdir().unwrap();
    let store = store(&temp.path().join("home"), true);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut request = payload("demo");
    request["plugins"][0]["marketplace"] = json!("wework-personal");
    assert_eq!(
        handler.apply_sync(request.clone()).await.unwrap()["success"],
        true
    );
    let target = store.personal_marketplace_dir().join("plugins/demo");
    remove_existing_path(&target).unwrap();
    copy_dir_recursive(
        &store
            .codex_plugins_dir
            .join("cache/wework-personal/demo/1.0"),
        &target,
    )
    .unwrap();
    assert!(!target.is_symlink());
    request["plugins"][0]["version"] = json!("2.0");
    let update = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive_payload("demo", "v2")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    assert_eq!(update.apply_sync(request).await.unwrap()["success"], true);
    assert!(store
        .codex_plugins_dir
        .join("cache/wework-personal/demo/2.0")
        .exists());
}

#[tokio::test]
async fn stale_personal_install_does_not_delete_unknown_source_in_new_home() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = store(&old, true);
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        original.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let mut request = payload("demo");
    request["plugins"][0]["marketplace"] = json!("wework-personal");
    assert_eq!(handler.apply_sync(request).await.unwrap()["success"], true);
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    let personal = store.personal_marketplace_dir().join("plugins/demo");
    remove_existing_path(&personal).unwrap();
    fs::create_dir_all(&personal).unwrap();
    fs::write(personal.join("personal.txt"), "keep").unwrap();
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
    assert_eq!(
        fs::read_to_string(personal.join("personal.txt")).unwrap(),
        "keep"
    );
    assert!(!old.exists());
    assert!(store.manifest.load().unwrap()["plugins"]
        .as_object()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn relocated_uninstalled_owner_can_reinstall_without_reviving_on_startup() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = installed(&old, true).await;
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        original.clone(),
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
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    let report = store.reconcile_managed_plugin_runtimes().unwrap();
    assert!(report.restored.is_empty());
    assert!(report.failed.is_empty());
    let value = store.manifest.load().unwrap();
    assert!(value["plugins"].as_object().unwrap().is_empty());
    assert!(value["plugin_runtime_owners"]
        .as_object()
        .unwrap()
        .keys()
        .all(|path| !Path::new(path).starts_with(&old)));
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    assert_eq!(
        handler.apply_sync(payload("demo")).await.unwrap()["success"],
        true
    );
}

#[tokio::test]
async fn relocated_uninstalled_python_mcp_reuses_only_verified_runtime_contents() {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, body) in [
        (
            CODEX_PLUGIN_MANIFEST_PATH,
            r#"{"name":"demo","version":"1.0"}"#,
        ),
        (
            ".mcp.json",
            r#"{"demo":{"command":"python3","cwd":"./","args":["probe.py"]}}"#,
        ),
        ("probe.py", "pass\n"),
    ] {
        zip.start_file(path, zip::write::FileOptions::default())
            .unwrap();
        zip.write_all(body.as_bytes()).unwrap();
    }
    let packages = Packages(zip.finish().unwrap().into_inner());
    for marketplace in RECONCILABLE_PLUGIN_MARKETPLACES {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        let old_python = old.join("managed-runtimes/python/bin/python3");
        let new_python = new.join("managed-runtimes/python/bin/python3");
        let original = store(&old, true).with_managed_mcp_python(Some(old_python.clone()));
        let key = format!("demo@{marketplace}");
        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            original.clone(),
            packages.clone(),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        let mut request = payload("demo");
        request["plugins"][0]["marketplace"] = json!(marketplace);
        request["plugins"][0]["enabled"] = json!(true);
        let installed = handler.apply_sync(request.clone()).await.unwrap();
        assert_eq!(installed["success"], true, "{installed}");
        let entry = original.manifest.load().unwrap()["plugins"][&key].clone();
        let old_cache = PathBuf::from(entry["runtime"]["codex_link"].as_str().unwrap());
        assert_eq!(entry["runtime"]["managed_mcp_python"], json!(old_python));
        let removed = handler
            .apply_sync(json!({"scope":"plugins","plugins":[]}))
            .await
            .unwrap();
        assert_eq!(removed["success"], true, "{removed}");
        fs::rename(&old, &new).unwrap();
        let moved = store(&new, true).with_managed_mcp_python(Some(new_python.clone()));
        let report = moved.reconcile_managed_plugin_runtimes().unwrap();
        assert!(
            report.restored.is_empty() && report.failed.is_empty(),
            "{report:?}"
        );
        assert!(moved.manifest.load().unwrap()["plugins"][&key].is_null());

        let handler = CapabilitySyncHandler::with_package_provider(
            "",
            moved,
            packages.clone(),
            std::sync::Arc::new(crate::NoRunningSessions),
        );
        request["plugins"][0]["installed_plugin_id"] = json!(42);
        let cache = new.join(old_cache.strip_prefix(&old).unwrap());
        let script = cache.join("probe.py");
        fs::write(&script, "modified\n").unwrap();
        let rejected = handler.apply_sync(request.clone()).await.unwrap();
        assert_eq!(rejected["success"], false, "{rejected}");
        assert_eq!(
            rejected["plugins"][0]["error"],
            "Retained plugin destination is occupied by unrelated data; preserving it"
        );
        assert_eq!(fs::read_to_string(&script).unwrap(), "modified\n");

        fs::write(&script, "pass\n").unwrap();
        let reinstalled = handler.apply_sync(request).await.unwrap();
        assert_eq!(reinstalled["success"], true, "{marketplace}: {reinstalled}");
        let config: Value =
            serde_json::from_slice(&fs::read(cache.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(config["demo"]["command"], json!(new_python));
    }
}

#[tokio::test]
async fn fresh_verified_archive_recovers_legacy_record_without_package_metadata() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = installed(&old, true).await;
    let mut value = original.manifest.load().unwrap();
    value
        .as_object_mut()
        .unwrap()
        .remove("plugin_runtime_owners");
    value["plugins"]["demo@wegent"]
        .as_object_mut()
        .unwrap()
        .remove("checksum");
    original.manifest.save(value).unwrap();
    fs::remove_dir_all(old.join("workbench/shared")).unwrap();
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true);
    assert!(store
        .reconcile_managed_plugin_runtimes()
        .unwrap()
        .failed
        .contains_key("demo@wegent"));
    let handler = CapabilitySyncHandler::with_package_provider(
        "",
        store.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    let result = handler.apply_sync(payload("demo")).await.unwrap();
    assert_eq!(result["success"], true, "{result}");
    let value = store.manifest.load().unwrap();
    assert!(value["plugins"]["demo@wegent"]
        .get("runtime_recovery_error")
        .is_none());
    assert!(!old.exists());
}

#[tokio::test]
async fn pending_journal_recovers_after_real_metadata_writes_without_a_receipt() {
    for codex_only in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let store = installed(&temp.path().join("home"), codex_only).await;
        let manifest = store.manifest.load().unwrap();
        let mut spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
        spec.enabled = true;
        let template = temp.path().join("template");
        copy_dir_recursive(&store.plugin_codex_link(&spec), &template).unwrap();
        let config = store
            .codex_plugins_dir
            .parent()
            .unwrap()
            .join("config.toml");
        let before = fs::read(&config).unwrap();
        let path = store.recovery_journal_path(&spec.key);
        let journal = RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
        if !codex_only {
            store
                .install_claude_plugin_runtime_metadata_at(
                    &spec,
                    &template,
                    &journal.timestamp,
                    &BTreeSet::new(),
                )
                .unwrap();
        }
        store
            .install_codex_marketplace_metadata(
                &spec,
                &store.plugin_codex_link(&spec),
                manifest["plugins"][&spec.key]
                    .get("component_states")
                    .unwrap_or(&json!({})),
                &BTreeSet::new(),
            )
            .unwrap();
        assert_ne!(fs::read(&config).unwrap(), before);
        store
            .recover_plugin_journal(&path, &spec, &manifest)
            .unwrap();
        assert_eq!(fs::read(&config).unwrap(), before);
        assert!(!path.exists());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn pending_journal_refuses_a_replaced_file_parent_even_when_target_is_missing() {
    let temp = tempfile::tempdir().unwrap();
    let store = installed(&temp.path().join("home"), true).await;
    let manifest = store.manifest.load().unwrap();
    let spec = checked_spec("demo@wegent", &manifest["plugins"]["demo@wegent"]).unwrap();
    let template = temp.path().join("template");
    copy_dir_recursive(&store.plugin_codex_link(&spec), &template).unwrap();
    let path = store.recovery_journal_path(&spec.key);
    let _journal = RecoveryJournal::prepare(&store, &path, &spec, &template, &manifest).unwrap();
    let external = temp.path().join("personal");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("sentinel"), "keep").unwrap();
    let parent = store
        .codex_marketplace_dir(&spec.marketplace)
        .join(".agents");
    fs::remove_dir_all(&parent).unwrap();
    std::os::unix::fs::symlink(&external, &parent).unwrap();
    assert!(store
        .recover_plugin_journal(&path, &spec, &manifest)
        .is_err());
    assert!(path.join("journal.json").exists());
    assert_eq!(
        fs::read_to_string(external.join("sentinel")).unwrap(),
        "keep"
    );
    assert!(!external.join("plugins").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn current_manifest_does_not_allow_a_symlinked_runtime_parent_fast_path() {
    let temp = tempfile::tempdir().unwrap();
    let store = installed(&temp.path().join("home"), true).await;
    let cache = store.codex_plugins_dir.join("cache");
    let external = temp.path().join("personal");
    copy_dir_recursive(&cache, &external).unwrap();
    fs::write(external.join("sentinel"), "keep").unwrap();
    fs::remove_dir_all(&cache).unwrap();
    std::os::unix::fs::symlink(&external, &cache).unwrap();
    let report = store.reconcile_managed_plugin_runtimes().unwrap();
    assert!(report.failed.contains_key("demo@wegent"));
    assert_eq!(
        fs::read_to_string(external.join("sentinel")).unwrap(),
        "keep"
    );
    assert!(cache.is_symlink());
}

#[tokio::test]
async fn custom_runtime_home_rebases_retained_owners_from_active_identity() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    let original = store(&old, true).with_codex_plugins_dir(old.join("custom-old-home/plugins"));
    let first = CapabilitySyncHandler::with_package_provider(
        "",
        original.clone(),
        Packages(archive("demo")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    assert_eq!(
        first.apply_sync(payload("demo")).await.unwrap()["success"],
        true
    );
    let mut update = payload("demo");
    update["plugins"][0]["version"] = json!("2.0");
    let second = CapabilitySyncHandler::with_package_provider(
        "",
        original.clone(),
        Packages(archive_payload("demo", "v2")),
        std::sync::Arc::new(crate::NoRunningSessions),
    );
    assert_eq!(second.apply_sync(update).await.unwrap()["success"], true);
    fs::rename(&old, &new).unwrap();
    let store = store(&new, true).with_codex_plugins_dir(new.join("custom-old-home/plugins"));
    let report = store.reconcile_managed_plugin_runtimes().unwrap();
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let manifest = store.manifest.load().unwrap();
    assert!(manifest["plugin_runtime_owners"]
        .as_object()
        .unwrap()
        .keys()
        .all(|path| !Path::new(path).starts_with(&old)));
}

#[path = "runtime_publication_tests.rs"]
mod runtime_publication_tests;

#[path = "runtime_sync_tests.rs"]
mod sync_scope;
