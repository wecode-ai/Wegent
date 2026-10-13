//! Build group member requirements without requiring a connected desktop.
use super::*;

pub(super) fn group_agents(
    connection: &Connection,
    project_id: &str,
    group: &Value,
) -> Result<Vec<LoopItem>, TaskRuntimeError> {
    let mut agents = Vec::new();
    let mut seen = HashSet::new();
    for member in
        std::iter::once(&group["leader"]).chain(group["members"].as_array().into_iter().flatten())
    {
        if member["kind"] != "agent" {
            continue;
        }
        let id = member["id"]
            .as_str()
            .ok_or_else(|| TaskRuntimeError::Invalid("Group member identity is missing".into()))?;
        let agent = collaboration_agent(connection, project_id, id)?;
        if seen.insert(agent.id.clone()) {
            agents.push(agent);
        }
    }
    Ok(agents)
}

pub(super) fn add_group_profiles(
    connection: &Connection,
    project_id: &str,
    group: &Value,
    payload: &mut serde_json::Map<String, Value>,
) -> Result<(), TaskRuntimeError> {
    let agents = group_agents(connection, project_id, group)?;
    if !payload.contains_key("automation_run_id")
        && !agents
            .iter()
            .any(|agent| agent.metadata["execution_policy"].is_object())
    {
        return Ok(());
    }
    let mut profiles = payload
        .get("memberRuntimeProfiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for agent in agents {
        if profiles
            .iter()
            .any(|profile| profile["agentId"] == agent.id)
        {
            continue;
        }
        let config = &agent.metadata;
        if config["routing_configuration_required"] == true
            || !config["execution_policy"].is_object()
        {
            return Err(TaskRuntimeError::Invalid("RUNNER_CONFIGURATION_REQUIRED: configure each group member before automatic execution".into()));
        }
        let runtime = config["runtime"].as_str().unwrap_or("codex");
        let mut member_ids = vec![agent.id.clone()];
        if let Some(id) = config["wegent_team_id"].as_i64() {
            member_ids.push(id.to_string());
        }
        profiles.push(json!({
            "agentId":agent.id, "agentName":agent.title.as_ref().or(agent.name.as_ref()), "memberIds":member_ids,
            "runtimePayload":{
                "runnerPolicy":{"execution_policy":config["execution_policy"],"model_policy":config["model_policy"],"runtime":runtime},
                "runnerSelection":payload.get("runnerSelection"), "runtime":runtime,
                "projectInstructions":config["system_prompt"],"additionalSkills":config["additional_skills"],
                "projectPlugins":config["plugins"],
                "bot":[{"id":agent.id,"name":agent.name,"shell_type":if runtime=="claude_code" {"ClaudeCode"} else {"Codex"},"mcp_servers":config["mcp_servers"]}]
            }
        }));
    }
    payload.insert("memberRuntimeProfiles".into(), json!(profiles));
    Ok(())
}
