use super::*;
use std::fs;

#[test]
fn copies_matching_marketplaces_and_reports_default_plugins() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = root.path().join("destination/wework-personal");
    fs::create_dir_all(source.join(".agents/plugins")).unwrap();
    fs::create_dir_all(source.join(".claude-plugin")).unwrap();
    fs::create_dir_all(source.join("plugins/smart-app-builder")).unwrap();
    fs::write(
        source.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[{"name":"smart-app-builder","policy":{"installation":"INSTALLED_BY_DEFAULT"}},{"name":"wework-space"}]}"#,
    )
    .unwrap();
    fs::write(
        source.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[{"name":"wework-space"},{"name":"smart-app-builder"}]}"#,
    )
    .unwrap();
    fs::write(
        source.join("plugins/smart-app-builder/README.md"),
        "builder",
    )
    .unwrap();

    let marketplace =
        initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

    assert_eq!(marketplace.id, "wework-personal");
    assert_eq!(marketplace.plugin_count, 2);
    assert_eq!(
        marketplace.default_plugin_names,
        vec!["smart-app-builder".to_owned()]
    );
    assert_eq!(
        fs::read_to_string(destination.join("plugins/smart-app-builder/README.md")).unwrap(),
        "builder"
    );
    assert!(!marketplace.content_hash.is_empty());
    assert_eq!(
        fs::read_to_string(destination.join(CONTENT_HASH_FILE))
            .unwrap()
            .trim(),
        marketplace.content_hash
    );

    fs::create_dir_all(destination.join(".wegent/plugin-import-backups/pending")).unwrap();
    fs::write(
        destination.join(".wegent/plugin-copy-sources.json"),
        r#"{"copies":[{"localPluginName":"personal-tool"}]}"#,
    )
    .unwrap();
    fs::write(
        destination.join(".wegent/plugin-import-backups/pending/rollback.json"),
        r#"{"pluginName":"personal-tool"}"#,
    )
    .unwrap();

    remove_existing_path(&destination.join("plugins/smart-app-builder")).unwrap();
    fs::write(
        destination.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[{"name":"wework-space"}]}"#,
    )
    .unwrap();
    fs::write(
        destination.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[{"name":"wework-space"}]}"#,
    )
    .unwrap();
    let unchanged =
        initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

    assert_eq!(unchanged.content_hash, marketplace.content_hash);
    assert_eq!(
        fs::read_to_string(destination.join("plugins/smart-app-builder/README.md")).unwrap(),
        "builder"
    );
    assert!(
        marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json"))
            .unwrap()
            .contains(&"smart-app-builder".to_owned())
    );

    fs::create_dir_all(destination.join("plugins/personal-tool/.codex-plugin")).unwrap();
    fs::create_dir_all(destination.join("plugins/personal-tool/.claude-plugin")).unwrap();
    fs::write(
        destination.join("plugins/personal-tool/.codex-plugin/plugin.json"),
        r#"{"name":"personal-tool","version":"1.0.0"}"#,
    )
    .unwrap();
    fs::write(
        destination.join("plugins/personal-tool/.claude-plugin/plugin.json"),
        r#"{"name":"personal-tool","version":"1.0.0"}"#,
    )
    .unwrap();
    fs::write(
        source.join("plugins/smart-app-builder/README.md"),
        "updated builder",
    )
    .unwrap();
    let updated = initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

    assert_ne!(updated.content_hash, marketplace.content_hash);
    assert_eq!(
        fs::read_to_string(destination.join("plugins/smart-app-builder/README.md")).unwrap(),
        "updated builder"
    );
    assert!(destination
        .join("plugins/personal-tool/.codex-plugin/plugin.json")
        .is_file());
    assert!(
        marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json"))
            .unwrap()
            .contains(&"personal-tool".to_owned())
    );
    assert!(
        marketplace_plugin_names(&destination.join(".claude-plugin/marketplace.json"))
            .unwrap()
            .contains(&"personal-tool".to_owned())
    );
    assert_eq!(
        fs::read_to_string(destination.join(".wegent/plugin-copy-sources.json")).unwrap(),
        r#"{"copies":[{"localPluginName":"personal-tool"}]}"#
    );
    assert_eq!(
        fs::read_to_string(destination.join(".wegent/plugin-import-backups/pending/rollback.json"))
            .unwrap(),
        r#"{"pluginName":"personal-tool"}"#
    );
}

#[test]
fn recovers_configured_personal_plugin_from_codex_cache() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = root.path().join("destination/wework-personal");
    let codex_home = root.path().join("codex");
    fs::create_dir_all(source.join(".agents/plugins")).unwrap();
    fs::create_dir_all(source.join(".claude-plugin")).unwrap();
    fs::write(
        source.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[{"name":"smart-app-builder"}]}"#,
    )
    .unwrap();
    fs::write(
        source.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[{"name":"smart-app-builder"}]}"#,
    )
    .unwrap();
    initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

    fs::create_dir_all(&codex_home).unwrap();
    fs::write(
        codex_home.join("config.toml"),
        "[plugins.\"ip-location@wework-personal\"]\nenabled = true\n",
    )
    .unwrap();
    let cached = codex_home.join("plugins/cache/wework-personal/ip-location/0.3.0/.codex-plugin");
    fs::create_dir_all(&cached).unwrap();
    fs::write(
        cached.join("plugin.json"),
        r#"{"name":"ip-location","version":"0.3.0","description":"IP lookup","interface":{"category":"Utilities"}}"#,
    )
    .unwrap();

    let result = initialize_bundled_plugin_marketplace_from_paths_with_codex_home(
        &source,
        &destination,
        Some(&codex_home),
    )
    .unwrap();

    assert_eq!(result.plugin_count, 1);
    assert!(destination
        .join("plugins/ip-location/.codex-plugin/plugin.json")
        .is_file());
    assert!(
        marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json"))
            .unwrap()
            .contains(&"ip-location".to_owned())
    );
    assert!(
        marketplace_plugin_names(&destination.join(".claude-plugin/marketplace.json"))
            .unwrap()
            .contains(&"ip-location".to_owned())
    );
}

#[test]
fn removes_unrecoverable_personal_plugin_config_and_invalid_cache() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = root.path().join("destination/wework-personal");
    let codex_home = root.path().join("codex");
    fs::create_dir_all(source.join(".agents/plugins")).unwrap();
    fs::create_dir_all(source.join(".claude-plugin")).unwrap();
    fs::write(
        source.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();
    fs::write(
        source.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();
    fs::create_dir_all(codex_home.join("plugins/cache/wework-personal/removed-plugin/1.0.0"))
        .unwrap();
    fs::write(
        codex_home.join("config.toml"),
        concat!(
            "[plugins.\"removed-plugin@wework-personal\"]\n",
            "enabled = true\n",
            "[plugins.\"unrelated@other-marketplace\"]\n",
            "enabled = true\n"
        ),
    )
    .unwrap();

    initialize_bundled_plugin_marketplace_from_paths_with_codex_home(
        &source,
        &destination,
        Some(&codex_home),
    )
    .unwrap();

    let config = fs::read_to_string(codex_home.join("config.toml")).unwrap();
    assert!(!config.contains("removed-plugin@wework-personal"));
    assert!(config.contains("unrelated@other-marketplace"));
    assert!(!codex_home
        .join("plugins/cache/wework-personal/removed-plugin")
        .exists());
}

#[test]
fn migrates_personal_plugin_from_legacy_app_marketplace() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = root.path().join("destination/wework-personal");
    let legacy = root
        .path()
        .join("apps/com.example.wework/codex/plugins/marketplaces/wework-personal");
    fs::create_dir_all(source.join(".agents/plugins")).unwrap();
    fs::create_dir_all(source.join(".claude-plugin")).unwrap();
    fs::write(
        source.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();
    fs::write(
        source.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();
    fs::create_dir_all(legacy.join(".agents/plugins")).unwrap();
    fs::create_dir_all(legacy.join(".claude-plugin")).unwrap();
    fs::create_dir_all(legacy.join("plugins/personal-tool/.codex-plugin")).unwrap();
    fs::write(
        legacy.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[{"name":"personal-tool","source":{"source":"local","path":"./plugins/personal-tool"}}]}"#,
    )
    .unwrap();
    fs::write(
        legacy.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[{"name":"personal-tool","source":"./plugins/personal-tool"}]}"#,
    )
    .unwrap();
    fs::write(
        legacy.join("plugins/personal-tool/.codex-plugin/plugin.json"),
        r#"{"name":"personal-tool","version":"1.0.0"}"#,
    )
    .unwrap();

    initialize_bundled_plugin_marketplace_from_paths_with_recovery(
        &source,
        &destination,
        None,
        std::slice::from_ref(&legacy),
    )
    .unwrap();

    assert!(destination
        .join("plugins/personal-tool/.codex-plugin/plugin.json")
        .is_file());
    assert_eq!(
        marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json")).unwrap(),
        vec!["personal-tool".to_owned()]
    );

    remove_existing_path(&destination.join("plugins/personal-tool")).unwrap();
    fs::write(
        destination.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();
    fs::write(
        destination.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();

    initialize_bundled_plugin_marketplace_from_paths_with_recovery(
        &source,
        &destination,
        None,
        std::slice::from_ref(&legacy),
    )
    .unwrap();

    assert!(!destination.join("plugins/personal-tool").exists());
    assert!(
        marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json"))
            .unwrap()
            .is_empty()
    );
}

#[test]
fn recovers_unscoped_personal_plugin_for_branded_executor_home() {
    let root = tempfile::tempdir().unwrap();
    let wework_root = root.path().join(".wework");
    let executor_home = wework_root.join("apps/com.weibo.wework");
    let source = root.path().join("source");
    let destination = executor_home.join("capabilities/bundled-marketplaces/wework-personal");
    let legacy = wework_root.join("codex/plugins/marketplaces/wework-personal");
    fs::create_dir_all(source.join(".agents/plugins")).unwrap();
    fs::create_dir_all(source.join(".claude-plugin")).unwrap();
    fs::write(
        source.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();
    fs::write(
        source.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();
    fs::create_dir_all(legacy.join(".agents/plugins")).unwrap();
    fs::create_dir_all(legacy.join(".claude-plugin")).unwrap();
    fs::create_dir_all(legacy.join("plugins/local-ip/.codex-plugin")).unwrap();
    fs::write(
        legacy.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[{"name":"local-ip","source":{"source":"local","path":"./plugins/local-ip"}}]}"#,
    )
    .unwrap();
    fs::write(
        legacy.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[{"name":"local-ip","source":"./plugins/local-ip"}]}"#,
    )
    .unwrap();
    fs::write(
        legacy.join("plugins/local-ip/.codex-plugin/plugin.json"),
        r#"{"name":"local-ip","version":"1.0.0"}"#,
    )
    .unwrap();

    let legacy_roots = legacy_personal_marketplace_roots(&executor_home).unwrap();
    initialize_bundled_plugin_marketplace_from_paths_with_recovery(
        &source,
        &destination,
        None,
        &legacy_roots,
    )
    .unwrap();

    assert_eq!(legacy_roots, vec![legacy]);
    assert!(destination
        .join("plugins/local-ip/.codex-plugin/plugin.json")
        .is_file());
    assert_eq!(
        marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json")).unwrap(),
        vec!["local-ip".to_owned()]
    );
}

#[test]
fn leaves_a_hash_matched_marketplace_unchanged_when_recovery_fails() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = root.path().join("destination/wework-personal");
    let legacy = root.path().join("legacy/wework-personal");
    let codex_home = root.path().join("codex");
    for marketplace_root in [&source, &legacy] {
        fs::create_dir_all(marketplace_root.join(".agents/plugins")).unwrap();
        fs::create_dir_all(marketplace_root.join(".claude-plugin")).unwrap();
    }
    fs::write(
        source.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();
    fs::write(
        source.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();
    initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap();

    fs::create_dir_all(legacy.join("plugins/personal-tool/.codex-plugin")).unwrap();
    fs::write(
        legacy.join("plugins/personal-tool/.codex-plugin/plugin.json"),
        r#"{"name":"personal-tool","version":"1.0.0"}"#,
    )
    .unwrap();
    fs::write(
        legacy.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[{"name":"personal-tool","source":{"source":"local","path":"./plugins/personal-tool"}}]}"#,
    )
    .unwrap();
    fs::write(
        legacy.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[{"name":"personal-tool","source":"./plugins/personal-tool"}]}"#,
    )
    .unwrap();
    fs::create_dir_all(&codex_home).unwrap();
    fs::write(codex_home.join("config.toml"), "not valid toml = [").unwrap();

    let error = initialize_bundled_plugin_marketplace_from_paths_with_recovery(
        &source,
        &destination,
        Some(&codex_home),
        std::slice::from_ref(&legacy),
    )
    .unwrap_err();

    assert!(error.contains("Failed to parse"));
    assert!(!destination.join("plugins/personal-tool").exists());
    assert!(
        marketplace_plugin_names(&destination.join(".agents/plugins/marketplace.json"))
            .unwrap()
            .is_empty()
    );
    assert!(!destination
        .parent()
        .unwrap()
        .join(format!(".{MARKETPLACE_ID}-{}-staging", std::process::id()))
        .exists());
}

#[test]
fn rejects_mismatched_codex_and_claude_marketplaces() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    let destination = root.path().join("destination/wework-personal");
    fs::create_dir_all(source.join(".agents/plugins")).unwrap();
    fs::create_dir_all(source.join(".claude-plugin")).unwrap();
    fs::write(
        source.join(".agents/plugins/marketplace.json"),
        r#"{"plugins":[{"name":"smart-app-builder"}]}"#,
    )
    .unwrap();
    fs::write(
        source.join(".claude-plugin/marketplace.json"),
        r#"{"plugins":[]}"#,
    )
    .unwrap();

    let error =
        initialize_bundled_plugin_marketplace_from_paths(&source, &destination).unwrap_err();

    assert_eq!(error, "Bundled Codex and Claude plugin names must match");
    assert!(!destination.exists());
}
