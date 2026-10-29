//! Prepare committed assignment intents; configuration failures belong to that run.

use anyhow::{Context, Result, bail};
use brz_mysql::MysqlTransaction;
use serde_json::{Value, json};

use super::super::project::{
    assignments, authority as grants, profile, queue,
    store::{self, Node},
};
use super::{
    authority,
    model::{COLUMNS, Execution},
    projection, state,
};
use crate::AppState;

pub(super) async fn prepare(app: &AppState) -> Result<usize> {
    let rows:Vec<Execution>=app.mysql.fetch_all(format!("SELECT {COLUMNS} FROM loop_item_executions WHERE status='queued' AND JSON_TYPE(JSON_EXTRACT(CASE WHEN JSON_VALID(execution_payload) THEN execution_payload ELSE '{{}}' END,'$.runtime_selection.assignment_request'))='OBJECT' ORDER BY id"),()).await?;
    let mut prepared = 0;
    for row in rows {
        if prepared >= 100 {
            break;
        }
        if !authority::authorized(app, &row).await? {
            state::cancel(app, &row, "Execution authorization revoked").await?;
            continue;
        }
        match plan(app, &row).await {
            Ok(None) => continue,
            Ok(Some(plan)) => {
                let messages=app.mysql.with_transaction(async|tx|{
                    // Preserve the Issue -> execution lock order used by claims.
                    let issue:Option<Node>=tx.fetch_optional(format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='task' FOR UPDATE SKIP LOCKED",store::COLUMNS),(row.loop_item_id.as_str(),)).await?;
                    if issue.is_none(){return Ok(projection::Effects::default());}
                    let current:Option<Execution>=tx.fetch_optional(format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=? AND status='queued' FOR UPDATE"),(row.id,)).await?;
                    let Some(current)=current.filter(|current|current.version==row.version&&current.assignment_pending())else{return Ok(projection::Effects::default());};
                    let mut update=current;
                    if let Some(runtime)=plan.runtime_device.as_ref(){update.runtime_device_id=runtime.clone();}
                    let message=state::prepared_on(tx,app,&update,&plan.status,&plan.payload,plan.owner,plan.team,&plan.environment,&plan.device).await?;
                    Ok(message)
                }).await?;
                projection::publish(app, messages).await?;
            }
            Err(error) => {
                if authority::infrastructure(&error) {
                    return Err(error);
                }
                state::fail_preparation(app, &row, &error.to_string()).await?;
            }
        }
        prepared += 1;
    }
    Ok(prepared)
}

struct Plan {
    owner: i64,
    team: i64,
    environment: String,
    device: String,
    status: String,
    payload: Value,
    runtime_device: Option<String>,
}

async fn plan(app: &AppState, row: &Execution) -> Result<Option<Plan>> {
    let selection = row.selection();
    let request = &selection["assignment_request"];
    let issue = store::get(&app.mysql, "task", &row.loop_item_id)
        .await?
        .context("Issue unavailable")?;
    let agent = grants::agent(
        app,
        &row.cloud_project_id,
        &row.agent_id,
        row.assigner_user_id,
        true,
    )
    .await?;
    if agent.metadata.0["execution_mode"] == "manual_approval" && row.approval_status != "approved"
    {
        return Ok(Some(Plan {
            owner: row.executor_owner_user_id,
            team: row.team_id,
            environment: row.execution_environment.clone(),
            device: row.execution_device_id.clone(),
            status: "pending_approval".to_owned(),
            payload: row.intent(),
            runtime_device: None,
        }));
    }
    let mut context = row.context();
    let continuation = if request["continuation"].is_null() {
        None
    } else {
        let Some(source) = continuation(
            app,
            row,
            &issue,
            &agent,
            &request["continuation"],
            &mut context,
        )
        .await?
        else {
            return Ok(None);
        };
        Some(source)
    };
    let instruction = context["execution_prompt"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let mut plan = assignments::agent_admission(
        app,
        &issue,
        &agent,
        row.assigner_user_id,
        context,
        &instruction,
    )
    .await?;
    if plan.device_id.is_empty()
        && !plan.runtime_selection["runner_routing"].is_object()
        && plan.environment != "wegent"
    {
        if let Some(device) = request["execution_device_id"]
            .as_str()
            .filter(|device| !device.is_empty())
        {
            plan.device_id = device.to_owned();
            plan.environment = profile::environment(app, plan.owner, device).await?;
        } else if let Some(environment) = request["environment"].as_str() {
            plan.environment = environment.to_owned();
        }
    }
    queue::prepare(app, &issue, &mut plan).await?;
    if !plan.device_id.is_empty()
        && let Some(identity) = crate::device_identity::resolve_runtime_route_identity(
            &app.mysql,
            plan.owner,
            &plan.device_id,
        )
        .await?
    {
        plan.device_id = identity.runtime_device_id;
    }
    if continuation.is_some() && plan.context["dispatch_role"] == "manager" {
        plan.runtime_selection["group_runner_requirements"] =
            super::super::project::groups::runner_requirements(
                app,
                &row.cloud_project_id,
                &issue,
                &plan.context["collaboration_group"],
                row.assigner_user_id,
                &plan.context["runner_selection"],
                false,
            )
            .await?;
    }
    let status = if plan.waiting_runtime {
        "waiting_runtime"
    } else {
        "queued"
    };
    let mut payload = json!({"schema_version":2,"runtime_selection":plan.runtime_selection,"origin_context":plan.context});
    let mut runtime_device = None;
    let mut owner = plan.owner;
    if let Some(source) = continuation {
        owner = source.owner;
        runtime_device = Some(source.device.clone());
        payload["runtime_request"] = continued_request(row.id, &source, &plan.context)?;
    } else if !plan.device_id.is_empty() {
        let existing = row.intent()["runtime_request"].clone();
        payload["runtime_request"] =
            if existing.is_object() && !existing.as_object().unwrap().is_empty() {
                existing
            } else {
                profile::build(app, &issue, row.id, &plan).await?
            };
    }
    Ok(Some(Plan {
        owner,
        team: plan.team_id,
        environment: plan.environment,
        device: plan.device_id,
        status: status.to_owned(),
        payload,
        runtime_device,
    }))
}

struct Continuation {
    owner: i64,
    device: String,
    task: String,
    request: Value,
}

async fn continuation(
    app: &AppState,
    row: &Execution,
    issue: &Node,
    agent: &Node,
    source: &Value,
    context: &mut Value,
) -> Result<Option<Continuation>> {
    let mut source = source.clone();
    if let Some(id) = grants::integer(&source["execution_id"]).filter(|id| *id != 0) {
        let original: Execution = app
            .mysql
            .fetch_optional(
                format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=?"),
                (id,),
            )
            .await?
            .context("The original execution is unavailable")?;
        if original.cloud_project_id != row.cloud_project_id
            || original.loop_item_id != row.loop_item_id
        {
            bail!("The original session belongs to another Issue")
        }
        if original.runtime_device_id.is_empty()
            && matches!(
                original.status.as_str(),
                "queued" | "pending_approval" | "waiting_runtime"
            )
        {
            return Ok(None);
        }
        source["owner_user_id"] = json!(original.executor_owner_user_id);
        source["runtime_device_id"] = json!(original.runtime_device_id);
        source["runtime_request"] = original.intent()["runtime_request"].clone();
        source["runtime_selection"] = original.selection();
    }
    let binding=super::super::project::routing::issue_binding(app,issue).await?.context("ISSUE_RUNNER_CONFIGURATION_REQUIRED: The original session's environment must be restored before replying")?;
    let owner = grants::integer(&source["owner_user_id"]).context("Original owner unavailable")?;
    let device = source["runtime_device_id"]
        .as_str()
        .filter(|value| !value.is_empty())
        .context("Original environment unavailable")?;
    let active = crate::device_identity::resolve_owned_device_alias(&app.mysql, owner, device)
        .await?
        .context("Original environment unavailable")?;
    if active.id.to_string() != binding {
        bail!(
            "ISSUE_RUNNER_CONFLICT: The comment session belongs to a different environment than this Issue"
        )
    }
    let request = &source["runtime_request"];
    if !request.is_object() || request.as_object().unwrap().is_empty() {
        bail!("The original execution configuration is unavailable")
    }
    context["runtime_subject_user_id"] = json!(owner);
    if !context["runner_selection"].is_object() {
        context["runner_selection"] = json!({});
    }
    let config = &agent.metadata.0;
    if config["execution_policy"]["mode"] == "user_select"
        && context["runner_selection"]["execution_policy"].is_null()
    {
        context["runner_selection"]["execution_policy"] =
            json!({"mode":"fixed","environment_id":binding});
    }
    if config["model_policy"]["mode"] == "user_select"
        && context["runner_selection"]["model"].is_null()
    {
        context["runner_selection"]["model"] =
            source["runtime_selection"]["runner_routing"]["model"].clone();
    }
    if context["dispatch_kind"] == "collaboration_group" {
        let id = grants::integer(&context["collaboration_dispatch_execution_id"])
            .context("The collaboration dispatch is unavailable")?;
        let dispatch: Execution = app
            .mysql
            .fetch_optional(
                format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=?"),
                (id,),
            )
            .await?
            .context("The collaboration dispatch is unavailable")?;
        if dispatch.selection()["executor_kind"] != "collaboration_group_dispatch"
            || dispatch.cloud_project_id != row.cloud_project_id
            || dispatch.loop_item_id != row.loop_item_id
            || dispatch.context()["dispatch_id"] != context["dispatch_id"]
        {
            bail!("The collaboration dispatch is unavailable")
        }
        if !authority::authorized(app, &dispatch).await? {
            bail!("The collaboration dispatch authorization was revoked")
        }
    }
    Ok(Some(Continuation {
        owner,
        device: device.to_owned(),
        task: source["runtime_task_id"]
            .as_str()
            .context("Original session identity unavailable")?
            .to_owned(),
        request: request.clone(),
    }))
}

fn continued_request(execution_id: i64, source: &Continuation, context: &Value) -> Result<Value> {
    let mut request = source.request.clone();
    // Preserve the materialized model/workspace identity of the original session.
    let message = context["comment_prompt"]
        .as_str()
        .filter(|value| !value.is_empty())
        .context("Comment message unavailable")?;
    request["message"] = json!(message);
    request["newSession"] = json!(false);
    request["deviceId"] = json!(source.device);
    request["taskId"] = json!(source.task);
    request["attachmentIds"] = json!([]);
    request["attachments"] = context.get("attachments").cloned().unwrap_or(json!([]));
    let mut origin = request["origin"].as_object().cloned().unwrap_or_default();
    if let Some(context) = context.as_object() {
        origin.extend(context.clone());
    }
    origin.insert("type".into(), json!("board_comment"));
    origin.insert("executionId".into(), json!(execution_id));
    request["origin"] = json!(origin);
    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_reuses_the_original_session_and_configuration_with_fresh_comment_input() {
        let source = Continuation {
            owner: 7,
            device: "original-device".into(),
            task: "original-task".into(),
            request: json!({"schemaVersion":2,"runtime":"codex","message":"old prompt","newSession":true,
                "modelSelection":{"modelName":"model-a"},"workspacePath":"/project","attachmentIds":[4],
                "origin":{"cloudProjectId":"9","type":"board_task"}}),
        };
        let context = json!({"comment_prompt":"new reply","attachments":[{"id":5}],"comment_trigger_message_id":"comment-1"});
        let request = continued_request(23, &source, &context).unwrap();
        assert_eq!(request["taskId"], "original-task");
        assert_eq!(request["deviceId"], "original-device");
        assert_eq!(request["newSession"], false);
        assert_eq!(request["message"], "new reply");
        assert_eq!(request["modelSelection"]["modelName"], "model-a");
        assert_eq!(request["workspacePath"], "/project");
        assert_eq!(request["attachmentIds"], json!([]));
        assert_eq!(request["attachments"], json!([{"id":5}]));
        assert_eq!(request["origin"]["cloudProjectId"], "9");
        assert_eq!(request["origin"]["executionId"], 23);
        assert_eq!(request["origin"]["type"], "board_comment");
    }
}
