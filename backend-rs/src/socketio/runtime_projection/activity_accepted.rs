// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Commit the pending project chat activity with the executor acceptance.

use brz_mysql::{MysqlResult, MysqlTransaction};
use serde_json::{Value, json};

use super::super::{
    execution_conversation_task_id, execution_executor_type, execution_runtime_selection,
};
use super::{
    ExecutionRow, execution_origin_context, linked_activity, projected_view,
    raw_execution_id_matches, reload_activity, reload_execution,
};

/// Open or rebind the pending activity while committing Runtime acceptance.
pub(in crate::socketio) async fn open_accepted_activity<T: MysqlTransaction>(
    transaction: &mut T,
    execution_id: i64,
    observed_start: bool,
) -> MysqlResult<Option<Value>> {
    use crate::background_jobs::project::{notifications, store};
    use crate::socketio::project_chat_messages::{
        INSERT_MESSAGE_SQL, InsertMessage, insert_message_args, runtime_activity_key,
    };

    let Some(execution) = reload_execution(transaction, execution_id).await? else {
        return Ok(None);
    };
    if observed_start && execution.is_terminal() {
        return Ok(None);
    }
    let project = execution.cloud_project_id.as_deref().unwrap_or_default();
    let issue_id = execution.loop_item_id.as_deref().unwrap_or_default();
    let device = execution.runtime_device_id.as_deref().unwrap_or_default();
    let conversation = execution_conversation_task_id(&execution);
    if project.is_empty() || issue_id.is_empty() || device.is_empty() {
        return Ok(None);
    }
    let origin = Value::Object(execution_origin_context(&execution));
    let Some(profile) = activity_profile(transaction, &execution, &origin).await? else {
        return Ok(None);
    };
    let existing = match linked_activity(transaction, &execution).await? {
        Some(row) => reload_activity(transaction, row.id).await?,
        None => None,
    };
    if let Some(row) = existing.as_ref()
        && matches!(row.status.as_str(), "completed" | "failed" | "cancelled")
    {
        return Ok(Some(projected_view(row)));
    }

    let trigger = existing
        .as_ref()
        .map_or("", |row| row.trigger_message_id.as_str());
    let key = runtime_activity_key(device, &conversation, trigger).unwrap_or_default();
    // A group acceptance follows successful creation of the detached manager
    // conversation, which does not report a start on the parent execution.
    let status = if observed_start
        || execution_executor_type(&execution) == "collaboration_group_dispatch"
        || existing.as_ref().is_some_and(|row| {
            row.status == "streaming"
                && row.runtime_device_id == device
                && row.runtime_task_id == conversation
                && raw_execution_id_matches(row, execution_id)
                && row.metadata.0["run_status"] == "running"
        }) {
        "streaming"
    } else {
        "pending"
    };
    let selection = execution_runtime_selection(&execution);
    let mut metadata = existing
        .as_ref()
        .and_then(|row| row.metadata.0.as_object().cloned())
        .unwrap_or_default();
    metadata.extend([
        ("execution_id".into(), json!(execution_id)),
        (
            "executor_type".into(),
            json!(execution_executor_type(&execution)),
        ),
        ("executor_ref".into(), json!(profile.executor_ref)),
        (
            "run_status".into(),
            json!(if status == "streaming" {
                "running"
            } else {
                "starting"
            }),
        ),
        (
            "automation_run_id".into(),
            json!(execution.automation_run_id.as_deref().unwrap_or("")),
        ),
        (
            "model".into(),
            selection["model"]
                .as_str()
                .filter(|model| !model.is_empty())
                .map_or(Value::Null, |model| json!(model)),
        ),
    ]);
    for field in [
        "dispatch_role",
        "workflow_task_title",
        "workflow_stage_id",
        "coordination_round_id",
    ] {
        metadata.insert(field.into(), origin[field].clone());
    }

    let row_id = if let Some(row) = existing {
        transaction
            .execute(
                "UPDATE project_chat_messages SET message_type='agent_chunk', metadata=?, \
             runtime_device_id=?, runtime_task_id=?, runtime_activity_key=?, status=?, \
             updated_at=UTC_TIMESTAMP(6) WHERE id=?",
                (
                    brz_mysql::Json(Value::Object(metadata)),
                    device,
                    conversation.as_str(),
                    key.as_str(),
                    status,
                    row.id,
                ),
            )
            .await?;
        row.id
    } else {
        let issue: Option<store::Node> = transaction
            .fetch_optional(
                format!(
                    "SELECT {} FROM loop_items WHERE id=? AND resource_type='task'",
                    store::COLUMNS
                ),
                (issue_id,),
            )
            .await?;
        let admits_completed = crate::json_compat::python_truthy(&origin["run_id"])
            && origin["event"]["type"] == "task.status_changed"
            && origin["event"]["payload"]["status"] == "completed";
        if issue
            .as_ref()
            .is_none_or(|issue| issue.status == "completed" && !admits_completed)
        {
            return Ok(None);
        }
        if !metadata.contains_key("run_id") {
            let active_ai_run_id = origin
                .get("run_id")
                .and_then(Value::as_str)
                .filter(|run_id| !run_id.is_empty())
                .or_else(|| {
                    issue
                        .as_ref()
                        .and_then(|issue| issue.metadata.0.get("ai_state"))
                        .filter(|state| {
                            matches!(
                                state.get("status").and_then(Value::as_str),
                                Some("running" | "pending" | "queued")
                            ) && state
                                .get("runtime_task_id")
                                .and_then(Value::as_str)
                                .is_none_or(|task_id| task_id.is_empty() || task_id == conversation)
                        })
                        .and_then(|state| state.get("run_id"))
                        .and_then(Value::as_str)
                        .filter(|run_id| !run_id.is_empty())
                });
            if let Some(run_id) = active_ai_run_id {
                metadata.insert("run_id".into(), json!(run_id));
            }
        }
        let id = notifications::uuid();
        let agent = execution.agent_id.as_deref().unwrap_or_default();
        transaction
            .execute(
                INSERT_MESSAGE_SQL,
                insert_message_args(&InsertMessage {
                    message_id: &id,
                    client_message_id: &id,
                    project_id: project,
                    task_id: issue_id,
                    sender_type: "agent",
                    sender_id: &profile.sender_id,
                    sender_name: &profile.name,
                    message_type: "agent_chunk",
                    content: "",
                    metadata: Value::Object(metadata),
                    trigger_message_id: "",
                    reply_to_message_id: "",
                    thread_root_message_id: "",
                    agent_id: agent,
                    runtime_device_id: device,
                    runtime_task_id: &conversation,
                    runtime_activity_key: &key,
                    status,
                }),
            )
            .await?
            .last_insert_id as i64
    };
    Ok(reload_activity(transaction, row_id)
        .await?
        .as_ref()
        .map(projected_view))
}

struct ActivityProfile {
    sender_id: String,
    name: String,
    executor_ref: String,
}

async fn activity_profile<T: MysqlTransaction>(
    transaction: &mut T,
    execution: &ExecutionRow,
    origin: &Value,
) -> MysqlResult<Option<ActivityProfile>> {
    use crate::background_jobs::project::store::{COLUMNS, LIVE, Node};
    let kind = execution_executor_type(execution);
    let agent = execution.agent_id.as_deref().unwrap_or_default();
    let run = execution.automation_run_id.as_deref().unwrap_or_default();
    if kind == "project_robot" || kind == "collaboration_group_dispatch" {
        let profile_id = if kind == "project_robot" {
            agent
        } else {
            origin["manager_agent_id"].as_str().unwrap_or_default()
        };
        let profile: Option<Node> = transaction
            .fetch_optional(
                format!(
                    "SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type='chat_agent' \
                     AND cloud_project_id=? AND status='active' AND {LIVE}"
                ),
                (
                    profile_id,
                    execution.cloud_project_id.as_deref().unwrap_or_default(),
                ),
            )
            .await?;
        return Ok(profile.map(|profile| ActivityProfile {
            sender_id: if agent.is_empty() {
                format!("{kind}:{run}")
            } else {
                agent.into()
            },
            name: first_nonempty([profile.title.as_str(), profile.name.as_str(), "AI"]).into(),
            executor_ref: agent.into(),
        }));
    }
    if kind != "generic_robot" || run.is_empty() {
        return Ok(None);
    }
    let run_row: Option<Node> = transaction
        .fetch_optional(
            format!(
                "SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type='automation_run'"
            ),
            (run,),
        )
        .await?;
    let Some(run_row) = run_row else {
        return Ok(None);
    };
    let rule_id = run_row.parent_id.as_str();
    let rule: Option<Node> = transaction
        .fetch_optional(
            format!(
                "SELECT {COLUMNS} FROM loop_items WHERE id=? AND resource_type='automation_rule'"
            ),
            (rule_id,),
        )
        .await?;
    Ok(Some(ActivityProfile {
        sender_id: format!("{kind}:{run}"),
        name: first_nonempty([
            rule.as_ref().map_or("", |rule| rule.title.as_str()),
            run_row.metadata.0["workflow_node_name"]
                .as_str()
                .unwrap_or_default(),
            "AI",
        ])
        .into(),
        executor_ref: rule_id.into(),
    }))
}

fn first_nonempty<const N: usize>(values: [&str; N]) -> &str {
    values
        .into_iter()
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}
