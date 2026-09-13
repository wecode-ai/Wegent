use super::*;

#[tokio::test]
async fn task_token_marketplace_sources_are_filtered_copies_of_the_immutable_package() {
    let temp = TempRoot::new("task-token-marketplace");
    let claude = temp.path().join(".claude/plugins");
    let codex = temp.path().join(".codex/plugins");
    let source = r#"{"business":{"type":"http","url":"https://business.invalid/mcp","headers":{"Authorization":"Bearer ${{task_token}}"}},"public":{"url":"https://public.invalid/mcp"}}"#;
    let package = zip_bytes(&[
        (
            "fixture/.codex-plugin/plugin.json",
            r#"{"name":"fixture","version":"1.0.0","mcpServers":"./.mcp.json"}"#,
        ),
        ("fixture/.mcp.json", source),
    ]);
    let checksum = sha256_hex(&package);
    let store_dir = temp.path().join("store");
    let store = GlobalCapabilityStore::new(
        temp.path().join("manifest.json"),
        temp.path().join("skills"),
    )
    .with_plugins_dir(claude.clone())
    .with_codex_plugins_dir(codex.clone())
    .with_store_dir(store_dir.clone());
    let handler = CapabilitySyncHandler::with_package_provider(
        "token",
        store,
        StaticPackageProvider::default().with_plugin("/download", package),
    );
    let result = handler
        .apply_sync(json!({"mode":"replace", "plugins":[{
        "installed_plugin_id":20,"name":"fixture","marketplace":"wegent","version":"1.0.0",
        "download_path":"/download","checksum":checksum
    }], "skills":[],"mcps":[]}))
        .await
        .unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(
        fs::read_to_string(store_dir.join("plugins/20-wegent-fixture-1.0.0/.mcp.json")).unwrap(),
        source
    );
    for (home, runtime, name) in [
        (claude, "claude", "fixture-wegent"),
        (codex, "codex", "fixture"),
    ] {
        let root = home.join("marketplaces/wegent/plugins").join(name);
        assert!(root.is_dir());
        assert!(!root.is_symlink());
        let manifest = read_json(root.join(format!(".{runtime}-plugin/plugin.json")));
        let native = read_json(root.join(manifest["mcpServers"].as_str().unwrap()));
        let native_servers = native["mcpServers"].as_object().unwrap();
        assert!(!native_servers.contains_key("business"));
        assert!(native_servers["public"].is_object());
        if runtime == "claude" {
            let default = read_json(root.join(".mcp.json"));
            assert!(!default["mcpServers"]
                .as_object()
                .unwrap()
                .contains_key("business"));
        }
    }
}

#[tokio::test]
async fn configured_task_token_marketplace_sources_are_filtered() {
    let temp = TempRoot::new("configured-task-token-marketplace");
    let claude = temp.path().join(".claude/plugins");
    let codex = temp.path().join(".codex/plugins");
    let source = r#"{"business":{"url":"https://business.invalid/mcp","headers":{"X-Author-Header":"author"}},"public":{"url":"https://public.invalid/mcp"}}"#;
    let package = zip_bytes(&[
        (
            "fixture/.codex-plugin/plugin.json",
            r#"{"name":"fixture","version":"1.0.0","mcpServers":"./.mcp.json"}"#,
        ),
        ("fixture/.mcp.json", source),
    ]);
    let checksum = sha256_hex(&package);
    let store_dir = temp.path().join("store");
    let store = GlobalCapabilityStore::new(
        temp.path().join("manifest.json"),
        temp.path().join("skills"),
    )
    .with_plugins_dir(claude.clone())
    .with_codex_plugins_dir(codex.clone())
    .with_store_dir(store_dir.clone());
    let handler = CapabilitySyncHandler::with_package_provider(
        "token",
        store,
        StaticPackageProvider::default().with_plugin("/download", package),
    );
    let result = handler
        .apply_sync(json!({"mode":"replace", "plugins":[{
        "installed_plugin_id":20,"name":"fixture","marketplace":"wegent","version":"1.0.0",
        "download_path":"/download","checksum":checksum,
        "component_config":{"mcp:business":{"headers":{
            "Authorization":"Bearer ${{task_token}}"
        }}}
    }], "skills":[],"mcps":[]}))
        .await
        .unwrap();
    assert_eq!(result["success"], true);
    assert_eq!(
        fs::read_to_string(store_dir.join("plugins/20-wegent-fixture-1.0.0/.mcp.json")).unwrap(),
        source
    );
    for (home, runtime, name) in [
        (claude, "claude", "fixture-wegent"),
        (codex, "codex", "fixture"),
    ] {
        let root = home.join("marketplaces/wegent/plugins").join(name);
        assert!(root.is_dir());
        assert!(!root.is_symlink());
        let manifest = read_json(root.join(format!(".{runtime}-plugin/plugin.json")));
        let native = read_json(root.join(manifest["mcpServers"].as_str().unwrap()));
        assert!(native["mcpServers"]["business"].is_null());
        assert!(native["mcpServers"]["public"].is_object());
        if runtime == "claude" {
            assert!(read_json(root.join(".mcp.json"))["mcpServers"]["business"].is_null());
        }
    }
}
