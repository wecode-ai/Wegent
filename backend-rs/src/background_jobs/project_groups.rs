// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! A collaboration assignment hands one immutable dispatch to its current
//! leader. The Runtime owns coordination after admission.

use super::{
    agents, assignments, authority, issues, notifications,
    queue::{self, Admission},
    routing,
    store::{self, COLUMNS, LIVE, Node},
};
use crate::state::AppState;
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use serde_json::{Value, json};

#[derive(FromMysqlRow)]
struct Group {
    id: i64,
    user_id: i64,
    name: String,
    namespace: String,
    json: Json<Value>,
}
type Id = (i64,);

async fn authorized_definition(
    state: &AppState,
    project_id: &str,
    id: &str,
    actor: i64,
) -> Result<Value> {
    authority::require(state, project_id, actor).await?;
    let workspace = authority::parent(state, project_id).await?;
    let group:Option<Group>=state.mysql.fetch_optional("SELECT id,user_id,name,namespace,json FROM kinds WHERE id=? AND kind='CollaborationGroup' AND is_active=true",(id.parse::<i64>()?,)).await?;
    let group = group.context("Collaboration group is unavailable")?;
    let grant:Option<Id>=state.mysql.fetch_optional("SELECT id FROM resource_members WHERE resource_type='CollaborationGroup' AND resource_id=? AND entity_type='project' AND entity_id=? AND status='approved' AND role IN ('Owner','Maintainer','Developer') LIMIT 1",(group.id,project_id)).await?;
    if grant.is_none() {
        bail!("Collaboration group is not enabled in this project")
    }
    if group.namespace != format!("projects/{project_id}") {
        let grant:Option<Id>=state.mysql.fetch_optional("SELECT id FROM resource_members WHERE resource_type='CollaborationGroup' AND resource_id=? AND entity_type='workspace' AND entity_id=? AND status='approved' AND role IN ('Owner','Maintainer','Developer') LIMIT 1",(group.id,workspace.to_string())).await?;
        if grant.is_none() || group.namespace != format!("workspaces/{workspace}") {
            bail!("Collaboration group resource authorization is revoked")
        }
    }
    let spec = &group.json.0["spec"];
    let snapshot = json!({"id":group.id,"workspace_id":workspace,"owner_type":if group.namespace.starts_with("projects/"){"project"}else{"workspace"},"owner_id":if group.namespace.starts_with("projects/"){project_id.parse::<i64>()?}else{workspace},"name":group.name,"description":spec["description"].as_str().unwrap_or(""),"instructions":spec["instructions"].as_str().unwrap_or(""),"leader":spec.get("leader").filter(|value|value.is_object()).cloned().unwrap_or(json!({})),"members":spec["members"].as_array().cloned().unwrap_or_default(),"coordination_mode":spec["coordinationMode"].as_str().unwrap_or("manager"),"stages":spec["stages"].as_array().cloned().unwrap_or_default(),"execution_requirements":spec.get("executionRequirements").filter(|value|value.is_object()).cloned().unwrap_or(json!({"required_tags":[]})),"version":group.json.0["status"]["version"].as_i64().unwrap_or(1),"created_by_user_id":group.user_id});
    Ok(snapshot)
}

pub(crate) async fn authorize(
    state: &AppState,
    project_id: &str,
    id: &str,
    actor: i64,
) -> Result<Value> {
    let snapshot = authorized_definition(state, project_id, id, actor).await?;
    for member in participants(&snapshot)? {
        validate_member(state, project_id, member, actor).await?;
    }
    Ok(snapshot)
}

fn participants(group: &Value) -> Result<Vec<&Value>> {
    let mut values = vec![&group["leader"]];
    if let Some(members) = group["members"].as_array() {
        values.extend(members)
    }
    if let Some(stages) = group["stages"].as_array() {
        values.extend(
            stages
                .iter()
                .filter_map(|stage| stage.get("assignee").filter(|value| !value.is_null())),
        )
    }
    if values.iter().any(|value| {
        !matches!(value["kind"].as_str(), Some("human" | "agent")) || member_id(value).is_empty()
    }) {
        bail!("Collaboration group participants are invalid")
    }
    Ok(values)
}
fn member_id(value: &Value) -> String {
    value["id"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| value["id"].as_i64().map(|id| id.to_string()))
        .unwrap_or_default()
}

async fn validate_member(
    state: &AppState,
    project_id: &str,
    member: &Value,
    actor: i64,
) -> Result<()> {
    let id = member_id(member);
    if member["kind"] == "human" {
        let active: Option<Id> = state
            .mysql
            .fetch_optional(
                "SELECT id FROM users WHERE id=? AND is_active=true",
                (id.parse::<i64>()?,),
            )
            .await?;
        if active.is_none() {
            bail!("Collaboration group participant is unavailable")
        }
        authority::require(state, project_id, id.parse()?)
            .await
            .context("Collaboration group participant cannot execute")?;
    } else {
        let agent = resolve_agent(state, project_id, &id).await?;
        authority::agent(state, project_id, &agent.id, actor, true).await?;
    }
    Ok(())
}

pub(crate) async fn authorize_snapshot(
    state: &AppState,
    project_id: &str,
    snapshot: &Value,
    actor: i64,
) -> Result<()> {
    let current = authorized_definition(state, project_id, &member_id(snapshot), actor).await?;
    let identities: std::collections::BTreeSet<_> = participants(&current)?
        .iter()
        .map(|member| {
            (
                member["kind"].as_str().unwrap_or("").to_owned(),
                member_id(member),
            )
        })
        .collect();
    for member in participants(snapshot)? {
        if !identities.contains(&(
            member["kind"].as_str().unwrap_or("").to_owned(),
            member_id(member),
        )) {
            bail!("Collaboration group membership was revoked")
        }
        validate_member(state, project_id, member, actor).await?;
    }
    Ok(())
}

async fn resolve_agent(state: &AppState, project_id: &str, id: &str) -> Result<Node> {
    state.mysql.fetch_optional(format!("SELECT {COLUMNS} FROM loop_items WHERE resource_type='chat_agent' AND cloud_project_id=? AND status='active' AND {LIVE} AND (id=? OR CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.wegent_team_id')) AS CHAR)=?) ORDER BY (id=?) DESC LIMIT 1"),(project_id,id,id,id)).await?.context("Collaboration group member Agent is unavailable")
}

pub(crate) async fn runner_requirements(
    state: &AppState,
    project_id: &str,
    issue: &Node,
    group: &Value,
    user: i64,
    selection: &Value,
    automatic: bool,
) -> Result<Value> {
    let mut requirements = serde_json::Map::new();
    let mut intersection: Option<std::collections::BTreeSet<i64>> = None;
    for member in
        std::iter::once(&group["leader"]).chain(group["members"].as_array().into_iter().flatten())
    {
        if member["kind"] != "agent" {
            continue;
        }
        let agent = resolve_agent(state, project_id, &member_id(member)).await?;
        let config = agents::compile(state, &agent, user).await?;
        if !config["execution_policy"].is_object() {
            continue;
        }
        let mut choices = json!({});
        for key in ["execution_policy", "model"] {
            if (key == "execution_policy" && config["execution_policy"]["mode"] == "user_select")
                || (key == "model" && config["model_policy"]["mode"] == "user_select")
            {
                choices[key] = selection[key].clone();
            }
        }
        let route = routing::resolve(
            state, &config, &agent.id, project_id, issue, user, &choices, automatic,
        )
        .await?;
        let candidates =
            routing::candidates_for_snapshot(state, project_id, &agent.id, &route).await?;
        intersection = Some(match intersection {
            None => candidates,
            Some(current) => current.intersection(&candidates).copied().collect(),
        });
        requirements.insert(agent.id, route);
    }
    if intersection.as_ref().is_some_and(|ids| ids.is_empty()) {
        bail!(
            "ISSUE_RUNNER_CONFLICT: No authorized runner satisfies all group members' environment and model policies"
        )
    }
    Ok(Value::Object(requirements))
}

pub(super) async fn assign(
    state: &AppState,
    project: &Node,
    rule: &Node,
    run: &Node,
    id: &str,
    mut context: Value,
) -> Result<()> {
    let group = authorize(state, &project.id, id, rule.created_by_user_id).await?;
    let mut issue = issues::load(state, project, &run.task_id, rule.created_by_user_id).await?;
    authority::require_issue(state, project, &issue, rule.created_by_user_id).await?;
    let key = if issue.metadata.0["collaboration_group"]["id"].as_str() == Some(id) {
        issue.metadata.0["collaboration_group_assignment_key"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| notifications::uuid().replace('-', ""))
    } else {
        notifications::uuid().replace('-', "")
    };
    issue.metadata.0["collaboration_group"] = json!({"id":id,"name":group["name"]});
    issue.metadata.0["collaboration_group_assignment_key"] = json!(key);
    assignments::history(
        &mut issue.metadata.0,
        rule.created_by_user_id,
        "group",
        id,
        group["name"].as_str().unwrap_or(""),
    );
    let mut admission = None;
    if group["leader"]["kind"] == "agent" {
        let leader = resolve_agent(state, &project.id, &member_id(&group["leader"])).await?;
        let config = agents::compile(
            state,
            &leader,
            if leader.created_by_user_id == 0 {
                rule.created_by_user_id
            } else {
                leader.created_by_user_id
            },
        )
        .await?;
        if !matches!(config["runtime"].as_str(), Some("codex" | "claude_code")) {
            bail!("Collaboration group AI must use an Executor runtime")
        }
        let requirements = runner_requirements(
            state,
            &project.id,
            &issue,
            &group,
            rule.created_by_user_id,
            &context["runner_selection"],
            true,
        )
        .await?;
        context["dispatch_kind"] = json!("collaboration_group");
        context["dispatch_id"] = json!(format!("collaboration-group:{id}:{key}"));
        context["dispatch_task_id"] = json!(issue.id);
        context["dispatch_role"] = json!("manager");
        context["manager_agent_id"] = json!(leader.id);
        context["collaboration_group_id"] = json!(id);
        context["assignment_key"] = json!(key);
        context["manager_display_name"] = group["name"].clone();
        context["collaboration_group"] = group.clone();
        context["execution_prompt"] = json!(manager_message(project, &issue, &group)?);
        context["system_prompt"] = json!(MANAGER_INSTRUCTIONS);
        let routed = requirements.as_object().is_some_and(|map| !map.is_empty());
        if routed {
            let route = requirements
                .get(&leader.id)
                .context("Configure the group leader's environment and model policies")?
                .clone();
            context["group_runner_requirements"] = json!(requirements);
            context["runner_routing"] = route;
        }
        let mut plan = Admission {
            owner: if routed || leader.created_by_user_id == 0 {
                rule.created_by_user_id
            } else {
                leader.created_by_user_id
            },
            assigner: rule.created_by_user_id,
            agent_id: String::new(),
            team_id: 0,
            environment: config["execution_environment"]
                .as_str()
                .unwrap_or("local")
                .into(),
            device_id: if routed {
                String::new()
            } else {
                config["execution_device_id"].as_str().unwrap_or("").into()
            },
            runtime_selection: json!({"executor_kind":"collaboration_group_dispatch"}),
            context,
            config,
            requires_approval: false,
            waiting_runtime: false,
        };
        if routed {
            plan.runtime_selection["runner_routing"] = plan.context["runner_routing"].clone();
            plan.runtime_selection["group_runner_requirements"] =
                plan.context["group_runner_requirements"].clone();
        }
        queue::prepare(state, &issue, &mut plan).await?;
        admission = Some(plan);
    }
    let pending=state.mysql.with_transaction(async |tx| {
        let existing=store::locked(tx,"task",&issue.id).await?.ok_or(brz_mysql::MysqlError::RowNotFound)?;
        let _=existing;
        let mut metadata=issue.meta();let revision=metadata["content_revision"].as_i64().unwrap_or(1)+1;metadata["content_revision"]=json!(revision);if !metadata["read_revisions"].is_object(){metadata["read_revisions"]=json!({})}metadata["read_revisions"][rule.created_by_user_id.to_string()]=json!(revision);
        if issue.status!="in_progress" {assignments::status_history(&mut metadata,project,&issue.status,"in_progress",rule.created_by_user_id);let last=metadata["status_history"].as_array_mut().and_then(|rows|rows.last_mut());if let Some(last)=last{last["trigger"]=json!("collaboration_group_assignment");}}
        tx.execute("UPDATE loop_items SET assignee_user_id=0,assignee_agent_id='',assignee_team_id=0,status='in_progress',completed_at=?,sort_order=0,metadata=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(store::UNSET,Json(metadata),issue.id.as_str())).await?;
        if let Some(plan)=admission.as_ref(){
            let existing:Option<Id>=tx.fetch_optional("SELECT id FROM loop_item_executions WHERE loop_item_id=? AND automation_run_id=? ORDER BY id DESC LIMIT 1",(issue.id.as_str(),run.id.as_str())).await?;
            if existing.is_none(){let execution=queue::enqueue_on(tx,state,&issue,run,plan).await?;let payload=json!({"runtime_selection":plan.runtime_selection,"origin_context":plan.context,"dispatch_request":{"kind":"collaboration_group"}});tx.execute("UPDATE loop_item_executions SET execution_payload=? WHERE id=?",(payload.to_string(),execution.id)).await?;}
            tx.execute("UPDATE loop_items SET status='queued',version=version+1 WHERE id=?",(run.id.as_str(),)).await?;Ok(None)
        }else{
            let leader=authority::integer(&group["leader"]["id"]).ok_or_else(||brz_mysql::MysqlError::InvalidQuery{reason:"Collaboration group human leader is invalid".into()})?;
            let mut payload=notifications::target(state,project,&issue,leader).await.map_err(|error|brz_mysql::MysqlError::InvalidQuery{reason:error.to_string()})?;
            let assignment_key=format!("group:{id}:{key}");
            let existing:Option<Id>=tx.fetch_optional("SELECT 1 AS id FROM wework_notifications WHERE user_id=? AND kind='assignment' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.collaborationGroupAssignmentKey'))=? LIMIT 1",(leader,assignment_key.as_str())).await?;
            payload["action"]=json!("coordinate_collaboration_group");payload["issueId"]=json!(issue.id);payload["collaborationGroupId"]=json!(id);payload["collaborationGroupAssignmentKey"]=json!(assignment_key);payload["instructions"]=json!(human_instructions(project,&issue,&group).map_err(|error|brz_mysql::MysqlError::InvalidQuery{reason:error.to_string()})?);
            let pending=if existing.is_none(){Some(notifications::create_on(tx,state,leader,rule.created_by_user_id,"assignment",&format!("请协调：{}",issue.title),"你是该协作小组的负责人。请打开 Issue 分配本轮任务并验收结果。",payload).await?)}else{None};
            tx.execute("UPDATE loop_items SET status='succeeded',completed_at=UTC_TIMESTAMP(6),version=version+1 WHERE id=?",(run.id.as_str(),)).await?;Ok(pending)
        }
    }).await?;
    if let Some(pending) = pending {
        notifications::deliver(state, pending).await;
    }
    Ok(())
}

const MANAGER_INSTRUCTIONS: &str = "You are the manager for one project Issue.\nCoordinate the collaboration group through the project-space management tools.\nAssign one concurrent batch of concrete tasks at a time. Each task must identify\nits assignee and, when configured, its workflow stage. Do not execute member work\nyourself. After every batch finishes, evaluate the evidence and either assign the\nnext batch or explicitly update the Issue status. When updating the Issue status,\nuse the optional comment field of update_issue_status if collaborators need an\nexplanation. Do not publish the same decision again with a separate comment tool;\nthe Executor already records manager and member runs in the Issue activity.";
fn manager_message(project: &Node, issue: &Node, group: &Value) -> Result<String> {
    let rules = json!({"group":{"id":group["id"],"name":group["name"],"description":group["description"],"coordination_mode":group["coordination_mode"]},"group_instructions":group["instructions"],"leader":group["leader"],"members":group["members"],"group_stages":group["stages"],"project_workflow":project.metadata.0.get("workflow_definition").filter(|value|value.is_object()).cloned().unwrap_or(json!({}))});
    Ok(format!(
        "Issue: {}\n\nIssue description:\n{}\n\nProject collaboration rules and workflow:\n{}\n\nCoordinate this Issue with the configured collaboration group. Use the Issue status tool only after you have evaluated the member results.",
        issue.title,
        issue.description,
        serde_json::to_string_pretty(&rules)?
    ))
}
fn human_instructions(project: &Node, issue: &Node, group: &Value) -> Result<String> {
    Ok(format!(
        "{}\n\n协作规则：{}\n\n参考阶段：{}\n\n项目流程：{}\n\n请协调小组成员完成工作，并在验收后更新 Issue 状态。",
        if issue.description.is_empty() {
            &issue.title
        } else {
            &issue.description
        },
        group["instructions"].as_str().unwrap_or(""),
        serde_json::to_string_pretty(&group["stages"])?,
        serde_json::to_string_pretty(
            project
                .metadata
                .0
                .get("workflow_definition")
                .unwrap_or(&json!({}))
        )?
    ))
}
