//! A locked Issue serializes acceptance, retries and cancellation decisions.

use brz_mysql::{MysqlResult, MysqlTransaction};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    Action, RequestRow, enabled, model, optional_request_on, reject, request_on, rows_on, view_on,
};
use crate::background_jobs::project::completion::Message;
use crate::background_jobs::project::{queue, store};
use crate::background_jobs::robot::{self, model::Execution};
use crate::loop_tasks::{
    assignments::active_events,
    loop_repository::{CommentRow, item_comments_query},
};
use crate::plugins_marketplace::query::PluginQuery;
use crate::socketio::personal_assistant_dispatch;

async fn assignment_on(
    query: &mut impl PluginQuery,
    issue: &store::Node,
    owner: i64,
) -> MysqlResult<Value> {
    if issue.assignee_user_id != owner
        || matches!(issue.status.as_str(), "completed" | "cancelled" | "deleted")
    {
        return Err(reject(409, "Issue assignment is no longer active"));
    }
    let comments: Vec<CommentRow> = query
        .fetch_all(
            format!("{} FOR UPDATE", item_comments_query()),
            (issue.id.as_str(),),
        )
        .await?;
    let owner_id = owner.to_string();
    let assignment = active_events(&comments)
        .into_iter()
        .find(|event| {
            matches!(
                event.metadata.target_type.as_deref(),
                Some("human" | "user")
            ) && event.metadata.target_id.as_deref() == Some(owner_id.as_str())
                && event
                    .metadata
                    .workflow_step
                    .as_deref()
                    .is_none_or(str::is_empty)
                && event.metadata.human_assistant_dispatch.is_some()
        })
        .ok_or_else(|| reject(409, "Default assistant assignment is unavailable"))?;
    let dispatch = assignment
        .metadata
        .human_assistant_dispatch
        .as_ref()
        .expect("present dispatch");
    Ok(
        json!({"assignment_id":assignment.comment.id,"assignment_version":assignment.metadata.assignment_version,
        "human_assistant_dispatch":dispatch["dispatchId"],"owner_user_id":owner,
        "stand_in_id":"@primary","publish_policy":"summary_and_evidence_only"}),
    )
}

pub(super) async fn require_assignment_on(
    query: &mut impl PluginQuery,
    issue: &store::Node,
    owner: i64,
    context: &Value,
) -> MysqlResult<()> {
    let current = assignment_on(query, issue, owner).await?;
    if current["assignment_id"] != context["assignment_id"]
        || current["assignment_version"] != context["assignment_version"]
        || current["human_assistant_dispatch"] != context["human_assistant_dispatch"]
    {
        return Err(reject(
            409,
            "Assistant request assignment is no longer current",
        ));
    }
    let active: Option<(i64,)> = query
        .fetch_optional(
            "SELECT id FROM users WHERE id=? AND is_active=true",
            (owner,),
        )
        .await?;
    if active.is_none() {
        return Err(reject(403, "Assistant request owner is unavailable"));
    }
    Ok(())
}

#[tracing::instrument(name = "collaboration.assistant_request.action", skip_all, fields(issue_id = %issue.id, owner_id = owner, action = %action.action))]
pub(super) async fn act_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    owner: i64,
    action: &Action,
) -> MysqlResult<(Value, Vec<Execution>, Option<Message>)> {
    if action.action == "new_request" {
        let id = model::request_id(
            &issue.cloud_project_id,
            &issue.id,
            owner,
            &action.idempotency_key,
        );
        if let Some(previous) = optional_request_on(
            &mut &mut *tx,
            &issue.cloud_project_id,
            &issue.id,
            owner,
            &id,
        )
        .await?
        {
            if previous.intent()["assistant_request"]["creationFingerprint"] != action.fingerprint()
            {
                return Err(reject(
                    409,
                    "Idempotency key already belongs to a different request",
                ));
            }
            return Ok((view_on(&mut &mut *tx, &previous).await?, vec![], None));
        }
        if !enabled() {
            return Err(reject(409, "Asynchronous assistant requests are disabled"));
        }
        let parent = if let Some(parent) = action.parent_request_id.as_deref() {
            request_on(
                &mut &mut *tx,
                &issue.cloud_project_id,
                &issue.id,
                owner,
                parent,
            )
            .await?;
            Some(parent.to_owned())
        } else {
            rows_on(&mut &mut *tx, &issue.cloud_project_id, &issue.id, owner)
                .await?
                .into_iter()
                .find(|row| !row.terminal())
                .and_then(|row| {
                    row.intent()["assistant_request"]["requestId"]
                        .as_str()
                        .map(str::to_owned)
                })
        };
        let (created, message) = create_on(tx, issue, owner, action, &id, parent, None).await?;
        return Ok((
            view_on(&mut &mut *tx, &created).await?,
            vec![],
            Some(message),
        ));
    }
    let id = action
        .request_id
        .as_deref()
        .expect("validated request identity");
    let mut row = request_on(&mut &mut *tx, &issue.cloud_project_id, &issue.id, owner, id).await?;
    let mut intent = row.intent();
    let key = model::digest(&action.idempotency_key);
    if let Some(record) = intent["assistant_request"]["actions"].get(&key) {
        if record["fingerprint"] != action.fingerprint() {
            return Err(reject(
                409,
                "Idempotency key already belongs to another action",
            ));
        }
        let target = record["requestId"].as_str().unwrap_or(id);
        let previous = request_on(
            &mut &mut *tx,
            &issue.cloud_project_id,
            &issue.id,
            owner,
            target,
        )
        .await?;
        return Ok((view_on(&mut &mut *tx, &previous).await?, vec![], None));
    }
    let mut cancellations = Vec::new();
    let mut target = id.to_owned();
    let mut message = None;
    match action.action.as_str() {
        "followup" => {
            if row.status == "cancel_requested" {
                return Err(reject(
                    409,
                    "The previous request attempt is still stopping",
                ));
            }
            require_assignment_on(&mut &mut *tx, issue, owner, &intent["origin_context"]).await?;
            if row.terminal() {
                let endpoint = personal_assistant_dispatch::request_endpoint_on(tx, issue, owner)
                    .await?
                    .ok_or_else(|| reject(403, "Default assistant is not authorized"))?;
                intent["assistant_request"]["actions"][&key] =
                    json!({"fingerprint":action.fingerprint(),"requestId":id});
                intent["assistant_request"]["attemptMessage"] = json!(action.message);
                intent["assistant_request"]["attemptCommandId"] = json!(format!("{id}-{key}"));
                intent["assistant_request"]["attemptClientUserMessageId"] =
                    json!(action.client_user_message_id);
                let resumed = enqueue_on(tx, issue, owner, id, &endpoint, &intent).await?;
                return Ok((view_on(&mut &mut *tx, &resumed).await?, vec![], None));
            }
            let route = if row.runtime_device_id.is_empty() {
                &row.execution_device_id
            } else {
                &row.runtime_device_id
            };
            let permitted = personal_assistant_dispatch::endpoint_permitted_on(
                &mut &mut *tx,
                owner,
                route,
                &issue.cloud_project_id,
                &issue.metadata.0["tags"],
            )
            .await
            .map_err(|error| brz_mysql::MysqlError::InvalidQuery {
                reason: error.to_string(),
            })?;
            if !permitted {
                return Err(reject(
                    403,
                    "Default assistant authorization is unavailable",
                ));
            }
            let commands = intent["assistant_request"]["commands"]
                .as_array_mut()
                .ok_or_else(|| reject(409, "Request commands are unavailable"))?;
            commands.push(json!({"id":format!("{id}-{key}"),"action":"followup","executionId":row.id.to_string(),"message":action.message,"clientUserMessageId":action.client_user_message_id,"acknowledged":false}));
        }
        "cancel" => cancel_on(tx, &mut row, &mut cancellations).await?,
        "prepare_merge" => {
            if row.status != "completed" {
                return Err(reject(
                    409,
                    "Only completed requests can prepare merge evidence",
                ));
            }
            require_assignment_on(&mut &mut *tx, issue, owner, &intent["origin_context"]).await?;
            personal_assistant_dispatch::request_endpoint_on(tx, issue, owner)
                .await?
                .ok_or_else(|| reject(403, "Default assistant is not authorized"))?;
            let commands = intent["assistant_request"]["commands"]
                .as_array_mut()
                .ok_or_else(|| reject(409, "Request commands are unavailable"))?;
            commands.push(json!({"id":format!("{id}-{key}"),"action":"prepare_merge","executionId":row.id.to_string(),"acknowledged":false}));
        }
        "retry" => {
            if !matches!(row.status.as_str(), "failed" | "cancelled") {
                return Err(reject(
                    409,
                    "Only failed or cancelled requests can be retried",
                ));
            }
            let endpoint = personal_assistant_dispatch::request_endpoint_on(tx, issue, owner)
                .await?
                .ok_or_else(|| reject(403, "Default assistant is not authorized"))?;
            require_assignment_on(&mut &mut *tx, issue, owner, &intent["origin_context"]).await?;
            intent["assistant_request"]["actions"][&key] =
                json!({"fingerprint":action.fingerprint(),"requestId":id});
            intent["assistant_request"]["retry"] = json!(true);
            intent["assistant_request"]["attemptCommandId"] = Value::Null;
            intent["assistant_request"]["attemptClientUserMessageId"] = Value::Null;
            let execution = enqueue_on(tx, issue, owner, id, &endpoint, &intent).await?;
            return Ok((view_on(&mut &mut *tx, &execution).await?, vec![], None));
        }
        "replace" => {
            if !enabled() {
                return Err(reject(409, "Asynchronous assistant requests are disabled"));
            }
            // Revalidate before cancelling so an invalid replacement cannot stop valid work.
            personal_assistant_dispatch::request_endpoint_on(tx, issue, owner)
                .await?
                .ok_or_else(|| reject(403, "Default assistant is not authorized"))?;
            assignment_on(&mut &mut *tx, issue, owner).await?;
            target = model::request_id(
                &issue.cloud_project_id,
                &issue.id,
                owner,
                &action.idempotency_key,
            );
            cancel_on(tx, &mut row, &mut cancellations).await?;
            message = Some(
                create_on(
                    tx,
                    issue,
                    owner,
                    action,
                    &target,
                    Some(id.to_owned()),
                    Some(id),
                )
                .await?
                .1,
            );
        }
        _ => return Err(reject(422, "Unsupported request action")),
    }
    intent["assistant_request"]["actions"][&key] =
        json!({"fingerprint":action.fingerprint(),"requestId":target});
    save_on(tx, &mut row, &intent).await?;
    let latest = request_on(
        &mut &mut *tx,
        &issue.cloud_project_id,
        &issue.id,
        owner,
        &target,
    )
    .await?;
    let response = view_on(&mut &mut *tx, &latest).await?;
    Ok((response, cancellations, message))
}

pub(super) async fn create_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    owner: i64,
    action: &Action,
    id: &str,
    parent: Option<String>,
    dependency: Option<&str>,
) -> MysqlResult<(RequestRow, Message)> {
    if optional_request_on(&mut &mut *tx, &issue.cloud_project_id, &issue.id, owner, id)
        .await?
        .is_some()
    {
        return Err(reject(409, "Idempotency key already belongs to a request"));
    }
    let endpoint = personal_assistant_dispatch::request_endpoint_on(tx, issue, owner)
        .await?
        .ok_or_else(|| reject(403, "Default assistant is not authorized for this Issue"))?;
    let mut context = assignment_on(&mut &mut *tx, issue, owner).await?;
    context["assistant_request_id"] = json!(id);
    context["comment_continue_task_id"] = json!(format!("assistant-request-{id}"));
    let binding = crate::loop_tasks::human_task_binding::direct_task_binding(
        &issue.id,
        context["assignment_id"]
            .as_str()
            .expect("assignment identity"),
    );
    let request = json!({"requestId":id,"parentRequestId":parent,"message":action.message,
        "attemptMessage":action.message,"attemptClientUserMessageId":action.client_user_message_id,
        "humanAssignmentId":binding["humanAssignmentId"],"creationFingerprint":action.fingerprint(),
        "commands":[],"actions":{},"dependencyRequestId":dependency});
    let intent = json!({"schema_version":2,"runtime_selection":{"executor_kind":"human_assistant"},
        "origin_context":context,"assistant_request":request});
    let row = enqueue_on(tx, issue, owner, id, &endpoint, &intent).await?;
    let message = receipt_on(tx, issue, owner, id).await?;
    Ok((row, message))
}

async fn enqueue_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    owner: i64,
    request: &str,
    endpoint: &str,
    intent: &Value,
) -> MysqlResult<RequestRow> {
    let input = queue::Admission {
        owner,
        assigner: owner,
        agent_id: String::new(),
        team_id: 0,
        environment: "local".into(),
        device_id: endpoint.into(),
        context: intent["origin_context"].clone(),
        runtime_selection: json!({"executor_kind":"human_assistant"}),
        config: json!({}),
        requires_approval: false,
        waiting_runtime: true,
    };
    let scope = format!("assistant-request:{request}");
    let execution = queue::enqueue_intent_on(tx, issue, None, &scope, &input).await?;
    let mut intent = intent.clone();
    if intent["assistant_request"]["attemptCommandId"]
        .as_str()
        .is_none_or(str::is_empty)
    {
        intent["assistant_request"]["attemptCommandId"] =
            json!(format!("assistant-start:{}", execution.id));
    }
    tx.execute("UPDATE loop_item_executions SET execution_payload=?,max_retries=0,execution_note='Waiting for the authorized default assistant' WHERE id=?",(intent.to_string(),execution.id)).await?;
    request_on(
        &mut &mut *tx,
        &issue.cloud_project_id,
        &issue.id,
        owner,
        request,
    )
    .await
}

pub(super) async fn save_on(
    tx: &mut impl MysqlTransaction,
    row: &mut RequestRow,
    intent: &Value,
) -> MysqlResult<()> {
    tx.execute("UPDATE loop_item_executions SET execution_payload=?,updated_at=UTC_TIMESTAMP(6),version=version+1 WHERE id=?",(intent.to_string(),row.id)).await?;
    row.execution_payload = intent.to_string();
    Ok(())
}

async fn cancel_on(
    tx: &mut impl MysqlTransaction,
    row: &mut RequestRow,
    effects: &mut Vec<Execution>,
) -> MysqlResult<()> {
    if row.terminal() || row.status == "cancel_requested" {
        return Ok(());
    }
    let mut execution: Execution = tx
        .fetch_optional(
            format!(
                "SELECT {} FROM loop_item_executions WHERE id=? FOR UPDATE",
                robot::model::COLUMNS
            ),
            (row.id,),
        )
        .await?
        .ok_or_else(|| reject(404, "Execution not found"))?;
    let next = if execution.can_cancel_without_runtime() {
        "cancelled"
    } else {
        "cancel_requested"
    };
    if next == "cancelled" {
        tx.execute("UPDATE loop_item_executions SET status='cancelled',cancel_requested_at=UTC_TIMESTAMP(6),completed_at=UTC_TIMESTAMP(6),lease_expires_at='1970-01-01 00:00:01',observed_state='cancelled',observed_at=UTC_TIMESTAMP(6),sync_state='in_sync',termination_reason='cancelled_before_start',error_message='',version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(row.id,)).await?;
    } else {
        tx.execute("UPDATE loop_item_executions SET status='cancel_requested',cancel_requested_at=UTC_TIMESTAMP(6),termination_reason='user_cancelled',sync_state='pending',version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(row.id,)).await?;
    }
    row.status = next.into();
    if next == "cancel_requested" {
        execution.status = next.into();
        effects.push(execution);
    }
    Ok(())
}

/// Only a compact, deliberately public receipt enters the parent timeline.
async fn receipt_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    owner: i64,
    request: &str,
) -> MysqlResult<Message> {
    use crate::socketio::project_chat_messages::{
        INSERT_MESSAGE_SQL, InsertMessage, insert_message_args,
    };
    let name: Option<(String,)> = tx
        .fetch_optional(
            "SELECT user_name FROM users WHERE id=? AND is_active=true",
            (owner,),
        )
        .await?;
    let name = name
        .ok_or_else(|| reject(403, "Assistant owner is unavailable"))?
        .0;
    let key = format!("assistant-request-receipt:{request}");
    let metadata = receipt_metadata(request, owner);
    let content = format!("Request {request}: accepted");
    tx.execute(
        INSERT_MESSAGE_SQL,
        insert_message_args(&InsertMessage {
            message_id: &key,
            client_message_id: &key,
            project_id: &issue.cloud_project_id,
            task_id: &issue.id,
            sender_type: "user",
            sender_id: &owner.to_string(),
            sender_name: &name,
            message_type: "text",
            content: &content,
            metadata,
            trigger_message_id: "",
            reply_to_message_id: "",
            thread_root_message_id: "",
            agent_id: "",
            runtime_device_id: "",
            runtime_task_id: "",
            runtime_activity_key: "",
            status: "completed",
        }),
    )
    .await?;
    tx.fetch_optional(
        "SELECT * FROM project_chat_messages WHERE message_id=?",
        (key.as_str(),),
    )
    .await?
    .ok_or_else(|| reject(409, "Accepted receipt was not persisted"))
}

fn receipt_metadata(request: &str, owner: i64) -> Value {
    json!({"activity_type":"assistant_request_receipt","request_id":request,"state":"accepted",
        "execution_entry":{"requestId":request},
        "provenance":{"origin":"ai_generated","owner_user_id":owner,"publisher_user_id":owner,"confirmation_status":"unconfirmed"}})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct MergeApproval {
    idempotency_key: String,
    target_revision: String,
    candidate_revision: String,
}

impl MergeApproval {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.idempotency_key.trim().is_empty() || self.idempotency_key.len() > 128 {
            return Err("idempotencyKey must contain 1 to 128 bytes");
        }
        if !valid_revision(&self.target_revision) || !valid_revision(&self.candidate_revision) {
            return Err("Merge confirmation requires exact Git revisions");
        }
        Ok(())
    }
}

pub(super) fn valid_revision(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[tracing::instrument(name = "collaboration.assistant_request.approve_merge", skip_all, fields(issue_id = %issue.id, owner_id = owner, request_id = request))]
pub(super) async fn approve_merge_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    owner: i64,
    request: &str,
    approval: MergeApproval,
) -> MysqlResult<Value> {
    let mut row = request_on(
        &mut &mut *tx,
        &issue.cloud_project_id,
        &issue.id,
        owner,
        request,
    )
    .await?;
    let mut intent = row.intent();
    require_assignment_on(&mut &mut *tx, issue, owner, &intent["origin_context"]).await?;
    let id = format!(
        "{request}-merge-{}",
        model::digest(&approval.idempotency_key)
    );
    let commands = intent["assistant_request"]["commands"]
        .as_array()
        .ok_or_else(|| reject(409, "Request commands are unavailable"))?;
    if let Some(command) = commands.iter().find(|command| command["id"] == id) {
        if command["targetRevision"] != approval.target_revision
            || command["candidateRevision"] != approval.candidate_revision
            || command["approvedByUserId"] != owner
        {
            return Err(reject(
                409,
                "Idempotency key already belongs to another merge confirmation",
            ));
        }
        return view_on(&mut &mut *tx, &row).await;
    }
    let evidence = &intent["assistant_request"]["worktree"]["merge"];
    if row.status != "completed"
        || evidence["state"] != "awaiting_confirmation"
        || evidence["targetRevision"] != approval.target_revision
        || evidence["candidateRevision"] != approval.candidate_revision
    {
        return Err(reject(
            409,
            "Merge candidate is no longer awaiting this confirmation",
        ));
    }
    let commands = intent["assistant_request"]["commands"]
        .as_array_mut()
        .expect("validated commands");
    commands.push(json!({"id":id,"action":"merge","executionId":row.id.to_string(),"targetRevision":approval.target_revision,"candidateRevision":approval.candidate_revision,"approvedByUserId":owner,"acknowledged":false}));
    save_on(tx, &mut row, &intent).await?;
    view_on(&mut &mut *tx, &row).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_receipt_never_contains_private_execution_details() {
        let value = receipt_metadata("request", 7);
        assert_eq!(value["state"], "accepted");
        for key in [
            "message",
            "deviceId",
            "runtimeTaskId",
            "worktree",
            "commands",
        ] {
            assert!(value.get(key).is_none());
        }
    }
}
