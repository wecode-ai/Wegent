//! Execution outcomes and their existing run/activity projections commit together.

use anyhow::Result;
use brz_mysql::{FromMysqlRow, Json, MysqlResult, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    super::project::{
        completion::{self, Message},
        notifications::{self, Pending},
        store::{self, LIVE, Node},
    },
    model::{COLUMNS, Execution, terminal},
};
use crate::AppState;

#[derive(FromMysqlRow)]
struct Run {
    metadata: Json<Value>,
}

#[derive(Default)]
pub(super) struct Effects {
    pub messages: Vec<Message>,
    pub notices: Vec<Pending>,
}
impl From<Vec<Message>> for Effects {
    fn from(messages: Vec<Message>) -> Self {
        Self {
            messages,
            notices: Vec::new(),
        }
    }
}

pub(super) async fn linked(
    tx: &mut impl MysqlTransaction,
    row: &Execution,
) -> MysqlResult<Option<Message>> {
    let context = row.context();
    if let Some(trigger) = context["comment_trigger_message_id"]
        .as_str()
        .filter(|value| !value.is_empty())
    {
        return tx.fetch_optional(format!("SELECT * FROM project_chat_messages WHERE project_id=? AND task_id=? AND trigger_message_id=? AND sender_type='agent' AND {LIVE} LIMIT 1"), (row.cloud_project_id.as_str(),row.loop_item_id.as_str(),trigger)).await;
    }
    if !row.automation_run_id.is_empty() {
        let run: Option<Run> = tx
            .fetch_optional(
                "SELECT metadata FROM loop_items WHERE id=? AND resource_type='automation_run'",
                (row.automation_run_id.as_str(),),
            )
            .await?;
        if let Some(id) = run
            .as_ref()
            .and_then(|run| run.metadata.0["activity_message_id"].as_str())
            .filter(|value| !value.is_empty())
        {
            let activity:Option<Message>=tx.fetch_optional(format!("SELECT * FROM project_chat_messages WHERE message_id=? AND project_id=? AND {LIVE} LIMIT 1"),(id,row.cloud_project_id.as_str())).await?;
            if activity
                .as_ref()
                .is_some_and(|message| message.metadata.0["execution_id"].as_i64() == Some(row.id))
            {
                return Ok(activity);
            }
        }
    }
    if !row.runtime_device_id.is_empty() && !row.runtime_task_id.is_empty() {
        let messages:Vec<Message>=tx.fetch_all(format!("SELECT * FROM project_chat_messages WHERE runtime_device_id=? AND runtime_task_id=? AND sender_type='agent' AND {LIVE} ORDER BY id DESC"),(row.runtime_device_id.as_str(),row.conversation_id())).await?;
        if let Some(message) = messages
            .into_iter()
            .find(|message| message.metadata.0["kind"] != "task_ai_subagent")
        {
            return Ok(Some(message));
        }
    }
    let managed: Option<Message> = tx.fetch_optional(
        format!("SELECT * FROM project_chat_messages WHERE message_id=? AND project_id=? AND task_id=? AND {LIVE}"),
        (format!("managed-execution-{}", row.id), row.cloud_project_id.as_str(), row.loop_item_id.as_str()),
    ).await?;
    if managed.is_some() {
        return Ok(managed);
    }
    let messages:Vec<Message>=tx.fetch_all(format!("SELECT * FROM project_chat_messages WHERE project_id=? AND task_id=? AND {LIVE} ORDER BY id DESC LIMIT 20"),(row.cloud_project_id.as_str(),row.loop_item_id.as_str())).await?;
    Ok(messages
        .into_iter()
        .find(|message| message.metadata.0["execution_id"].as_i64() == Some(row.id)))
}

/// Ordinary assignments do not have a comment or automation activity to reuse.
/// The caller holds the execution lock and commits this node with its Task binding.
pub(super) async fn ensure_managed_activity(
    tx: &mut impl MysqlTransaction,
    row: &Execution,
) -> MysqlResult<Message> {
    if let Some(message) = linked(tx, row).await? {
        return Ok(message);
    }
    use crate::socketio::project_chat_messages::{InsertMessage, insert_message_on};
    let message_id = format!("managed-execution-{}", row.id);
    let agent: Option<(String,)> = tx.fetch_optional("SELECT title FROM loop_items WHERE id=? AND cloud_project_id=? AND resource_type='chat_agent'",(row.agent_id.as_str(),row.cloud_project_id.as_str())).await?;
    let context = row.context();
    let trigger = context["comment_trigger_message_id"]
        .as_str()
        .unwrap_or_default();
    let id = insert_message_on(tx, &InsertMessage {
        message_id: &message_id,
        client_message_id: &message_id,
        project_id: &row.cloud_project_id,
        task_id: &row.loop_item_id,
        sender_type: "agent",
        sender_id: &row.agent_id,
        sender_name: agent.as_ref().map(|(title,)| title.as_str()).unwrap_or_default(),
        message_type: "agent_status",
        content: "",
        metadata: json!({"execution_id": row.id, "executor_type": "project_robot", "run_status": "running", "run_id": notifications::uuid()}),
        trigger_message_id: trigger,
        reply_to_message_id: trigger,
        thread_root_message_id: trigger,
        agent_id: &row.agent_id,
        runtime_device_id: "",
        runtime_task_id: "",
        runtime_activity_key: "",
        status: "streaming",
    }).await?;
    tx.fetch_one("SELECT * FROM project_chat_messages WHERE id=?", (id,))
        .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn terminal_on(
    tx: &mut impl MysqlTransaction,
    app: &AppState,
    row: &Execution,
    status: &str,
    detail: &str,
    note: &str,
    at: NaiveDateTime,
    notify: bool,
) -> MysqlResult<Effects> {
    if row.context()["dispatch_role"] == "member" {
        tx.execute("UPDATE loop_item_executions SET execution_payload=JSON_SET(execution_payload,'$.assignment_result',?), error_message=IF(?='failed',?,error_message) WHERE id=?", (detail, status, detail, row.id)).await?;
    }
    let mut output = Vec::new();
    if let Some(mut message) = linked(tx, row).await? {
        super::activity::finish(tx, &mut message, status, detail).await?;
        save_message(tx, &message).await?;
        let children:Vec<Message>=tx.fetch_all(format!("SELECT * FROM project_chat_messages WHERE project_id=? AND task_id=? AND trigger_message_id=? AND sender_type='agent' AND {LIVE} ORDER BY id"),(message.project_id.as_str(),message.task_id.as_str(),message.message_id.as_str())).await?;
        output.push(message);
        for mut child in children {
            if child.metadata.0["kind"] != "task_ai_subagent"
                || terminal(&child.status)
                || child.status == "canceled"
            {
                continue;
            }
            child.status = status.to_owned();
            child.message_type = "text".to_owned();
            child.updated_at = crate::socketio::project_chat_messages::database_timestamp(at);
            child.metadata.0["run_status"] = json!(status);
            child.metadata.0["subagent_status"] = json!(status);
            save_message(tx, &child).await?;
            output.push(child);
        }
    }
    if !row.automation_run_id.is_empty() {
        let run_status = match status {
            "completed" => "succeeded",
            "failed" => "failed",
            _ => "cancelled",
        };
        let description = if status == "failed" { detail } else { note };
        let description = if description.trim().is_empty() {
            format!("Run {run_status}.")
        } else {
            description.trim().chars().take(2000).collect()
        };
        tx.execute("UPDATE loop_items SET status=?,description=?,completed_at=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND resource_type='automation_run' AND (status<>? OR description<>? OR NOT(completed_at<=>?))",(run_status,description.as_str(),at,row.automation_run_id.as_str(),run_status,description.as_str(),at)).await?;
    }
    let mut effects = Effects::from(output);
    if notify && let Some(notice) = notify_on(tx, app, row, status, detail).await? {
        effects.notices.push(notice);
    }
    Ok(effects)
}

pub(super) async fn save_message(
    tx: &mut impl MysqlTransaction,
    message: &Message,
) -> MysqlResult<()> {
    tx.execute("UPDATE project_chat_messages SET content=?,status=?,message_type=?,metadata=?,updated_at=? WHERE id=?",(message.content.as_str(),message.status.as_str(),message.message_type.as_str(),Json(&message.metadata.0),message.updated_at,message.id)).await?;
    Ok(())
}

pub(super) async fn requeued_on(
    tx: &mut impl MysqlTransaction,
    row: &Execution,
) -> MysqlResult<Vec<Message>> {
    let mut output = Vec::new();
    if let Some(mut message) = linked(tx, row).await? {
        if !message.metadata.0.is_object() {
            message.metadata.0 = json!({});
        }
        message.metadata.0["run_status"] = json!("queued");
        message.status = "pending".to_owned();
        message.runtime_device_id.clear();
        message.runtime_task_id.clear();
        message.updated_at =
            crate::socketio::project_chat_messages::database_timestamp(Utc::now().naive_utc());
        let key = message_key(&message.message_id, false);
        tx.execute("UPDATE project_chat_messages SET metadata=?,status='pending',runtime_device_id='',runtime_task_id='',runtime_activity_key=?,updated_at=? WHERE id=?",(Json(&message.metadata.0),key,message.updated_at,message.id)).await?;
        output.push(message);
    }
    if !row.runtime_device_id.is_empty() && !row.runtime_task_id.is_empty() {
        let messages:Vec<Message>=tx.fetch_all(format!("SELECT * FROM project_chat_messages WHERE runtime_device_id=? AND runtime_task_id=? AND sender_type='agent' AND status='streaming' AND {LIVE}"),(row.runtime_device_id.as_str(),row.conversation_id())).await?;
        for message in messages {
            if output.iter().any(|linked| linked.id == message.id)
                || !message.content.trim().is_empty()
            {
                continue;
            }
            tx.execute("UPDATE project_chat_messages SET deleted_at=UTC_TIMESTAMP(6),runtime_activity_key=? WHERE id=?",(message_key(&message.message_id,true),message.id)).await?;
        }
    }
    if !row.automation_run_id.is_empty() {
        tx.execute("UPDATE loop_items SET status='queued',version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND resource_type='automation_run' AND status NOT IN ('succeeded','failed','cancelled')",(row.automation_run_id.as_str(),)).await?;
    }
    Ok(output)
}

fn message_key(id: &str, deleted: bool) -> String {
    let namespace = if deleted { "deleted" } else { "message" };
    Sha256::digest(format!("{namespace}\0{id}").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) async fn publish(state: &AppState, effects: Effects) -> Result<()> {
    for message in effects.messages {
        match state.redis.as_ref() {
            Some(redis) => {
                if completion::publish(redis, &message).await.is_err() {
                    tracing::warn!(message_id=%message.message_id,"Committed Robot activity push failed");
                }
            }
            None => {
                tracing::warn!(message_id=%message.message_id,"Committed Robot activity has no Redis transport")
            }
        }
    }
    for notice in effects.notices {
        notifications::deliver(state, notice).await;
    }
    Ok(())
}

pub(super) async fn notify_on(
    tx: &mut impl MysqlTransaction,
    app: &AppState,
    row: &Execution,
    status: &str,
    detail: &str,
) -> MysqlResult<Option<Pending>> {
    let project: Option<Node> = tx
        .fetch_optional(
            format!(
                "SELECT {} FROM loop_items WHERE id=? AND resource_type='project'",
                store::COLUMNS
            ),
            (row.cloud_project_id.as_str(),),
        )
        .await?;
    let issue: Option<Node> = tx
        .fetch_optional(
            format!(
                "SELECT {} FROM loop_items WHERE id=? AND resource_type='task'",
                store::COLUMNS
            ),
            (row.loop_item_id.as_str(),),
        )
        .await?;
    let (Some(project), Some(issue)) = (project, issue) else {
        return Ok(None);
    };
    tx.execute("SAVEPOINT robot_lifecycle_notification", ())
        .await?;
    let result = notifications::execution_on(
        tx,
        &app.mysql,
        &project,
        &issue,
        row.id,
        row.executor_owner_user_id,
        status,
        detail,
    )
    .await;
    let notice = match result {
        Ok(notice) => notice,
        Err(_) => {
            tx.execute("ROLLBACK TO SAVEPOINT robot_lifecycle_notification", ())
                .await?;
            tracing::warn!(
                execution_id = row.id,
                "Robot lifecycle notification failed; execution transition retained"
            );
            None
        }
    };
    tx.execute("RELEASE SAVEPOINT robot_lifecycle_notification", ())
        .await?;
    Ok(notice)
}

pub(super) async fn repair_terminal(state: &AppState) -> Result<usize> {
    let rows:Vec<Execution>=state.mysql.fetch_all(format!("SELECT {COLUMNS} FROM loop_item_executions e WHERE e.status IN ('completed','failed','cancelled') AND e.automation_run_id<>'' AND e.id=(SELECT MAX(newest.id) FROM loop_item_executions newest WHERE newest.automation_run_id=e.automation_run_id) AND EXISTS (SELECT 1 FROM loop_items r WHERE r.id=e.automation_run_id AND r.resource_type='automation_run' AND r.status NOT IN ('succeeded','failed','cancelled','skipped')) LIMIT 100"),()).await?;
    let mut repaired = 0;
    for row in rows {
        let messages = state
            .mysql
            .with_transaction(async |tx| {
                let current: Option<Execution> = tx
                    .fetch_optional(
                        format!("SELECT {COLUMNS} FROM loop_item_executions WHERE id=? FOR UPDATE"),
                        (row.id,),
                    )
                    .await?;
                let Some(current) = current.filter(|row| row.terminal()) else {
                    return Ok(Effects::default());
                };
                let at = current
                    .completed_at
                    .filter(|value| *value > chrono::DateTime::UNIX_EPOCH.naive_utc())
                    .unwrap_or_else(|| Utc::now().naive_utc());
                let detail = if current.status == "failed" {
                    if current.error_message.is_empty() {
                        "Automation execution failed"
                    } else {
                        current.error_message.as_str()
                    }
                } else {
                    current.execution_note.as_str()
                };
                terminal_on(
                    tx,
                    state,
                    &current,
                    &current.status,
                    detail,
                    &current.execution_note,
                    at,
                    false,
                )
                .await
            })
            .await?;
        publish(state, messages).await?;
        repaired += 1;
    }
    Ok(repaired)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub(crate) async fn verify_managed_activity(
        mysql: &brz_mysql::MysqlService,
    ) -> anyhow::Result<()> {
        let mut row = Execution {
            id: 9901,
            loop_item_id: "managed-activity-issue".into(),
            cloud_project_id: "project-1".into(),
            executor_owner_user_id: 7,
            assigner_user_id: 7,
            agent_id: "managed-activity-agent".into(),
            team_id: 74,
            automation_run_id: String::new(),
            execution_environment: "wegent".into(),
            execution_device_id: String::new(),
            runtime_device_id: String::new(),
            runtime_task_id: String::new(),
            status: "queued".into(),
            approval_status: String::new(),
            execution_payload: "{}".into(),
            error_message: String::new(),
            execution_note: String::new(),
            version: 1,
            observed_state: None,
            start_requested_at: None,
            completed_at: None,
        };
        let message = mysql
            .with_transaction(async |tx| {
                let first = ensure_managed_activity(tx, &row).await?;
                let repeated = ensure_managed_activity(tx, &row).await?;
                assert_eq!(first.message_id, repeated.message_id);
                assert_eq!(first.metadata.0["execution_id"], 9901);
                assert_eq!(first.agent_id, row.agent_id);
                assert_eq!(first.message_type, "agent_status");
                assert_eq!(first.status, "streaming");
                for index in 0..21 {
                    tx.execute(
                        "INSERT INTO project_chat_messages(message_id,project_id,task_id,content,metadata,status) VALUES(?,?,?,'',JSON_OBJECT(),'sent')",
                        (format!("managed-later-{index}"),row.cloud_project_id.as_str(),row.loop_item_id.as_str()),
                    ).await?;
                }
                assert_eq!(
                    linked(tx, &row).await?.unwrap().message_id,
                    first.message_id,
                    "Terminal projection must find activities outside the recent-message window"
                );
                Ok(first)
            })
            .await?;
        row.execution_payload =
            json!({"origin_context":{"comment_trigger_message_id":"managed-followup"}}).to_string();
        mysql
            .execute(
                "UPDATE project_chat_messages SET trigger_message_id='managed-followup' WHERE id=?",
                (message.id,),
            )
            .await?;
        row.id = 9902;
        let continuation = mysql
            .with_transaction(async |tx| ensure_managed_activity(tx, &row).await)
            .await?;
        assert_eq!(
            continuation.message_id, message.message_id,
            "An existing reply must not acquire a second activity node"
        );
        Ok(())
    }
}
