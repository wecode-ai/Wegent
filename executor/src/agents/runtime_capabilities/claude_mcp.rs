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
use super::mcp_environment::context_variable;
use super::mcp_environment::{bind_context, visit_strings};

pub(super) fn prepare(
    home: &Path,
    request: &ExecutionRequest,
    global_mcps: &BTreeMap<String, Value>,
    mut spec: CommandSpec,
) -> Result<CommandSpec, String> {
    let path = home.join("mcp.json");
    if fs::symlink_metadata(&path).is_ok_and(|meta| !meta.is_file()) {
        return Err("Claude MCP config must be a regular file".to_owned());
    }
    let mut servers =
        merge_claude_mcp_servers(&path, extract_claude_mcp_templates(request, global_mcps))?;
    // Executor-managed endpoints and grants are authoritative for this execution.
    for name in [
        crate::task_runtime::mcp::SPACE_MCP_SERVER_NAME,
        crate::task_runtime::mcp::NOTIFICATIONS_MCP_SERVER_NAME,
    ] {
        servers.remove(name);
    }
    let mut environment = BTreeMap::new();
    bind_context(&mut servers, request, &mut environment)?;
    let mut managed = BTreeMap::new();
    super::inject_managed_wework_mcps(request, &mut managed)?;
    for (name, server) in &mut managed {
        for field in ["url", "headers"] {
            let Some(value) = server.get_mut(field) else {
                continue;
            };
            let mut index = 0;
            visit_strings(value, &mut |text| {
                use sha2::{Digest, Sha256};
                let variable = format!(
                    "WEGENT_MCP_MANAGED_{:x}",
                    Sha256::digest(format!("{name}:{field}:{index}").as_bytes())
                );
                index += 1;
                environment.insert(variable.clone(), text.clone());
                *text = format!("${{{variable}}}");
                Ok(())
            })?;
        }
    }
    servers.extend(managed);
    let config = json!({"mcpServers": servers});
    let previous = fs::read(&path)
        .ok()
        .and_then(|content| serde_json::from_slice::<Value>(&content).ok());
    if previous.as_ref() != Some(&config) {
        super::write_json_file(&path, &config)?;
    }
    for (key, value) in environment {
        spec = spec.env(key, value);
    }
    Ok(spec
        .arg("--mcp-config")
        .arg(path.display().to_string())
        .env("WEGENT_MCP_CONFIG_PATH", path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude")
        )
        .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), content);
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
        assert_eq!(config["mcpServers"].as_object().unwrap().len(), 2);
        assert_eq!(
            config["mcpServers"]["replace"],
            json!({"type": "stdio", "command": "new"})
        );
        fs::write(&path, "{broken").unwrap();
        assert!(prepare(
            home.path(),
            &request,
            &BTreeMap::new(),
            CommandSpec::new("claude")
        )
        .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "{broken");
    }

    #[test]
    fn stale_managed_grants_are_not_merged_into_a_new_execution() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("mcp.json");
        let config = json!({"mcpServers": {
            (crate::task_runtime::mcp::SPACE_MCP_SERVER_NAME): {"type": "http", "url": "https://stale.example", "headers": {"Authorization": "old-grant"}},
            (crate::task_runtime::mcp::NOTIFICATIONS_MCP_SERVER_NAME): {"type": "http", "url": "https://stale.example"},
            "skill-tool": {"command": "keep"}
        }});
        fs::write(&path, config.to_string()).unwrap();
        prepare(
            home.path(),
            &ExecutionRequest::default(),
            &BTreeMap::new(),
            CommandSpec::new("claude"),
        )
        .unwrap();
        let content = fs::read_to_string(path).unwrap();
        assert!(!content.contains("old-grant"));
        let config: Value = serde_json::from_str(&content).unwrap();
        assert_eq!(
            config["mcpServers"],
            json!({"skill-tool": {"command": "keep"}})
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
