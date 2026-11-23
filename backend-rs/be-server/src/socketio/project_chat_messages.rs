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
use serde_json::{Map, Value, json};

use super::project_chat_events::ack_error;
use crate::json_compat::python_json_value;
use crate::sql_support::StatementArg;
use crate::state::AppState;

#[cfg(test)]
pub(crate) use wegent_project_coordination::project_chat_message::utc_isoformat;
pub(crate) use wegent_project_coordination::project_chat_message::{
    INSERT_MESSAGE_SQL, InsertMessage, MESSAGE_COLUMNS, MessageRow, database_timestamp,
    insert_message_args, insert_message_on, message_view, metadata_map, runtime_activity_key,
    runtime_source, utc_isoformat_micros, utc_timestamp,
};

use super::project_chat_events::{AgentFailureRequest, AgentStartRequest};

#[path = "project_chat_authorship.rs"]
mod authorship;
pub(crate) use authorship::{message_view_with_actor, shared_message_payload};

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
