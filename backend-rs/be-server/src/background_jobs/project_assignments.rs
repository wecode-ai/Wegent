// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Assignment activity, legacy assignee projection and execution admission
//! commit together. Repeated assignments retain the same active activity.

use super::issues::{assignment_status_history, attribute_history, automation_actor};
use super::{
    agents, authority, issues, notifications, profile,
    queue::{self, Admission},
    routing,
    store::{self, Node, iso},
};
use crate::loop_tasks::{
    assignment_index::refresh_active_index,
    assignments::uncancelled_events,
    loop_repository::{CommentRow, item_comments_query},
};
use crate::state::AppState;
use anyhow::{Context, Result};
use brz_mysql::{FromMysqlRow, Json, MysqlTransaction};
use chrono::Utc;
use serde_json::{Value, json};
use wegent_project_scheduler::AssignmentTarget;

pub(crate) async fn agent_admission(
    state: &AppState,
    issue: &Node,
    agent: &Node,
    assigner: i64,
    mut context: Value,
    instruction: &str,
    session_environment_id: Option<&str>,
) -> Result<Admission> {
    authority::require(&state.mysql, &issue.cloud_project_id, assigner).await?;
    let source = context["runtime_source"]
        .as_str()
        .unwrap_or("agent_default")
        .to_owned();
    context
        .as_object_mut()
        .context("Automation context must be an object")?
        .entry("dispatch_role")
        .or_insert(json!("executor"));
    context["execution_prompt"] = json!(instruction);
    let subject = authority::integer(&context["runtime_subject_user_id"])
        .filter(|value| *value != 0)
        .unwrap_or(if issue.assignee_user_id != 0 {
            issue.assignee_user_id
        } else if issue.created_by_user_id != 0 {
            issue.created_by_user_id
        } else {
            assigner
        });
    let config = agents::compile(state, agent, subject).await?;
    let profile_id = if source == "agent_default" {
        config["default_runtime_profile_id"].as_str()
    } else {
        context["runtime_profile_id"].as_str()
    };
    let profile = if let Some(profile_id) = profile_id {
        store::get(&state.mysql, "runtime_profile", profile_id)
            .await?
            .filter(|profile| profile.status == "active")
    } else {
        None
    };
    let profile_metadata = profile.as_ref().map(Node::meta).unwrap_or(json!({}));
    let pick = |key: &str| {
        context
            .get(key)
            .filter(|value| authority::truthy(value))
            .or_else(|| {
                profile_metadata
                    .get(key)
                    .filter(|value| authority::truthy(value))
            })
            .or_else(|| config.get(key))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let model = pick("model");
    let model_type = pick("model_type");
    let options = pick("model_options");
    let runtime = config["runtime"].as_str().unwrap_or("");
    let team_id = authority::integer(&config["wegent_team_id"]).unwrap_or(0);
    let mut owner = profile.as_ref().map_or(subject, |profile| profile.user_id);
    let inherited = profile::inherited(&context);
    let mut device = if runtime == "wegent" {
        String::new()
    } else {
        inherited
            .as_ref()
            .and_then(|value| value["deviceId"].as_str())
            .or_else(|| {
                context["execution_device_id"]
                    .as_str()
                    .filter(|value| !value.is_empty())
            })
            .or_else(|| {
                profile
                    .as_ref()
                    .map(|profile| profile.device_id.as_str())
                    .filter(|value| !value.is_empty())
            })
            .or_else(|| {
                config["execution_device_id"]
                    .as_str()
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or(&agent.device_id)
            .to_owned()
    };
    let environment = if runtime == "wegent" {
        "wegent".into()
    } else if !device.is_empty() && !config["execution_policy"].is_object() {
        profile::environment(&state.mysql, owner, &device).await?
    } else {
        config["execution_environment"]
            .as_str()
            .unwrap_or("local")
            .into()
    };
    let mut selection = json!({"runtime_source":source,"runtime_profile_id":profile.as_ref().map(|profile|&profile.id),"runtime_profile_version":profile.as_ref().map(|profile|profile.version),"model":model,"model_type":model_type,"model_options":if options.is_object(){options}else{json!({})},"capability_mode":config["capability_mode"],"workspace_policy":profile_metadata["workspace_policy"].as_str().unwrap_or("project")});
    if let Some(strategy) = config.get("team_strategy") {
        selection["team_strategy"] = strategy.clone();
    }
    let mut configured_model = model.as_str().unwrap_or("").to_owned();
    if runtime != "wegent" && config["execution_policy"].is_object() {
        let route = routing::resolve(
            state,
            &config,
            &agent.id,
            &issue.cloud_project_id,
            issue,
            assigner,
            &context["runner_selection"],
            authority::truthy(&context["run_id"]),
            session_environment_id,
            false,
        )
        .await?;
        configured_model = route["model"]["model_id"].as_str().unwrap_or("").into();
        selection["runner_routing"] = route;
        selection["model"] = json!(configured_model);
        selection["model_type"] = json!("runtime");
        selection["model_options"] = json!({});
        device.clear();
        owner = assigner;
    }
    let waiting = runtime != "wegent"
        && ((config["capability_mode"] != "follow_device" && configured_model.trim().is_empty())
            || (context.get("workspace_binding").is_some()
                && !context["workspace_binding"].is_object()));
    let mut admission = Admission {
        owner,
        assigner,
        agent_id: agent.id.clone(),
        team_id,
        environment,
        device_id: device,
        context,
        runtime_selection: selection,
        config: config.clone(),
        requires_approval: config["execution_mode"] == "manual_approval",
        waiting_runtime: waiting,
    };
    queue::prepare(state, issue, &mut admission).await?;
    Ok(admission)
}

pub(super) async fn assign(
    state: &AppState,
    project: &Node,
    rule: &Node,
    run: &Node,
    target: AssignmentTarget,
    mut context: Value,
    instruction: &str,
) -> Result<()> {
    let owner = rule.created_by_user_id;
    let automation = automation_actor(&context);
    authority::require(&state.mysql, &project.id, owner).await?;
    let issue = issues::load(&state.project_issues(), project, &run.task_id, owner).await?;
    authority::require_issue(&state.mysql, project, &issue, owner).await?;
    let (kind, id, name, admission, wake_user) = match target {
        AssignmentTarget::Human(user) => {
            authority::require(&state.mysql, &project.id, user)
                .await
                .context("Assignee is not a member of this Project")?;
            #[derive(FromMysqlRow)]
            struct User {
                user_name: String,
            }
            let row: User = state
                .mysql
                .fetch_one(
                    "SELECT user_name FROM users WHERE id=? AND is_active=true",
                    (user,),
                )
                .await?;
            ("human", user.to_string(), row.user_name, None, 0)
        }
        AssignmentTarget::Team(team_id) => {
            let team = authority::team(&state.mysql, &project.id, team_id).await?;
            let mut admission = Admission {
                owner,
                assigner: owner,
                agent_id: String::new(),
                team_id,
                environment: "managed".into(),
                device_id: String::new(),
                context,
                runtime_selection: json!({}),
                config: json!({}),
                requires_approval: false,
                waiting_runtime: false,
            };
            queue::prepare(state, &issue, &mut admission).await?;
            ("team", team_id.to_string(), team.name, Some(admission), 0)
        }
        AssignmentTarget::Agent(agent) => {
            let agent =
                authority::agent(&state.mysql, &project.id, &agent.id, owner, false).await?;
            if context.get("workspace_binding").is_none() {
                context["runtime_source"] = json!("agent_default");
                context["runtime_profile_id"] = Value::Null;
                context["runtime_subject_user_id"] = json!(if agent.created_by_user_id == 0 {
                    owner
                } else {
                    agent.created_by_user_id
                });
            }
            let admission =
                agent_admission(state, &issue, &agent, owner, context, instruction, None).await?;
            let name = if agent.title.is_empty() {
                agent.name.clone()
            } else {
                agent.title.clone()
            };
            (
                "agent",
                agent.id,
                name,
                Some(admission),
                agent.created_by_user_id,
            )
        }
    };
    // External labels are the provider's assignment truth. The index row and
    // activity retain the same task identity for queue/authorization queries.
    if matches!(
        project.metadata.0["task_provider"].as_str(),
        Some("github" | "gitlab")
    ) {
        issues::assign_external(
            &state.project_issues(),
            project,
            &issue,
            kind,
            &id,
            &name,
            owner,
        )
        .await?;
    }
    let notify = true;
    let trigger = if kind == "agent" {
        "manual"
    } else {
        "automation"
    };
    let result=state.mysql.with_transaction(async |tx| {
        let Some(mut issue)=store::locked(tx,"task",&issue.id).await? else{return Err(brz_mysql::MysqlError::RowNotFound)};
        let mut notifications=Vec::new();
        let (assignment_id,created)=record(tx,&issue,kind,&id,&name,owner,notify,trigger,&automation).await?;
        let previous_user=issue.assignee_user_id;
        let mut metadata=issue.meta();
        history(&mut metadata,owner,if kind=="human"{"user"}else{kind},&id,&name);
        attribute_history(&mut metadata, "assignment_history", &automation);
        let revision=metadata["content_revision"].as_i64().filter(|value|*value>0).unwrap_or(1)+1;metadata["content_revision"]=json!(revision);
        if !metadata["read_revisions"].is_object(){metadata["read_revisions"]=json!({})}metadata["read_revisions"][owner.to_string()]=json!(revision);
        let user=if kind=="human"{id.parse::<i64>().unwrap_or(0)}else{0};let team=if kind=="team"{id.parse::<i64>().unwrap_or(0)}else{0};let agent=if kind=="agent"{id.as_str()}else{""};
        let status=if kind!="human"&&issue.status!="completed"&&issue.status!="in_progress"&&has_status(project,"in_progress"){
            assignment_status_history(&mut metadata,project,&issue.status,"in_progress",owner);attribute_history(&mut metadata, "status_history", &automation);"in_progress".to_owned()
        }else{issue.status.clone()};
        tx.execute("UPDATE loop_items SET assignee_user_id=?,assignee_team_id=?,assignee_agent_id=?,status=?,metadata=?,version=version+1,updated_by_user_id=?,updated_at=CURRENT_TIMESTAMP(6) WHERE id=?",(user,team,agent,status.as_str(),Json(metadata.clone()),owner,issue.id.as_str())).await?;
        issue.status=status;issue.metadata=Json(metadata);issue.assignee_user_id=user;issue.assignee_team_id=team;issue.assignee_agent_id=agent.to_owned();
        let execution=if created&&issue.status!="completed" {if let Some(admission)=admission.as_ref(){
            let execution=queue::enqueue_on(tx,state,&issue,run,admission).await?;
            match notifications::execution_on(tx,&state.mysql,project,&issue,execution.id,admission.owner,&execution.status,"").await{Ok(Some(pending))=>notifications.push(pending),Ok(None)=>{},Err(error)=>tracing::error!(%error,"supplementary execution notification failed")}
            Some(execution)
        }else{None}}else{None};
        if kind=="human" {
            if notify&&created&&previous_user!=user && let Some(pending)=notifications::direct_human_on(tx,&state.mysql,project,&issue,user,owner,&name,&assignment_id).await?{notifications.push(pending);}
            tx.execute("UPDATE loop_items SET status='succeeded',completed_at=UTC_TIMESTAMP(6),version=version+1,updated_at=CURRENT_TIMESTAMP(6) WHERE id=?",(run.id.as_str(),)).await?;
        }else{
            let device_id=if let Some(execution)=execution{execution.device_id}else{
                let (device_id,): (String,) = tx.fetch_one(
                    "SELECT execution_device_id FROM loop_item_executions WHERE automation_run_id=? ORDER BY id DESC LIMIT 1",
                    (run.id.as_str(),),
                ).await?;
                device_id
            };
            tx.execute("UPDATE loop_items SET status='queued',assignee_agent_id=?,device_id=?,version=version+1,updated_at=CURRENT_TIMESTAMP(6) WHERE id=?",(agent,device_id.as_str(),run.id.as_str())).await?;
        }
        Ok(notifications)
    }).await?;
    for pending in result {
        notifications::deliver(state, pending).await;
    }
    if wake_user != 0
        && kind == "agent"
        && let Some(redis) = state.redis.as_ref()
    {
        use brz_redis::Redis;
        let hint = crate::socketio_emit::emit_message(
            "queue:task_assigned",
            &json!([{"projectId":project.id,"agentId":id}]).to_string(),
            "/wework-runtime",
            &format!("wework-runtime:user:{wake_user}"),
        );
        if let Err(error) = redis
            .publish(crate::socketio_emit::SOCKETIO_CHANNEL, hint)
            .await
        {
            tracing::debug!(%error,"Robot creator queue wake failed after commit");
        }
    }
    Ok(())
}

// Keep the immutable assignment identity and its notification/trigger policy
// explicit at the transaction boundary shared by individual and group targets.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn record(
    tx: &mut impl MysqlTransaction,
    issue: &Node,
    kind: &str,
    target: &str,
    name: &str,
    owner: i64,
    notify: bool,
    trigger: &str,
    automation: &Value,
) -> brz_mysql::MysqlResult<(String, bool)> {
    let comments = assignment_events_on(tx, issue).await?;
    let canonical = if kind == "human" { "human" } else { "agent" };
    let active = uncancelled_events(&comments);
    let existing = active.iter().rev().find(|comment| {
        comment.metadata.target_type.as_deref() == Some(canonical)
            && comment.metadata.target_id.as_deref() == Some(target)
            && comment
                .metadata
                .workflow_step
                .as_deref()
                .unwrap_or("")
                .is_empty()
    });
    if let Some(existing) = existing
        && (existing.metadata.trigger.as_deref() != Some("default") || trigger == "default")
    {
        refresh_active_index(tx, &issue.id).await?;
        return Ok((existing.comment.id.clone(), false));
    }
    if canonical == "human" {
        for previous in active {
            if !previous
                .metadata
                .workflow_step
                .as_deref()
                .unwrap_or("")
                .is_empty()
            {
                continue;
            }
            cancel_assignment(tx, issue, owner, &previous).await?;
        }
    }
    let id = append_assignment(
        tx,
        issue,
        owner,
        (canonical, target, name),
        notify,
        trigger,
        automation,
    )
    .await?;
    refresh_active_index(tx, &issue.id).await?;
    Ok((id, true))
}

pub(crate) async fn clear_human_assignment(
    tx: &mut impl MysqlTransaction,
    issue: &Node,
    owner: i64,
) -> brz_mysql::MysqlResult<()> {
    let comments = assignment_events_on(tx, issue).await?;
    let mut changed = false;
    for previous in uncancelled_events(&comments) {
        if previous.metadata.target_type.as_deref() == Some("human")
            && previous
                .metadata
                .workflow_step
                .as_deref()
                .unwrap_or("")
                .is_empty()
        {
            cancel_assignment(tx, issue, owner, &previous).await?;
            changed = true;
        }
    }
    if changed {
        refresh_active_index(tx, &issue.id).await?;
    }
    Ok(())
}

async fn assignment_events_on(
    tx: &mut impl MysqlTransaction,
    issue: &Node,
) -> brz_mysql::MysqlResult<Vec<CommentRow>> {
    tx.fetch_all(
        format!("{} FOR UPDATE", item_comments_query()),
        (issue.id.as_str(),),
    )
    .await
}

async fn cancel_assignment(
    tx: &mut impl MysqlTransaction,
    issue: &Node,
    owner: i64,
    previous: &wegent_project_coordination::loop_tasks::assignment_events::ActiveEvent<'_>,
) -> brz_mysql::MysqlResult<()> {
    insert_assignment(tx, issue, owner, json!({
        "event_type":"assignment", "action":"unassign", "assignment_event_id":previous.comment.id,
        "target_type":previous.metadata.target_type, "target_id":previous.metadata.target_id,
        "workflow_step":"", "notify":false, "trigger":"reassignment"
    })).await?;
    Ok(())
}

async fn insert_assignment(
    tx: &mut impl MysqlTransaction,
    issue: &Node,
    owner: i64,
    metadata: Value,
) -> brz_mysql::MysqlResult<String> {
    store::insert(tx, "comment", json!({
        "cloud_project_id":issue.cloud_project_id, "loop_item_id":issue.id,
        "created_by_user_id":owner, "updated_by_user_id":owner, "status":"active", "metadata":metadata
    })).await
}

async fn append_assignment(
    tx: &mut impl MysqlTransaction,
    issue: &Node,
    owner: i64,
    (kind, target, name): (&str, &str, &str),
    notify: bool,
    trigger: &str,
    automation: &Value,
) -> brz_mysql::MysqlResult<String> {
    insert_assignment(tx, issue, owner, json!({
        "event_type":"assignment", "action":"assign", "target_type":kind, "target_id":target,
        "target_name":name, "workflow_step":"", "notify":notify, "trigger":trigger, "automation":automation
    })).await
}

pub(crate) async fn record_manual_human(
    tx: &mut impl MysqlTransaction,
    issue: &Node,
    actor: i32,
    assignee: i32,
    notify: bool,
    fresh_issue: bool,
) -> brz_mysql::MysqlResult<String> {
    let (name,): (String,) = tx
        .fetch_one("SELECT user_name FROM users WHERE id=?", (assignee,))
        .await?;
    let target = assignee.to_string();
    let (assignment, created) = if fresh_issue {
        let id = append_assignment(
            tx,
            issue,
            i64::from(actor),
            ("human", &target, &name),
            notify,
            "manual",
            &Value::Null,
        )
        .await?;
        wegent_project_participation::assignment_index::initialize_first_assignment(
            tx, &issue.id, &id,
        )
        .await?;
        (id, true)
    } else {
        record(
            tx,
            issue,
            "human",
            &target,
            &name,
            i64::from(actor),
            notify,
            "manual",
            &Value::Null,
        )
        .await?
    };
    if notify && created {
        crate::stand_in_issue_events::enqueue_assignment_on(
            tx,
            i64::from(assignee),
            &issue.cloud_project_id,
            &issue.id,
            &assignment,
        )
        .await?;
    }
    Ok(assignment)
}

pub(super) fn history(metadata: &mut Value, user: i64, kind: &str, id: &str, name: &str) {
    let mut history = metadata["assignment_history"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    history.push(json!({"by_user_id":user,"to_type":kind,"to_id":id,"to_name":name,"action":if history.is_empty(){"assign"}else{"reassign"},"at":iso(Utc::now().naive_utc())}));
    metadata["assignment_history"] = json!(history);
}
pub(crate) fn has_status(project: &Node, status: &str) -> bool {
    project.metadata.0["board_config"]["statuses"]
        .as_array()
        .map_or(
            matches!(
                status,
                "inbox" | "pending" | "in_progress" | "in_review" | "completed"
            ),
            |values| values.iter().any(|value| value["id"] == status),
        )
}
#[cfg(test)]
mod attribution_tests {
    use super::*;

    #[test]
    fn snapshots_rule_without_changing_authorizing_user_or_older_history() {
        let context = json!({"rule_id":"rule-1","rule_name":"Review new Issues","run_id":"run-1"});
        let mut metadata = json!({"assignment_history":[{"by_user_id":7}]});
        history(&mut metadata, 52, "agent", "agent-1", "Leader");
        attribute_history(
            &mut metadata,
            "assignment_history",
            &automation_actor(&context),
        );
        assert!(
            metadata["assignment_history"][0]
                .get("automation")
                .is_none()
        );
        assert_eq!(metadata["assignment_history"][1]["by_user_id"], 52);
        assert_eq!(metadata["assignment_history"][1]["automation"], context);
        assert!(automation_actor(&json!({"runtime_subject_user_id":52})).is_null());
    }
}
