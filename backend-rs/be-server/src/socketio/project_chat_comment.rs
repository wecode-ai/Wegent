// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeSet;

use brz_mysql::{MysqlError, MysqlTransaction};
use serde_json::{Map, Value, json};

use super::project_chat_events::ack_error;
use super::project_chat_messages::{self as messages, InsertMessage, MessageRow};
use crate::background_jobs::project::{authority, groups, queue, store};
use crate::background_jobs::robot::{self, model};
use crate::state::AppState;

pub(super) async fn enqueue_root(
    state: &AppState,
    user_id: i64,
    trigger: &MessageRow,
    request: &Map<String, Value>,
) -> Result<(Vec<Value>, bool), Value> {
    let human_request = request
        .get("human_request_id")
        .or_else(|| request.get("humanRequestId"))
        .filter(|value| !value.is_null());
    if human_request.is_some_and(|value| value.as_str().is_none_or(str::is_empty)) {
        return Err(execution_failed());
    }
    let attachment_ids = request
        .get("attachment_ids")
        .or_else(|| request.get("attachmentIds"))
        .map(|value| {
            value
                .as_array()
                .and_then(|items| {
                    items
                        .iter()
                        .map(|item| authority::integer(item).filter(|id| *id > 0))
                        .collect::<Option<BTreeSet<_>>>()
                })
                .ok_or_else(|| ack_error("INVALID_MESSAGE", "Invalid attachment IDs"))
        })
        .transpose()?
        .unwrap_or_default();
    let human_request_id = human_request.and_then(Value::as_str);
    let mut new_response = false;
    let result = state.mysql.with_transaction(async |tx| {
        let Some(issue) = store::locked(tx, "task", &trigger.task_id).await? else {
            return Ok(Err(ack_error("SCOPE_NOT_FOUND", "The project issue is unavailable")));
        };
        if issue.cloud_project_id != trigger.project_id {
            return Ok(Err(ack_error("SCOPE_NOT_FOUND", "The project issue is unavailable")));
        }
        let mut query = &mut *tx;
        let access = authority::execution_access_on(&mut query, &trigger.project_id, user_id)
            .await.map_err(database_error)?;
        authority::require_issue_with_priority_on(&mut query, &access.project, &issue, user_id, access.priority)
            .await.map_err(database_error)?;
        let locked: Option<(i64,)> = tx.fetch_optional(
            "SELECT id FROM project_chat_messages WHERE id=? AND sender_type='user' AND sender_id=?
             AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01')) FOR UPDATE",
            (trigger.id, user_id.to_string()),
        ).await?;
        if locked.is_none() {
            return Ok(Err(ack_error("SCOPE_NOT_FOUND", "The saved comment was not found")));
        }
        let existing: Option<(i64,)> = tx.fetch_optional(
            "SELECT id FROM project_chat_messages WHERE project_id=? AND task_id=? AND trigger_message_id=?
             AND sender_type='agent' AND (deleted_at IS NULL OR deleted_at IN
                 ('1970-01-01 00:00:00','1970-01-01 00:00:01')) ORDER BY id LIMIT 1 FOR UPDATE",
            (trigger.project_id.as_str(), trigger.task_id.as_str(), trigger.message_id.as_str()),
        ).await?;
        if let Some((id,)) = existing {
            return Ok(Ok(Some(id)));
        }
        let mut original = None;
        if !trigger.reply_to_message_id.is_empty() {
            let root = if trigger.thread_root_message_id.is_empty() {
                &trigger.reply_to_message_id
            } else {
                &trigger.thread_root_message_id
            };
            let thread: Option<(i64,)> = tx.fetch_optional(
                "SELECT id FROM project_chat_messages WHERE project_id=? AND task_id=? AND message_id=?
                 AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))
                 FOR UPDATE",
                (trigger.project_id.as_str(), trigger.task_id.as_str(), root.as_str()),
            ).await?;
            if thread.is_none() {
                return Ok(Err(execution_failed()));
            }
            // Guidance receipts acknowledge a steer. Only the originating activity binds a session.
            let bound: Option<MessageRow> = tx.fetch_optional(
                format!("SELECT {} FROM project_chat_messages WHERE project_id=? AND task_id=? AND sender_type='agent'
                 AND (message_id=? OR thread_root_message_id=?)
                 AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.collaboration_guidance')), 'false') <> 'true'
                 AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))
                 ORDER BY (message_id=?) DESC, id DESC LIMIT 1 FOR UPDATE", messages::MESSAGE_COLUMNS),
                (trigger.project_id.as_str(), trigger.task_id.as_str(), root.as_str(), root.as_str(),
                 trigger.reply_to_message_id.as_str()),
            ).await?;
            if let Some(bound) = bound {
                let Some(mut bound) = published_comment_activity(tx, trigger, bound).await? else {
                    return Ok(Err(execution_failed()));
                };
                let metadata = bound.metadata();
                let manager_task = metadata["manager_runtime_task_id"].as_str()
                    .filter(|id| !id.is_empty() && (
                        metadata["collaboration_public_reply"] == true
                        || metadata["activity_type"] == "manager_status_comment"
                    ));
                let manager_execution = if let Some(task) = manager_task {
                    let project_id = trigger.project_id.parse().map_err(|_| MysqlError::InvalidQuery {
                        reason: "Invalid project identifier".to_owned(),
                    })?;
                    let result = wegent_runtime_work::comment_manager_dispatch(
                        &state.mysql, project_id, &trigger.task_id, &bound.agent_id, &metadata,
                    ).await;
                    let Ok(Some((id, device))) = result else {
                        return Ok(Err(execution_failed()));
                    };
                    bound.runtime_task_id = task.to_owned();
                    bound.runtime_device_id = device;
                    Some(id)
                } else {
                    None
                };
                let member = if metadata["dispatch_role"] == "member"
                    && metadata["execution_id"].is_null()
                {
                    let project_id = trigger.project_id.parse().map_err(|_| MysqlError::InvalidQuery {
                        reason: "Invalid project identifier".to_owned(),
                    })?;
                    let result = wegent_runtime_work::comment_member_assignment(
                        &state.mysql, project_id, &trigger.task_id, &bound.agent_id,
                        &bound.runtime_device_id, &bound.runtime_task_id, &metadata,
                    ).await;
                    let Ok(Some((id, assignment))) = result else {
                        return Ok(Err(execution_failed()));
                    };
                    Some((id, assignment))
                } else {
                    None
                };
                let execution = if let Some(id) = manager_execution {
                    load_execution(tx, trigger, id).await?
                } else if let Some((id, _)) = member.as_ref() {
                    load_execution(tx, trigger, *id).await?
                } else {
                    bound_execution(state, tx, trigger, &bound).await?
                };
                let Some(execution) = execution else {
                    return Ok(Err(execution_failed()));
                };
                original = Some((bound, execution, member.map(|(_, assignment)| assignment)));
            }
        }
        let attachments = load_comment_attachments(tx, user_id, &attachment_ids).await?;
        if attachments.len() != attachment_ids.len() {
            return Ok(Err(ack_error("INVALID_MESSAGE", "An attachment is unavailable or belongs to another user")));
        }
        let mut assigner = user_id;
        let mut human_update = None;
        if let Some(request_id) = human_request_id {
            let Some((bound, execution, _)) = &original else {
                return Ok(Err(execution_failed()));
            };
            let (authority, metadata) = match claim_human_reply(&issue, trigger, bound, execution, request_id, user_id) {
                Ok(value) => value,
                Err(error) => return Ok(Err(error)),
            };
            assigner = authority;
            human_update = metadata;
        }
        let metadata = trigger.metadata();
        let mentioned: BTreeSet<&str> = metadata["mentions"].as_array().into_iter().flatten()
            .filter(|mention| mention["type"] == "agent")
            .filter_map(|mention| mention["id"].as_str()).collect();
        if original.is_none() && mentioned.len() > 1 {
            return Ok(Err(ack_error("INVALID_MESSAGE", "A comment can start one agent session")));
        }
        let agent_id = original.as_ref().map(|(bound, _, _)| bound.agent_id.as_str())
            .unwrap_or_else(|| mentioned.first().copied().unwrap_or(&issue.assignee_agent_id));
        if agent_id.is_empty() {
            if original.is_some() {
                return Ok(Err(execution_failed()));
            }
            tx.execute("UPDATE project_chat_messages SET metadata=JSON_SET(
                        IF(JSON_TYPE(metadata)='OBJECT',metadata,JSON_OBJECT()),
                        '$.execution_dispatch','comment_only') WHERE id=?", (trigger.id,)).await?;
            return Ok(Ok(None));
        }
        let agent = authority::agent_on(&mut &mut *tx, &trigger.project_id, agent_id, assigner, true)
            .await.map_err(database_error)?;
        let config = &agent.metadata.0;
        let mut owner = if agent.created_by_user_id != 0 { agent.created_by_user_id } else { user_id };
        let mut environment = config["execution_environment"].as_str()
            .filter(|value| matches!(*value, "cloud" | "local" | "wegent")).unwrap_or("local");
        let root = if trigger.thread_root_message_id.is_empty() { &trigger.message_id } else { &trigger.thread_root_message_id };
        let mut context = json!({
            "runtime_subject_user_id": owner,
            "runner_selection": request.get("runner_selection").or_else(|| request.get("runnerSelection")),
            "comment_trigger_message_id": trigger.message_id, "comment_prompt": trigger.content,
            "rootCommentId": root, "comment_user_id": user_id,
            "attachments": attachments, "comment_attachment_ids": attachment_ids,
        });
        let mut assignment = json!({"environment": environment, "execution_device_id": agent.device_id});
        let mut name = if agent.title.is_empty() { &agent.name } else { &agent.title };
        if let Some((bound, original, member)) = &original {
            let group_context = original.context();
            let group = group_context["dispatch_kind"] == "collaboration_group";
            if group && !groups::current_dispatch(&issue.metadata.0, &group_context) {
                return Ok(Err(execution_failed()));
            }
            let mut checked = original.clone();
            checked.assigner_user_id = assigner;
            if !robot::authority::authorized_on(state, &mut &mut *tx, &checked, Some(&issue))
                .await.map_err(database_error)?
            {
                return Ok(Err(ack_error("SCOPE_FORBIDDEN", "Comment execution authorization is revoked")));
            }
            if group && human_request_id.is_none() {
                match guide_active_comment(state, tx, trigger, bound, original, &attachments).await? {
                    Ok(Some(id)) => {
                        new_response = true;
                        return Ok(Ok(Some(id)));
                    }
                    Ok(None) => {}
                    Err(error) => return Ok(Err(error)),
                }
            }
            owner = original.executor_owner_user_id;
            if !original.execution_environment.is_empty() {
                environment = &original.execution_environment;
            }
            name = &bound.sender_name;
            if group {
                let mut inherited = group_context.as_object().cloned().unwrap_or_default();
                inherited.remove("human_request_id");
                inherited.extend(context.as_object().cloned().unwrap_or_default());
                context = Value::Object(inherited);
                if context["collaboration_dispatch_execution_id"].is_null()
                    && original.selection()["executor_kind"] == "collaboration_group_dispatch"
                {
                    context["collaboration_dispatch_execution_id"] = json!(original.id);
                }
            }
            context["runtime_subject_user_id"] = json!(owner);
            context["comment_continue_task_id"] = json!(bound.runtime_task_id);
            if let Some(id) = human_request_id {
                context["human_request_id"] = json!(id);
                context["runner_selection"] = json!({});
            }
            let mut continuation = json!({
                "execution_id": original.id,
                "runtime_task_id": bound.runtime_task_id,
            });
            if let Some(member) = member {
                let metadata = bound.metadata();
                context["collaboration_dispatch_execution_id"] = json!(original.id);
                context["dispatch_role"] = json!("member");
                context["coordination_round_id"] = metadata["coordination_round_id"].clone();
                context["assignment_id"] = metadata["assignment_id"].clone();
                context["workflow_task_title"] = member["task_title"].clone();
                continuation = json!({
                    "owner_user_id": owner,
                    "runtime_device_id": bound.runtime_device_id,
                    "runtime_task_id": bound.runtime_task_id,
                    "runtime_selection": {"runner_routing": original.selection()["group_runner_requirements"][agent_id]},
                    "compile_member_profile": true,
                });
            }
            assignment = json!({
                "environment": environment,
                "execution_device_id": original.runtime_device_id,
                "continuation": continuation,
            });
        }
        let plan = queue::Admission {
            owner, assigner, agent_id: agent_id.to_owned(), team_id: 0,
            environment: environment.to_owned(), device_id: String::new(), context,
            runtime_selection: json!({"assignment_request": assignment}),
            config: Value::Null, requires_approval: false, waiting_runtime: false,
        };
        let scope = format!("comment:{}", trigger.message_id);
        let execution = queue::enqueue_intent_on(tx, &issue, None, &scope, &plan).await?;
        let message_id = messages::uuid4();
        let mut response_metadata = json!({"execution_id":execution.id,"run_status":execution.status});
        if let Some(id) = human_request_id {
            response_metadata["human_request_id"] = json!(id);
        }
        let message = InsertMessage {
            message_id: &message_id, client_message_id: &message_id, project_id: &trigger.project_id,
            task_id: &trigger.task_id, sender_type: "agent", sender_id: agent_id, sender_name: name,
            message_type: "agent_status", content: "",
            metadata: response_metadata,
            trigger_message_id: &trigger.message_id, reply_to_message_id: &trigger.message_id,
            thread_root_message_id: root, agent_id, runtime_device_id: "",
            runtime_task_id: &execution.runtime_task_id,
            runtime_activity_key: "", status: "pending",
        };
        let row_id = messages::insert_message_on(tx, &message).await?;
        if let Some(metadata) = human_update {
            tx.execute("UPDATE loop_items SET metadata=?, version=version+1, updated_at=CURRENT_TIMESTAMP(6) WHERE id=?",
                (brz_mysql::Json(metadata), issue.id.as_str())).await?;
        }
        new_response = true;
        Ok(Ok(Some(row_id)))
    }).await.map_err(|error| {
        tracing::error!(%error, "project comment admission failed");
        execution_failed()
    })??;
    let Some(id) = result else {
        return Ok((Vec::new(), false));
    };
    let row = messages::load_message_by_id(state, id)
        .await?
        .ok_or_else(execution_failed)?;
    if new_response && row.metadata()["collaboration_guidance"] != true {
        if let Err(error) = crate::background_jobs::robot::prepare_and_wake(state).await {
            tracing::warn!(%error, "project comment runner wake failed");
        }
        tracing::info!(
            item_id = trigger.task_id,
            trigger_id = trigger.message_id,
            execution_id = row.metadata()["execution_id"].as_i64(),
            "Project chat comment execution queued"
        );
    }
    Ok((
        vec![messages::message_view_with_actor(state, user_id, &row).await?],
        new_response,
    ))
}

async fn guide_active_comment(
    state: &AppState,
    tx: &mut impl MysqlTransaction,
    trigger: &MessageRow,
    bound: &MessageRow,
    execution: &model::Execution,
    attachments: &[Value],
) -> Result<Result<Option<i64>, Value>, MysqlError> {
    let active: Option<(i64,)> = tx
        .fetch_optional(
            "SELECT id FROM project_chat_messages
         WHERE project_id=? AND task_id=? AND runtime_task_id=? AND sender_type='agent'
         AND status='streaming'
         AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.collaboration_guidance')), 'false') <> 'true'
         AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))
         LIMIT 1",
            (
                trigger.project_id.as_str(),
                trigger.task_id.as_str(),
                bound.runtime_task_id.as_str(),
            ),
        )
        .await?;
    if active.is_none() || bound.runtime_device_id.is_empty() {
        return Ok(Ok(None));
    }
    let result = wegent_runtime_work::call_owned_runtime(
        &crate::runtime_work::request_services(state), execution.executor_owner_user_id, &bound.runtime_device_id,
        "runtime.tasks.guidance",
        json!({
            "taskId": bound.runtime_task_id,
            "clientGuidanceId": trigger.message_id,
            "issueCommentId": trigger.message_id,
            "message": format!(
                "New comment on this Issue (comment ID {}). Keep its reply separate from other comments and use add_board_item_comment with this reply_to_comment_id.\n\n{}",
                trigger.message_id, trigger.content,
            ),
            "attachments": attachments,
        }),
        15, false, None,
    ).await;
    let accepted = match result {
        Ok(value) if value["accepted"] == true => value,
        Ok(value)
            if matches!(
                value["code"].as_str(),
                Some("no_active_turn" | "conversation_context_mismatch" | "user_input_pending")
            ) =>
        {
            return Ok(Ok(None));
        }
        Err(wegent_runtime_work::CallFailure::Rpc(error))
            if error.code == "remote_control_disabled" =>
        {
            return Ok(Ok(None));
        }
        _ => {
            return Ok(Err(ack_error(
                "EXECUTION_FAILED",
                "Delivery of the Issue reply could not be confirmed",
            )));
        }
    };
    let message_id = messages::uuid4();
    let message = InsertMessage {
        message_id: &message_id,
        client_message_id: &message_id,
        project_id: &trigger.project_id,
        task_id: &trigger.task_id,
        sender_type: "agent",
        sender_id: &bound.agent_id,
        sender_name: &bound.sender_name,
        message_type: "agent_status",
        content: "",
        metadata: json!({
            "run_status": "running",
            "collaboration_guidance": true,
            "runtime_turn_id": accepted["turnId"],
        }),
        trigger_message_id: &trigger.message_id,
        reply_to_message_id: &trigger.message_id,
        thread_root_message_id: &trigger.thread_root_message_id,
        agent_id: &bound.agent_id,
        runtime_device_id: &bound.runtime_device_id,
        runtime_task_id: &bound.runtime_task_id,
        runtime_activity_key: "",
        status: "streaming",
    };
    let row_id = messages::insert_message_on(tx, &message).await?;
    Ok(Ok(Some(row_id)))
}

async fn published_comment_activity(
    tx: &mut impl MysqlTransaction,
    trigger: &MessageRow,
    published: MessageRow,
) -> Result<Option<MessageRow>, MysqlError> {
    let metadata = published.metadata();
    let Some(activity_id) = metadata["collaboration_member_activity_id"].as_str() else {
        return Ok(Some(published));
    };
    if metadata["collaboration_public_reply"] != true || published.agent_id.is_empty() {
        return Ok(None);
    }
    let source: Option<MessageRow> = tx.fetch_optional(
        format!(
            "SELECT {} FROM project_chat_messages
             WHERE project_id=? AND task_id=? AND message_id=? AND sender_type='agent' AND agent_id=?
             AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00','1970-01-01 00:00:01'))
             FOR UPDATE",
            messages::MESSAGE_COLUMNS,
        ),
        (
            trigger.project_id.as_str(),
            trigger.task_id.as_str(),
            activity_id,
            published.agent_id.as_str(),
        ),
    ).await?;
    Ok(source.filter(|source| {
        let source_metadata = source.metadata();
        (source_metadata["activity_type"] == "member_execution"
            && source_metadata["dispatch_id"] == metadata["dispatch_id"])
            || (source_metadata["dispatch_role"] == "member"
                && source_metadata["execution_id"].is_i64()
                && source_metadata["execution_id"] == metadata["collaboration_member_execution_id"])
    }))
}

async fn load_comment_attachments(
    tx: &mut impl MysqlTransaction,
    user_id: i64,
    ids: &BTreeSet<i64>,
) -> Result<Vec<Value>, MysqlError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    #[derive(brz_mysql::FromMysqlRow)]
    struct Attachment {
        id: i64,
        subtask_id: i64,
        name: String,
        type_data: Option<brz_mysql::Json<Value>>,
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let parameters: Vec<_> = std::iter::once(user_id)
        .chain(ids.iter().copied())
        .map(crate::sql_support::StatementArg::Int)
        .collect();
    let rows: Vec<Attachment> = tx
        .fetch_all(
            format!(
                "SELECT id,subtask_id,name,type_data FROM subtask_contexts WHERE user_id=?
         AND context_type='attachment' AND status='ready' AND id IN ({placeholders}) ORDER BY id"
            ),
            parameters,
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let fields = row.type_data.map(|data| data.0).unwrap_or_default();
            json!({
                "id": row.id, "subtask_id": row.subtask_id,
                "original_filename": fields["original_filename"].as_str().unwrap_or(&row.name),
                "mime_type": fields["mime_type"].as_str().unwrap_or(""),
                "file_size": fields["file_size"].as_i64().unwrap_or(0),
                "file_extension": fields["file_extension"].as_str().unwrap_or(""),
            })
        })
        .collect())
}

fn claim_human_reply(
    issue: &store::Node,
    trigger: &MessageRow,
    bound: &MessageRow,
    execution: &model::Execution,
    request_id: &str,
    user_id: i64,
) -> Result<(i64, Option<Value>), Value> {
    if matches!(
        issue.status.as_str(),
        "completed" | "cancelled" | "archived"
    ) {
        return Err(execution_failed());
    }
    let mut metadata = issue.meta();
    let target = metadata["human_requests"]
        .as_array_mut()
        .and_then(|requests| {
            requests
                .iter_mut()
                .find(|request| request["id"] == request_id)
        })
        .ok_or_else(|| ack_error("SCOPE_NOT_FOUND", "Question not found"))?;
    if target["recipient_user_id"].as_i64() != Some(user_id) {
        return Err(ack_error(
            "SCOPE_FORBIDDEN",
            "Question is assigned to another person",
        ));
    }
    let root = if trigger.thread_root_message_id.is_empty() {
        &trigger.reply_to_message_id
    } else {
        &trigger.thread_root_message_id
    };
    if root.is_empty()
        || target["root_comment_id"] != root.as_str()
        || target["runtime_device_id"] != bound.runtime_device_id
        || target["runtime_task_id"] != bound.runtime_task_id
        || execution.assigner_user_id <= 0
        || target["answer_message_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && id != trigger.message_id)
    {
        return Err(execution_failed());
    }
    if target["status"] != "pending" {
        return if matches!(target["status"].as_str(), Some("answering" | "resolved"))
            && target["answer_message_id"] == trigger.message_id
        {
            Ok((execution.assigner_user_id, None))
        } else {
            Err(execution_failed())
        };
    }
    let now = chrono::Utc::now().to_rfc3339();
    target
        .as_object_mut()
        .expect("matched request object")
        .remove("delivery_error");
    target["status"] = json!("answering");
    target["answer_message_id"] = json!(trigger.message_id);
    target["version"] = json!(target["version"].as_i64().unwrap_or(1) + 1);
    target["updated_at"] = json!(now);
    let mut events = target["events"].as_array().cloned().unwrap_or_default();
    events.push(
        json!({"type":"answered","at":now,"user_id":user_id,"message_id":trigger.message_id}),
    );
    target["events"] = json!(events);
    Ok((execution.assigner_user_id, Some(metadata)))
}

async fn bound_execution(
    state: &AppState,
    tx: &mut brz_mysql::MysqlTransactionService,
    trigger: &MessageRow,
    bound: &MessageRow,
) -> Result<Option<model::Execution>, MysqlError> {
    let metadata = bound.metadata();
    let Some(id) = authority::integer(&metadata["execution_id"]) else {
        return Ok(None);
    };
    let execution = load_execution(tx, trigger, id).await?;
    let Some(execution) = execution else {
        return Ok(None);
    };
    if execution.agent_id.is_empty()
        || bound.agent_id != execution.agent_id
        || bound.runtime_task_id.is_empty()
        || bound.runtime_task_id != execution.runtime_task_id
    {
        return Ok(None);
    }
    if execution.runtime_device_id.is_empty()
        && matches!(
            execution.status.as_str(),
            "queued" | "pending_approval" | "waiting_runtime"
        )
    {
        return Ok(Some(execution));
    }
    if execution.execution_environment == "wegent" {
        return if robot::managed::source_matches(state, &execution, &bound.metadata()).await? {
            Ok(Some(execution))
        } else {
            Ok(None)
        };
    }
    let owner = execution.executor_owner_user_id;
    let recorded = crate::device_identity::resolve_owned_device_alias_on(
        &mut &mut *tx,
        owner,
        &bound.runtime_device_id,
    )
    .await?;
    let current = crate::device_identity::resolve_owned_device_alias_on(
        &mut &mut *tx,
        owner,
        &execution.runtime_device_id,
    )
    .await?;
    Ok(recorded
        .zip(current)
        .filter(|(recorded, current)| recorded.id == current.id)
        .map(|_| execution))
}

async fn load_execution(
    tx: &mut brz_mysql::MysqlTransactionService,
    trigger: &MessageRow,
    id: i64,
) -> Result<Option<model::Execution>, MysqlError> {
    tx
        .fetch_optional(
            format!(
                "SELECT {} FROM loop_item_executions WHERE id=? AND cloud_project_id=? AND loop_item_id=?",
                model::COLUMNS
            ),
            (id, trigger.project_id.as_str(), trigger.task_id.as_str()),
        )
        .await
}

fn execution_failed() -> Value {
    ack_error(
        "EXECUTION_FAILED",
        "Comment saved, but AI execution could not start",
    )
}

fn database_error(error: anyhow::Error) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: error.to_string(),
    }
}
