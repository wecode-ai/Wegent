//! Enforce stand-in write confirmation for home, CLI and thread MCP configurations.
use super::{config_override_entry, toml_json_value, toml_key_path, toml_value, ExecutionRequest};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, fs, path::Path};

fn read_home_mcp_config(home: &Path) -> Result<Value, String> {
    let path = home.join("config.toml");
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(error) => {
            return Err(format!(
                "Cannot read Codex MCP configuration {}: {error}",
                path.display()
            ))
        }
    };
    toml_edit::de::from_str(&content)
        .map_err(|_| format!("Cannot parse Codex MCP configuration {}", path.display()))
}

pub(super) fn stand_in_mcp_approval_overrides(
    request: &ExecutionRequest,
    codex_home: &Path,
    overrides: &[String],
    thread_config: &Map<String, Value>,
) -> Result<Vec<String>, String> {
    let mut servers = BTreeMap::<String, std::collections::BTreeSet<String>>::new();
    let home_config = read_home_mcp_config(codex_home)?;
    let entries = overrides.iter().cloned().chain(
        thread_config
            .iter()
            .map(|(key, value)| format!("{key}={}", toml_json_value(value))),
    );
    let launch_values = entries
        .map(|entry| {
            let (key, value) = config_override_entry(&entry)
                .ok_or_else(|| "Invalid Codex MCP configuration override".to_owned())?;
            toml_edit::de::from_str::<Value>(&format!("{key}={}", toml_json_value(&value)))
                .map_err(|_| "Invalid Codex MCP configuration override key".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let values = std::iter::once(home_config).chain(launch_values);
    for value in values {
        for (name, config) in value["mcp_servers"].as_object().into_iter().flatten() {
            let tools = servers.entry(name.clone()).or_default();
            tools.extend(
                config["tools"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(name, _)| name.clone()),
            );
        }
    }
    let mut result = Vec::new();
    for (name, tools) in servers {
        let mode = if name == crate::task_runtime::mcp::STAND_IN_MCP_SERVER_NAME
            && request
                .extra
                .get("origin")
                .is_some_and(|origin| origin["type"] == "stand_in_identity")
        {
            "approve"
        } else {
            "writes"
        };
        result.push(format!(
            "{}={}",
            toml_key_path(&["mcp_servers", &name, "default_tools_approval_mode"]),
            toml_value(mode)
        ));
        for tool in tools {
            result.push(format!(
                "{}={}",
                toml_key_path(&["mcp_servers", &name, "tools", &tool, "approval_mode"]),
                toml_value(mode)
            ));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn raw_string_cli_approvals_and_quoted_dotted_keys_are_enforced() {
        let root = tempfile::tempdir().unwrap();
        let overrides = vec![
            "mcp_servers.\"remote.service\".tools.\"send.message\".approval_mode=approve".into(),
        ];
        let result = stand_in_mcp_approval_overrides(
            &ExecutionRequest::default(),
            root.path(),
            &overrides,
            &Map::new(),
        )
        .unwrap();
        assert!(result.contains(
            &"mcp_servers.\"remote.service\".tools.\"send.message\".approval_mode=\"writes\""
                .into()
        ));
    }

    #[test]
    fn malformed_cli_overrides_fail_closed_without_echoing_values() {
        let root = tempfile::tempdir().unwrap();
        for entry in [
            "synthetic-secret",
            "=synthetic-secret",
            "mcp_servers..tools=synthetic-secret",
        ] {
            let error = stand_in_mcp_approval_overrides(
                &ExecutionRequest::default(),
                root.path(),
                &[entry.into()],
                &Map::new(),
            )
            .unwrap_err();
            assert!(!error.contains("synthetic-secret"));
        }
    }

    #[test]
    fn home_and_launch_tool_policies_are_all_overridden() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("config.toml"),
            r#"
[mcp_servers."home.service"]
command = "node"
default_tools_approval_mode = "approve"
[mcp_servers."home.service".tools."send.message"]
approval_mode = "approve"
"#,
        )
        .unwrap();
        let request = serde_json::from_value(
            json!({"origin":{"initiatedBy":"stand_in","askBeforeAct":true}}),
        )
        .unwrap();
        let overrides =
            vec!["mcp_servers.\"home.service\".tools.other.approval_mode=\"approve\"".into()];
        let result =
            stand_in_mcp_approval_overrides(&request, root.path(), &overrides, &Map::new())
                .unwrap();
        assert!(result.contains(
            &"mcp_servers.\"home.service\".default_tools_approval_mode=\"writes\"".into()
        ));
        assert!(result.contains(
            &"mcp_servers.\"home.service\".tools.\"send.message\".approval_mode=\"writes\"".into()
        ));
        assert!(result
            .contains(&"mcp_servers.\"home.service\".tools.other.approval_mode=\"writes\"".into()));
    }

    #[test]
    fn unreadable_or_invalid_home_configuration_fails_closed_without_echoing_content() {
        let root = tempfile::tempdir().unwrap();
        let request = ExecutionRequest::default();
        fs::write(
            root.path().join("config.toml"),
            "private_value = 'synthetic-secret'\ninvalid = [",
        )
        .unwrap();
        let error =
            stand_in_mcp_approval_overrides(&request, root.path(), &[], &Map::new()).unwrap_err();
        assert!(error.contains("Cannot parse Codex MCP configuration"));
        assert!(!error.contains("synthetic-secret"));
        fs::remove_file(root.path().join("config.toml")).unwrap();
        fs::create_dir(root.path().join("config.toml")).unwrap();
        assert!(stand_in_mcp_approval_overrides(&request, root.path(), &[], &Map::new()).is_err());
    }
}
