// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Project chat messages, wire views, and Runtime reply settlement.

use brz_mysql::{FromMysqlRow, Json, MysqlError, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use wegent_backend_persistence::sql_support::StatementArg;
use wegent_python_compat::json_compat::python_json_value;

use crate::project_store as store;

/// One `project_chat_messages` row used by the view.
#[derive(Clone, Debug, brz_mysql::FromMysqlRow)]
pub struct MessageRow {
    #[mysql(rename = "id")]
    pub id: i64,
    #[mysql(rename = "message_id")]
    pub message_id: String,
    #[mysql(rename = "client_message_id")]
    pub client_message_id: String,
    #[mysql(rename = "project_id")]
    pub project_id: String,
    #[mysql(rename = "task_id")]
    pub task_id: String,
    #[mysql(rename = "sender_type")]
    pub sender_type: String,
    #[mysql(rename = "sender_id")]
    pub sender_id: String,
    #[mysql(rename = "sender_name")]
    pub sender_name: String,
    #[mysql(rename = "message_type")]
    pub message_type: String,
    #[mysql(rename = "content")]
    pub content: String,
    #[mysql(rename = "metadata")]
    pub metadata: Option<Json<Value>>,
    #[mysql(rename = "trigger_message_id")]
    pub trigger_message_id: String,
    #[mysql(rename = "reply_to_message_id")]
    pub reply_to_message_id: String,
    #[mysql(rename = "thread_root_message_id")]
    pub thread_root_message_id: String,
    #[mysql(rename = "agent_id")]
    pub agent_id: String,
    #[mysql(rename = "runtime_device_id")]
    pub runtime_device_id: String,
    #[mysql(rename = "runtime_task_id")]
    pub runtime_task_id: String,
    #[mysql(rename = "status")]
    pub status: String,
    #[mysql(rename = "created_at")]
    pub created_at: chrono::NaiveDateTime,
    #[mysql(rename = "updated_at")]
    pub updated_at: chrono::NaiveDateTime,
}

impl MessageRow {
    pub fn metadata(&self) -> Value {
        self.metadata
            .as_ref()
            .map(|json| json.0.clone())
            .unwrap_or_else(|| json!({}))
    }
}

/// `row.metadata_json` as an object map (the source default is `{}`).
pub fn metadata_map(row: &MessageRow) -> Map<String, Value> {
    match row.metadata() {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The `project_chat_messages` projection shared by every read.
pub const MESSAGE_COLUMNS: &str = "id, message_id, client_message_id, project_id, task_id, \
     sender_type, sender_id, sender_name, message_type, content, metadata, \
     trigger_message_id, reply_to_message_id, thread_root_message_id, agent_id, \
     runtime_device_id, runtime_task_id, status, created_at, updated_at";

#[derive(Debug, Clone, FromMysqlRow)]
pub struct Message {
    pub id: i64,
    pub message_id: String,
    pub client_message_id: String,
    pub project_id: String,
    pub task_id: String,
    pub sender_type: String,
    pub sender_id: String,
    pub sender_name: String,
    pub message_type: String,
    pub content: String,
    pub metadata: Json<Value>,
    pub trigger_message_id: String,
    pub reply_to_message_id: String,
    pub thread_root_message_id: String,
    pub agent_id: String,
    pub runtime_device_id: String,
    pub runtime_task_id: String,
    pub status: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl Message {
    pub fn view(&self) -> Value {
        message_view(&MessageRow {
            id: self.id,
            message_id: self.message_id.clone(),
            client_message_id: self.client_message_id.clone(),
            project_id: self.project_id.clone(),
            task_id: self.task_id.clone(),
            sender_type: self.sender_type.clone(),
            sender_id: self.sender_id.clone(),
            sender_name: self.sender_name.clone(),
            message_type: self.message_type.clone(),
            content: self.content.clone(),
            metadata: Some(self.metadata.clone()),
            trigger_message_id: self.trigger_message_id.clone(),
            reply_to_message_id: self.reply_to_message_id.clone(),
            thread_root_message_id: self.thread_root_message_id.clone(),
            agent_id: self.agent_id.clone(),
            runtime_device_id: self.runtime_device_id.clone(),
            runtime_task_id: self.runtime_task_id.clone(),
            status: self.status.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

/// One deferred `project_chat_messages` INSERT.
pub struct InsertMessage<'a> {
    pub message_id: &'a str,
    pub client_message_id: &'a str,
    pub project_id: &'a str,
    pub task_id: &'a str,
    pub sender_type: &'a str,
    pub sender_id: &'a str,
    pub sender_name: &'a str,
    pub message_type: &'a str,
    pub content: &'a str,
    pub metadata: Value,
    pub trigger_message_id: &'a str,
    pub reply_to_message_id: &'a str,
    pub thread_root_message_id: &'a str,
    pub agent_id: &'a str,
    pub runtime_device_id: &'a str,
    pub runtime_task_id: &'a str,
    pub runtime_activity_key: &'a str,
    pub status: &'a str,
}

pub async fn insert_message_on(
    tx: &mut impl brz_mysql::MysqlTransaction,
    message: &InsertMessage<'_>,
) -> brz_mysql::MysqlResult<i64> {
    tx.execute(INSERT_MESSAGE_SQL, insert_message_args(message))
        .await
        .map(|execution| execution.last_insert_id as i64)
}

pub const INSERT_MESSAGE_SQL: &str = "INSERT INTO project_chat_messages (message_id, client_message_id, project_id, \
               task_id, sender_type, sender_id, sender_name, message_type, content, metadata, \
               trigger_message_id, reply_to_message_id, thread_root_message_id, agent_id, \
               runtime_device_id, runtime_task_id, runtime_activity_key, status) \
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

pub fn insert_message_args(message: &InsertMessage<'_>) -> Vec<StatementArg> {
    vec![
        StatementArg::Str(message.message_id.to_string()),
        StatementArg::Str(message.client_message_id.to_string()),
        StatementArg::Str(message.project_id.to_string()),
        StatementArg::Str(message.task_id.to_string()),
        StatementArg::Str(message.sender_type.to_string()),
        StatementArg::Str(message.sender_id.to_string()),
        StatementArg::Str(message.sender_name.to_string()),
        StatementArg::Str(message.message_type.to_string()),
        StatementArg::Str(message.content.to_string()),
        StatementArg::Str(python_json_value(&message.metadata)),
        StatementArg::Str(message.trigger_message_id.to_string()),
        StatementArg::Str(message.reply_to_message_id.to_string()),
        StatementArg::Str(message.thread_root_message_id.to_string()),
        StatementArg::Str(message.agent_id.to_string()),
        StatementArg::Str(message.runtime_device_id.to_string()),
        StatementArg::Str(message.runtime_task_id.to_string()),
        StatementArg::Str(if message.runtime_activity_key.is_empty() {
            use sha2::{Digest as _, Sha256};
            format!(
                "{:x}",
                Sha256::digest(format!("message\0{}", message.message_id))
            )
        } else {
            message.runtime_activity_key.to_string()
        }),
        StatementArg::Str(message.status.to_string()),
    ]
}

/// Resolve a complete persisted source pair; never combine unrelated sources.
pub fn runtime_source(row: &MessageRow) -> (String, String) {
    if !row.runtime_device_id.is_empty() && !row.runtime_task_id.is_empty() {
        return (row.runtime_device_id.clone(), row.runtime_task_id.clone());
    }
    let metadata = row.metadata();
    let stand_in = &metadata["stand_in"];
    if row.sender_type == "agent"
        && stand_in["binding_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
        && stand_in["user_id"].as_i64().is_some_and(|id| id > 0)
        && let (Some(device), Some(task)) =
            (stand_in["device_id"].as_str(), stand_in["task_id"].as_str())
        && !device.is_empty()
        && !task.is_empty()
    {
        return (device.into(), task.into());
    }
    let publication = &metadata["assistant_publication"];
    if publication["verified"] != true && publication["source_verified"] != true {
        return (String::new(), String::new());
    }
    (
        publication["device_id"].as_str().unwrap_or_default().into(),
        publication["task_id"].as_str().unwrap_or_default().into(),
    )
}

/// `ProjectChatMessageView`.
pub fn message_view(row: &MessageRow) -> Value {
    let metadata = row.metadata();
    let (device_id, task_id) = runtime_source(row);
    let trace_ref = (!device_id.is_empty() && !task_id.is_empty()).then(|| {
        let identity = format!(
            "{}\0{}\0{}\0{}",
            row.project_id, row.task_id, device_id, task_id
        );
        format!("{:x}", Sha256::digest(identity.as_bytes()))
    });
    let historical = metadata
        .get("history_import")
        .is_some_and(|value| !value.is_null())
        || metadata
            .get("imported_from")
            .is_some_and(|value| !value.is_null());
    let verified_publication = metadata
        .get("assistant_publication")
        .and_then(|value| value.get("verified"))
        .and_then(Value::as_bool)
        == Some(true);
    let verified_source = metadata["assistant_publication"]["source_verified"] == true;
    let published_by = metadata
        .get("assistant_publication")
        .filter(|_| verified_publication)
        .and_then(|value| value.get("published_by"))
        .and_then(Value::as_str);
    let source = if historical {
        "human"
    } else if verified_publication || verified_source {
        "ai"
    } else {
        match row.sender_type.as_str() {
            "user" => "human",
            "agent" => "ai",
            _ => "system",
        }
    };
    json!({
        "actorUserId": if source == "human" { optional_text(&row.sender_id) } else { Value::Null },
        "actorDisplayName": if source == "human" { optional_text(&row.sender_name) } else { Value::Null },
        "generationSource": source,
        "publicationSource": if published_by == Some("ai") {
            "ai"
        } else if verified_publication {
            "human"
        } else {
            source
        },
        "confirmationState": if historical {
            "unknown"
        } else if published_by == Some("ai") {
            "not_required"
        } else if verified_publication {
            "authorized"
        } else if source == "ai" {
            "pending"
        } else {
            "not_required"
        },
        "sequenceNumber": row.id,
        "messageId": row.message_id,
        "clientMessageId": optional_text(&row.client_message_id),
        "projectId": row.project_id,
        "taskId": optional_text(&row.task_id),
        "sender": {
            "type": row.sender_type,
            "id": row.sender_id,
            "name": row.sender_name,
        },
        "type": row.message_type,
        "content": row.content,
        "metadata": row.metadata(),
        "triggerMessageId": optional_text(&row.trigger_message_id),
        "replyToMessageId": optional_text(&row.reply_to_message_id),
        "rootMessageId": optional_text(&row.thread_root_message_id),
        "agentId": optional_text(&row.agent_id),
        "runtimeAddress": Value::Null,
        "traceState": if trace_ref.is_some() { "restricted" } else { "history-unavailable" },
        "traceRef": trace_ref,
        "status": row.status,
        "createdAt": utc_isoformat(row.created_at),
        "updatedAt": utc_isoformat(row.updated_at),
    })
}

/// An empty text column renders as JSON null.
pub fn optional_text(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value.to_string())
    }
}

/// `database_datetime_as_utc(...).isoformat()`: naive columns are stored in the
/// deployment's UTC+8 timezone.
pub fn utc_isoformat(value: chrono::NaiveDateTime) -> String {
    let utc = utc_timestamp(value).and_utc();
    if utc.timestamp_subsec_nanos() == 0 {
        utc.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    } else {
        utc.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
    }
}

pub use crate::project_store::{database_timestamp, utc_timestamp};

pub fn utc_isoformat_micros() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
}

/// `_runtime_activity_key`: sha256 of `device\0task\0trigger`.
pub fn runtime_activity_key(
    runtime_device_id: &str,
    runtime_task_id: &str,
    trigger_message_id: &str,
) -> Option<String> {
    if runtime_device_id.is_empty() || runtime_task_id.is_empty() {
        return None;
    }
    use sha2::{Digest as _, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(runtime_device_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(runtime_task_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(trigger_message_id.as_bytes());
    Some(
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

pub async fn settle_human_reply(
    tx: &mut impl MysqlTransaction,
    mut issue: store::Node,
    request_id: &str,
    message_id: &str,
) -> Result<bool, MysqlError> {
    let Some(target) = issue.metadata.0["human_requests"]
        .as_array_mut()
        .and_then(|requests| {
            requests
                .iter_mut()
                .find(|request| request["id"] == request_id)
        })
        .filter(|request| {
            request["status"] == "answering" && request["answer_message_id"] == message_id
        })
    else {
        return Ok(false);
    };
    let now = chrono::Utc::now().to_rfc3339();
    target
        .as_object_mut()
        .expect("matched request object")
        .remove("delivery_error");
    target["status"] = json!("resolved");
    target["version"] = json!(target["version"].as_i64().unwrap_or(1) + 1);
    target["updated_at"] = json!(now);
    let mut events = target["events"].as_array().cloned().unwrap_or_default();
    events.push(json!({"type":"accepted","at":now,"message_id":message_id}));
    target["events"] = json!(events);
    let recipient = target["recipient_user_id"].as_i64().unwrap_or(0);
    let responsible = target["responsible_user_id"].as_i64().unwrap_or(0);
    tx.execute("UPDATE loop_items SET metadata=?, version=version+1, updated_at=CURRENT_TIMESTAMP(6) WHERE id=?",
        (issue.metadata, issue.id.as_str())).await?;
    tx.execute("DELETE FROM loop_items WHERE resource_type='human_request_index' AND parent_id=? AND name=?",
        (issue.id.as_str(), request_id)).await?;
    tx.execute("UPDATE wework_notifications SET is_read=true, read_status_changed_at=UTC_TIMESTAMP(6)
        WHERE user_id IN (?,?) AND is_read=false AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.humanRequestId'))=?",
        (recipient, responsible, request_id)).await?;
    Ok(true)
}

pub fn shared_message_payload(view: &Value) -> Value {
    let mut shared = view.clone();
    if let Some(metadata) = view.get("metadata") {
        shared["metadata"] = json!(shared_metadata(metadata, false));
    }
    if private_execution_message(view["type"].as_str().unwrap_or_default(), &view["metadata"]) {
        shared["content"] = json!("");
        if view["type"] == "text" {
            shared["type"] = json!("agent_chunk");
        }
    }
    shared["runtimeAddress"] = Value::Null;
    shared["traceState"] = json!(
        if view.get("traceRef").is_some_and(|value| !value.is_null()) {
            "restricted"
        } else {
            "history-unavailable"
        }
    );
    shared
}

pub fn private_execution_message(message_type: &str, metadata: &Value) -> bool {
    matches!(message_type, "agent_status" | "agent_chunk") || metadata["kind"] == "task_ai_subagent"
}

pub fn shared_metadata(metadata: &Value, include_runtime: bool) -> serde_json::Map<String, Value> {
    const SHARED_KEYS: &[&str] = &[
        "mentions",
        "stand_in_reply_to",
        "collaboration_public_reply",
        "collaboration_turn_start",
        "collaboration_guidance",
        "collaboration_execution_activity_id",
        "execution_dispatch",
        "activity_type",
        "dispatch_role",
        "manager_display_name",
        "run_status",
        "externalInvocation",
        "externalProgress",
        "externalReplyRevision",
        "summary",
        "evidence_refs",
        "next_action",
        "publish_policy",
        "imported_from",
        "history_import",
        "member_assistant_result",
        "runtime_event_sequence",
    ];
    const RUNTIME_KEYS: &[&str] = &[
        "run_id",
        "execution_id",
        "executor_type",
        "backend_task_id",
        "execution_url",
        "model",
        "runtime_event_sequence",
        "contentMode",
        "runtime_turn_id",
        "workflow_task_title",
    ];
    SHARED_KEYS
        .iter()
        .chain(if include_runtime {
            RUNTIME_KEYS.iter()
        } else {
            [].iter()
        })
        .filter_map(|key| {
            metadata
                .get(*key)
                .map(|value| ((*key).into(), value.clone()))
        })
        .collect()
}
