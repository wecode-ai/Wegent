// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! One persisted automation run becomes an Issue assignment or a continuation.

use super::{
    assignments, authority,
    events::AutomationEvent,
    groups, issues, runtime_rpc,
    store::{self, COLUMNS, LIVE, Node},
};
use crate::state::AppState;
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json};
use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{Value, json};

pub(super) use issues::create as create_issue;

pub(super) async fn run(state: &AppState, rule: &Node, run: &Node) -> Result<()> {
    if !matches!(run.status.as_str(), "pending" | "queued") {
        return Ok(());
    }
    if let Err(error) = dispatch(state, rule, run).await {
        tracing::error!(run_id=%run.id,rule_id=%rule.id,%error,"project automation dispatch failed");
        if let Some(redis) = state.redis.as_ref() {
            super::completion::dispatch_failed(&state.mysql, redis, &run.id, &error.to_string())
                .await?;
        } else {
            state.mysql.execute("UPDATE loop_items SET status='failed',description=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status NOT IN ('succeeded','failed','cancelled','skipped')",(error.to_string().chars().take(2000).collect::<String>(),run.id.as_str())).await?;
        }
    }
    Ok(())
}

async fn dispatch(state: &AppState, rule: &Node, run: &Node) -> Result<()> {
    let project = store::get(&state.mysql, "project", &rule.cloud_project_id)
        .await?
        .context("Automation owner or project is unavailable")?;
    authority::require(state, &project.id, rule.created_by_user_id).await?;
    let mut run = run.clone();
    let mut metadata = run.meta();
    if metadata["task_origin"].as_str().unwrap_or("").is_empty() {
        metadata["task_origin"] = json!(if run.task_id.is_empty() {
            "automation_created"
        } else {
            "existing_issue"
        });
    }
    state
        .mysql
        .execute(
            "UPDATE loop_items SET metadata=? WHERE id=?",
            (Json(metadata.clone()), run.id.as_str()),
        )
        .await?;
    run.metadata = Json(metadata);
    if run.task_id.is_empty() {
        let scheduled = run.metadata.0["scheduled_for"]
            .as_str()
            .and_then(|value| {
                DateTime::parse_from_rfc3339(value)
                    .map(|value| value.naive_utc())
                    .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f"))
                    .ok()
            })
            .unwrap_or_else(|| Utc::now().naive_utc());
        let timezone = rule.metadata.0["timezone"]
            .as_str()
            .unwrap_or("Asia/Shanghai")
            .parse::<chrono_tz::Tz>()
            .unwrap_or(chrono_tz::UTC);
        let title = format!(
            "{} · {}",
            rule.title,
            scheduled
                .and_utc()
                .with_timezone(&timezone)
                .format("%Y-%m-%d %H:%M")
        );
        let context = context(state, rule, &run).await?;
        let issue = create_issue(
            state,
            &project,
            rule.created_by_user_id,
            &title,
            instruction(rule, &run),
            &["automation"],
            &context,
        )
        .await?;
        state.mysql.execute("UPDATE loop_items SET task_id=?,task_title=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(issue.id.as_str(),issue.title.as_str(),run.id.as_str())).await?;
        run.task_id = issue.id;
        run.task_title = issue.title;
    }
    let target = &rule.metadata.0["dispatch_target"];
    if !target.is_object() {
        bail!("Automation dispatch target is unavailable")
    }
    let mut context = context(state, rule, &run).await?;
    context["runner_selection"] = target["runner_selection"].clone();
    if target["execution_device_id"]
        .as_str()
        .is_some_and(|value| !value.trim().is_empty())
    {
        context["execution_device_id"] = target["execution_device_id"].clone();
    }
    let kind = target["kind"].as_str().unwrap_or("");
    let target_id = target["id"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| target["id"].as_i64().map(|v| v.to_string()))
        .unwrap_or_default();
    match kind {
        "human" => {
            assignments::assign(
                state,
                &project,
                rule,
                &run,
                assignments::Target::Human(target_id.parse()?),
                context,
                instruction(rule, &run),
            )
            .await?;
        }
        "collaboration_group" => {
            groups::assign(state, &project, rule, &run, &target_id, context).await?;
        }
        "agent" => {
            let agent:Option<Node>=state.mysql.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='chat_agent' AND cloud_project_id=? AND status='active' AND {LIVE} AND (id=? OR CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wegent_team_id')) AS CHAR)=?) ORDER BY (id=?) DESC LIMIT 1"),(project.id.as_str(),target_id.as_str(),target_id.as_str(),target_id.as_str())).await?;
            if let Some(agent) = agent {
                assignments::assign(
                    state,
                    &project,
                    rule,
                    &run,
                    assignments::Target::Agent(Box::new(agent)),
                    context,
                    instruction(rule, &run),
                )
                .await?;
            } else {
                assignments::assign(
                    state,
                    &project,
                    rule,
                    &run,
                    assignments::Target::Team(
                        target_id
                            .parse()
                            .context("The collaboration-group Agent is unavailable")?,
                    ),
                    context,
                    instruction(rule, &run),
                )
                .await?;
            }
        }
        _ => bail!("The automatic-processing target is invalid"),
    }
    Ok(())
}

pub(super) fn instruction<'a>(rule: &'a Node, run: &'a Node) -> &'a str {
    run.metadata.0["instruction_override"]
        .as_str()
        .unwrap_or(&rule.description)
}

pub(super) async fn context(state: &AppState, rule: &Node, run: &Node) -> Result<Value> {
    let runtime = &rule.metadata.0["runtime"];
    let workflow = &run.metadata.0["workflow_execution_config"];
    let mut source = runtime["source"]
        .as_str()
        .unwrap_or("agent_default")
        .to_owned();
    let mut subject = rule.created_by_user_id;
    let mut profile = runtime["runtime_profile_id"].clone();
    if source == "issue_creator" && !run.task_id.is_empty() {
        if let Some(issue) = store::get(&state.mysql, "task", &run.task_id).await?
            && issue.created_by_user_id != 0
        {
            subject = issue.created_by_user_id;
        }
    } else if source == "runtime_user" {
        subject = authority::integer(&runtime["user_id"])
            .filter(|v| *v != 0)
            .unwrap_or(subject);
    }
    let configured = workflow
        .get("runtimeProfileId")
        .or_else(|| workflow.get("runtime_profile_id"))
        .filter(|v| authority::truthy(v));
    if let Some(configured) = configured {
        source = "fixed_profile".into();
        profile = configured.clone();
    }
    if source == "fixed_profile"
        && let Some(id) = profile.as_str()
        && let Some(profile) = store::get(&state.mysql, "runtime_profile", id).await?
        && profile.user_id != 0
    {
        subject = profile.user_id;
    }
    let mut context = json!({"rule_id":rule.id,"run_id":run.id,"trigger":run.metadata.0["trigger"].as_str().unwrap_or(&run.source),"scheduled_for":run.metadata.0["scheduled_for"],"event":run.metadata.0.get("event").filter(|v|v.is_object()).cloned().unwrap_or(json!({})),"runtime_source":source,"runtime_profile_id":profile,"runtime_subject_user_id":subject});
    if workflow.as_object().is_some_and(|value| !value.is_empty()) {
        for (to, camel, snake) in [
            ("agent_id", "agentId", "agent_id"),
            (
                "execution_device_id",
                "executionDeviceId",
                "execution_device_id",
            ),
            ("model_type", "modelType", "model_type"),
            ("model_options", "modelOptions", "model_options"),
            ("workspace_binding", "workspaceBinding", "workspace_binding"),
        ] {
            context[to] = workflow
                .get(camel)
                .filter(|v| authority::truthy(v))
                .or_else(|| workflow.get(snake))
                .cloned()
                .unwrap_or(if to == "model_options" {
                    json!({})
                } else {
                    Value::Null
                });
        }
        context["model"] = workflow["model"].clone();
        for (camel, snake) in [
            ("runtime", "runtime"),
            ("runtimePermissionMode", "runtime_permission_mode"),
            ("execution", "execution"),
            ("initialGoal", "initial_goal"),
            ("initialSupervisor", "initial_supervisor"),
            ("ephemeral", "ephemeral"),
            ("projectPlugins", "project_plugins"),
            ("additionalSkills", "additional_skills"),
        ] {
            if let Some(value) = workflow.get(camel).or_else(|| workflow.get(snake)) {
                context[snake] = value.clone();
            }
        }
    }
    Ok(context)
}

pub(super) async fn continue_binding(
    state: &AppState,
    rule: &Node,
    run: &Node,
    binding: &Node,
    event: &AutomationEvent,
) -> Result<()> {
    state.mysql.execute("UPDATE loop_items SET status='running',version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(run.id.as_str(),)).await?;
    let outcome=async {
        authority::require(state,&event.project_id,rule.created_by_user_id).await?;
        let aliases=crate::device_identity::owned_device_identity_ids(&state.mysql,binding.task_user_id,&binding.device_id).await?;
        #[derive(FromMysqlRow)]struct Selection{execution_payload:String}
        let mut args=vec![crate::sql_support::StatementArg::Str(binding.loop_item_id.clone()),crate::sql_support::StatementArg::Str(binding.cloud_project_id.clone()),crate::sql_support::StatementArg::Int(binding.task_user_id),crate::sql_support::StatementArg::Str(binding.task_id.clone())];
        args.extend(aliases.iter().cloned().map(crate::sql_support::StatementArg::Str));
        let row:Option<Selection>=if aliases.is_empty(){None}else{state.mysql.fetch_optional(format!("SELECT execution_payload FROM loop_item_executions WHERE loop_item_id=? AND cloud_project_id=? AND executor_owner_user_id=? AND runtime_task_id=? AND runtime_device_id IN ({}) ORDER BY id DESC LIMIT 1",vec!["?";aliases.len()].join(",")),args).await?};
        let selection=row.and_then(|row|serde_json::from_str::<Value>(&row.execution_payload).ok()).map(|intent|intent["runtime_selection"].clone()).filter(|selection|selection["model"].as_str().is_some_and(|v|!v.trim().is_empty())).map(|selection|json!({"modelName":selection["model"],"modelType":selection["model_type"],"options":selection.get("model_options").filter(|v|v.is_object()).cloned().unwrap_or(json!({}))})).or_else(||rule.metadata.0["event_config"]["runtime_workflow_definition"]["nodes"].as_array().and_then(|nodes|nodes.iter().find_map(|node|{let config=&node["execution_config"];config["model"].as_str().filter(|value|!value.is_empty()).map(|model|json!({"modelName":model,"modelType":config["model_type"],"options":config.get("model_options").filter(|v|v.is_object()).cloned().unwrap_or(json!({}))}))})));
        let subject=event.payload["subject"]["url"].as_str().unwrap_or(&event.subject_id);
        let external=format!("External event context:\n- Type: {}\n- Provider: {}\n- Change request: {subject}\n- Payload: {}",event.event_type,event.source,serde_json::to_string(&event.payload)?);
        let prompt=[rule.description.as_str(),external.as_str()].into_iter().filter(|value|!value.is_empty()).collect::<Vec<_>>().join("\n\n");
        runtime_rpc::continue_task(state,binding,&prompt,selection.as_ref()).await
    }.await;
    let (status, error) = match outcome {
        Ok(()) => ("succeeded", String::new()),
        Err(error) => ("failed", error.to_string()),
    };
    state.mysql.execute("UPDATE loop_items SET status=?,description=?,completed_at=UTC_TIMESTAMP(6),version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(status,error,run.id.as_str())).await?;
    Ok(())
}
