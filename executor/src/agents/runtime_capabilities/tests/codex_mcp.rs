// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn unconfigured_mcps_are_removed_from_runtime_and_persisted_config() {
    let home = tempfile::tempdir().unwrap();
    let connector = json!({"name": "connector", "type": "http",
        "url": "${{backend_api_url}}/mcp/connectors/sse",
        "headers": {"Authorization": "Bearer ${{task_token}}"}});
    let mut request = ExecutionRequest {
        auth_token: Some("synthetic-task-token".to_owned()),
        mcp_servers: vec![
            json!({"name": "custom-example", "type": "http", "url": "${{task_data.user_mcps.example.services.docs.credentials.url}}"}),
            json!({"name": "web", "type": "http", "url": "https://example.test/web"}),
            connector.clone(),
        ],
        ..Default::default()
    };
    let mut runtime = Map::new();
    assert!(prepare(home.path(), &request, &mut runtime).unwrap());
    assert!(runtime.contains_key("mcp_servers.web"));
    assert!(!runtime.contains_key("mcp_servers.custom-example"));
    assert!(!runtime.contains_key("mcp_servers.connector"));

    request.backend_url = Some("https://first.example/api/".to_owned());
    request.extra.insert("task_data".to_owned(), json!({
        "user_mcps": {"example": {"services": {"docs": {
            "enabled": true, "credentials": {"url": "https://example.test/docs?token=synthetic-secret"}
        }}}}
    }));
    let mut runtime = Map::new();
    prepare(home.path(), &request, &mut runtime).unwrap();
    assert_eq!(
        runtime["mcp_servers.custom-example"]["url"],
        "https://example.test/docs?token=synthetic-secret"
    );
    assert_eq!(
        runtime["mcp_servers.connector"]["url"],
        "https://first.example/api/mcp/connectors/sse"
    );
    let path = home.path().join("config.toml");
    assert!(!fs::read_to_string(&path)
        .unwrap()
        .contains("synthetic-secret"));

    request.extra.clear();
    request.backend_url = None;
    request.mcp_servers.clear();
    let mut runtime = Map::new();
    assert!(prepare(home.path(), &request, &mut runtime).unwrap());
    assert!(!runtime.contains_key("mcp_servers.custom-example"));
    assert!(!runtime.contains_key("mcp_servers.connector"));
    assert!(runtime.contains_key("mcp_servers.web"));
    let persisted: Value = toml_edit::de::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(persisted["mcp_servers"].get("custom-example").is_none());
    assert!(persisted["mcp_servers"].get("connector").is_none());

    request.backend_url = Some("https://second.example/deployment/api/".to_owned());
    request.auth_token = Some("synthetic-next-token".to_owned());
    request.mcp_servers = vec![connector];
    let mut runtime = Map::new();
    prepare(home.path(), &request, &mut runtime).unwrap();
    assert_eq!(
        runtime["mcp_servers.connector"]["url"],
        "https://second.example/deployment/api/mcp/connectors/sse"
    );
    assert_eq!(
        runtime["mcp_servers.connector"]["http_headers"]["Authorization"],
        "Bearer synthetic-next-token"
    );
    assert!(runtime.contains_key("mcp_servers.web"));
    let persisted = fs::read_to_string(path).unwrap();
    assert!(!persisted.contains("second.example"));
    assert!(!persisted.contains("synthetic-next-token"));
}

#[test]
fn remote_mcp_with_empty_command_connects_by_url() {
    for command in [json!(""), json!(" \t"), Value::Null] {
        for server_type in [
            None,
            Some("http"),
            Some("streamable-http"),
            Some("streamable_http"),
            Some("sse"),
        ] {
            let home = tempfile::tempdir().unwrap();
            let mut server = json!({
                "name": "remote", "command": command, "args": [], "env": {},
                "url": "https://example.test/mcp", "headers": {"X-Test": "remote"}
            });
            if let Some(server_type) = server_type {
                server["type"] = json!(server_type);
            }
            let request = ExecutionRequest {
                mcp_servers: vec![server],
                ..Default::default()
            };
            let mut runtime = Map::new();
            prepare(home.path(), &request, &mut runtime).unwrap();
            let expected = json!({
                "url": "https://example.test/mcp", "http_headers": {"X-Test": "remote"},
                "default_tools_approval_mode": "approve"
            });
            let mut runtime_expected = expected.clone();
            runtime_expected["required"] = json!(false);
            assert_eq!(runtime["mcp_servers.remote"], runtime_expected);
            assert!(!runtime.contains_key("mcp_servers.remote.env"));
            let content = fs::read_to_string(home.path().join("config.toml")).unwrap();
            let persisted: Value = toml_edit::de::from_str(&content).unwrap();
            assert_eq!(persisted["mcp_servers"]["remote"], expected);
        }
    }
}

#[test]
fn explicit_transport_is_authoritative_and_invalid_stdio_is_rejected() {
    assert_eq!(
        native_definition(
            json!({"type": "http", "command": "node", "url": "https://example.test/mcp"})
        )
        .unwrap(),
        json!({"url": "https://example.test/mcp", "default_tools_approval_mode": "approve"})
    );
    for command in [json!(""), json!(" \t"), Value::Null] {
        assert_eq!(
            native_definition(
                json!({"type": "stdio", "command": command, "url": "https://example.test/mcp"})
            )
            .unwrap_err(),
            "MCP definition requires command"
        );
        assert_eq!(
            native_definition(json!({"command": command})).unwrap_err(),
            "MCP definition requires url"
        );
    }
}

#[test]
fn native_transports_normalize_consumed_values_before_context_binding() {
    let home = tempfile::tempdir().unwrap();
    let request = ExecutionRequest {
        mcp_servers: vec![
            json!({"name":"http", "type":"http", "command":"unused",
                "args":["${{backend_api_url}}"], "url":" https://example.test/mcp "}),
            json!({"name":"stdio", "type":"stdio", "command":" node ",
                "args":["run.js", 42, true, null, [], {"unused":"${{backend_url}}"}],
                "url":"${{backend_api_url}}/unused"}),
        ],
        ..Default::default()
    };
    let mut runtime = Map::new();
    prepare(home.path(), &request, &mut runtime).unwrap();
    assert_eq!(
        runtime["mcp_servers.http"]["url"],
        "https://example.test/mcp"
    );
    assert_eq!(runtime["mcp_servers.stdio"]["command"], "node");
    assert_eq!(
        runtime["mcp_servers.stdio"]["args"],
        json!(["run.js", "42", "true"])
    );
    let mut resumed = Map::new();
    prepare(home.path(), &ExecutionRequest::default(), &mut resumed).unwrap();
    assert_eq!(resumed, runtime);
}

#[test]
fn templated_mcp_metadata_resolves_before_merging_and_binding() {
    let home = tempfile::tempdir().unwrap();
    let request = ExecutionRequest {
        auth_token: Some("synthetic-token".into()),
        mcp_servers: vec![json!({
            "name": "docs-${{task_data.region}}",
            "type": "${{task_data.transport}}",
            "command": "",
            "args": ["${{backend_url}}"],
            "url": "https://example.test/mcp",
            "headers": {"Authorization": "Bearer ${{task_token}}"},
            "defaultToolsApprovalMode": "prompt"
        })],
        extra: Map::from_iter([(
            "task_data".into(),
            json!({"region":"eu", "transport":"http"}),
        )]),
        ..Default::default()
    };
    let mut runtime = Map::new();
    prepare(home.path(), &request, &mut runtime).unwrap();
    assert_eq!(
        runtime["mcp_servers.docs-eu"]["url"],
        "https://example.test/mcp"
    );
    assert_eq!(
        runtime["mcp_servers.docs-eu"]["http_headers"]["Authorization"],
        "Bearer synthetic-token"
    );
    assert_eq!(
        runtime["mcp_servers.docs-eu"]["default_tools_approval_mode"],
        "prompt"
    );
    assert!(runtime["mcp_servers.docs-eu"].get("command").is_none());
    let saved = fs::read_to_string(home.path().join("config.toml")).unwrap();
    assert!(!saved.contains("synthetic-token"));
    let mut resumed = Map::new();
    prepare(home.path(), &request, &mut resumed).unwrap();
    assert_eq!(runtime, resumed);
}

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
    let mut runtime = Map::new();
    prepare(home.path(), &request, &mut runtime).unwrap();
    assert!(runtime.is_empty());
    let persisted: Value = toml_edit::de::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(persisted["model"], "my-model");
    assert!(persisted["mcp_servers"].get("skill-shell").is_none());
    assert!(persisted["mcp_servers"].get("skill-http").is_none());
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
        request.mcp_servers = vec![json!({"name":"replace", "url":"${{backend_api_url}}/mcp/connectors/sse"})];
        let mut runtime = Map::new();
        prepare(home.path(), &request, &mut runtime).unwrap();
        assert!(!runtime.contains_key("mcp_servers.replace"));
        assert!(runtime.contains_key("mcp_servers.keep"));
        let config: Value = toml_edit::de::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert!(config["mcp_servers"].get("replace").is_none());
        assert_eq!(config["mcp_servers"]["keep"], json!({"command":"keep"}));
    }
}

#[test]
fn invalid_config_or_request_is_not_overwritten() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("config.toml");
    let content = "[broken";
    fs::write(&path, content).unwrap();
    assert!(prepare(home.path(), &ExecutionRequest::default(), &mut Map::new()).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), content);
    fs::write(&path, "model = 'keep'\nmcp_servers = 42").unwrap();
    let mut runtime = Map::new();
    let request = ExecutionRequest {
        mcp_servers: vec![json!({"name":"healthy", "command":"node"})],
        ..Default::default()
    };
    prepare(home.path(), &request, &mut runtime).unwrap();
    assert_eq!(runtime["mcp_servers.healthy"]["command"], "node");
    assert_eq!(runtime["mcp_servers.healthy"]["required"], false);
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "model = 'keep'\nmcp_servers = 42"
    );
    fs::write(
        &path,
        "model = 'keep'\n[mcp_servers]\nbad = 42\nkeep = {command='keep', env_vars=['PATH', {name='CONFIG', source='local'}]}",
    )
    .unwrap();
    let mut runtime = Map::new();
    prepare(home.path(), &ExecutionRequest::default(), &mut runtime).unwrap();
    assert!(!runtime.contains_key("mcp_servers.bad"));
    assert_eq!(runtime["mcp_servers.keep"]["command"], "keep");
    assert_eq!(
        runtime["mcp_servers.keep"]["env_vars"],
        json!(["PATH", {"name":"CONFIG", "source":"local"}])
    );
    fs::write(&path, "model = 'keep'").unwrap();
    let request = ExecutionRequest {
        mcp_servers: vec![json!({"name":"bad", "command":"node", "env":{"TOKEN":false}})],
        ..Default::default()
    };
    let mut runtime = Map::new();
    prepare(home.path(), &request, &mut runtime).unwrap();
    assert!(!runtime.contains_key("mcp_servers.bad"));
    assert_eq!(fs::read_to_string(&path).unwrap(), "model = 'keep'");
}

#[test]
fn invalid_mcp_approval_modes_preserve_healthy_native_services() {
    for field in ["default_tools_approval_mode", "defaultToolsApprovalMode"] {
        for mode in ["auto", "prompt", "writes", "approve"] {
            let home = tempfile::tempdir().unwrap();
            let path = home.path().join("config.toml");
            fs::write(
                &path,
                toml_edit::ser::to_document(&json!({
                    "model": "keep",
                    "mcp_servers": {
                        "saved-bad": {"command":"node", "default_tools_approval_mode":"invalid"},
                        "bad-tool-mode": {"command":"node", "tools":{"read":{"approval_mode":"invalid"}}},
                        "bad-tool-budget": {"command":"node", "tools":{"read":{"output_token_limit":0}}},
                        "healthy-tools": {"command":"node", "tools":{"read":{"approval_mode":mode, "output_token_limit":100}}}
                    }
                }))
                .unwrap()
                .to_string(),
            )
            .unwrap();
            let request = ExecutionRequest {
                mcp_servers: vec![
                    json!({"name":"bad", "command":"node", (field):"invalid"}),
                    json!({"name":"healthy", "command":"node", (field):mode}),
                ],
                ..Default::default()
            };
            let mut runtime = Map::new();
            assert!(prepare(home.path(), &request, &mut runtime).unwrap());
            assert!(!runtime.contains_key("mcp_servers.bad"));
            assert!(!runtime.contains_key("mcp_servers.saved-bad"));
            assert!(!runtime.contains_key("mcp_servers.bad-tool-mode"));
            assert!(!runtime.contains_key("mcp_servers.bad-tool-budget"));
            assert_eq!(runtime["mcp_servers.healthy"]["command"], "node");
            assert_eq!(runtime["mcp_servers.healthy"]["required"], false);
            assert_eq!(
                runtime["mcp_servers.healthy"]["default_tools_approval_mode"],
                mode
            );
            assert_eq!(
                runtime["mcp_servers.healthy-tools"]["tools"]["read"],
                json!({"approval_mode":mode, "output_token_limit":100})
            );
            let persisted: Value =
                toml_edit::de::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(persisted["model"], "keep");
            assert!(persisted["mcp_servers"].get("bad").is_none());
            assert!(persisted["mcp_servers"].get("saved-bad").is_none());
            assert!(persisted["mcp_servers"].get("bad-tool-mode").is_none());
            assert!(persisted["mcp_servers"].get("bad-tool-budget").is_none());
            assert_eq!(
                persisted["mcp_servers"]["healthy"]["default_tools_approval_mode"],
                mode
            );
        }
    }
}

#[test]
fn invalid_native_fields_isolate_incoming_and_saved_services() {
    for (field, value, stdio) in [
        ("cwd", json!(42), true),
        ("name", json!(42), true),
        ("environment_id", json!(42), true),
        ("startup_timeout_ms", json!(-1), true),
        ("startup_timeout_ms", json!(1.5), true),
        ("startup_readiness", json!("invalid"), true),
        ("tool_input_schema_max_bytes", json!(0), true),
        ("omit_tools_from", json!(["invalid"]), true),
        (
            "env_vars",
            json!([{ "name": "PATH", "source": "invalid" }]),
            true,
        ),
        (
            "env_vars",
            json!([{ "name": "PATH", "unexpected": true }]),
            true,
        ),
        ("tools", json!({"read": {"output_token_limit": -1}}), true),
        ("auth", json!("invalid"), false),
        ("http_headers_helper", json!(42), false),
        ("http_headers_helper", json!(" "), false),
        ("bearer_token", json!("unsupported"), false),
        ("oauth", json!(42), false),
        ("oauth", json!({"callback_port": 65536}), false),
        ("oauth", json!({"callback_url": 42}), false),
        ("oauth", json!({"client_id": 42}), false),
        (
            "oauth",
            json!({"token_endpoint_auth_method": "invalid"}),
            false,
        ),
        (
            "oauth",
            json!({"authorization_server_issuer": "https://issuer.example"}),
            false,
        ),
    ] {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("config.toml");
        let mut bad = if stdio {
            json!({"command": "node"})
        } else {
            json!({"url": "https://example.test/mcp"})
        };
        bad[field] = value;
        fs::write(
            &path,
            toml_edit::ser::to_document(
                &json!({"model": "keep", "mcp_servers": {"saved-bad": bad}}),
            )
            .unwrap()
            .to_string(),
        )
        .unwrap();
        let mut incoming = bad;
        incoming["name"] = json!("incoming-bad");
        let request = ExecutionRequest {
            mcp_servers: vec![incoming, json!({"name": "healthy", "command": "node"})],
            ..Default::default()
        };
        let mut runtime = Map::new();
        assert!(
            prepare(home.path(), &request, &mut runtime).unwrap(),
            "{field}"
        );
        assert!(!runtime.contains_key("mcp_servers.saved-bad"), "{field}");
        if field != "name" {
            assert!(!runtime.contains_key("mcp_servers.incoming-bad"), "{field}");
        }
        assert_eq!(runtime["mcp_servers.healthy"]["command"], "node");
        let saved: Value = toml_edit::de::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved["model"], "keep");
        assert!(saved["mcp_servers"].get("saved-bad").is_none(), "{field}");
    }
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
