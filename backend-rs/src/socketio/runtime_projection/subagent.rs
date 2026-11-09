// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use brz_mysql::{Json, MysqlResult, MysqlTransaction};
use serde_json::{Map, Value, json};

use super::activity::{record_runtime_sequence, reload_activity, runtime_event_is_stale};
use super::{Message, Projected, TERMINAL_RUN_STATUSES, projected_view};
use crate::background_jobs::project::notifications;
use crate::socketio::project_chat_messages::{
    INSERT_MESSAGE_SQL, InsertMessage, insert_message_args, runtime_activity_key,
};

pub(super) async fn project(
    tx: &mut impl MysqlTransaction,
    parent: &Message,
    data: Option<&Map<String, Value>>,
    sequence: Option<i64>,
) -> MysqlResult<Option<Projected>> {
    let Some(data) = data else {
        return Ok(None);
    };
    let child = data.get("subagent").and_then(Value::as_object);
    let Some(name) = text(
        data,
        &[
            "subagent_name",
            "subagentName",
            "executor_name",
            "agent_name",
            "name",
        ],
    )
    .or_else(|| child.and_then(|child| text(child, &["name", "title"]))) else {
        return Ok(None);
    };
    let child_id = text(
        data,
        &["subagent_id", "subagentId", "executor_id", "agent_id", "id"],
    )
    .or_else(|| child.and_then(|child| text(child, &["id", "name", "title"])))
    .unwrap_or("child");
    let sender = format!("{}:{child_id}", parent.agent_id);
    let content = text(data, &["summary", "content", "message", "text", "result"]).unwrap_or("");
    let status = status(data);
    let id: Option<brz_mysql::MysqlRow> = tx.fetch_optional(
        format!("SELECT id FROM project_chat_messages WHERE project_id=? AND task_id=? AND trigger_message_id=? AND agent_id=? AND sender_id=? AND {} LIMIT 1 FOR UPDATE", super::UNSET_DELETED_AT),
        (parent.project_id.as_str(), parent.task_id.as_str(), parent.message_id.as_str(), parent.agent_id.as_str(), sender.as_str()),
    ).await?;
    let metadata = json!({
        "kind": "task_ai_subagent", "parent_agent_id": parent.agent_id,
        "parent_message_id": parent.message_id, "subagent_id": child_id,
        "subagent_name": name, "subagent_status": run_status(status), "run_status": run_status(status),
    });
    let row_id = if let Some(id) = id {
        let id: i64 = id.get_required("id")?;
        let Some(mut row) = reload_activity(tx, id).await? else {
            return Ok(None);
        };
        if runtime_event_is_stale(&row, sequence, false) {
            return Ok(None);
        }
        let mut merged = row.metadata.0.as_object().cloned().unwrap_or_default();
        if let Value::Object(metadata) = metadata {
            merged.extend(metadata);
        }
        if TERMINAL_RUN_STATUSES.contains(&row.status.as_str()) {
            let durable = if row.status == "canceled" {
                "cancelled"
            } else {
                &row.status
            };
            merged.insert("run_status".into(), json!(durable));
            merged.insert("subagent_status".into(), json!(durable));
        } else {
            row.status = status.into();
            if !content.is_empty() {
                row.content = content.into();
            }
        }
        row.metadata = Json(Value::Object(merged));
        record_runtime_sequence(&mut row, sequence);
        tx.execute(
            "UPDATE project_chat_messages SET content=?, status=?, message_type='text', metadata=?, updated_at=UTC_TIMESTAMP(6) WHERE id=?",
            (row.content.as_str(), row.status.as_str(), row.metadata, id),
        ).await?;
        id
    } else {
        let id = notifications::uuid();
        let key = runtime_activity_key(
            &parent.runtime_device_id,
            &parent.runtime_task_id,
            &format!("{}:{child_id}", parent.message_id),
        )
        .unwrap_or_default();
        let mut metadata = metadata;
        if let Some(seq) = sequence.filter(|seq| *seq > 0) {
            metadata["runtime_event_sequence"] = json!(seq.to_string());
        }
        tx.execute(
            INSERT_MESSAGE_SQL,
            insert_message_args(&InsertMessage {
                message_id: &id,
                client_message_id: &id,
                project_id: &parent.project_id,
                task_id: &parent.task_id,
                sender_type: "agent",
                sender_id: &sender,
                sender_name: &format!("{}.{name}", parent.sender_name),
                message_type: "text",
                content,
                metadata,
                trigger_message_id: &parent.message_id,
                reply_to_message_id: &parent.message_id,
                thread_root_message_id: if parent.thread_root_message_id.is_empty() {
                    &parent.message_id
                } else {
                    &parent.thread_root_message_id
                },
                agent_id: &parent.agent_id,
                runtime_device_id: &parent.runtime_device_id,
                runtime_task_id: &parent.runtime_task_id,
                runtime_activity_key: &key,
                status,
            }),
        )
        .await?
        .last_insert_id as i64
    };
    Ok(reload_activity(tx, row_id).await?.map(|row| Projected {
        message: projected_view(&row),
        delta: false,
        terminal_activity: TERMINAL_RUN_STATUSES
            .contains(&row.status.as_str())
            .then(|| Box::new(row)),
    }))
}

fn text<'a>(data: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        data.get(*key)?
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn status(data: &Map<String, Value>) -> &'static str {
    let value = text(data, &["status", "kind"])
        .unwrap_or("")
        .replace(['_', '-'], "")
        .to_ascii_lowercase();
    match value.as_str() {
        "done" | "completed" | "taskcomplete" => "completed",
        "failed" | "error" => "failed",
        "interrupted" | "cancelled" | "canceled" | "aborted" => "cancelled",
        _ => "streaming",
    }
}

fn run_status(status: &str) -> &str {
    if status == "streaming" {
        "running"
    } else {
        status
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_runtime_subagent_statuses_to_durable_activity_states() {
        let cases = [
            ("task_complete", "completed"),
            ("error", "failed"),
            ("aborted", "cancelled"),
            ("tool_call", "streaming"),
        ];
        for (raw, expected) in cases {
            let event = json!({"status":raw});
            assert_eq!(status(event.as_object().unwrap()), expected);
        }
        assert_eq!(run_status("streaming"), "running");
    }
}
