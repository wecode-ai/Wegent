// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `project_chat_messages` row access and view rendering.
//!
//! Source: `app/services/project_chat/service.py` (`subscribe`, `send`,
//! `start_agent_response`, `fail_agent_response`, `to_view`,
//! `_agent_response_for_runtime`, `_finish_activity`) and
//! `app/api/ws/wework_runtime_namespace.py`.

use brz_mysql::{Json, MysqlTransaction as _};
use chrono::Utc;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::project_chat_events::ack_error;
use crate::json_compat::python_json_value;
use crate::sql_support::StatementArg;
use crate::state::AppState;

use super::project_chat_events::{AgentFailureRequest, AgentStartRequest};

#[path = "project_chat_authorship.rs"]
mod authorship;
pub(crate) use authorship::{message_view_with_actor, shared_message_payload};

/// One `project_chat_messages` row used by the view.
#[derive(Clone, Debug, brz_mysql::FromMysqlRow)]
pub(crate) struct MessageRow {
    #[mysql(rename = "id")]
    pub(crate) id: i64,
    #[mysql(rename = "message_id")]
    pub(crate) message_id: String,
    #[mysql(rename = "client_message_id")]
    pub(crate) client_message_id: String,
    #[mysql(rename = "project_id")]
    pub(crate) project_id: String,
    #[mysql(rename = "task_id")]
    pub(crate) task_id: String,
    #[mysql(rename = "sender_type")]
    pub(crate) sender_type: String,
    #[mysql(rename = "sender_id")]
    pub(crate) sender_id: String,
    #[mysql(rename = "sender_name")]
    pub(crate) sender_name: String,
    #[mysql(rename = "message_type")]
    pub(crate) message_type: String,
    #[mysql(rename = "content")]
    pub(crate) content: String,
    #[mysql(rename = "metadata")]
    pub(crate) metadata: Option<Json<Value>>,
    #[mysql(rename = "trigger_message_id")]
    pub(crate) trigger_message_id: String,
    #[mysql(rename = "reply_to_message_id")]
    pub(crate) reply_to_message_id: String,
    #[mysql(rename = "thread_root_message_id")]
    pub(crate) thread_root_message_id: String,
    #[mysql(rename = "agent_id")]
    pub(crate) agent_id: String,
    #[mysql(rename = "runtime_device_id")]
    pub(crate) runtime_device_id: String,
    #[mysql(rename = "runtime_task_id")]
    pub(crate) runtime_task_id: String,
    #[mysql(rename = "status")]
    pub(crate) status: String,
    #[mysql(rename = "created_at")]
    pub(crate) created_at: chrono::NaiveDateTime,
    #[mysql(rename = "updated_at")]
    pub(crate) updated_at: chrono::NaiveDateTime,
}

impl MessageRow {
    pub(crate) fn metadata(&self) -> Value {
        self.metadata
            .as_ref()
            .map(|json| json.0.clone())
            .unwrap_or_else(|| json!({}))
    }
}

/// `row.metadata_json` as an object map (the source default is `{}`).
pub(crate) fn metadata_map(row: &MessageRow) -> Map<String, Value> {
    match row.metadata() {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The `project_chat_messages` projection shared by every read.
pub(super) const MESSAGE_COLUMNS: &str = "id, message_id, client_message_id, project_id, task_id, \
     sender_type, sender_id, sender_name, message_type, content, metadata, \
     trigger_message_id, reply_to_message_id, thread_root_message_id, agent_id, \
     runtime_device_id, runtime_task_id, status, created_at, updated_at";

/// `subscribe`'s message query (`after_sequence` order, limit, task filter).
pub(crate) async fn load_messages(
    mysql: &impl brz_mysql::Mysql,
    viewer_user_id: i64,
    project_id: &str,
    task_id: Option<&str>,
    after_sequence: i64,
    limit: i64,
    message_id: Option<&str>,
) -> Result<Vec<Value>, Value> {
    let task_filter = if task_id.is_some() {
        "project_chat_messages.task_id = ?"
    } else {
        "(project_chat_messages.task_id IS NULL OR project_chat_messages.task_id = '')"
    };
    let mut arguments = vec![StatementArg::Str(project_id.to_string())];
    if let Some(task_id) = task_id {
        arguments.push(StatementArg::Str(task_id.to_string()));
    }
    let exact_message = if let Some(message) = message_id {
        arguments.push(StatementArg::Str(message.to_owned()));
        " AND project_chat_messages.message_id = ?"
    } else {
        ""
    };
    let sql = if after_sequence > 0 {
        format!(
            "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages \
             WHERE project_chat_messages.project_id = ? \
             AND (project_chat_messages.deleted_at IS NULL OR project_chat_messages.deleted_at \
             IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
             AND {task_filter}{exact_message} AND project_chat_messages.id > ? \
             ORDER BY project_chat_messages.id ASC LIMIT ?"
        )
    } else {
        format!(
            "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages \
             WHERE project_chat_messages.project_id = ? \
             AND (project_chat_messages.deleted_at IS NULL OR project_chat_messages.deleted_at \
             IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
             AND {task_filter}{exact_message} \
             ORDER BY project_chat_messages.id DESC LIMIT ?"
        )
    };
    if after_sequence > 0 {
        arguments.push(StatementArg::Int(after_sequence));
    }
    arguments.push(StatementArg::Int(limit));
    let rows: Vec<MessageRow> = mysql.fetch_all(&sql, arguments).await.map_err(|error| {
        tracing::error!(%error, project_id, "project chat message read failed");
        ack_error("INVALID_MESSAGE", "database query failed")
    })?;
    let mut rows = rows;
    if after_sequence <= 0 {
        rows.reverse();
    }
    authorship::message_views(mysql, viewer_user_id, &rows).await
}

/// One message by primary key (`db.refresh`).
pub(crate) async fn load_message_by_id(
    state: &AppState,
    id: i64,
) -> Result<Option<MessageRow>, Value> {
    let sql = format!("SELECT {MESSAGE_COLUMNS} FROM project_chat_messages WHERE id = ? LIMIT 1");
    let handle = &state.mysql;
    handle.fetch_optional(&sql, (id,)).await.map_err(|error| {
        tracing::error!(%error, id, "project chat message refresh failed");
        ack_error("INVALID_MESSAGE", "database query failed")
    })
}

/// One message by its public id and project.
pub(crate) async fn load_message_by_message_id(
    state: &AppState,
    project_id: &str,
    message_id: &str,
) -> Result<Option<MessageRow>, Value> {
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages \
         WHERE message_id = ? AND project_id = ? \
         AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         LIMIT 1"
    );
    let handle = &state.mysql;
    handle
        .fetch_optional(&sql, (message_id, project_id))
        .await
        .map_err(|error| {
            tracing::error!(%error, "project chat reply target read failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })
}

/// The dedupe read (`sender_type`, `sender_id`, `client_message_id`).
pub(crate) async fn existing_client_message(
    state: &AppState,
    user_id: i64,
    client_message_id: &str,
) -> Option<MessageRow> {
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages \
         WHERE sender_type = 'user' AND sender_id = ? AND client_message_id = ? LIMIT 1"
    );
    let handle = &state.mysql;
    handle
        .fetch_optional(&sql, (user_id.to_string(), client_message_id))
        .await
        .ok()
        .flatten()
}

/// `_agent_response_for_runtime`.
pub(crate) async fn existing_agent_response(
    state: &AppState,
    request: &AgentStartRequest,
) -> Result<Option<MessageRow>, Value> {
    let (trigger_filter, mut arguments) = match &request.trigger_message_id {
        Some(trigger_id) => (
            "trigger_message_id = ?".to_string(),
            vec![StatementArg::Str(trigger_id.clone())],
        ),
        None => (
            "(trigger_message_id IS NULL OR trigger_message_id = '')".to_string(),
            Vec::new(),
        ),
    };
    arguments.push(StatementArg::Str(request.agent_id.clone()));
    arguments.push(StatementArg::Str(request.runtime_device_id.clone()));
    arguments.push(StatementArg::Str(request.runtime_task_id.clone()));
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages \
         WHERE {trigger_filter} AND agent_id = ? AND runtime_device_id = ? AND runtime_task_id = ? \
         AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         LIMIT 1"
    );
    let handle = &state.mysql;
    handle
        .fetch_optional(&sql, arguments)
        .await
        .map_err(|error| {
            tracing::error!(%error, "project chat agent response read failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })
}

/// `_active AI response` lookup for `agent:failed`.
pub(crate) async fn load_active_agent_response(
    state: &AppState,
    request: &AgentFailureRequest,
) -> Result<Option<MessageRow>, Value> {
    let task_filter = if request.task_id.is_some() {
        "task_id = ?"
    } else {
        "(task_id IS NULL OR task_id = '')"
    };
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages \
         WHERE message_id = ? AND project_id = ? AND {task_filter} AND sender_type = 'agent' \
         AND status IN ('pending', 'streaming') \
         AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         LIMIT 1"
    );
    let mut arguments = vec![
        StatementArg::Str(request.message_id.clone()),
        StatementArg::Str(request.project_id.clone()),
    ];
    if let Some(task_id) = &request.task_id {
        arguments.push(StatementArg::Str(task_id.clone()));
    }
    let handle = &state.mysql;
    handle
        .fetch_optional(&sql, arguments)
        .await
        .map_err(|error| {
            tracing::error!(%error, "project chat active response read failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })
}

/// One user trigger message.
pub(crate) async fn load_trigger(
    state: &AppState,
    project_id: &str,
    task_id: Option<&str>,
    trigger_id: &str,
) -> Result<Option<MessageRow>, Value> {
    let task_filter = if task_id.is_some() {
        "task_id = ?"
    } else {
        "(task_id IS NULL OR task_id = '')"
    };
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages \
         WHERE message_id = ? AND project_id = ? AND {task_filter} AND sender_type = 'user' \
         AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
         LIMIT 1"
    );
    let mut arguments = vec![
        StatementArg::Str(trigger_id.to_string()),
        StatementArg::Str(project_id.to_string()),
    ];
    if let Some(task_id) = task_id {
        arguments.push(StatementArg::Str(task_id.to_string()));
    }
    let handle = &state.mysql;
    handle
        .fetch_optional(&sql, arguments)
        .await
        .map_err(|error| {
            tracing::error!(%error, "project chat trigger read failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })
}

/// One user message by id scoped to the caller.
pub(crate) async fn load_user_message(
    state: &AppState,
    trigger_id: &str,
    user_id: i64,
) -> Result<Option<MessageRow>, Value> {
    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages \
         WHERE message_id = ? AND sender_type = 'user' AND sender_id = ? LIMIT 1"
    );
    let handle = &state.mysql;
    handle
        .fetch_optional(&sql, (trigger_id, user_id.to_string()))
        .await
        .map_err(|error| {
            tracing::error!(%error, "project chat trigger read failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })
}

pub(super) async fn load_comment_trigger(
    state: &AppState,
    project_id: &str,
    task_id: &str,
    message_id: &str,
    user_id: i64,
) -> Result<Option<MessageRow>, Value> {
    state
        .mysql
        .fetch_optional(
            format!(
                "SELECT {MESSAGE_COLUMNS} FROM project_chat_messages
                 WHERE project_id=? AND task_id=? AND message_id=? AND sender_type='user'
                   AND sender_id=? AND (deleted_at IS NULL OR deleted_at IN
                       ('1970-01-01 00:00:00','1970-01-01 00:00:01')) LIMIT 1"
            ),
            (project_id, task_id, message_id, user_id.to_string()),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "project chat comment trigger read failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })
}

/// `require_cloud_project_role` for the comment executor's task lookup.
pub(crate) async fn project_task_exists(state: &AppState, project_id: &str, task_id: &str) -> bool {
    let sql = "SELECT 1 FROM loop_items WHERE id = ? AND cloud_project_id = ? \
               AND resource_type = 'task' \
               AND (deleted_at IS NULL OR deleted_at IN ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
               LIMIT 1";
    let handle = &state.mysql;
    matches!(
        handle
            .fetch_optional::<_, _, i64>(sql, (task_id, project_id))
            .await,
        Ok(Some(_))
    )
}

/// `ProjectChatAgent` row.
pub(crate) struct AgentRow {
    pub(crate) id: String,
    pub(crate) cloud_project_id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) title: Option<String>,
    pub(crate) status: Option<String>,
    pub(crate) created_by_user_id: Option<i32>,
    pub(crate) metadata: Value,
    pub(crate) deleted_at: Option<chrono::NaiveDateTime>,
}

impl AgentRow {
    pub(crate) fn sender_name(&self) -> String {
        self.title
            .clone()
            .filter(|title| !title.is_empty())
            .or_else(|| self.name.clone())
            .unwrap_or_default()
    }
}

/// `db.get(ProjectChatAgent, agent_id)`.
pub(crate) async fn load_agent(state: &AppState, agent_id: &str) -> Result<AgentRow, Value> {
    #[derive(brz_mysql::FromMysqlRow)]
    struct Row {
        #[mysql(rename = "id")]
        id: String,
        #[mysql(rename = "cloud_project_id")]
        cloud_project_id: Option<String>,
        #[mysql(rename = "name")]
        name: Option<String>,
        #[mysql(rename = "title")]
        title: Option<String>,
        #[mysql(rename = "status")]
        status: Option<String>,
        #[mysql(rename = "created_by_user_id")]
        created_by_user_id: Option<i32>,
        #[mysql(rename = "metadata")]
        metadata: Option<Json<Value>>,
        #[mysql(rename = "deleted_at")]
        deleted_at: Option<chrono::NaiveDateTime>,
    }
    let handle = &state.mysql;
    let row: Option<Row> = handle
        .fetch_optional(
            "SELECT id, cloud_project_id, name, title, status, created_by_user_id, metadata, \
             deleted_at FROM loop_items WHERE id = ? AND resource_type = 'chat_agent' LIMIT 1",
            (agent_id,),
        )
        .await
        .map_err(|error| {
            tracing::error!(%error, "project chat agent read failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })?;
    let Some(row) = row else {
        return Err(ack_error("SCOPE_NOT_FOUND", "Project chat AI not found"));
    };
    Ok(AgentRow {
        id: row.id,
        cloud_project_id: row.cloud_project_id,
        name: row.name,
        title: row.title,
        status: row.status,
        created_by_user_id: row.created_by_user_id,
        metadata: row.metadata.map(|json| json.0).unwrap_or_else(|| json!({})),
        deleted_at: row.deleted_at,
    })
}

/// `require_project_agent` + `require_project_agent_visibility`.
pub(crate) fn validate_agent(
    agent: &AgentRow,
    project_id: &str,
    user_id: i64,
) -> Result<(), Value> {
    let enabled = agent.cloud_project_id.as_deref() == Some(project_id)
        && agent.status.as_deref() == Some("active")
        && crate::board_snapshot::repository::datetime_is_unset(agent.deleted_at);
    if !enabled {
        return Err(ack_error(
            "INVALID_MESSAGE",
            "Agent is not enabled in this project",
        ));
    }
    let private = agent.metadata.get("visibility").and_then(Value::as_str) == Some("private");
    if private && agent.created_by_user_id.map(i64::from) != Some(user_id) {
        return Err(ack_error(
            "SCOPE_FORBIDDEN",
            "Private Agent is not shared with this member",
        ));
    }
    Ok(())
}

/// One deferred `project_chat_messages` INSERT.
pub(crate) struct InsertMessage<'a> {
    pub(crate) message_id: &'a str,
    pub(crate) client_message_id: &'a str,
    pub(crate) project_id: &'a str,
    pub(crate) task_id: &'a str,
    pub(crate) sender_type: &'a str,
    pub(crate) sender_id: &'a str,
    pub(crate) sender_name: &'a str,
    pub(crate) message_type: &'a str,
    pub(crate) content: &'a str,
    pub(crate) metadata: Value,
    pub(crate) trigger_message_id: &'a str,
    pub(crate) reply_to_message_id: &'a str,
    pub(crate) thread_root_message_id: &'a str,
    pub(crate) agent_id: &'a str,
    pub(crate) runtime_device_id: &'a str,
    pub(crate) runtime_task_id: &'a str,
    pub(crate) runtime_activity_key: &'a str,
    pub(crate) status: &'a str,
}

/// `db.add` + flush: insert one message and return its generated id.
pub(crate) async fn insert_message(
    state: &AppState,
    message: &InsertMessage<'_>,
) -> Result<i64, Value> {
    state
        .mysql
        .execute(INSERT_MESSAGE_SQL, insert_message_args(message))
        .await
        .map(|execution| execution.last_insert_id as i64)
        .map_err(|error| {
            tracing::error!(%error, "project chat message insert failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })
}

pub(crate) async fn insert_message_on(
    tx: &mut impl brz_mysql::MysqlTransaction,
    message: &InsertMessage<'_>,
) -> brz_mysql::MysqlResult<i64> {
    tx.execute(INSERT_MESSAGE_SQL, insert_message_args(message))
        .await
        .map(|execution| execution.last_insert_id as i64)
}

pub(super) const INSERT_MESSAGE_SQL: &str = "INSERT INTO project_chat_messages (message_id, client_message_id, project_id, \
               task_id, sender_type, sender_id, sender_name, message_type, content, metadata, \
               trigger_message_id, reply_to_message_id, thread_root_message_id, agent_id, \
               runtime_device_id, runtime_task_id, runtime_activity_key, status) \
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

pub(super) fn insert_message_args(message: &InsertMessage<'_>) -> Vec<StatementArg> {
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

/// `_finish_activity`'s message update.
pub(crate) async fn update_message(
    state: &AppState,
    row: &MessageRow,
    message_type: &str,
    content: Option<&str>,
    metadata: &Map<String, Value>,
    status: Value,
) -> Result<(), Value> {
    let status = status.as_str().unwrap_or("failed").to_string();
    let content = content.unwrap_or(row.content.as_str());
    let sql = "UPDATE project_chat_messages SET message_type=?, content=?, metadata=?, \
               status=?, updated_at=now() WHERE id = ?";
    state
        .mysql
        .with_transaction(async |transaction| {
            transaction
                .execute(
                    sql,
                    (
                        message_type.to_string(),
                        content.to_string(),
                        python_json_value(&Value::Object(metadata.clone())),
                        status.clone(),
                        row.id,
                    ),
                )
                .await?;
            Ok(())
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, "project chat message update failed");
            ack_error("INVALID_MESSAGE", "database query failed")
        })
}

/// Resolve a complete persisted source pair; never combine unrelated sources.
pub(super) fn runtime_source(row: &MessageRow) -> (String, String) {
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
pub(crate) fn message_view(row: &MessageRow) -> Value {
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
pub(crate) fn optional_text(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        Value::String(value.to_string())
    }
}

/// `database_datetime_as_utc(...).isoformat()`: naive columns are stored in the
/// deployment's UTC+8 timezone.
pub(crate) fn utc_isoformat(value: chrono::NaiveDateTime) -> String {
    let utc = utc_timestamp(value).and_utc();
    if utc.timestamp_subsec_nanos() == 0 {
        utc.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    } else {
        utc.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
    }
}

const DATABASE_OFFSET: chrono::Duration = chrono::Duration::hours(8);

/// Encode a UTC instant using the same database-session convention as reads.
pub(crate) fn database_timestamp(value: chrono::NaiveDateTime) -> chrono::NaiveDateTime {
    value + DATABASE_OFFSET
}

/// Keep in-memory activity updates at the precision of the message table's DATETIME column.
pub(super) fn activity_database_timestamp(value: chrono::NaiveDateTime) -> chrono::NaiveDateTime {
    use chrono::Timelike as _;

    database_timestamp(value.with_nanosecond(0).expect("whole seconds are valid"))
}

pub(crate) fn utc_timestamp(value: chrono::NaiveDateTime) -> chrono::NaiveDateTime {
    value - DATABASE_OFFSET
}

/// `datetime.now(UTC).isoformat()`.
pub(crate) fn utc_isoformat_micros() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
}

/// `_runtime_activity_key`: sha256 of `device\0task\0trigger`.
pub(crate) fn runtime_activity_key(
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

/// `uuid.uuid4()`.
pub(crate) fn uuid4() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{}-{}-{}-{}-{}",
        hex(&bytes[0..4]),
        hex(&bytes[4..6]),
        hex(&bytes[6..8]),
        hex(&bytes[8..10]),
        hex(&bytes[10..16])
    )
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
pub(crate) async fn verify_source_resolution(mysql: &impl brz_mysql::Mysql) -> anyhow::Result<()> {
    let execution = mysql.execute("INSERT INTO loop_item_executions(loop_item_id,cloud_project_id,agent_id,executor_owner_user_id,status,runtime_device_id,runtime_task_id,execution_payload,error_message) VALUES ('timestamp-issue','timestamp-project','',1,'claimed','native-device','native-task','{}','')",()).await?.last_insert_id;
    for id in ["first-source", "newer-source"] {
        let message = InsertMessage {
            message_id: id,
            client_message_id: "",
            project_id: "timestamp-project",
            task_id: "timestamp-issue",
            sender_type: "agent",
            sender_id: "group",
            sender_name: "Group",
            message_type: "agent_status",
            content: "private output",
            metadata: json!({"execution_id":execution,"runtime_event_sequence":"7","private_prompt":"private"}),
            trigger_message_id: id,
            reply_to_message_id: "",
            thread_root_message_id: "",
            agent_id: "",
            runtime_device_id: "native-device",
            runtime_task_id: "native-task",
            runtime_activity_key: "",
            status: "completed",
        };
        mysql
            .execute(INSERT_MESSAGE_SQL, insert_message_args(&message))
            .await?;
    }
    let messages = load_messages(
        mysql,
        99,
        "timestamp-project",
        Some("timestamp-issue"),
        0,
        1,
        Some("first-source"),
    )
    .await
    .unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["messageId"], "first-source");
    assert_eq!(
        messages[0]["traceState"], "available",
        "A canonical group execution uses the persisted empty agent ID"
    );
    assert_eq!(messages[0]["runtimeAddress"]["taskId"], "native-task");
    assert_eq!(messages[0]["content"], "");
    assert!(messages[0]["metadata"].get("private_prompt").is_none());
    assert_eq!(messages[0]["metadata"]["runtime_event_sequence"], "7");
    assert!(
        load_messages(
            mysql,
            99,
            "timestamp-project",
            Some("another-issue"),
            0,
            1,
            Some("first-source")
        )
        .await
        .unwrap()
        .is_empty()
    );
    mysql.execute("UPDATE loop_items SET metadata=JSON_SET(COALESCE(metadata,JSON_OBJECT()),'$.assistant_dispatch_role','owner_assistant') WHERE id='timestamp-issue'",()).await?;
    let private = load_messages(
        mysql,
        99,
        "timestamp-project",
        Some("timestamp-issue"),
        0,
        1,
        Some("first-source"),
    )
    .await
    .unwrap();
    assert_eq!(private[0]["traceState"], "restricted");
    assert!(private[0]["runtimeAddress"].is_null());
    Ok(())
}
