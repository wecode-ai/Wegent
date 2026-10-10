// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn stable_config_retains_omitted_services_and_refreshes_context() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("config.toml");
    fs::write(&path, "# personal config\nmodel = 'my-model'\n").unwrap();
    let mut request = ExecutionRequest {
        task_id: "task-first".to_owned(),
        auth_token: Some("synthetic-first-secret".to_owned()),
        mcp_servers: vec![
            json!({"name":"skill-shell", "command":"node", "args":["probe.js", "${{task_id}}"], "env":{"TOKEN":"${{auth_token}}"}}),
            json!({"name":"skill-http", "type":"http", "url":"https://example.test/mcp", "headers":{"Authorization":"Bearer synthetic-first-secret"}}),
        ],
        ..Default::default()
    };
    let mut first = Map::new();
    prepare(home.path(), &request, &mut first).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.starts_with("# personal config\nmodel = 'my-model'\n"));
    assert!(!content.contains("synthetic-first-secret"));
    assert!(!content.contains("task-first"));
    assert_eq!(
        first["mcp_servers.skill-shell"]["env"]["TOKEN"],
        "synthetic-first-secret"
    );
    let before = fs::metadata(&path).unwrap();
    request.task_id = "task-second".to_owned();
    request.auth_token = Some("synthetic-second-secret".to_owned());
    request.mcp_servers.clear();
    let mut second = Map::new();
    prepare(home.path(), &request, &mut second).unwrap();
    assert_eq!(
        second["mcp_servers.skill-shell.env"]["TOKEN"],
        "synthetic-second-secret"
    );
    assert_eq!(second["mcp_servers.skill-shell"]["args"][1], "task-second");
    assert_eq!(
        second["mcp_servers.skill-http"]["http_headers"]["Authorization"],
        "Bearer synthetic-second-secret"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), content);
    let after = fs::metadata(&path).unwrap();
    assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(before.ino(), after.ino());
    }
    request.auth_token = None;
    assert!(prepare(home.path(), &request, &mut Map::new()).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), content);
    assert!(!home.path().join("mcp.json").exists());
}

#[test]
fn same_name_replaces_transport_and_keeps_other_settings_including_inline_tables() {
    for original in [
        "model = 'my-model'\n[mcp_servers.keep]\ncommand = 'keep'\n[mcp_servers.replace]\nurl = 'https://old.example'\nhttp_headers = {Authorization = 'old'}\n",
        "model = 'my-model'\nmcp_servers = {keep = {command = 'keep'}, replace = {url = 'https://old.example', http_headers = {Authorization = 'old'}}}\n",
    ] {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.toml");
        fs::write(&path, original).unwrap();
        let mut request = ExecutionRequest {
            mcp_servers: vec![json!({"name":"replace", "command":"new", "defaultToolsApprovalMode":"prompt"})],
            ..Default::default()
        };
        prepare(home.path(), &request, &mut Map::new()).unwrap();
        let config: Value = toml_edit::de::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(config["model"], "my-model");
        assert_eq!(config["mcp_servers"]["keep"], json!({"command":"keep"}));
        assert_eq!(config["mcp_servers"]["replace"], json!({"command":"new", "default_tools_approval_mode":"prompt"}));
        request.mcp_servers = vec![json!({"name":"replace", "type":"http", "url":"https://new.example"})];
        prepare(home.path(), &request, &mut Map::new()).unwrap();
        let config: Value = toml_edit::de::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(config["mcp_servers"]["replace"], json!({"url":"https://new.example", "default_tools_approval_mode":"approve"}));
    }
}

#[test]
fn invalid_config_or_request_is_not_overwritten() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("config.toml");
    for content in ["[broken", "mcp_servers = 42", "[mcp_servers]\nbad = 42"] {
        fs::write(&path, content).unwrap();
        assert!(prepare(home.path(), &ExecutionRequest::default(), &mut Map::new()).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
    }
    fs::write(&path, "model = 'keep'").unwrap();
    let request = ExecutionRequest {
        mcp_servers: vec![json!({"name":"bad", "command":"node", "env":{"TOKEN":false}})],
        ..Default::default()
    };
    assert!(prepare(home.path(), &request, &mut Map::new()).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "model = 'keep'");
}

#[test]
fn managed_grants_are_not_persisted_and_agent_homes_do_not_share_servers() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let name = crate::task_runtime::mcp::SPACE_MCP_SERVER_NAME;
    let path = first.path().join("config.toml");
    fs::write(
        &path,
        format!("[mcp_servers.{name}]\nurl = 'https://stale.example'\n"),
    )
    .unwrap();
    let mut request = ExecutionRequest {
        mcp_servers: vec![json!({"name":"skill", "command":"keep"})],
        ..Default::default()
    };
    prepare(first.path(), &request, &mut Map::new()).unwrap();
    request.mcp_servers.clear();
    let mut runtime = Map::new();
    prepare(second.path(), &request, &mut runtime).unwrap();
    assert!(runtime.is_empty());
    let config: Value = toml_edit::de::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(config["mcp_servers"].get(name).is_none());
    assert!(config["mcp_servers"].get("skill").is_some());
}

#[cfg(unix)]
#[test]
fn symlinked_config_is_not_followed() {
    let home = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let path = external.path().join("config.toml");
    fs::write(&path, "model = 'keep'").unwrap();
    std::os::unix::fs::symlink(&path, home.path().join("config.toml")).unwrap();
    assert!(prepare(home.path(), &ExecutionRequest::default(), &mut Map::new()).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), "model = 'keep'");
}
