// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, fs, path::Path};

use serde_json::{json, Value};

use crate::{
    agents::claude_options::{extract_claude_mcp_templates, merge_claude_mcp_servers},
    process::CommandSpec,
    protocol::ExecutionRequest,
};

#[cfg(test)]
use super::mcp_environment::bind_context;
#[cfg(test)]
use super::mcp_environment::context_variable;
use super::mcp_environment::{bind_available_context, retain_available_servers, visit_strings};

pub(super) fn prepare(
    home: &Path,
    request: &ExecutionRequest,
    global_mcps: &BTreeMap<String, Value>,
    mut spec: CommandSpec,
) -> Result<CommandSpec, String> {
    crate::task_runtime::mcp::has_bound_issue_context(request)?;
    let path = home.join("mcp.json");
    let incoming = extract_claude_mcp_templates(request, global_mcps);
    let saved = if fs::symlink_metadata(&path).is_ok_and(|meta| !meta.is_file()) {
        Err("Claude MCP config must be a regular file".to_owned())
    } else {
        merge_claude_mcp_servers(&path, incoming.clone())
    };
    let persistable = saved.is_ok();
    let mut servers = saved.unwrap_or_else(|_| {
        super::mcp_environment::log_server_unavailable(
            request,
            "claude_mcps",
            "configuration_file",
        );
        incoming
    });
    // Executor-managed endpoints and grants are authoritative for this execution.
    for name in [
        crate::task_runtime::mcp::SPACE_MCP_SERVER_NAME,
        crate::task_runtime::mcp::NOTIFICATIONS_MCP_SERVER_NAME,
        crate::task_runtime::mcp::STAND_IN_MCP_SERVER_NAME,
        crate::workbench_control::SERVER_NAME,
    ] {
        servers.remove(name);
    }
    let configured = servers.keys().cloned().collect::<Vec<_>>();
    let mut environment = BTreeMap::new();
    retain_available_servers(&mut servers, request, "configuration", |_, server| {
        crate::mcp_utils::validate_mcp_server_definition(server)?;
        Ok(true)
    });
    bind_available_context(&mut servers, request, &mut environment);
    let mut managed = BTreeMap::new();
    super::inject_managed_wework_mcps(request, &mut managed)?;
    for (name, server) in &mut managed {
        bind_transport_environment(name, server, &["url", "headers"], &mut environment)?;
    }
    servers.extend(managed);
    let config = json!({"mcpServers": servers});
    let persisted = persistable && {
        let previous = fs::read(&path)
            .ok()
            .and_then(|content| serde_json::from_slice::<Value>(&content).ok());
        previous.as_ref() == Some(&config) || super::write_json_file(&path, &config).is_ok()
    };
    if !persisted {
        super::mcp_environment::log_server_unavailable(
            request,
            "claude_mcps",
            "configuration_write",
        );
        // Native JSON input retains independent services when persistence fails.
        // Keep every transport value in the child environment, never in argv.
        retain_available_servers(
            &mut servers,
            request,
            "inline_configuration",
            |name, server| {
                *server = crate::agents::claude_options::normalize_mcp_server_for_claude(server);
                bind_transport_environment(
                    &format!("inline:{name}"),
                    server,
                    &["command", "args", "env", "url", "headers"],
                    &mut environment,
                )?;
                Ok(true)
            },
        );
        spec = spec
            .arg("--mcp-config")
            .arg(json!({"mcpServers": servers}).to_string());
    } else {
        spec = spec
            .arg("--mcp-config")
            .arg(path.display().to_string())
            .env("WEGENT_MCP_CONFIG_PATH", path.display().to_string());
    }
    for (key, value) in environment {
        spec = spec.env(key, value);
    }
    if request.extra.get("enable_tools").and_then(Value::as_bool) != Some(false)
        && configured.iter().any(|name| !servers.contains_key(name))
    {
        let hint = super::mcp_environment::UNAVAILABLE_HINT;
        if let Some(index) = spec
            .args()
            .windows(2)
            .position(|args| args[0] == "--append-system-prompt")
        {
            let prompt = format!("{}\n\n{hint}", spec.args()[index + 1]);
            spec.replace_arg(index + 1, prompt);
        } else {
            spec = spec.arg("--append-system-prompt").arg(hint);
        }
    }
    Ok(spec)
}

fn bind_transport_environment(
    name: &str,
    server: &mut Value,
    fields: &[&str],
    environment: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let mut bindings = BTreeMap::new();
    for field in fields {
        let Some(value) = server.get_mut(*field) else {
            continue;
        };
        super::mcp_environment::resolve_context(value, environment)?;
        let mut index = 0;
        visit_strings(value, &mut |text| {
            use sha2::{Digest, Sha256};
            let variable = format!(
                "WEGENT_MCP_MANAGED_{:x}",
                Sha256::digest(format!("{name}:{field}:{index}").as_bytes())
            );
            index += 1;
            bindings.insert(variable.clone(), text.clone());
            *text = format!("${{{variable}}}");
            Ok(())
        })?;
    }
    environment.extend(bindings);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_mcps_are_removed_when_unconfigured_and_can_be_enabled_again() {
        let home = tempfile::tempdir().unwrap();
        let connector = json!({"name": "connector", "type": "http",
            "url": "${{backend_api_url}}/mcp/connectors/sse",
            "headers": {"Authorization": "Bearer ${{task_token}}"}});
        let mut request = ExecutionRequest {
            auth_token: Some("synthetic-task-token".to_owned()),
            mcp_servers: vec![
                json!({"name": "custom-example", "type": "http", "url": "${{task_data.user_mcps.example.services.storage.credentials.url}}"}),
                json!({"name": "web", "type": "http", "url": "https://example.test/web"}),
                connector.clone(),
            ],
            ..Default::default()
        };
        let configured = json!({"user_mcps": {"example": {"services": {"storage": {
            "enabled": true, "credentials": {"url": "https://example.test/table?token=synthetic-secret"}
        }}}}});
        // A fresh request without credentials must still prepare the web service.
        let spec = prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude")
                .arg("--append-system-prompt")
                .arg("Existing task instructions"),
        )
        .unwrap();
        assert!(spec.args().windows(2).any(|args| {
            args[0] == "--append-system-prompt"
                && args[1].starts_with("Existing task instructions\n\n")
                && args[1].contains(super::super::mcp_environment::UNAVAILABLE_HINT)
        }));
        let path = home.path().join("mcp.json");
        let config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(config["mcpServers"].get("custom-example").is_none());
        assert!(config["mcpServers"].get("connector").is_none());
        assert!(config["mcpServers"].get("web").is_some());

        request.backend_url = Some("https://first.example/api/".to_owned());
        request
            .extra
            .insert("task_data".to_owned(), configured.clone());
        let spec = prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        let variable =
            context_variable("task_data.user_mcps.example.services.storage.credentials.url");
        assert_eq!(
            spec.envs()[&variable],
            "https://example.test/table?token=synthetic-secret"
        );
        let backend_variable = context_variable("backend_api_url");
        assert_eq!(spec.envs()[&backend_variable], "https://first.example/api");
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("synthetic-secret"));

        // Disabling the service must remove its persisted reference on later turns.
        request.extra.clear();
        request.backend_url = None;
        request.mcp_servers.clear();
        let spec = prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        let config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(config["mcpServers"].get("custom-example").is_none());
        assert!(config["mcpServers"].get("connector").is_none());
        assert!(config["mcpServers"].get("web").is_some());
        assert!(!spec.envs().contains_key(&variable));
        assert!(!spec.envs().contains_key(&backend_variable));
        assert!(!spec.envs().contains_key(&context_variable("task_token")));

        request.backend_url = Some("https://second.example/deployment/api/".to_owned());
        request.auth_token = Some("synthetic-next-token".to_owned());
        request.extra.insert("task_data".to_owned(), configured);
        request.mcp_servers = vec![
            json!({"name": "custom-example", "type": "http",
                "url": "${{task_data.user_mcps.example.services.storage.credentials.url}}"}),
            connector,
        ];
        let spec = prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        assert!(spec.envs().contains_key(&variable));
        assert_eq!(
            spec.envs()[&backend_variable],
            "https://second.example/deployment/api"
        );
        assert_eq!(
            spec.envs()[&context_variable("task_token")],
            "synthetic-next-token"
        );
        let config: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert!(config["mcpServers"].get("custom-example").is_some());
        assert!(config["mcpServers"].get("connector").is_some());
    }

    #[test]
    fn stable_file_retains_services_and_rebinds_omitted_task_context() {
        let home = tempfile::tempdir().unwrap();
        let mut request = ExecutionRequest {
            task_id: "first-task".to_owned(),
            auth_token: Some("synthetic-first-secret".to_owned()),
            mcp_servers: vec![json!({
                "name": "skill-tool", "type": "http", "url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer ${{auth_token}}", "X-Task": "${{ task_id }}"}
            })],
            ..Default::default()
        };
        let first = prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        let path = home.path().join("mcp.json");
        let content = fs::read_to_string(&path).unwrap();
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(!content.contains("synthetic-first-secret"));
        assert!(!content.contains("first-task"));
        assert_eq!(
            first.envs()[&context_variable("auth_token")],
            "synthetic-first-secret"
        );
        request.auth_token = Some("synthetic-second-secret".to_owned());
        request.task_id = "second-task".to_owned();
        request.mcp_servers.clear();
        let second = prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        assert_eq!(first.args(), second.args());
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        assert_eq!(
            second.envs()[&context_variable("auth_token")],
            "synthetic-second-secret"
        );
        assert_eq!(second.envs()[&context_variable("task_id")], "second-task");
        assert!(!second.args().join(" ").contains("synthetic-second-secret"));

        request.auth_token = None;
        let spec = prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        assert!(!spec.envs().contains_key(&context_variable("auth_token")));
        assert!(!spec.envs().contains_key(&context_variable("task_id")));
        let config: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert!(config["mcpServers"].get("skill-tool").is_none());
    }

    #[test]
    fn same_name_replaces_config_and_invalid_json_is_preserved() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("mcp.json");
        fs::write(&path, json!({"mcpServers": {
            "keep": {"command": "keep"},
            "replace": {"type": "http", "url": "https://old.example", "headers": {"Authorization": "old"}}
        }}).to_string()).unwrap();
        let request = ExecutionRequest {
            mcp_servers: vec![json!({"name": "replace", "type": "stdio", "command": "new"})],
            ..Default::default()
        };
        prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        let config: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(config["mcpServers"].as_object().unwrap().len(), 3);
        assert_eq!(config["mcpServers"]["keep"], json!({"command": "keep"}));
        assert_eq!(config["mcpServers"]["wework_space"]["type"], "http");
        assert_eq!(
            config["mcpServers"]["replace"],
            json!({"type": "stdio", "command": "new"})
        );
        fs::write(&path, "{broken").unwrap();
        let spec = prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        assert_inline_replacement(&spec);
        assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
        #[cfg(unix)]
        {
            let external = home.path().join("external-mcp.json");
            fs::write(&external, "protected configuration").unwrap();
            fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(&external, &path).unwrap();
            let spec = prepare(
                home.path(),
                &request,
                &BTreeMap::new(),
                CommandSpec::new("claude"),
            )
            .unwrap();
            assert_inline_replacement(&spec);
            assert_eq!(
                fs::read_to_string(external).unwrap(),
                "protected configuration"
            );
        }
    }

    fn assert_inline_replacement(spec: &CommandSpec) {
        let input = spec
            .args()
            .windows(2)
            .find(|args| args[0] == "--mcp-config")
            .unwrap();
        let mut config: Value = serde_json::from_str(&input[1]).unwrap();
        assert!(!spec.envs().contains_key("WEGENT_MCP_CONFIG_PATH"));
        super::super::mcp_environment::resolve_context(&mut config, spec.envs()).unwrap();
        assert_eq!(config["mcpServers"]["replace"]["command"], "new");
        assert!(config["mcpServers"].get("keep").is_none());
        assert!(input[1].contains("${WEGENT_MCP_MANAGED_"));
    }

    #[test]
    fn inline_configuration_keeps_credentials_out_of_arguments() {
        let home = tempfile::tempdir().unwrap();
        fs::write(home.path().join("mcp.json"), "{broken").unwrap();
        let request = ExecutionRequest {
            mcp_servers: vec![json!({"name":"healthy", "type":"http",
                "url":"https://example.test/mcp?token=synthetic-private",
                "headers":{"Authorization":"Bearer synthetic-private"}})],
            ..Default::default()
        };
        let spec = prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        assert!(!spec.args().join(" ").contains("synthetic-private"));
        let input = spec
            .args()
            .windows(2)
            .find(|args| args[0] == "--mcp-config")
            .unwrap();
        let mut config: Value = serde_json::from_str(&input[1]).unwrap();
        super::super::mcp_environment::resolve_context(&mut config, spec.envs()).unwrap();
        assert_eq!(
            config["mcpServers"]["healthy"]["headers"]["Authorization"],
            "Bearer synthetic-private"
        );
        assert_eq!(
            config["mcpServers"]["healthy"]["url"],
            "https://example.test/mcp?token=synthetic-private"
        );
        assert_eq!(
            fs::read_to_string(home.path().join("mcp.json")).unwrap(),
            "{broken"
        );
    }

    #[test]
    fn stale_managed_grants_are_not_merged_into_a_new_execution() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("mcp.json");
        let config = json!({"mcpServers": {
            (crate::task_runtime::mcp::SPACE_MCP_SERVER_NAME): {"type": "http", "url": "https://stale.example", "headers": {"Authorization": "old-grant"}},
            (crate::task_runtime::mcp::NOTIFICATIONS_MCP_SERVER_NAME): {"type": "http", "url": "https://stale.example"},
            (crate::workbench_control::SERVER_NAME): {"type": "http", "url": "https://stale.example", "headers": {"Authorization": "old-control-grant"}},
            "skill-tool": {"command": "keep"}
        }});
        fs::write(&path, config.to_string()).unwrap();
        let spec = prepare(
            home.path(),
            &ExecutionRequest::default(),
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        let content = fs::read_to_string(path).unwrap();
        assert!(!content.contains("old-grant"));
        assert!(!content.contains("stale.example"));
        let mut config: Value = serde_json::from_str(&content).unwrap();
        super::super::mcp_environment::resolve_context(&mut config, spec.envs()).unwrap();
        let endpoint = crate::task_runtime::mcp_http::space_mcp_http_endpoint().unwrap();
        let server = &config["mcpServers"]["wework_space"];
        assert_eq!(server["type"], "http");
        assert_eq!(server["url"], endpoint.url);
        assert_eq!(
            server["headers"]["Authorization"],
            format!("Bearer {}", endpoint.token)
        );
        assert!(!server["headers"]["X-Wework-Mcp-Context"]
            .as_str()
            .unwrap()
            .is_empty());
        assert_eq!(config["mcpServers"].as_object().unwrap().len(), 2);
        assert_eq!(
            config["mcpServers"]["skill-tool"],
            json!({"command": "keep"})
        );
    }

    #[test]
    fn literal_current_token_is_not_written_and_context_paths_do_not_collide() {
        let request = ExecutionRequest {
            auth_token: Some("synthetic-secret".to_owned()),
            ..Default::default()
        };
        let mut servers = BTreeMap::from([(
            "tool".to_owned(),
            json!({"headers": {"Authorization": "Bearer synthetic-secret"}}),
        )]);
        let mut environment = BTreeMap::new();
        bind_context(&mut servers, &request, &mut environment).unwrap();
        assert!(!serde_json::to_string(&servers)
            .unwrap()
            .contains("synthetic-secret"));
        assert_eq!(
            environment[&context_variable("auth_token")],
            "synthetic-secret"
        );
        assert_ne!(context_variable("user.id"), context_variable("user_id"));
        servers.insert(
            "invalid".to_owned(),
            json!({"command": "${WEGENT_MCP_CONTEXT_1}"}),
        );
        assert!(bind_context(&mut servers, &request, &mut environment).is_err());
    }
}
