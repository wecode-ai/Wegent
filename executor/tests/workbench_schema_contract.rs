// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::process::Command;

#[test]
fn codex_migration_check_is_read_only_and_returns_no_config_or_credentials() {
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path().join("codex home");
    let unused_home = temporary.path().join("must-not-initialize");
    std::fs::create_dir(&home).unwrap();
    // A directory instead of a file proves the checker never opens auth.json.
    std::fs::create_dir(home.join("auth.json")).unwrap();
    for (config, allowed) in [
        ("cli_auth_credentials_store = 'file'\n[features]\nsecret_auth_storage = false", true),
        ("[features]\nsecret_auth_storage = false\n[mcp_servers.test]\nurl = 'https://example.invalid/mcp'", true),
        ("mcp_oauth_credentials_store = 'keyring'\n[features]\nsecret_auth_storage = false\n[mcp_servers.test]\nurl = 'https://example.invalid/mcp'", true),
        ("[features]\nsecret_auth_storage = true", false),
        ("cli_auth_credentials_store = 'keyring'", false),
        ("broken = [ synthetic-secret", false),
    ] {
        std::fs::write(home.join("config.toml"), config).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
            .arg("--workbench-codex-migration-check")
            .arg(&home)
            .arg("--version")
            .env("HOME", &unused_home)
            .env("WEGENT_EXECUTOR_HOME", &unused_home)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(output.stderr.is_empty());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic-secret"));
        let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(response["codex_home_migration"], 1);
        assert_eq!(response["allowed"], allowed);
        assert!(!unused_home.exists());
        assert_eq!(
            std::fs::read_to_string(home.join("config.toml")).unwrap(),
            config
        );
    }
}

#[test]
fn schema_query_does_not_initialize_homes_or_runtime() {
    let temporary = tempfile::tempdir().unwrap();
    let home = temporary.path().join("untouched-home");
    let output = Command::new(env!("CARGO_BIN_EXE_wegent-executor"))
        .args(["--workbench-schema", "--version"])
        .env("HOME", &home)
        .env("WEGENT_EXECUTOR_HOME", &home)
        .env("WEGENT_WORKBENCH_HOME", &home)
        .env("WEGENT_CODEX_HOME", &home)
        .env("WEGENT_CAPABILITIES_HOME", &home)
        .env("WEGENT_CLAUDE_HOME", &home)
        .env("WEGENT_APP_LIFECYCLE_FD", "99")
        .env("SHELL", "/does/not/exist")
        .output()
        .expect("query executor schema");
    assert!(output.status.success());
    assert!(output.stderr.is_empty());
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["protocol_version"], 1);
    assert_eq!(
        response["workbench_layout_versions"],
        serde_json::json!([1])
    );
    assert_eq!(
        response["capability_manifest_versions"],
        serde_json::json!([2])
    );
    assert!(
        !home.exists(),
        "schema queries must not touch application data"
    );
}
