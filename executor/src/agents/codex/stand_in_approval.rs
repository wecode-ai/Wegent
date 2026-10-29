//! Enforce source-work MCP review while preserving the collaboration surface.
use super::{config_override_entry, toml_json_value, toml_key_path, toml_value, ExecutionRequest};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, fs, path::Path};

pub(super) fn read_home_mcp_config(home: &Path) -> Result<Value, String> {
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
        // Collaboration tools enforce access and dispatch roles on the server.
        // Do not replace their approval policy with external-source review.
        let mode = if name == crate::task_runtime::mcp::SPACE_MCP_SERVER_NAME {
            "approve"
        } else if super::external_work::applies(request)
            && !crate::runtime_work::stand_in_requires_confirmation(request)
        {
            "prompt"
        } else if name == crate::task_runtime::mcp::STAND_IN_MCP_SERVER_NAME
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
    if request
        .extra
        .get("origin")
        .is_some_and(|origin| origin["type"] == "stand_in_coordinator")
    {
        // Batch commands only persist scoped intents; dispatch revalidates every source.
        // Ordinary task operations and external tools retain native review above.
        for tool in [
            "read_intake",
            "read_work",
            "create_work",
            "continue_work",
            "ignore_events",
            "defer_events",
            "schedule_followup",
        ] {
            result.push(format!(
                "mcp_servers.wework_stand_in.tools.{tool}.approval_mode=\"approve\""
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
    fn coordinator_keeps_external_review_and_only_exempts_batch_commands() {
        let root = tempfile::tempdir().unwrap();
        let request: ExecutionRequest = serde_json::from_value(
            json!({"origin":{"type":"stand_in_coordinator","initiatedBy":"stand_in_coordinator"}}),
        )
        .unwrap();
        let result = stand_in_mcp_approval_overrides(
            &request,
            root.path(),
            &[
                "mcp_servers.business.command=\"business\"".into(),
                "mcp_servers.wework_stand_in.url=\"http://localhost\"".into(),
            ],
            &Map::new(),
        )
        .unwrap();
        assert!(
            result.contains(&"mcp_servers.business.default_tools_approval_mode=\"prompt\"".into())
        );
        assert!(result.contains(
            &"mcp_servers.wework_stand_in.default_tools_approval_mode=\"prompt\"".into()
        ));
        assert!(result.contains(
            &"mcp_servers.wework_stand_in.tools.create_work.approval_mode=\"approve\"".into()
        ));
        assert!(!result
            .iter()
            .any(|entry| entry.contains("tools.create_task")
                || entry.contains("tools.continue_task")));
        assert!(super::super::external_work::applies(&request));
    }

    #[test]
    fn collaboration_is_exempt_without_exempting_other_servers_or_tool_policies() {
        let root = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("config.toml"),
            r#"
[mcp_servers.wework_space.tools.get_board_item]
approval_mode = "prompt"
[mcp_servers.wework_space.tools.assign_board_item]
approval_mode = "writes"
[mcp_servers.business.tools.send]
approval_mode = "approve"
"#,
        )
        .unwrap();
        for kind in ["connection_work", "dingtalk_work", "issue_dispatch"] {
            for ask in [false, true] {
                let request = serde_json::from_value(json!({
                    "origin":{"type":kind,"initiatedBy":"stand_in","askBeforeAct":ask}
                }))
                .unwrap();
                let overrides = vec![
                    "mcp_servers.wework_space.tools.add_board_item_comment.approval_mode=\"prompt\"".into(),
                    "mcp_servers.wework_space_plugin.default_tools_approval_mode=\"approve\"".into(),
                ];
                let thread_config = Map::from_iter([(
                    "mcp_servers.wework_space.tools.submit_workflow_plan.approval_mode".into(),
                    json!("prompt"),
                )]);
                let result = stand_in_mcp_approval_overrides(
                    &request,
                    root.path(),
                    &overrides,
                    &thread_config,
                )
                .unwrap();
                for suffix in [
                    "default_tools_approval_mode",
                    "tools.get_board_item.approval_mode",
                    "tools.assign_board_item.approval_mode",
                    "tools.add_board_item_comment.approval_mode",
                    "tools.submit_workflow_plan.approval_mode",
                ] {
                    assert!(
                        result.contains(&format!("mcp_servers.wework_space.{suffix}=\"approve\""))
                    );
                }
                let mode = if ask { "writes" } else { "prompt" };
                for key in [
                    "business.default_tools_approval_mode",
                    "business.tools.send.approval_mode",
                    "wework_space_plugin.default_tools_approval_mode",
                ] {
                    assert!(result.contains(&format!("mcp_servers.{key}=\"{mode}\"")));
                }
            }
        }
    }

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
