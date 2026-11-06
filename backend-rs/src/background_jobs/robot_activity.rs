//! Project-chat terminal state preserves newer runs and existing Issue content.

use brz_mysql::{Json, MysqlResult, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};
use serde_json::{Value, json};

use super::super::project::{
    completion::Message,
    issues, notifications,
    store::{self, LIVE, Node, iso},
};

pub(super) async fn finish(
    tx: &mut impl MysqlTransaction,
    message: &mut Message,
    status: &str,
    detail: &str,
) -> MysqlResult<()> {
    let now = Utc::now().naive_utc();
    if (status == "completed" || message.content.is_empty()) && !detail.is_empty() {
        message.content = detail.to_owned();
    }
    message.status = status.to_owned();
    if status != "failed" {
        message.message_type = "text".to_owned();
    }
    if !message.metadata.0.is_object() {
        message.metadata.0 = json!({});
    }
    if message.metadata.0["run_id"]
        .as_str()
        .is_none_or(|value| value.is_empty())
    {
        message.metadata.0["run_id"] = json!(notifications::uuid());
    }
    message.metadata.0["run_status"] = json!(status);
    message.metadata.0["activity_at"] = json!(now.and_utc().to_rfc3339());
    message.updated_at = now;
    if message.task_id.is_empty() {
        return Ok(());
    }
    let task:Option<Node>=tx.fetch_optional(format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='task' AND {LIVE} FOR UPDATE",store::COLUMNS),(message.task_id.as_str(),)).await?;
    let Some(task) = task else {
        return Ok(());
    };
    let mut metadata = task.meta();
    let applied = project_ai_state(&mut metadata, message, status, detail, now);
    issues::update_change_request_source(
        &mut metadata,
        &format!("activity:{}", message.message_id),
        &message.content,
    );
    let review = can_review(&task, &metadata, message);
    if review {
        let project: Option<Node> = tx
            .fetch_optional(
                format!(
                    "SELECT {} FROM loop_items WHERE id=? AND resource_type='project'",
                    store::COLUMNS
                ),
                (task.cloud_project_id.as_str(),),
            )
            .await?;
        let mut history = metadata["status_history"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let from = project.as_ref().map_or_else(
            || task.status.clone(),
            |project| issues::status_name(project, &task.status),
        );
        let to = project.as_ref().map_or("in_review".to_owned(), |project| {
            issues::status_name(project, "in_review")
        });
        history.push(json!({"from_status":task.status,"to_status":"in_review","from_name":from,"to_name":to,"trigger":"ai_completed","by_user_id":null,"at":iso(now)}));
        metadata["status_history"] = json!(history);
    }
    if applied || review || metadata != task.metadata.0 {
        tx.execute("UPDATE loop_items SET metadata=?,status=?,completed_at=CASE WHEN ? THEN '1970-01-01 00:00:01' ELSE completed_at END,sort_order=CASE WHEN ? THEN 0 ELSE sort_order END,version=version+?,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND resource_type='task'",(Json(metadata),if review{"in_review"}else{task.status.as_str()},review,review,i64::from(applied)+i64::from(review),task.id.as_str())).await?;
    }
    Ok(())
}

fn project_ai_state(
    metadata: &mut Value,
    message: &Message,
    status: &str,
    error: &str,
    at: NaiveDateTime,
) -> bool {
    if message.metadata.0["conversation_only"] == true {
        return false;
    }
    let previous = metadata["ai_state"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    let run = message.metadata.0["run_id"].as_str().unwrap_or("");
    let old_run = previous.get("run_id").and_then(Value::as_str).unwrap_or("");
    let old_status = previous.get("status").and_then(Value::as_str).unwrap_or("");
    if !old_run.is_empty() && old_run != run && !terminal(old_status) {
        return false;
    }
    let mut next = previous.clone();
    for (key, value) in [
        ("run_id", json!(run)),
        ("status", json!(status)),
        ("agent_id", json!(message.agent_id)),
        ("agent_name", json!(message.sender_name)),
        ("trigger_message_id", optional(&message.trigger_message_id)),
        ("project_chat_message_id", json!(message.message_id)),
        ("runtime_device_id", optional(&message.runtime_device_id)),
        ("runtime_task_id", optional(&message.runtime_task_id)),
        ("updated_at", json!(iso(at))),
        (
            "auto_retry",
            json!(message.metadata.0["auto_retry"] == true),
        ),
        ("completed_at", json!(iso(at))),
        ("heartbeat_at", Value::Null),
        ("lease_expires_at", Value::Null),
    ] {
        next.insert(key.into(), value);
    }
    if status != "completed" && !error.is_empty() {
        next.insert("last_error".into(), json!(error));
    }
    if status == "failed" && message.metadata.0["auto_retry"] == true {
        let count = previous
            .get("auto_retry_count")
            .and_then(super::super::project::authority::integer)
            .unwrap_or(0);
        next.insert("auto_retry_count".into(), json!(count + 1));
    }
    if old_status != status {
        let revision = metadata["content_revision"]
            .as_i64()
            .filter(|value| *value >= 1)
            .unwrap_or(1);
        metadata["content_revision"] = json!(revision + 1);
        if !metadata["read_revisions"].is_object() {
            metadata["read_revisions"] = json!({});
        }
    }
    metadata["ai_state"] = json!(next);
    metadata["execution_state"] = json!(status);
    metadata["execution_updated_at"] = json!(iso(at));
    true
}

fn can_review(task: &Node, metadata: &Value, message: &Message) -> bool {
    if matches!(task.status.as_str(), "completed" | "in_review")
        || message.agent_id.is_empty()
        || task.assignee_agent_id != message.agent_id
    {
        return false;
    }
    if matches!(
        message.metadata.0["dispatch_role"].as_str(),
        Some("manager" | "member")
    ) {
        return false;
    }
    let current = &metadata["ai_state"];
    if current["project_chat_message_id"]
        .as_str()
        .is_some_and(|id| !id.is_empty() && id != message.message_id)
        && !terminal(current["status"].as_str().unwrap_or(""))
    {
        return false;
    }
    metadata["external_index"] != true
        && metadata["external_shadow"] != true
        && metadata["dispatch_child"] != true
        && !metadata["workflow_plan"].is_object()
}

fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled" | "canceled")
}
fn optional(value: &str) -> Value {
    if value.is_empty() {
        Value::Null
    } else {
        json!(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message() -> Message {
        let at = Utc::now().naive_utc();
        Message {
            id: 1,
            message_id: "old-message".into(),
            client_message_id: String::new(),
            project_id: "2".into(),
            task_id: "P-1".into(),
            sender_type: "agent".into(),
            sender_id: "a".into(),
            sender_name: "Agent".into(),
            message_type: "ai_activity".into(),
            content: "Partial output".into(),
            metadata: Json(json!({"run_id":"old","auto_retry":true})),
            trigger_message_id: String::new(),
            reply_to_message_id: String::new(),
            thread_root_message_id: String::new(),
            agent_id: "a".into(),
            runtime_device_id: "device".into(),
            runtime_task_id: "task".into(),
            status: "running".into(),
            created_at: at,
            updated_at: at,
        }
    }

    #[test]
    fn stale_terminal_does_not_replace_a_newer_live_issue_run() {
        let mut metadata = json!({"ai_state":{"run_id":"new","status":"running","project_chat_message_id":"new-message"},"content_revision":7});
        let original = metadata.clone();
        assert!(!project_ai_state(
            &mut metadata,
            &message(),
            "failed",
            "old failure",
            Utc::now().naive_utc()
        ));
        assert_eq!(metadata, original);
    }

    #[test]
    fn failure_retries_and_revision_keep_unrelated_issue_metadata() {
        let mut metadata = json!({"ai_state":{"run_id":"old","status":"running","auto_retry_count":2,"prompt":"Keep prompt"},"content_revision":7,"read_revisions":{"7":5},"custom":"kept"});
        assert!(project_ai_state(
            &mut metadata,
            &message(),
            "failed",
            "timeout",
            Utc::now().naive_utc()
        ));
        assert_eq!(metadata["ai_state"]["auto_retry_count"], 3);
        assert_eq!(metadata["ai_state"]["last_error"], "timeout");
        assert_eq!(metadata["ai_state"]["prompt"], "Keep prompt");
        assert_eq!(metadata["content_revision"], 8);
        assert_eq!(metadata["read_revisions"]["7"], 5);
        assert_eq!(metadata["custom"], "kept");
    }
}
