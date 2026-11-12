//! Group settings reuse the original board, automation and runner contracts.
use super::*;

pub(super) fn apply(
    connection: &Connection,
    group: &mut LoopItem,
    configuration: &Value,
) -> Result<(), TaskRuntimeError> {
    let configuration = configuration
        .as_object()
        .ok_or_else(|| invalid("Invalid group configuration"))?;
    let mut metadata = group.metadata.clone();
    for (key, value) in configuration {
        match key.as_str() {
            "board_views" => {
                crate::task_runtime::board_views::validate_update(&metadata[key], value)?
            }
            "tags" => {
                let tags: Vec<String> = serde_json::from_value(value.clone())
                    .map_err(|_| invalid("Invalid group tags"))?;
                crate::task_runtime::tagging::validate_tags(&tags)?;
            }
            "board_config"
            | "card_display"
            | "collaboration_groups"
            | "automatic_processing_rules"
            | "execution_environment" => {}
            _ => return Err(invalid("Invalid group configuration")),
        }
        metadata[key] = match key.as_str() {
            "board_config" => project_status::group_board_config(value)?,
            "execution_environment" => {
                if !value.is_object() {
                    return Err(invalid("Invalid execution environment"));
                }
                code_projects::merge_execution_environment(&metadata[key], value.clone())
            }
            _ => value.clone(),
        };
    }
    if configuration.contains_key("collaboration_groups") {
        validate_crews(connection, &group.id, &mut metadata["collaboration_groups"])?;
    }
    if configuration.contains_key("automatic_processing_rules")
        || configuration.contains_key("collaboration_groups")
    {
        let rules = metadata
            .get("automatic_processing_rules")
            .cloned()
            .unwrap_or(json!([]));
        validate_targets(connection, &group.id, &rules)?;
        local_automation::validate_rules(connection, &group.id, &metadata, &rules)?;
    }
    group.metadata = metadata;
    Ok(())
}

fn validate_crews(
    connection: &Connection,
    owner: &str,
    value: &mut Value,
) -> Result<(), TaskRuntimeError> {
    let groups = value
        .as_array_mut()
        .ok_or_else(|| invalid("Collaboration groups must be an array"))?;
    let mut ids = HashSet::new();
    for group in groups {
        let id = group["id"]
            .as_str()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| invalid("Collaboration group identity is missing"))?;
        if !ids.insert(id.to_owned()) {
            return Err(invalid("Duplicate collaboration group identity"));
        }
        if group
            .get("binding_owner_id")
            .is_some_and(|value| value.as_str() != Some(owner))
        {
            return Err(invalid(
                "Collaboration group binding belongs to another container",
            ));
        }
        let leader = group
            .get("leader")
            .ok_or_else(|| invalid("Collaboration group leader is missing"))?;
        let members = group["members"]
            .as_array()
            .ok_or_else(|| invalid("Collaboration group members must be an array"))?;
        for member in std::iter::once(leader).chain(members.iter()) {
            match member["kind"].as_str() {
                Some("agent") => {
                    collaboration_agent(
                        connection,
                        owner,
                        member["id"].as_str().unwrap_or_default(),
                    )?;
                }
                Some("human") if member["id"].as_str() == Some("0") => {}
                _ => {
                    return Err(invalid(
                        "Collaboration group member is not available in this Group",
                    ))
                }
            }
        }
        group["binding_owner_id"] = json!(owner);
    }
    Ok(())
}

fn validate_targets(
    connection: &Connection,
    owner: &str,
    rules: &Value,
) -> Result<(), TaskRuntimeError> {
    let rules = rules
        .as_array()
        .ok_or_else(|| invalid("Automation rules must be an array"))?;
    for rule in rules.iter().filter(|rule| rule["enabled"] != false) {
        match rule["targetKind"].as_str() {
            Some("agent") => {
                collaboration_agent(
                    connection,
                    owner,
                    rule["targetId"].as_str().unwrap_or_default(),
                )?;
            }
            Some("human") if rule["targetId"].as_str() != Some("0") => {
                return Err(invalid("Automation assignee is not a Group member"))
            }
            _ => {}
        }
    }
    Ok(())
}

fn invalid(message: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.into())
}
