// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Project one managed Task's outcome onto its automation run and timeline.

use anyhow::Result;
use brz_mysql::{
    FromMysqlCol, FromMysqlRow, Json, Mysql, MysqlError, MysqlResult, MysqlRow, MysqlTransaction,
};
use brz_redis::Redis;
use chrono::{NaiveDateTime, Utc};
use serde_json::{Value, json};

use crate::socketio_emit::{SOCKETIO_CHANNEL, emit_message};

const TERMINAL: &[&str] = &["succeeded", "failed", "cancelled", "skipped"];

/// `task_store.get_by_id` (`app/stores/tasks/sqlalchemy_task_store.py:403-411`):
/// the full TaskResource projection filtered by id only. The owner is checked
/// after the read (`project_automation_managed_execution.py`'s
/// `task.user_id != user_id`), so the statement carries no `user_id` or `kind`
/// predicate.
fn task_by_id_statement(table: &str) -> String {
    format!(
        "SELECT {} \nFROM {table} \nWHERE {table}.id = ? \n LIMIT 1",
        crate::task_store_statements::task_projection(table)
    )
}

/// Decode one column of the labeled TaskResource projection positionally.
fn task_column<T: FromMysqlCol>(row: &MysqlRow, column: &str) -> MysqlResult<T> {
    let index = crate::task_store_statements::task_column_index(column).ok_or_else(|| {
        MysqlError::InvalidQuery {
            reason: format!("unknown task projection column: {column}"),
        }
    })?;
    row.get_at(index)
}

/// Source's post-read ownership guard (`task.user_id != user_id`).
fn task_owned_by(read_user_id: i64, owner_id: i64) -> bool {
    read_user_id == owner_id
}

#[derive(Debug, FromMysqlRow)]
struct Run {
    id: String,
    cloud_project_id: Option<String>,
    created_by_user_id: Option<i64>,
    backend_task_id: Option<i64>,
    status: Option<String>,
}

#[derive(Debug, FromMysqlRow)]
struct Subtask {
    result: Option<Json<Value>>,
    error_message: Option<String>,
}

#[derive(Debug, FromMysqlRow)]
pub(crate) struct Message {
    pub(crate) id: i64,
    pub(crate) message_id: String,
    pub(crate) client_message_id: String,
    pub(crate) project_id: String,
    pub(crate) task_id: String,
    pub(crate) sender_type: String,
    pub(crate) sender_id: String,
    pub(crate) sender_name: String,
    pub(crate) message_type: String,
    pub(crate) content: String,
    pub(crate) metadata: Json<Value>,
    pub(crate) trigger_message_id: String,
    pub(crate) reply_to_message_id: String,
    pub(crate) thread_root_message_id: String,
    pub(crate) agent_id: String,
    pub(crate) runtime_device_id: String,
    pub(crate) runtime_task_id: String,
    pub(crate) status: String,
    pub(crate) created_at: NaiveDateTime,
    pub(crate) updated_at: NaiveDateTime,
}

impl Message {
    pub(crate) fn view(&self) -> Value {
        let optional = |value: &str| (!value.is_empty()).then(|| value.to_string());
        json!({
            "sequenceNumber": self.id,
            "messageId": self.message_id,
            "clientMessageId": optional(&self.client_message_id),
            "projectId": self.project_id,
            "taskId": optional(&self.task_id),
            "sender": {"type": self.sender_type, "id": self.sender_id, "name": self.sender_name},
            "type": self.message_type,
            "content": self.content,
            "metadata": self.metadata.0,
            "triggerMessageId": optional(&self.trigger_message_id),
            "replyToMessageId": optional(&self.reply_to_message_id),
            "rootMessageId": optional(&self.thread_root_message_id),
            "agentId": optional(&self.agent_id),
            "runtimeAddress": if self.runtime_device_id.is_empty() || self.runtime_task_id.is_empty() {
                Value::Null
            } else { json!({"deviceId": self.runtime_device_id, "taskId": self.runtime_task_id}) },
            "status": self.status,
            "createdAt": self.created_at.and_utc().to_rfc3339(),
            "updatedAt": self.updated_at.and_utc().to_rfc3339(),
        })
    }
}

#[derive(Debug)]
struct Labels {
    subtask_id: i64,
    run_id: String,
    message_id: String,
    project_id: Option<String>,
    board_task_id: Option<String>,
}

impl Labels {
    fn parse(document: &Value) -> Option<Self> {
        let labels = document.pointer("/metadata/labels")?;
        if labels.get("source")?.as_str()? != "project_automation" {
            return None;
        }
        Some(Self {
            subtask_id: integer(labels.get("projectAutomationSubtaskId")?)?,
            run_id: labels
                .get("projectAutomationRunId")?
                .as_str()
                .filter(|v| !v.is_empty())?
                .into(),
            message_id: labels
                .get("projectChatMessageId")?
                .as_str()
                .filter(|v| !v.is_empty())?
                .into(),
            project_id: labels.get("weworkSpaceProjectId").map(identity),
            board_task_id: labels.get("weworkSpaceTaskId").map(identity),
        })
    }

    fn matches(&self, run: &Run, message: &Message, task_id: i64, owner_id: i64) -> bool {
        run.created_by_user_id == Some(owner_id)
            && run
                .backend_task_id
                .is_none_or(|id| id == 0 || id == task_id)
            && self.project_id.as_ref().is_none_or(|id| {
                *id == message.project_id && run.cloud_project_id.as_ref() == Some(id)
            })
            && self
                .board_task_id
                .as_ref()
                .is_none_or(|id| *id == message.task_id)
            && message
                .metadata
                .0
                .get("automation_run_id")
                .is_none_or(|id| identity(id) == self.run_id)
            && message.metadata.0.get("backend_task_id").is_none_or(|id| {
                id.is_null() || integer(id).is_some_and(|id| id == 0 || id == task_id)
            })
    }
}

fn integer(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}

fn identity(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn final_text(result: Option<&Value>) -> Option<String> {
    let result = result?;
    for source in [Some(result), result.get("result")].into_iter().flatten() {
        for key in ["value", "text", "content", "output_text"] {
            if let Some(value) = source
                .get(key)
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
            {
                return Some(value.into());
            }
        }
    }
    let texts: String = result
        .pointer("/response/output")?
        .as_array()?
        .iter()
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect();
    (!texts.is_empty()).then_some(texts)
}

fn apply_terminal(
    run: &Run,
    message: &mut Message,
    task_id: i64,
    status: &str,
    result: Option<&Value>,
    error: Option<&str>,
) -> Option<&'static str> {
    let (run_status, message_status) = match status.to_ascii_uppercase().as_str() {
        "COMPLETED" => ("succeeded", "completed"),
        "FAILED" => ("failed", "failed"),
        "CANCELLED" => ("cancelled", "cancelled"),
        _ => return None,
    };
    let current = run.status.as_deref().unwrap_or("");
    if current == run_status && message.status == message_status {
        return None;
    }
    if TERMINAL.contains(&current) && current != run_status {
        return None;
    }
    let content = final_text(result);
    let content = match status.to_ascii_uppercase().as_str() {
        "FAILED" => error
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .or(content)
            .or_else(|| Some("AI 托管任务执行失败。".into())),
        "CANCELLED" => content.or_else(|| {
            Some(if message.content.is_empty() {
                "AI 托管任务已取消。".into()
            } else {
                message.content.clone()
            })
        }),
        _ => content.or_else(|| {
            message
                .content
                .is_empty()
                .then(|| "AI 托管任务已完成。".into())
        }),
    };
    if let Some(content) = content.filter(|v| !v.is_empty()) {
        message.content = content;
    }
    message.status = message_status.into();
    message.message_type = "text".into();
    let mut metadata = message.metadata.0.as_object().cloned().unwrap_or_default();
    metadata.insert("automation_run_id".into(), json!(run.id));
    metadata.insert("backend_task_id".into(), json!(task_id));
    metadata.insert("run_id".into(), json!(run.id));
    metadata.insert("run_status".into(), json!(message_status));
    if let Some(error) = error.filter(|v| !v.is_empty()) {
        metadata.insert("error".into(), json!(error));
    } else {
        metadata.remove("error");
    }
    message.metadata = Json(Value::Object(metadata));
    Some(run_status)
}

/// Both callback completion and worker dispatch failures enter this transaction.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn complete<M: Mysql, R: Redis>(
    mysql: &M,
    redis: &R,
    tables: crate::task_store::TableTemplates,
    task_id: i64,
    owner_id: i64,
    status: &str,
    failure: Option<&str>,
) -> Result<bool> {
    let routed = mysql.route(crate::task_routing::ByTaskId(task_id as u64));
    let task: Option<MysqlRow> = routed
        .fetch_optional(task_by_id_statement(tables.tasks), (task_id,))
        .await?;
    let Some(task) = task else {
        return Ok(false);
    };
    if !task_owned_by(task_column::<i64>(&task, "user_id")?, owner_id) {
        return Ok(false);
    }
    let task_json: Json<Value> = task_column(&task, "json")?;
    let Some(labels) = Labels::parse(&task_json.0) else {
        return Ok(false);
    };
    let subtask: Option<Subtask> = routed.fetch_optional(
        format!("SELECT result, error_message FROM {} WHERE id=? AND task_id=? AND user_id=? AND role='ASSISTANT'", tables.subtasks),
        (labels.subtask_id, task_id, owner_id),
    ).await?;
    let result = subtask
        .as_ref()
        .and_then(|subtask| subtask.result.as_ref())
        .map(|result| &result.0);
    let error = failure.or_else(|| {
        subtask
            .as_ref()
            .and_then(|subtask| subtask.error_message.as_deref())
    });
    let message = mysql.with_transaction(async |transaction| {
        let run: Option<Run> = transaction.fetch_optional(
            "SELECT id, cloud_project_id, created_by_user_id, backend_task_id, status FROM loop_items WHERE id=? AND resource_type='automation_run' FOR UPDATE",
            (labels.run_id.as_str(),),
        ).await?;
        let message: Option<Message> = transaction.fetch_optional(
            "SELECT * FROM project_chat_messages WHERE message_id=? FOR UPDATE", (labels.message_id.as_str(),),
        ).await?;
        let (Some(run), Some(mut message)) = (run, message) else { return Ok(None) };
        if !labels.matches(&run, &message, task_id, owner_id) { return Ok(None) }
        let Some(run_status) = apply_terminal(&run, &mut message, task_id, status, result, error) else { return Ok(None) };
        let now = Utc::now().naive_utc();
        transaction.execute(
            "UPDATE project_chat_messages SET content=?, status=?, message_type='text', metadata=?, updated_at=? WHERE id=?",
            (message.content.as_str(), message.status.as_str(), Json(message.metadata.0.clone()), now, message.id),
        ).await?;
        transaction.execute(
            "UPDATE loop_items SET status=?, backend_task_id=?, completed_at=?, description=CASE WHEN ?='failed' THEN ? ELSE description END, version=version+1, updated_at=? WHERE id=? AND resource_type='automation_run'",
            (run_status, task_id, now, run_status, message.content.as_str(), now, run.id.as_str()),
        ).await?;
        message.updated_at = now;
        Ok(Some(message))
    }).await?;
    if let Some(message) = message {
        if let Err(error) = publish(redis, &message).await {
            tracing::error!(message_id=%message.message_id, %error, "project activity notification failed after commit");
        }
        return Ok(true);
    }
    Ok(false)
}

pub(crate) async fn started<M: Mysql, R: Redis>(
    mysql: &M,
    redis: &R,
    tables: crate::task_store::TableTemplates,
    task_id: i64,
    owner_id: i64,
) -> Result<bool> {
    let routed = mysql.route(crate::task_routing::ByTaskId(task_id as u64));
    let task: Option<MysqlRow> = routed
        .fetch_optional(task_by_id_statement(tables.tasks), (task_id,))
        .await?;
    let Some(task) = task else {
        return Ok(false);
    };
    if !task_owned_by(task_column::<i64>(&task, "user_id")?, owner_id) {
        return Ok(false);
    }
    let task_json: Json<Value> = task_column(&task, "json")?;
    let Some(labels) = Labels::parse(&task_json.0) else {
        return Ok(false);
    };
    let message=mysql.with_transaction(async |tx| {
        let run:Option<Run>=tx.fetch_optional("SELECT id,cloud_project_id,created_by_user_id,backend_task_id,status FROM loop_items WHERE id=? AND resource_type='automation_run' FOR UPDATE",(labels.run_id.as_str(),)).await?;
        let message:Option<Message>=tx.fetch_optional("SELECT * FROM project_chat_messages WHERE message_id=? FOR UPDATE",(labels.message_id.as_str(),)).await?;
        let (Some(run),Some(mut message))=(run,message) else{return Ok(None)};
        if !labels.matches(&run,&message,task_id,owner_id) || run.status.as_deref().is_some_and(|status|TERMINAL.contains(&status)) || matches!(message.status.as_str(),"completed"|"failed"|"cancelled") {return Ok(None)}
        let mut metadata=message.metadata.0.as_object().cloned().unwrap_or_default();
        metadata.insert("backend_task_id".into(),json!(task_id));metadata.insert("run_status".into(),json!("running"));
        message.status="streaming".into();message.metadata=Json(Value::Object(metadata));message.updated_at=Utc::now().naive_utc();
        tx.execute("UPDATE loop_items SET status='running',backend_task_id=?,version=version+1,updated_at=? WHERE id=?",(task_id,message.updated_at,run.id.as_str())).await?;
        tx.execute("UPDATE project_chat_messages SET status='streaming',metadata=?,updated_at=? WHERE id=?",(Json(message.metadata.0.clone()),message.updated_at,message.id)).await?;
        Ok(Some(message))
    }).await?;
    if let Some(message) = message {
        if let Err(error) = publish(redis, &message).await {
            tracing::error!(%error,"project activity start notification failed after commit");
        }
        Ok(true)
    } else {
        Ok(false)
    }
}

pub(crate) async fn dispatch_failed<M: Mysql, R: Redis>(
    mysql: &M,
    redis: &R,
    run_id: &str,
    error: &str,
) -> Result<()> {
    let changed=mysql.with_transaction(async |tx| {
        let Some(run)=super::store::locked(tx,"automation_run",run_id).await? else{return Ok(None)};
        if TERMINAL.contains(&run.status.as_str()){return Ok(None)}
        let message_id=run.metadata.0["activity_message_id"].as_str().unwrap_or("");
        let message:Option<Message>=if message_id.is_empty(){None}else{tx.fetch_optional("SELECT * FROM project_chat_messages WHERE message_id=? FOR UPDATE",(message_id,)).await?};
        let mut message=message;
        if let Some(message)=message.as_mut(){
            message.status="failed".into();message.message_type="text".into();message.content=if error.is_empty(){"AI 托管任务派发失败。".into()}else{error.into()};message.updated_at=Utc::now().naive_utc();
            let mut metadata=message.metadata.0.as_object().cloned().unwrap_or_default();metadata.insert("run_status".into(),json!("failed"));metadata.insert("error".into(),json!(message.content));message.metadata=Json(Value::Object(metadata));
            tx.execute("UPDATE project_chat_messages SET status='failed',message_type='text',content=?,metadata=?,updated_at=? WHERE id=?",(message.content.as_str(),Json(message.metadata.0.clone()),message.updated_at,message.id)).await?;
        }
        tx.execute("UPDATE loop_items SET status='failed',description=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=?",(error.chars().take(2000).collect::<String>(),run_id)).await?;
        Ok(message)
    }).await?;
    if let Some(message) = changed
        && let Err(error) = publish(redis, &message).await
    {
        tracing::error!(%error,"project failed activity push failed after commit");
    }
    Ok(())
}

pub(crate) async fn publish<R: Redis>(redis: &R, message: &Message) -> Result<()> {
    let room = if message.task_id.is_empty() {
        format!("wework-project-chat:project:{}", message.project_id)
    } else {
        format!(
            "wework-project-chat:task:{}:{}",
            message.project_id, message.task_id
        )
    };
    let data = serde_json::to_string(&json!([message.view()]))?;
    let payload = emit_message(
        "wework:project_chat:message:created",
        &data,
        "/wework-runtime",
        &room,
    );
    redis.publish(SOCKETIO_CHANNEL, payload).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_read_is_the_full_get_by_id_projection_without_kind_or_owner() {
        // `task_store.get_by_id(db, task_id=...)` with no owner:
        // `db.query(TaskResource).filter(TaskResource.id == task_id).first()`.
        let sql = task_by_id_statement("tasks_0711");
        assert!(
            sql.starts_with("SELECT tasks_0711.id AS tasks_0711_id, "),
            "{sql}"
        );
        assert!(
            sql.contains(
                "tasks_0711.client_origin AS tasks_0711_client_origin, \
                 tasks_0711.is_group_chat AS tasks_0711_is_group_chat \nFROM tasks_0711"
            ),
            "{sql}"
        );
        assert!(sql.ends_with("WHERE tasks_0711.id = ? \n LIMIT 1"), "{sql}");
        // No kind predicate and no SQL-side owner filter (the projection still
        // lists both columns).
        assert!(
            !sql.contains("kind =") && !sql.contains("kind='Task'"),
            "{sql}"
        );
        assert!(!sql.contains("user_id = ?"), "{sql}");
    }

    #[test]
    fn the_owner_check_rejects_a_non_owner_row() {
        assert!(task_owned_by(7, 7));
        assert!(!task_owned_by(8, 7));
    }

    fn activity() -> (Run, Message) {
        let now = Utc::now().naive_utc();
        (
            Run {
                id: "run-1".into(),
                cloud_project_id: Some("project-1".into()),
                created_by_user_id: Some(7),
                backend_task_id: Some(10),
                status: Some("running".into()),
            },
            Message {
                id: 1,
                message_id: "message-1".into(),
                client_message_id: String::new(),
                project_id: "project-1".into(),
                task_id: "issue-1".into(),
                sender_type: "agent".into(),
                sender_id: "team:8".into(),
                sender_name: "Agent".into(),
                message_type: "run".into(),
                content: String::new(),
                metadata: Json(
                    json!({"automation_run_id":"run-1", "backend_task_id":10, "error":"old"}),
                ),
                trigger_message_id: String::new(),
                reply_to_message_id: String::new(),
                thread_root_message_id: String::new(),
                agent_id: String::new(),
                runtime_device_id: String::new(),
                runtime_task_id: String::new(),
                status: "streaming".into(),
                created_at: now,
                updated_at: now,
            },
        )
    }

    #[test]
    fn completion_updates_the_existing_comment_and_clears_old_error() {
        let (mut run, mut message) = activity();
        let result = json!({"value":"Finished the issue"});
        assert_eq!(
            apply_terminal(&run, &mut message, 10, "COMPLETED", Some(&result), None),
            Some("succeeded")
        );
        assert_eq!(message.content, "Finished the issue");
        assert_eq!(message.status, "completed");
        assert_eq!(message.metadata.0["run_status"], "completed");
        assert!(message.metadata.0.get("error").is_none());
        run.status = Some("succeeded".into());
        assert!(apply_terminal(&run, &mut message, 10, "COMPLETED", Some(&result), None).is_none());
        assert!(
            apply_terminal(&run, &mut message, 10, "FAILED", None, Some("late failure")).is_none()
        );
        assert_eq!(message.content, "Finished the issue");
    }

    #[test]
    fn failure_prefers_error_and_cancellation_preserves_existing_comment() {
        let (run, mut message) = activity();
        assert_eq!(
            apply_terminal(
                &run,
                &mut message,
                10,
                "FAILED",
                None,
                Some("Dispatch failed")
            ),
            Some("failed")
        );
        assert_eq!(message.content, "Dispatch failed");
        let (run, mut message) = activity();
        message.content = "Last assistant output".into();
        assert_eq!(
            apply_terminal(&run, &mut message, 10, "CANCELLED", None, None),
            Some("cancelled")
        );
        assert_eq!(message.content, "Last assistant output");
    }

    #[test]
    fn labels_reject_foreign_owner_project_task_and_execution() {
        let labels = Labels::parse(&json!({"metadata":{"labels":{"source":"project_automation", "projectAutomationSubtaskId":"11", "projectAutomationRunId":"run-1", "projectChatMessageId":"message-1", "weworkSpaceProjectId":"project-1", "weworkSpaceTaskId":"issue-1"}}})).unwrap();
        let (run, mut message) = activity();
        assert!(labels.matches(&run, &message, 10, 7));
        assert!(!labels.matches(&run, &message, 10, 8));
        assert!(!labels.matches(&run, &message, 99, 7));
        message.project_id = "foreign-project".into();
        assert!(!labels.matches(&run, &message, 10, 7));
    }
}
