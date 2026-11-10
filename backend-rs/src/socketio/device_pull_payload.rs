// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::device_pull_claim::{ClaimPreparation, QueueExecutionRow, same_runtime_device};
use crate::background_jobs::project::{
    agents, authority, groups, profile, queue, routing, runtime_rpc, store,
};
use crate::state::AppState;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// Compile a queued execution using the same profile and transient
/// authentication path as a direct Runtime request.
pub(super) async fn compile_request(
    app: &AppState,
    command: &super::device_pull::PullCommand<'_>,
    row: &QueueExecutionRow,
    prepared: &mut ClaimPreparation,
) -> anyhow::Result<Value> {
    let execution = row.execution();
    let mut selection = if prepared.intent["runtime_selection"].is_object() {
        prepared.intent["runtime_selection"].clone()
    } else {
        execution.selection()
    };
    let context = execution.context();
    let group_dispatch = selection["executor_kind"] == "collaboration_group_dispatch";
    if group_dispatch {
        ensure!(
            prepared.intent["dispatch_request"]["kind"] == "collaboration_group",
            "Collaboration group dispatch request is unavailable"
        );
    }
    let mut request = prepared.intent["runtime_request"].clone();
    if group_dispatch
        || !request
            .as_object()
            .is_some_and(|request| !request.is_empty())
    {
        let issue = store::get(&app.mysql, "task", &row.loop_item_id)
            .await?
            .context("Issue execution task is unavailable")?;
        let agent_id = if group_dispatch {
            context["manager_agent_id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .context("Collaboration manager Agent is unavailable")?
        } else {
            &row.agent_id
        };
        let config = if agent_id.is_empty() {
            json!({})
        } else {
            let agent = authority::agent(
                app,
                &row.cloud_project_id,
                agent_id,
                row.assigner_user_id,
                true,
            )
            .await?;
            agents::compile(app, &agent, row.assigner_user_id).await?
        };
        if group_dispatch && !selection["runner_routing"].is_object() {
            for field in ["model", "model_type", "model_options"] {
                selection[field] = config[field].clone();
            }
        }
        request = profile::build(
            app,
            &issue,
            row.id,
            &queue::Admission {
                owner: command.owner_user_id,
                assigner: row.assigner_user_id,
                agent_id: row.agent_id.clone(),
                team_id: row.team_id,
                environment: command.environment.to_owned(),
                device_id: command.execution_target_id.to_owned(),
                context: context.clone(),
                runtime_selection: selection.clone(),
                config,
                requires_approval: false,
                waiting_runtime: false,
            },
        )
        .await?;
        // Preserve the compiled profile for continuations. Credentials are
        // added below only to the transport request.
        queue::validate_non_secret_plugins(&request["projectPlugins"])?;
        prepared.intent["runtime_request"] = request.clone();
    }
    let actor = if execution.routed() || context.get("project_coordination").is_some() {
        row.assigner_user_id
    } else {
        command.owner_user_id
    };
    let continuing = context["comment_continue_task_id"]
        .as_str()
        .is_some_and(|id| !id.is_empty());
    let mut payload =
        compile_wire(app, command, actor, &context, request, prepared, continuing).await?;
    if group_dispatch {
        let members = member_profiles(app, command, row, prepared, &selection, &context).await?;
        return Ok(json!({
            "dispatchKind": "collaboration_group", "dispatchTaskId": prepared.runtime_task_id,
            "managerRuntimeRequest": payload, "memberRuntimeProfiles": members
        }));
    }
    if continuing && context["dispatch_role"] == "manager" {
        let dispatch_id = authority::integer(&context["collaboration_dispatch_execution_id"])
            .context("The collaboration manager dispatch is unavailable")?;
        let dispatch: QueueExecutionRow = app
            .mysql
            .fetch_optional(
                format!(
                    "SELECT {} FROM loop_item_executions WHERE id=?",
                    crate::loop_tasks::loop_repository::EXECUTION_COLUMNS
                ),
                (dispatch_id,),
            )
            .await?
            .context("The collaboration manager dispatch is unavailable")?;
        let original = dispatch.execution();
        ensure!(
            original.selection()["executor_kind"] == "collaboration_group_dispatch"
                && dispatch.cloud_project_id == row.cloud_project_id
                && dispatch.loop_item_id == row.loop_item_id
                && original.context()["dispatch_id"] == context["dispatch_id"]
                && !dispatch.runtime_task_id.is_empty()
                && crate::background_jobs::robot::authority::authorized(app, &original).await?,
            "The collaboration manager dispatch is unavailable"
        );
        let members = member_profiles(app, command, row, prepared, &selection, &context).await?;
        payload["runtimeHandle"] = json!({
            "collaborationDispatchTaskId": dispatch.runtime_task_id,
            "collaborationManagerContext": context["execution_prompt"],
            "collaborationMemberRuntimeProfiles": members
        });
    }
    Ok(payload)
}

async fn compile_wire(
    app: &AppState,
    command: &super::device_pull::PullCommand<'_>,
    actor: i64,
    context: &Value,
    mut request: Value,
    prepared: &ClaimPreparation,
    continuing: bool,
) -> Result<Value> {
    for device in [
        request["deviceId"].as_str(),
        request["workspaceSourceTask"]["deviceId"].as_str(),
    ]
    .into_iter()
    .flatten()
    {
        anyhow::ensure!(
            same_runtime_device(
                app,
                command.owner_user_id,
                device,
                command.execution_target_id
            )
            .await?,
            "Execution request target does not match the claimed queue"
        );
    }
    let user: crate::auth::UserRow = app
        .mysql
        .fetch_one(crate::user_reader::USER_BY_ID_QUERY, (actor,))
        .await?;
    let message = request["message"]
        .as_str()
        .filter(|message| !message.trim().is_empty())
        .context("Execution message is unavailable")?;
    let prompt = application_prompt(message, &request["additionalContext"]);
    let mut execution_request = runtime_rpc::direct_execution(
        app,
        &user,
        &prepared.runtime_task_id,
        command.runtime_device_id,
        &prompt,
        request.get("modelSelection"),
    )
    .await?;
    if let Some(trigger) = context["comment_trigger_message_id"]
        .as_str()
        .filter(|id| !id.trim().is_empty())
    {
        request["clientUserMessageId"] = json!(trigger);
    }
    execution_request["subtask_id"] = json!(prepared.runtime_turn_id);
    execution_request["new_session"] = json!(!continuing);
    let options = &request["modelOptions"];
    if let Some(mode) = options
        .get("permissionMode")
        .or_else(|| options.get("permission_mode"))
        .filter(|mode| !mode.is_null())
    {
        let profile = match mode.as_str() {
            Some("read-only") => ":read-only",
            Some("workspace-write") => ":workspace",
            Some("full-access") => ":danger-full-access",
            _ => anyhow::bail!("Invalid runtime permission mode"),
        };
        execution_request["runtime_permission_profile"] = json!(profile);
    }
    let mut payload = wire_request(request, execution_request, prepared);
    if continuing {
        payload["runtimeAction"] = json!("send");
        payload["queueIfBusy"] = json!(true);
    }
    Ok(payload)
}

fn application_prompt(message: &str, context: &Value) -> String {
    let mut entries: Vec<String> = context
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, entry)| {
            let value = entry["value"].as_str()?.trim();
            (entry["kind"] == "application" && !value.is_empty())
                .then(|| format!("[{name}]\n{value}"))
        })
        .collect();
    if message.contains("cloud://projects") && context.get("projectSpaceCapability").is_none() {
        entries.push(concat!(
            "[projectSpaceCapability]\n",
            "Use wework_space as the only interface for WeWork project spaces, board items, files, attachments, and deliveries.\n",
            "Storage and task providers are internal implementation details.\n",
            "Do not use git commands or call GitHub, GitLab, or object-storage APIs to inspect or modify project-space data.\n",
            "Use list_spaces to discover spaces, get_board_item for item details, and read_item_attachment for attachment contents."
        ).to_owned());
    }
    if entries.is_empty() {
        return message.to_owned();
    }
    format!(
        "<application_context>\n{}\n</application_context>\n\n{message}",
        entries.join("\n\n")
    )
}

async fn member_profiles(
    app: &AppState,
    command: &super::device_pull::PullCommand<'_>,
    row: &QueueExecutionRow,
    prepared: &ClaimPreparation,
    selection: &Value,
    context: &Value,
) -> Result<Vec<Value>> {
    let group = &context["collaboration_group"];
    ensure!(
        group.is_object(),
        "Collaboration group snapshot is unavailable"
    );
    let issue = store::get(&app.mysql, "task", &row.loop_item_id)
        .await?
        .context("Issue execution task is unavailable")?;
    let runner = crate::device_identity::resolve_owned_device_alias(
        &app.mysql,
        command.owner_user_id,
        command.execution_target_id,
    )
    .await?
    .context("Collaboration Executor is unavailable")?;
    let mut agents = BTreeMap::<String, (store::Node, BTreeSet<String>)>::new();
    let refs =
        std::iter::once(&group["leader"]).chain(group["members"].as_array().into_iter().flatten());
    for member in refs.filter(|member| member["kind"] == "agent") {
        let id = member["id"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| member["id"].as_i64().map(|id| id.to_string()))
            .context("Collaboration Agent identity is unavailable")?;
        let agent = groups::resolve_agent(app, &row.cloud_project_id, &id).await?;
        let (_, aliases) = agents
            .entry(agent.id.clone())
            .or_insert_with(|| (agent.clone(), BTreeSet::from([agent.id])));
        aliases.insert(id);
    }
    let mut result = Vec::with_capacity(agents.len());
    for (agent_id, (agent, aliases)) in agents {
        let visible_agent = authority::agent(
            app,
            &row.cloud_project_id,
            &agent_id,
            row.assigner_user_id,
            true,
        )
        .await?;
        let config = agents::compile(app, &visible_agent, row.assigner_user_id).await?;
        let routed = selection["runner_routing"].is_object();
        let member_model = if routed {
            let route = &selection["group_runner_requirements"][&agent_id];
            ensure!(
                route.is_object(),
                "Configure every group member's environment and model policies"
            );
            routing::runner_model_selection(
                app,
                row.assigner_user_id,
                &runner.json,
                &route["model"],
            )
            .await?
            .context("Collaboration Agent model is unavailable on this Executor")?
        } else {
            json!({"model": config["model"], "model_type": config["model_type"], "model_options": config["model_options"]})
        };
        let mut member_context = context.clone();
        member_context["dispatch_role"] = json!("member");
        member_context["workflow_task_title"] = json!("Collaboration member task");
        member_context["system_prompt"] = config["system_prompt"].clone();
        member_context
            .as_object_mut()
            .expect("group origin object")
            .shift_remove("comment_continue_task_id");
        let mut request = profile::build(
            app,
            &issue,
            row.id,
            &queue::Admission {
                owner: command.owner_user_id,
                assigner: row.assigner_user_id,
                agent_id: agent_id.clone(),
                team_id: 0,
                environment: command.environment.to_owned(),
                device_id: command.execution_target_id.to_owned(),
                context: member_context.clone(),
                runtime_selection: member_model,
                config,
                requires_approval: false,
                waiting_runtime: false,
            },
        )
        .await?;
        request["message"] = json!("Collaboration member task");
        if let Some(origin) = request["origin"].as_object_mut() {
            origin.shift_remove("executionId");
            origin.shift_remove("execution_id");
        }
        let template = ClaimPreparation::profile_template(
            format!("{}-member-profile-{agent_id}", prepared.runtime_task_id),
            row.id,
        );
        member_context
            .as_object_mut()
            .expect("group origin object")
            .shift_remove("comment_trigger_message_id");
        let actor = if routed {
            row.assigner_user_id
        } else if agent.created_by_user_id != 0 {
            agent.created_by_user_id
        } else {
            command.owner_user_id
        };
        let runtime = compile_wire(
            app,
            command,
            actor,
            &member_context,
            request,
            &template,
            false,
        )
        .await?;
        let name = [&agent.title, &agent.name]
            .into_iter()
            .find(|name| !name.is_empty())
            .map(String::as_str)
            .unwrap_or("AI");
        result.push(json!({"memberIds": aliases, "agentId": agent_id, "agentName": name, "runtimePayload": runtime}));
    }
    ensure!(
        !result.is_empty(),
        "Collaboration member Runtime profiles are unavailable"
    );
    Ok(result)
}

pub(super) fn wire_request(
    request: Value,
    mut execution: Value,
    prepared: &ClaimPreparation,
) -> Value {
    let mut payload = json!({"taskId":prepared.runtime_task_id,"schemaVersion":2});
    for key in [
        "runtime",
        "message",
        "title",
        "workspacePath",
        "runtimeExecutablePath",
        "runtimePermissionMode",
        "clientUserMessageId",
        "standaloneChatWorkspace",
        "runtimeProjectKey",
        "runtimeProjectName",
        "projectInstructions",
        "friendlyTitle",
        "modelId",
        "modelType",
        "forceStart",
        "cloudProjectId",
        "ephemeral",
        "origin",
        "runtimeWorkspaceRoots",
        "projectPlugins",
        "additionalSkills",
        "bot",
        "attachments",
        "modelSelection",
        "modelOptions",
        "execution",
        "initialGoal",
        "initialSupervisor",
        "sideSource",
        "workspaceSourceTask",
        "additionalContext",
    ] {
        if let Some(value) = request.get(key).filter(|value| !value.is_null()) {
            payload[key] = value.clone();
        }
    }
    for (from, to) in [
        ("title", "task_title"),
        ("bot", "bot"),
        ("origin", "origin"),
        ("projectInstructions", "system_prompt"),
        ("attachments", "attachments"),
        ("runtimePermissionMode", "claude_permission_mode"),
        ("workspacePath", "project_workspace_path"),
        ("runtimeProjectKey", "runtime_project_key"),
        ("runtimeProjectName", "runtime_project_name"),
        ("runtimeWorkspaceRoots", "runtime_workspace_roots"),
        ("clientUserMessageId", "client_user_message_id"),
        ("additionalSkills", "preload_skills"),
        ("cloudProjectId", "cloud_project_id"),
        ("standaloneChatWorkspace", "standalone_chat_workspace"),
        ("runtimeExecutablePath", "runtime_executable_path"),
        ("ephemeral", "ephemeral"),
    ] {
        if let Some(value) = request.get(from).filter(|value| !value.is_null()) {
            execution[to] = value.clone();
        }
    }
    if let Some(bot) = request["bot"].as_array().and_then(|bots| bots.first()) {
        execution["bot_name"] = json!(bot["name"].as_str().unwrap_or_default());
        execution["bot_namespace"] = json!(
            bot["namespace"]
                .as_str()
                .or_else(|| bot["bot_namespace"].as_str())
                .unwrap_or("wework")
        );
    }
    if let Some(path) = request["workspacePath"]
        .as_str()
        .filter(|path| !path.is_empty())
    {
        execution["workspace"]["project"]["project_workspace_path"] = json!(path);
        execution["workspace"]["project"]["local_path"] = json!(path);
    }
    if request["execution"]["workspace"]["source"] == "git_worktree" {
        execution["workspace_source"] = json!("git_worktree");
        execution["workspace"]["project"]["workspace_source"] = json!("git_worktree");
    }
    if execution["system_prompt"] == "" {
        execution
            .as_object_mut()
            .expect("compiled execution object")
            .shift_remove("system_prompt");
    }
    payload["executionRequest"] = execution;
    payload
}
