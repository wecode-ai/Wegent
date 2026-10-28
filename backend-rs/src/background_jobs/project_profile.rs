// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Canonical non-secret RuntimeTaskCreateRequest V2 materialization.

use super::{
    authority,
    queue::Admission,
    store::{self, Node},
};
use crate::state::AppState;
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json};
use serde_json::{Value, json};

pub(crate) fn inherited(context: &Value) -> Option<Value> {
    let stage = &context["workflow_stage_input"];
    if stage["target_stage"]["workspace_policy"] != "inherit" {
        return None;
    }
    for dependency in stage["dependencies"].as_array()?.iter().rev() {
        if let Some(tasks) = dependency["runtime_tasks"].as_array() {
            for task in tasks.iter().rev() {
                let (device, task) = (
                    task["device_id"].as_str().unwrap_or(""),
                    task["task_id"].as_str().unwrap_or(""),
                );
                if !device.is_empty() && !task.is_empty() {
                    return Some(json!({"deviceId":device,"taskId":task}));
                }
            }
        }
    }
    None
}

pub(crate) async fn environment(state: &AppState, owner: i64, device: &str) -> Result<String> {
    let device = crate::device_identity::resolve_owned_device_alias(&state.mysql, owner, device)
        .await?
        .context("Execution device not found")?;
    Ok(match device.json["spec"]["deviceType"]
        .as_str()
        .unwrap_or("local")
    {
        "local" | "app" => "local",
        "cloud" | "remote" => "cloud",
        other => bail!("Unsupported execution device type '{other}'"),
    }
    .into())
}

#[derive(FromMysqlRow)]
struct Mapping {
    id: i64,
    json: Json<Value>,
}

async fn workspace_binding(
    state: &AppState,
    agent: Option<&Node>,
    owner: i64,
    device: &str,
    environment: &str,
    override_binding: &Value,
    local_project_id: i64,
) -> Result<Value> {
    let raw = if override_binding.is_object() {
        override_binding.clone()
    } else {
        agent
            .map(|agent| agent.metadata.0["workspace_binding"].clone())
            .unwrap_or(Value::Null)
    };
    let binding_type = raw["type"].as_str().unwrap_or(if local_project_id > 0 {
        "backend_project"
    } else {
        "standalone"
    });
    if binding_type == "standalone" {
        return Ok(json!({"type":"standalone","status":"ready"}));
    }
    if !raw["deviceId"].as_str().unwrap_or("").is_empty() && raw["deviceId"] != device {
        bail!("Workspace binding does not belong to the execution device")
    }
    if binding_type == "device_project" {
        let key = raw["runtimeProjectKey"]
            .as_str()
            .filter(|v| !v.is_empty())
            .context("Robot workspace binding is ambiguous; select an exact workspace")?;
        return Ok(
            json!({"type":"device_project","status":"ready","deviceId":device,"runtimeProjectKey":key}),
        );
    }
    if binding_type != "backend_project" {
        bail!("Robot workspace binding is ambiguous; select an exact workspace")
    }
    let project_id = authority::integer(&raw["projectId"]).unwrap_or(local_project_id);
    let project: Option<(i64,)> = state
        .mysql
        .fetch_optional(
            "SELECT id FROM projects WHERE id=? AND user_id=? AND client_origin='wework' AND is_active=true",
            (project_id, owner),
        )
        .await?;
    if project.is_none() {
        bail!("Robot workspace project is unavailable")
    }
    let mut mapping_id = authority::integer(&raw["deviceWorkspaceId"]);
    if mapping_id.is_none() && environment == "cloud" && !raw.is_object() {
        let mappings:Vec<Mapping>=state.mysql.fetch_all("SELECT id,json FROM kinds WHERE user_id=? AND kind='DeviceWorkspace' AND namespace='runtime-work' AND is_active=true ORDER BY updated_at DESC,id DESC",(owner,)).await?;
        let matching: Vec<_> = mappings
            .into_iter()
            .filter(|mapping| {
                authority::integer(&mapping.json.0["spec"]["projectId"]) == Some(project_id)
                    && mapping.json.0["spec"]["deviceId"] == device
            })
            .collect();
        if matching.len() != 1 {
            bail!("Robot workspace binding is ambiguous; select an exact workspace")
        }
        mapping_id = Some(matching[0].id);
    }
    if let Some(mapping_id) = mapping_id {
        let mapping:Option<Mapping>=state.mysql.fetch_optional("SELECT id,json FROM kinds WHERE id=? AND user_id=? AND kind='DeviceWorkspace' AND namespace='runtime-work' AND is_active=true",(mapping_id,owner)).await?;
        let mapping = mapping.context("Device workspace not found")?;
        if authority::integer(&mapping.json.0["spec"]["projectId"]) != Some(project_id) {
            bail!("Device workspace does not belong to the bound project")
        }
        if mapping.json.0["spec"]["deviceId"] != device {
            bail!("Device workspace does not belong to the execution device")
        }
    } else if environment == "cloud" {
        bail!("Cloud robot workspace binding requires deviceWorkspaceId")
    }
    Ok(
        json!({"type":"backend_project","status":"ready","projectId":project_id,"deviceWorkspaceId":mapping_id,"deviceId":device}),
    )
}

pub(crate) fn user_input(
    project: &str,
    issue: &str,
    execution_id: i64,
    instruction: &str,
    stage_instruction: &str,
) -> String {
    let mut parts = vec![
        format!("project_id: {project}\ntask_id: {issue}\nexecution_id: {execution_id}"),
        format!(
            "看板任务数据位于 cloud://projects/{project}/todos/{issue}，请通过看板工具自行查看。"
        ),
    ];
    let instruction = if !stage_instruction.trim().is_empty() {
        stage_instruction.trim()
    } else {
        instruction.trim()
    };
    if !instruction.is_empty() {
        parts.push(instruction.into())
    }
    parts.join("\n\n")
}

async fn environment_config(state: &AppState, project: &Node) -> Result<Value> {
    #[derive(FromMysqlRow)]
    struct Workspace {
        json: Json<Value>,
    }
    let workspace_id = authority::parent(state, &project.id).await?;
    let workspace:Workspace=state.mysql.fetch_one("SELECT json FROM kinds WHERE id=? AND kind='CollaborationWorkspace' AND is_active=true",(workspace_id,)).await?;
    let project_config = &project.metadata.0["execution_environment"];
    let selected = if project_config.as_object().is_some_and(|v| !v.is_empty()) {
        project_config
    } else {
        &workspace.json.0["spec"]["executionEnvironment"]
    };
    let text = |value: &Value| value.as_str().unwrap_or("").trim().to_owned();
    let repositories:Vec<_>=selected["repositories"].as_array().into_iter().flatten().filter(|repository|repository.is_object()&&!text(&repository["url"]).is_empty()&&!text(&repository["path"]).is_empty()).map(|repository|json!({"name":text(&repository["name"]),"url":text(&repository["url"]),"ref":text(&repository["ref"]),"path":text(&repository["path"]),"primary":authority::truthy(&repository["primary"])})).collect();
    let steps:Vec<_>=selected["setup_steps"].as_array().into_iter().flatten().filter(|step|step.is_object()&&!text(&step["command"]).is_empty()).map(|step|json!({"command":text(&step["command"]),"workingDirectory":text(&step["working_directory"])})).collect();
    let devices = selected["devices"]
        .as_object()
        .map(|devices| {
            devices
                .iter()
                .filter(|(_, value)| value.is_object())
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect::<serde_json::Map<_, _>>()
        })
        .unwrap_or_default();
    Ok(
        json!({"repositories":repositories,"workspace_policy":selected["workspace_policy"].as_str().unwrap_or("git_worktree"),"setup_steps":steps,"fingerprint":selected["fingerprint"],"devices":devices}),
    )
}

pub(crate) async fn build(
    state: &AppState,
    issue: &Node,
    execution_id: i64,
    input: &Admission,
) -> Result<Value> {
    let project = store::get(&state.mysql, "project", &issue.cloud_project_id)
        .await?
        .context("Wework execution project is unavailable")?;
    let agent = if input.agent_id.is_empty() {
        None
    } else {
        Some(
            authority::agent(
                state,
                &issue.cloud_project_id,
                &input.agent_id,
                input.assigner,
                true,
            )
            .await?,
        )
    };
    let config = &input.config;
    let origin_context = &input.context;
    let runtime = origin_context["runtime"]
        .as_str()
        .or_else(|| config["runtime"].as_str())
        .unwrap_or("codex");
    let shell = match runtime {
        "codex" => "Codex",
        "claude_code" => "ClaudeCode",
        _ => bail!("Project robot runtime '{runtime}' is not a native device runtime"),
    };
    let mut local_project_id = agent.as_ref().map_or(0, |agent| agent.local_project_id);
    if let Some(profile_id) = input.runtime_selection["runtime_profile_id"]
        .as_str()
        .filter(|id| !id.is_empty())
    {
        let runtime_profile = store::get(&state.mysql, "runtime_profile", profile_id)
            .await?
            .context("Runtime profile is unavailable")?;
        #[derive(FromMysqlRow)]
        struct Binding {
            local_project_id: i64,
        }
        let binding:Option<Binding>=state.mysql.fetch_optional(format!("SELECT COALESCE(local_project_id,0) AS local_project_id FROM loop_items WHERE resource_type='local_binding' AND cloud_project_id=? AND user_id=? AND device_id=? AND status='active' AND {} ORDER BY updated_at DESC LIMIT 1",store::LIVE),(issue.cloud_project_id.as_str(),input.owner,runtime_profile.device_id.as_str())).await?;
        local_project_id = binding.map_or(0, |binding| binding.local_project_id);
    }
    let mut binding = workspace_binding(
        state,
        agent.as_ref(),
        input.owner,
        &input.device_id,
        &input.environment,
        &origin_context["workspace_binding"],
        local_project_id,
    )
    .await?;
    let stage_input = &origin_context["workflow_stage_input"];
    let stage_policy = stage_input["target_stage"]["workspace_policy"]
        .as_str()
        .unwrap_or("");
    let inherited = inherited(origin_context);
    if stage_input.is_object() && stage_policy == "inherit" {
        if inherited.is_none() {
            bail!("Inherited workflow workspace has no predecessor Runtime task")
        }
        binding = json!({"type":"standalone","status":"ready"});
    }
    let bound = binding["type"] == "device_project"
        || (binding["type"] == "backend_project"
            && (!binding["deviceWorkspaceId"].is_null() || input.environment != "cloud"));
    let environment = environment_config(state, &project).await?;
    let configured = ["repositories", "setup_steps", "fingerprint", "devices"]
        .iter()
        .any(|key| authority::truthy(&environment[*key]));
    let device_state = &environment["devices"][&input.device_id];
    let path = if device_state["status"] == "ready" {
        device_state["workspace_path"].as_str().unwrap_or("")
    } else {
        ""
    };
    let isolated = inherited.is_none()
        && environment["workspace_policy"] == "git_worktree"
        && (authority::truthy(&environment["repositories"]) || (!configured && bound));
    let mut execution = origin_context["execution"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let mut workspace = execution
        .get("workspace")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if isolated {
        workspace.insert("source".into(), json!("git_worktree"));
    } else if workspace.get("source") == Some(&json!("git_worktree")) {
        workspace.remove("source");
    }
    if !workspace.is_empty() {
        execution.insert("workspace".into(), json!(workspace));
    } else {
        execution.remove("workspace");
    }
    if configured && inherited.is_none() {
        execution.insert("environment".into(),json!({"environmentId":format!("project-{}",project.id),"repositories":environment["repositories"],"setupSteps":environment["setup_steps"],"fingerprint":environment["fingerprint"],"workspacePath":if path.is_empty(){Value::Null}else{json!(path)}}));
    }
    let mut origin = origin_context.clone();
    origin["type"] = json!(
        if authority::truthy(&origin_context["comment_trigger_message_id"]) {
            "board_comment"
        } else {
            "board_task"
        }
    );
    for (key, value) in [
        ("cloudProjectId", json!(project.id)),
        ("loopItemId", json!(issue.id)),
        ("executionId", json!(execution_id)),
        (
            "taskUrl",
            json!(format!(
                "cloud://projects/{}/todos/{}",
                project.id, issue.id
            )),
        ),
        (
            "workspacePolicy",
            json!(if stage_policy.is_empty() {
                environment["workspace_policy"]
                    .as_str()
                    .unwrap_or("git_worktree")
            } else {
                stage_policy
            }),
        ),
        ("executionEnvironment", environment.clone()),
    ] {
        origin[key] = value;
    }
    if ["dispatch_id", "dispatch_task_id", "dispatch_role"]
        .iter()
        .all(|key| authority::truthy(&origin_context[*key]))
    {
        for (from, to) in [
            ("dispatch_id", "dispatchId"),
            ("dispatch_task_id", "taskId"),
            ("dispatch_role", "dispatchRole"),
            ("manager_agent_id", "managerAgentId"),
        ] {
            origin[to] = origin_context[from].clone();
        }
    }
    if stage_input["target_stage"].is_object() {
        origin["workflowStageId"] = stage_input["target_stage"]["id"].clone();
        origin["workflowStageName"] = stage_input["target_stage"]["name"]
            .as_str()
            .map(|v| json!(v))
            .unwrap_or(stage_input["target_stage"]["id"].clone());
    }
    let prompt = if authority::truthy(&origin_context["comment_trigger_message_id"]) {
        origin_context["comment_prompt"].as_str().unwrap_or("")
    } else if input.agent_id.is_empty() {
        origin_context["execution_prompt"].as_str().unwrap_or("")
    } else {
        ""
    };
    let message = user_input(&project.id, &issue.id, execution_id, prompt, "");
    let mcp = origin_context
        .get("mcp_servers")
        .unwrap_or(&config["mcp_servers"]);
    if !mcp.is_null() && !mcp.is_object() {
        bail!("Project robot MCP servers must be an object")
    }
    let servers: Vec<_> = mcp
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, value)| value.is_object())
        .map(|(name, value)| {
            let mut value = value.clone();
            value["name"] = json!(name);
            value
        })
        .collect();
    let display = agent
        .as_ref()
        .map(|agent| {
            if agent.title.is_empty() {
                agent.name.as_str()
            } else {
                agent.title.as_str()
            }
        })
        .unwrap_or("AI");
    let bot = if let Some(coordinate) = origin_context.get("coordinate_bots") {
        let coordinate = coordinate
            .as_array()
            .filter(|bots| !bots.is_empty() && bots.iter().all(Value::is_object))
            .context("Coordinate execution requires a list of bot objects")?;
        origin["collaborationMode"] = json!(
            origin_context["collaborationMode"]
                .as_str()
                .or_else(|| origin_context["collaboration_mode"].as_str())
                .unwrap_or("coordinate")
        );
        json!(coordinate)
    } else {
        json!([{"id":if input.agent_id.is_empty(){json!(0)}else{json!(input.agent_id)},"name":display,"shell_type":shell,"mcp_servers":servers}])
    };
    let mut additional = origin_context["additional_context"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    if stage_input.is_object() {
        additional.insert("workflowStageInput".into(),json!({"kind":"application","value":format!("<workflow_stage_input>\n{}\n</workflow_stage_input>\nThis immutable snapshot is the input for the current workflow stage. Fulfill every required deliverable by its requirement ID before completing the task.",serde_json::to_string(stage_input)?)}));
    }
    let model = input.runtime_selection["model"].as_str().unwrap_or("");
    let model_type = &input.runtime_selection["model_type"];
    let model_options = &input.runtime_selection["model_options"];
    let runtime_task_id = origin_context["comment_continue_task_id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("codex-queue-{execution_id}"));
    let mut request = json!({"schemaVersion":2,"taskId":runtime_task_id,"runtime":runtime,"message":message,"title":origin_context["workflow_task_title"].as_str().unwrap_or(&issue.title),"modelId":if model.is_empty(){Value::Null}else{json!(model)},"modelType":model_type,"modelOptions":if model_options.is_object(){model_options.clone()}else{json!({})},"modelSelection":if model.is_empty(){Value::Null}else{json!({"modelName":model,"modelType":model_type,"options":model_options})},"projectInstructions":origin_context.get("system_prompt").unwrap_or(&config["system_prompt"]).as_str().unwrap_or(""),"bot":bot,"cloudProjectId":project.id,"projectId":if binding["type"]=="backend_project"{binding["projectId"].clone()}else{Value::Null},"deviceWorkspaceId":binding["deviceWorkspaceId"],"workspacePath":if path.is_empty(){Value::Null}else{json!(path)},"deviceId":if input.device_id.is_empty(){Value::Null}else{json!(input.device_id)},"runtimeProjectKey":if binding["type"]=="device_project"{binding["runtimeProjectKey"].clone()}else{Value::Null},"origin":origin,"standaloneChatWorkspace":!bound&&!configured&&inherited.is_none()&&path.is_empty(),"workspaceSourceTask":inherited,"additionalContext":additional,"projectPlugins":origin_context.get("project_plugins").unwrap_or(&config["plugins"]).as_array().cloned().unwrap_or_default(),"runtimePermissionMode":origin_context["runtime_permission_mode"],"execution":if inherited.is_some()||execution.is_empty(){Value::Null}else{json!(execution)},"initialGoal":origin_context["initial_goal"],"initialSupervisor":origin_context["initial_supervisor"],"additionalSkills":origin_context.get("additional_skills").unwrap_or(&config["additional_skills"]).as_array().cloned().unwrap_or_default(),"attachmentIds":origin_context["attachment_ids"].as_array().cloned().unwrap_or_default(),"attachments":origin_context["attachments"].as_array().cloned().unwrap_or_default(),"ephemeral":origin_context["ephemeral"]});
    request
        .as_object_mut()
        .unwrap()
        .retain(|_, value| !value.is_null());
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inherited_workspace_chooses_the_latest_predecessor_task() {
        let context = json!({"workflow_stage_input":{"target_stage":{"workspace_policy":"inherit"},"dependencies":[{"runtime_tasks":[{"device_id":"d","task_id":"old"}]},{"runtime_tasks":[{"device_id":"d","task_id":"latest"}]}]}});
        assert_eq!(
            inherited(&context),
            Some(json!({"deviceId":"d","taskId":"latest"}))
        );
        assert!(user_input("p", "i", 1, "instruction", "").ends_with("instruction"));
    }
}
