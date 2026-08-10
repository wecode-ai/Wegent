use super::*;

fn test_directory(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "wework-agent-plugin-{name}-{}-{}",
        std::process::id(),
        TEMPORARY_PATH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

fn create_standard_plugin(root: &Path) -> PluginSource {
    fs::create_dir_all(root.join("skills/demo")).unwrap();
    fs::write(
        root.join("plugin.json"),
        serde_json::to_vec(&json!({
            "$schema": AGENT_PLUGIN_SCHEMA,
            "name": "demo-plugin",
            "version": "1.0.0",
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        root.join("skills/demo/SKILL.md"),
        "---\nname: demo\ndescription: Demo skill\n---\n\nUse the demo MCP server.\n",
    )
    .unwrap();
    fs::write(
        root.join("mcp.json"),
        serde_json::to_vec(&json!({
            "mcpServers": {
                "demo": {
                    "command": "${PLUGIN_ROOT}/bin/demo",
                    "args": ["${PLUGIN_DATA}/state.json"],
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let data_root = root.join("data");
    fs::create_dir_all(&data_root).unwrap();
    PluginSource {
        name: "demo-plugin".to_string(),
        root: root.to_path_buf(),
        data_root,
    }
}

#[test]
fn replaces_agent_plugin_path_variables_recursively() {
    let source = PluginSource {
        name: "demo".to_string(),
        root: PathBuf::from("/plugins/demo"),
        data_root: PathBuf::from("/data/demo"),
    };
    let expanded = expand_plugin_values(
        &json!({
            "command": "${PLUGIN_ROOT}/bin/server",
            "args": ["${PLUGIN_DATA}/config.json"],
        }),
        &source,
    );
    assert_eq!(expanded["command"], "/plugins/demo/bin/server");
    assert_eq!(expanded["args"][0], "/data/demo/config.json");
}

#[test]
fn converts_stdio_mcp_servers_for_opencode() {
    let source = PluginSource {
        name: "demo".to_string(),
        root: PathBuf::from("/plugins/demo"),
        data_root: PathBuf::from("/data/demo"),
    };
    let adapted = adapt_opencode_mcp_server(
        &json!({
            "command": "node",
            "args": ["server.mjs"],
            "env": {"MODE": "test"},
        }),
        Some(&source),
    )
    .expect("OpenCode MCP adapter");
    assert_eq!(adapted["type"], "local");
    assert_eq!(adapted["command"], json!(["node", "server.mjs"]));
    assert_eq!(adapted["environment"]["MODE"], "test");
    assert_eq!(adapted["cwd"], "/plugins/demo");
}

#[test]
fn prepares_claude_home_without_replacing_existing_settings() {
    let root = test_directory("claude-home");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(".claude.json"),
        serde_json::to_vec(&json!({
            "theme": "dark",
            "bypassPermissionsModeAccepted": false,
        }))
        .unwrap(),
    )
    .unwrap();

    prepare_claude_home(&root, Some("/workspace/demo"), false).unwrap();
    let default_mode: Value =
        serde_json::from_slice(&fs::read(root.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(default_mode["theme"], "dark");
    assert_eq!(default_mode["hasCompletedOnboarding"], true);
    assert_eq!(default_mode["bypassPermissionsModeAccepted"], false);
    assert_eq!(
        default_mode["customApiKeyResponses"]["approved"],
        json!([WEWORK_LOCAL_ROUTER_API_KEY])
    );
    assert_eq!(
        default_mode["projects"]["/workspace/demo"]["hasTrustDialogAccepted"],
        true
    );
    assert_eq!(
        default_mode["projects"]["/workspace/demo"]["hasCompletedProjectOnboarding"],
        true
    );

    prepare_claude_home(&root, Some("/workspace/demo"), true).unwrap();
    let bypass_mode: Value =
        serde_json::from_slice(&fs::read(root.join(".claude.json")).unwrap()).unwrap();
    assert_eq!(bypass_mode["theme"], "dark");
    assert_eq!(bypass_mode["hasCompletedOnboarding"], true);
    assert_eq!(bypass_mode["bypassPermissionsModeAccepted"], false);
    let bypass_settings: Value =
        serde_json::from_slice(&fs::read(root.join("settings.json")).unwrap()).unwrap();
    assert_eq!(bypass_settings["skipDangerousModePermissionPrompt"], true);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn materializes_standard_plugins_and_builtin_browser_for_all_harnesses() {
    let root = test_directory("materialize");
    let plugin_root = root.join("plugin");
    let source = create_standard_plugin(&plugin_root);

    let open_code_root = root.join("opencode");
    materialize_adapter(&open_code_root, "opencode", &[source]).unwrap();
    let open_code: Value =
        serde_json::from_slice(&fs::read(open_code_root.join("opencode.json")).unwrap()).unwrap();
    assert_eq!(
        open_code["mcp"]["demo"]["command"][0],
        plugin_root.join("bin/demo").display().to_string()
    );
    assert_eq!(
        open_code["mcp"]["demo"]["command"][1],
        plugin_root.join("data/state.json").display().to_string()
    );
    assert!(open_code["mcp"]["wework_browser"].is_object());
    assert!(open_code_root.join("skills/demo/SKILL.md").is_file());
    assert!(open_code_root
        .join("skills/wework-built-in-browser/SKILL.md")
        .is_file());

    let source = create_standard_plugin(&plugin_root);
    let claude_root = root.join("claude");
    materialize_adapter(&claude_root, "claude_code", &[source]).unwrap();
    let claude_mcp: Value =
        serde_json::from_slice(&fs::read(claude_root.join(".mcp.json")).unwrap()).unwrap();
    assert_eq!(
        claude_mcp["mcpServers"]["demo"]["command"],
        plugin_root.join("bin/demo").display().to_string()
    );
    assert!(claude_mcp["mcpServers"]["wework_browser"].is_object());
    assert!(claude_root.join(".claude-plugin/plugin.json").is_file());
    assert!(claude_root.join("skills/demo/SKILL.md").is_file());

    let source = create_standard_plugin(&plugin_root);
    let kimi_root = root.join("kimi");
    materialize_adapter(&kimi_root, "kimi_code", &[source]).unwrap();
    let kimi_home = root.join("kimi-home");
    synchronize_kimi_home(&kimi_root, &kimi_home, None).unwrap();
    let kimi_mcp: Value =
        serde_json::from_slice(&fs::read(kimi_home.join("mcp.json")).unwrap()).unwrap();
    assert_eq!(
        kimi_mcp["mcpServers"]["demo"]["command"],
        plugin_root.join("bin/demo").display().to_string()
    );
    assert!(kimi_mcp["mcpServers"]["wework_browser"].is_object());
    assert!(kimi_home.join("skills/demo/SKILL.md").is_file());
    assert!(kimi_home
        .join("skills/wework-built-in-browser/SKILL.md")
        .is_file());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn prepares_kimi_workspace_trust_using_kimi_code_storage_contract() {
    let root = test_directory("kimi-trust");
    let workspace = root.join("Wegent Demo");
    let home = root.join("kimi-home");
    fs::create_dir_all(&workspace).unwrap();

    prepare_kimi_workspace_trust(&home, workspace.to_str().unwrap()).unwrap();

    let canonical_workspace = fs::canonicalize(&workspace).unwrap();
    let normalized = canonical_workspace.display().to_string().replace('\\', "/");
    let digest = format!("{:x}", Sha256::digest(normalized.as_bytes()));
    let trust_path = home
        .join("workspace-trust")
        .join(format!("wd_wegent-demo_{}", &digest[..12]));
    let trust: Value = serde_json::from_slice(&fs::read(&trust_path).unwrap()).unwrap();
    assert_eq!(trust["root"], canonical_workspace.display().to_string());
    assert!(trust["trustedAt"].as_u64().is_some());

    fs::remove_dir_all(root).unwrap();
}
