// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Personal assistant authority and the final, deliberately public result.

use brz_mysql::{Json, MysqlResult, MysqlTransaction};
use chrono::Utc;
use serde_json::{Value, json};

use crate::background_jobs::project::{authority, completion::Message, store};
use crate::loop_tasks::{assignments::active_events, loop_repository::CommentRow};

use super::execution_aggregate::ExecutionRow;
use super::project_chat_messages::{INSERT_MESSAGE_SQL, InsertMessage, insert_message_args};

pub(super) fn is_personal(row: &ExecutionRow) -> bool {
    super::runtime_projection::execution_executor_type(row) == "human_assistant"
}

/// Each turn carries its frozen execution identity even when its Task is reused.
pub(super) fn event_matches(row: &ExecutionRow, payload: &Value) -> bool {
    !is_personal(row)
        || payload.get("executionId").and_then(Value::as_str) == Some(row.id.to_string().as_str())
}

/// Only the active turn's aggregate can change its blocking interaction state.
pub(super) fn observation_state(
    row: &ExecutionRow,
    event_name: &str,
    payload: &Value,
) -> &'static str {
    if !is_personal(row) {
        return "running";
    }
    if event_name == "response.created" && event_matches(row, payload) {
        return "running";
    }
    if waiting_exit(event_name, payload) {
        return "waiting_user";
    }
    if event_name == "runtime.interaction.updated" && event_matches(row, payload) {
        match payload["data"]["state"].as_str() {
            Some("waiting_user") => return "waiting_user",
            Some("running") => return "running",
            _ => {}
        }
    }
    if row.observed_state.as_deref() == Some("waiting_user") {
        "waiting_user"
    } else {
        "running"
    }
}

/// Codex and Claude both end a deferred turn with this explicit silent outcome.
pub(super) fn waiting_exit(event_name: &str, payload: &Value) -> bool {
    let data = payload.get("data").unwrap_or(payload);
    let response = data
        .get("response")
        .filter(|value| value.is_object())
        .unwrap_or(data);
    event_name == "response.completed"
        && response["silent_exit"] == true
        && response["silent_exit_reason"] == "waiting_for_user_input"
}

fn origin(row: &ExecutionRow) -> Value {
    row.execution_payload
        .as_deref()
        .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
        .and_then(|payload| payload.get("origin_context").cloned())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn dispatch_matches(row: &ExecutionRow, assignment_id: &str, dispatch: &Value) -> bool {
    let origin = origin(row);
    origin["assignment_id"] == assignment_id
        && dispatch["assignmentId"] == assignment_id
        && dispatch["executionId"] == row.id.to_string()
        && dispatch["assignmentVersion"].is_i64()
        && dispatch["assignmentVersion"] == origin["assignment_version"]
        && matches!(
            dispatch["dispatchState"].as_str(),
            Some("waiting_device" | "queued" | "running")
        )
}

/// Current reads serialize against reassignment, unassignment and Issue closure.
pub(super) async fn current(
    tx: &mut impl MysqlTransaction,
    row: &ExecutionRow,
) -> MysqlResult<Option<(String, String)>> {
    let (Some(issue_id), Some(project_id), Some(owner)) = (
        row.loop_item_id.as_deref(),
        row.cloud_project_id.as_deref(),
        row.executor_owner_user_id,
    ) else {
        return Ok(None);
    };
    let issue: Option<store::Node> = tx
        .fetch_optional(
            format!(
                "SELECT {} FROM loop_items WHERE id=? AND resource_type='task' AND {} FOR UPDATE",
                store::COLUMNS,
                store::LIVE
            ),
            (issue_id,),
        )
        .await?;
    let Some(issue) = issue.filter(|issue| {
        issue.cloud_project_id == project_id
            && issue.assignee_user_id == owner
            && !matches!(issue.status.as_str(), "completed" | "cancelled" | "deleted")
    }) else {
        return Ok(None);
    };
    let comments: Vec<CommentRow> = tx
        .fetch_all(
            format!(
                "{} FOR UPDATE",
                crate::loop_tasks::loop_repository::item_comments_query()
            ),
            (issue_id,),
        )
        .await?;
    let owner_id = owner.to_string();
    let assignment = active_events(&comments).into_iter().find(|event| {
        matches!(
            event.metadata.target_type.as_deref(),
            Some("human" | "user")
        ) && event.metadata.target_id.as_deref() == Some(owner_id.as_str())
            && event
                .metadata
                .workflow_step
                .as_deref()
                .is_none_or(str::is_empty)
            && event
                .metadata
                .human_assistant_dispatch
                .as_ref()
                .is_some_and(|dispatch| dispatch_matches(row, &event.comment.id, dispatch))
    });
    let Some(assignment) = assignment else {
        return Ok(None);
    };
    let owner_name: Option<(String,)> = tx
        .fetch_optional(
            "SELECT user_name FROM users WHERE id=? AND is_active=1",
            (owner,),
        )
        .await?;
    let Some((name,)) = owner_name else {
        return Ok(None);
    };
    let mut query = &mut *tx;
    let Ok(access) = authority::execution_access_on(&mut query, project_id, owner).await else {
        return Ok(None);
    };
    if authority::require_issue_with_priority_on(
        &mut query,
        &access.project,
        &issue,
        owner,
        access.priority,
    )
    .await
    .is_err()
    {
        return Ok(None);
    }
    let route = row
        .runtime_device_id
        .as_deref()
        .filter(|route| !route.is_empty())
        .or(row.execution_device_id.as_deref())
        .unwrap_or_default();
    let permitted = super::personal_assistant_dispatch::endpoint_permitted_on(
        &mut query,
        owner,
        route,
        project_id,
        &issue.metadata.0["tags"],
    )
    .await
    .map_err(|error| brz_mysql::MysqlError::InvalidQuery {
        reason: error.to_string(),
    })?;
    if !permitted {
        return Ok(None);
    }
    Ok(Some((assignment.comment.id.clone(), name)))
}

/// Shared activity never contains the private Runtime address or tool stream.
fn summary(
    row: &ExecutionRow,
    assignment: &str,
    owner_name: &str,
    status: &str,
    text: &str,
) -> Message {
    let owner = row.executor_owner_user_id.unwrap_or(0);
    let key = format!("human-assistant-result:{}", row.id);
    let now = super::project_chat_messages::database_timestamp(Utc::now().naive_utc());
    Message {
        id: 0,
        message_id: key.clone(),
        client_message_id: key,
        project_id: row.cloud_project_id.clone().unwrap_or_default(),
        task_id: row.loop_item_id.clone().unwrap_or_default(),
        sender_type: "user".into(),
        sender_id: owner.to_string(),
        sender_name: owner_name.into(),
        message_type: "text".into(),
        content: text.into(),
        metadata: Json(json!({
            "activity_type":"human_assistant_result",
            "execution_id":row.id.to_string(),
            "assignment_id":assignment,
            "provenance":{"origin":"ai_generated","owner_user_id":owner,
                "publisher_user_id":owner,"confirmation_status":"unconfirmed"}
        })),
        trigger_message_id: String::new(),
        reply_to_message_id: String::new(),
        thread_root_message_id: String::new(),
        agent_id: String::new(),
        runtime_device_id: String::new(),
        runtime_task_id: String::new(),
        status: status.into(),
        created_at: now,
        updated_at: now,
    }
}

pub(super) async fn publish_result(
    tx: &mut impl MysqlTransaction,
    row: &ExecutionRow,
    status: &str,
    text: &str,
) -> MysqlResult<Vec<Message>> {
    if status == "cancelled" {
        return Ok(Vec::new());
    }
    let Some((assignment, name)) = current(tx, row).await? else {
        return Ok(Vec::new());
    };
    let mut message = summary(row, &assignment, &name, status, text);
    let existing: Option<(i64,)> = tx
        .fetch_optional(
            "SELECT id FROM project_chat_messages WHERE message_id=? FOR UPDATE",
            (message.message_id.as_str(),),
        )
        .await?;
    if existing.is_some() {
        return Ok(Vec::new());
    }
    let inserted = tx
        .execute(
            INSERT_MESSAGE_SQL,
            insert_message_args(&InsertMessage {
                message_id: &message.message_id,
                client_message_id: &message.client_message_id,
                project_id: &message.project_id,
                task_id: &message.task_id,
                sender_type: &message.sender_type,
                sender_id: &message.sender_id,
                sender_name: &message.sender_name,
                message_type: &message.message_type,
                content: &message.content,
                metadata: message.metadata.0.clone(),
                trigger_message_id: "",
                reply_to_message_id: "",
                thread_root_message_id: "",
                agent_id: "",
                runtime_device_id: "",
                runtime_task_id: "",
                runtime_activity_key: "",
                status,
            }),
        )
        .await?;
    message.id = inserted.last_insert_id as i64;
    Ok(vec![message])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn execution() -> ExecutionRow {
        ExecutionRow {
            id: 41,
            loop_item_id: Some("issue-1".into()),
            cloud_project_id: Some("7".into()),
            executor_owner_user_id: Some(3),
            agent_id: None,
            team_id: None,
            automation_run_id: None,
            execution_environment: Some("local".into()),
            execution_device_id: Some("private-device".into()),
            assigner_user_id: Some(3),
            status: Some("running".into()),
            priority_weight: None,
            started_at: None,
            attempt_no: Some(1),
            execution_scope: None,
            observed_state: None,
            start_requested_at: None,
            last_event_seq: None,
            termination_reason: None,
            retry_attempt: None,
            max_retries: None,
            execution_note: None,
            approval_status: None,
            approved_by_user_id: None,
            approved_at: None,
            runtime_device_id: Some("private-device".into()),
            runtime_task_id: Some("reused-private-task".into()),
            execution_payload: Some(
                json!({"runtime_selection":{"executor_kind":"human_assistant"},
                "origin_context":{"assignment_id":"assignment-1","assignment_version":2}})
                .to_string(),
            ),
            version: Some(1),
        }
    }

    #[test]
    fn a_reused_task_requires_the_frozen_execution_and_current_assignment_version() {
        let row = execution();
        assert!(event_matches(&row, &json!({"executionId":"41"})));
        assert!(!event_matches(&row, &json!({"executionId":"42"})));
        assert!(!event_matches(&row, &json!({})));
        let dispatch = json!({"assignmentId":"assignment-1","assignmentVersion":2,
            "executionId":"41","dispatchState":"queued"});
        assert!(dispatch_matches(&row, "assignment-1", &dispatch));
        for (key, value) in [
            ("executionId", json!("42")),
            ("assignmentVersion", json!(3)),
            ("assignmentId", json!("assignment-2")),
            ("dispatchState", json!("cancelled")),
            ("dispatchState", json!("no_authorized_assistant")),
        ] {
            let mut stale = dispatch.clone();
            stale[key] = value;
            assert!(!dispatch_matches(&row, "assignment-1", &stale));
        }
    }

    #[test]
    fn the_public_result_has_personal_attribution_without_a_private_runtime_address() {
        let message = summary(
            &execution(),
            "assignment-1",
            "Ada",
            "completed",
            "Summary [evidence](https://example.test/evidence)",
        );
        let view = message.view();
        assert_eq!(view["sender"], json!({"type":"user","id":"3","name":"Ada"}));
        assert_eq!(view["metadata"]["execution_id"], "41");
        assert_eq!(
            view["metadata"]["provenance"]["confirmation_status"],
            "unconfirmed"
        );
        assert_eq!(view["metadata"]["provenance"]["origin"], "ai_generated");
        assert!(view["runtimeAddress"].is_null());
        assert!(message.content.contains("https://example.test/evidence"));
        assert!(!view.to_string().contains("private-device"));
        assert!(!view.to_string().contains("reused-private-task"));
    }

    #[test]
    fn waiting_receipts_follow_frozen_aggregate_events_instead_of_tool_cards() {
        let mut row = execution();
        let waiting = json!({"executionId":"41","data":{"state":"waiting_user"}});
        assert_eq!(
            observation_state(&row, "runtime.interaction.updated", &waiting),
            "waiting_user"
        );
        row.observed_state = Some("waiting_user".into());
        let unrelated = json!({"executionId":"41","data":{"block":{"status":"done"}}});
        assert_eq!(
            observation_state(&row, "response.block.updated", &unrelated),
            "waiting_user"
        );
        let resumed = json!({"executionId":"41","data":{"state":"running"}});
        assert_eq!(
            observation_state(&row, "runtime.interaction.updated", &resumed),
            "running"
        );
        let stale = json!({"executionId":"42","data":{"state":"running"}});
        assert_eq!(
            observation_state(&row, "runtime.interaction.updated", &stale),
            "waiting_user"
        );
        assert_eq!(
            observation_state(&row, "response.created", &resumed),
            "running"
        );
        row.execution_payload = Some("{}".into());
        assert_eq!(
            observation_state(&row, "runtime.interaction.updated", &waiting),
            "running"
        );
    }

    #[test]
    fn deferred_codex_and_claude_turns_are_waiting_instead_of_completed() {
        let row = execution();
        for data in [
            json!({"silent_exit":true,"silent_exit_reason":"waiting_for_user_input"}),
            json!({"response":{"status":"completed","silent_exit":true,
                "silent_exit_reason":"waiting_for_user_input"}}),
        ] {
            let payload = json!({"executionId":"41","data":data});
            assert!(waiting_exit("response.completed", &payload));
            assert_eq!(
                observation_state(&row, "response.completed", &payload),
                "waiting_user"
            );
        }
        assert!(!waiting_exit(
            "response.completed",
            &json!({"data":{"value":"done"}})
        ));
        assert!(!waiting_exit(
            "response.completed",
            &json!({"data":{"silent_exit_reason":"waiting_for_user_input"}})
        ));
    }
}
