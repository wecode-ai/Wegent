//! Project-chat terminal state preserves newer runs and existing Issue content.

use crate::socketio::project_chat_messages::{database_timestamp, utc_timestamp};
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult, MysqlTransaction};
use chrono::{NaiveDateTime, Utc};
use serde_json::{Value, json};

use super::super::project::{
    assignments,
    completion::Message,
    issues, notifications,
    store::{self, LIVE, Node, iso},
};

#[derive(FromMysqlRow)]
struct ActivityOrder {
    id: i64,
}

pub(crate) async fn finish(
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
    message.updated_at = database_timestamp(now);
    if message.task_id.is_empty() {
        return Ok(());
    }
    let task:Option<Node>=tx.fetch_optional(format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='task' AND {LIVE} FOR UPDATE",store::COLUMNS),(message.task_id.as_str(),)).await?;
    let Some(task) = task else {
        return Ok(());
    };
    let mut metadata = task.meta();
    let previous_activity: Option<ActivityOrder> = if terminal(status)
        && metadata["ai_state"]["run_id"] != message.metadata.0["run_id"]
    {
        let id = metadata["ai_state"]["project_chat_message_id"]
            .as_str()
            .unwrap_or_default();
        tx.fetch_optional(
            "SELECT id FROM project_chat_messages WHERE message_id=? AND project_id=? AND task_id=?",
            (id, message.project_id.as_str(), message.task_id.as_str()),
        ).await?
    } else {
        None
    };
    let applied = project_ai_state(
        &mut metadata,
        message,
        status,
        detail,
        now,
        previous_activity.map(|row| row.id),
    );
    let auto_published =
        applied && apply_assistant_publication(&task, &mut metadata, message, status);
    issues::update_change_request_source(
        &mut metadata,
        &format!("activity:{}", message.message_id),
        &message.content,
    );
    let review = if applied && can_review(&task, &metadata, message) {
        append_review_history(tx, &task, &mut metadata, now).await?
    } else {
        false
    };
    let dispatch_review =
        dispatch_review_allowed(&task, &metadata, message, status, applied, auto_published)
            && append_review_history(tx, &task, &mut metadata, now).await?;
    if applied || review || dispatch_review || auto_published || metadata != task.metadata.0 {
        let candidate = assistant_transition(&task.status, review, dispatch_review, auto_published);
        let transition = if let Some(candidate) = candidate {
            let project: Option<Node> = tx
                .fetch_optional(
                    format!(
                        "SELECT {} FROM loop_items WHERE id=? AND resource_type='project'",
                        store::COLUMNS
                    ),
                    (task.cloud_project_id.as_str(),),
                )
                .await?;
            project
                .filter(|project| assignments::has_status(project, candidate))
                .map(|_| candidate)
        } else {
            None
        };
        let (next_status, reset_sort) = transition
            .map(|status| (status, true))
            .unwrap_or((task.status.as_str(), false));
        if transition == Some("completed") {
            metadata["completion_owner_user_id"] = metadata["assistant_owner_user_id"].clone();
            let mut history = metadata["status_history"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            history.push(json!({
                "from_status":task.status,"to_status":"completed","trigger":"assistant_publication",
                "completion_owner_user_id":metadata["assistant_owner_user_id"],"at":now.and_utc(),
            }));
            metadata["status_history"] = json!(history);
        }
        tx.execute(
            "UPDATE loop_items SET metadata=?,status=?,completed_at=CASE WHEN ? THEN '1970-01-01 00:00:01' WHEN ? THEN UTC_TIMESTAMP(6) ELSE completed_at END,sort_order=CASE WHEN ? THEN 0 ELSE sort_order END,version=version+?,updated_at=CURRENT_TIMESTAMP(6) WHERE id=? AND resource_type='task'",
            (
                Json(metadata),
                next_status,
                review || dispatch_review,
                transition == Some("completed"),
                reset_sort,
                i64::from(applied)
                    + i64::from(review)
                    + i64::from(dispatch_review)
                    + i64::from(auto_published),
                task.id.as_str(),
            ),
        )
        .await?;
    }
    Ok(())
}

fn assistant_transition(
    task_status: &str,
    review: bool,
    dispatch_review: bool,
    auto_published: bool,
) -> Option<&'static str> {
    if review || dispatch_review {
        Some("in_review")
    } else if auto_published && !matches!(task_status, "completed" | "in_review") {
        Some("completed")
    } else {
        None
    }
}

fn dispatch_review_allowed(
    task: &Node,
    metadata: &Value,
    message: &Message,
    status: &str,
    applied: bool,
    auto_published: bool,
) -> bool {
    applied
        && !auto_published
        && status == "completed"
        && metadata["assistant_dispatch_role"] == "member"
        && metadata["awaiting_public_summary"] == true
        && metadata["publish_policy"] == "summary_only"
        && !matches!(task.status.as_str(), "completed" | "in_review")
        && metadata["assistant_owner_user_id"].as_i64() == Some(task.assignee_user_id)
        && task.assignee_agent_id == message.agent_id
        && metadata["ai_state"]["project_chat_message_id"].as_str()
            == Some(message.message_id.as_str())
}

fn apply_assistant_publication(
    task: &Node,
    metadata: &mut Value,
    message: &mut Message,
    status: &str,
) -> bool {
    let policy = &metadata["assistant_autonomy_policy"];
    let authorized = status == "completed"
        && metadata["awaiting_public_summary"] == true
        && metadata["publish_policy"] == "summary_only"
        && metadata["risk_level"] == "low"
        && metadata["assistant_dispatch_role"] == "member"
        && metadata["assistant_owner_user_id"].as_i64() == Some(task.assignee_user_id)
        && task.assignee_agent_id == message.agent_id
        && task.cloud_project_id == message.project_id
        && !message.agent_id.is_empty()
        && !message.content.trim().is_empty()
        && policy["automatic"].as_bool() == Some(true)
        && policy["ask_before_act"].as_bool() == Some(false)
        && policy["risk_ceiling"] == "low";
    if !authorized {
        return false;
    }
    message.metadata.0["assistant_publication"] = json!({
        "verified":true,
        "published_by":"ai",
        "policy":"automatic_low_risk",
    });
    metadata["awaiting_public_summary"] = json!(false);
    metadata["assistant_publication_message_id"] = json!(message.message_id);
    true
}

pub(crate) async fn project_runtime_completion(
    mysql: &impl Mysql,
    message: &Message,
    allow_review: bool,
) -> MysqlResult<bool> {
    if message.task_id.is_empty() {
        return Ok(false);
    }
    mysql.with_transaction(async |tx| {
        let task: Option<Node> = tx.fetch_optional(
            format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='task' AND {LIVE} FOR UPDATE", store::COLUMNS),
            (message.task_id.as_str(),),
        ).await?;
        let Some(task) = task else {
            return Ok(false);
        };
        let mut metadata = task.meta();
        let superseded = metadata["ai_state"]["project_chat_message_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty() && id != message.message_id);
        if task.cloud_project_id != message.project_id {
            return Ok(false);
        }
        issues::update_change_request_source(
            &mut metadata,
            &format!("activity:{}", message.message_id),
            &message.content,
        );
        let review = allow_review && !superseded && can_review(&task, &metadata, message)
            && append_review_history(tx, &task, &mut metadata, utc_timestamp(message.updated_at)).await?;
        if !review {
            if metadata == task.metadata.0 {
                return Ok(false);
            }
            tx.execute(
                "UPDATE loop_items SET metadata=?, version=version+1, updated_at=CURRENT_TIMESTAMP(6) WHERE id=? AND resource_type='task'",
                (Json(metadata), task.id.as_str()),
            ).await?;
            return Ok(true);
        }
        if !metadata["ai_state"].is_object() {
            metadata["ai_state"] = json!({});
        }
        metadata["ai_state"]["project_chat_message_id"] = json!(message.message_id);
        let now = Utc::now().naive_utc();
        tx.execute(
            "UPDATE loop_items SET metadata=?, status='in_review', completed_at='1970-01-01 00:00:01', sort_order=0, version=version+1, updated_at=? WHERE id=? AND resource_type='task'",
            (Json(metadata), database_timestamp(now), task.id.as_str()),
        )
        .await?;
        Ok(true)
    }).await
}

async fn append_review_history(
    tx: &mut impl MysqlTransaction,
    task: &Node,
    metadata: &mut Value,
    now: NaiveDateTime,
) -> MysqlResult<bool> {
    let project: Option<Node> = tx
        .fetch_optional(
            format!(
                "SELECT {} FROM loop_items WHERE id=? AND resource_type='project'",
                store::COLUMNS
            ),
            (task.cloud_project_id.as_str(),),
        )
        .await?;
    let Some(project) = project.filter(|project| assignments::has_status(project, "in_review"))
    else {
        return Ok(false);
    };
    let mut history = metadata["status_history"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let from = issues::status_name(&project, &task.status);
    let to = issues::status_name(&project, "in_review");
    history.push(json!({"from_status":task.status,"to_status":"in_review","from_status_name":from,"to_status_name":to,"trigger":"ai_completed","by_user_id":null,"at":iso(now)}));
    metadata["status_history"] = json!(history);
    Ok(true)
}

fn project_ai_state(
    metadata: &mut Value,
    message: &Message,
    status: &str,
    error: &str,
    at: NaiveDateTime,
    previous_activity_id: Option<i64>,
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
    if terminal(status)
        && !old_run.is_empty()
        && old_run != run
        && previous_activity_id.is_none_or(|id| id >= message.id)
    {
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
    if status == "running" {
        let now = json!(iso(at));
        next.insert("started_at".into(), now.clone());
        next.insert("heartbeat_at".into(), now);
        next.insert(
            "lease_expires_at".into(),
            json!(iso(at + chrono::Duration::minutes(10))),
        );
        next.insert("completed_at".into(), Value::Null);
        next.insert("last_error".into(), Value::Null);
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
    if message.metadata.0["kind"] == "task_ai_subagent"
        || matches!(task.status.as_str(), "completed" | "in_review")
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

pub(crate) async fn start_runtime_activity(
    tx: &mut impl MysqlTransaction,
    message: &mut Message,
    owner: Option<i64>,
) -> MysqlResult<()> {
    if message.task_id.is_empty() || message.metadata.0["conversation_only"] == true {
        return Ok(());
    }
    let task: Option<Node> = tx.fetch_optional(
        format!("SELECT {} FROM loop_items WHERE id=? AND resource_type='task' AND {LIVE} FOR UPDATE", store::COLUMNS),
        (message.task_id.as_str(),),
    ).await?;
    let Some(task) = task.filter(|task| task.cloud_project_id == message.project_id) else {
        return Ok(());
    };
    let now = Utc::now().naive_utc();
    if message.metadata.0["run_id"]
        .as_str()
        .is_none_or(str::is_empty)
    {
        message.metadata.0["run_id"] = json!(notifications::uuid());
    }
    message.metadata.0["activity_at"] = json!(iso(now));
    let mut metadata = task.meta();
    project_ai_state(&mut metadata, message, "running", "", now, None);
    if let Some(owner) = owner {
        metadata["ai_state"]["updated_by_user_id"] = json!(owner);
    }
    let mut status = task.status.as_str();
    if metadata["external_index"] != true
        && metadata["external_shadow"] != true
        && metadata["dispatch_child"] != true
        && !matches!(status, "completed" | "in_progress")
    {
        let project: Option<Node> = tx
            .fetch_optional(
                format!(
                    "SELECT {} FROM loop_items WHERE id=? AND resource_type='project'",
                    store::COLUMNS
                ),
                (task.cloud_project_id.as_str(),),
            )
            .await?;
        if let Some(project) = project {
            let target = issues::status_name(&project, "in_progress");
            if !target.is_empty() {
                let mut history = metadata["status_history"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                history.push(json!({"from_status":status,"to_status":"in_progress",
                    "from_status_name":issues::status_name(&project,status),"to_status_name":target,
                    "trigger":"ai_started","by_user_id":null,"at":iso(now)}));
                metadata["status_history"] = json!(history);
                status = "in_progress";
            }
        }
    }
    let changed = status != task.status;
    tx.execute(
        "UPDATE loop_items SET metadata=?,status=?,completed_at=CASE WHEN ? THEN '1970-01-01 00:00:01' ELSE completed_at END,sort_order=CASE WHEN ? THEN 0 ELSE sort_order END,version=version+1,updated_at=CURRENT_TIMESTAMP(6) WHERE id=? AND resource_type='task'",
        (Json(metadata), status, changed, changed, task.id.as_str()),
    ).await?;
    tx.execute(
        "UPDATE project_chat_messages SET metadata=? WHERE id=?",
        (Json(message.metadata.0.clone()), message.id),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
pub(super) mod tests {
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

    fn task(status: &str) -> Node {
        Node {
            id: "P-1".into(),
            resource_type: "task".into(),
            cloud_project_id: "project".into(),
            parent_id: String::new(),
            loop_item_id: String::new(),
            name: String::new(),
            project_key: String::new(),
            next_item_number: 0,
            local_project_id: 0,
            assignee_user_id: 7,
            assignee_team_id: 0,
            priority: "none".into(),
            title: "Issue".into(),
            description: String::new(),
            status: status.into(),
            source: String::new(),
            created_by_user_id: 7,
            user_id: 7,
            task_user_id: 0,
            task_id: String::new(),
            task_title: String::new(),
            device_id: String::new(),
            backend_task_id: 0,
            assignee_agent_id: "a".into(),
            metadata: Json(json!({})),
            due_at: None,
            version: 1,
        }
    }

    pub(crate) async fn verify_issue_activity_projection(mysql: &impl Mysql) -> anyhow::Result<()> {
        let since = Utc::now();
        mysql.execute(
            "INSERT INTO loop_items(id, resource_type, description, metadata, created_at, updated_at) VALUES ('review-fixture-project', 'project', '', ?, NOW(), NOW())",
            (Json(json!({"board_config":{"statuses":[{"id":"doing","name":"Doing"}]}})),),
        ).await?;
        mysql.execute(
            "INSERT INTO loop_items(id, resource_type, cloud_project_id, description, metadata, status, assignee_agent_id, created_at, updated_at) VALUES ('review-fixture-issue', 'task', 'review-fixture-project', '', JSON_OBJECT(), 'doing', 'a', NOW(), NOW())",
            (),
        ).await?;
        let mut completed = message();
        completed.project_id = "review-fixture-project".into();
        completed.task_id = "review-fixture-issue".into();
        completed.status = "completed".into();
        completed.content = "https://github.com/example/project/pull/1".into();
        assert!(project_runtime_completion(mysql, &completed, true).await?);
        let issue = store::get(mysql, "task", &completed.task_id)
            .await?
            .unwrap();
        assert_eq!(issue.status, "doing");
        assert!(issue.metadata.0.get("status_history").is_none());

        // A repaired completion can change the badge while a newer run owns the Issue.
        mysql
            .execute(
                "UPDATE loop_items SET metadata=JSON_SET(metadata, '$.ai_state', CAST(? AS JSON)) WHERE id=?",
                (
                    Json(json!({"project_chat_message_id":"newer","status":"running"})),
                    completed.task_id.as_str(),
                ),
            )
            .await?;
        completed.content = "https://github.com/example/project/pull/2".into();
        assert!(project_runtime_completion(mysql, &completed, false).await?);
        let issue = store::get(mysql, "task", &completed.task_id)
            .await?
            .unwrap();
        assert_eq!(issue.status, "doing");
        assert_eq!(
            issue.metadata.0["ai_state"]["project_chat_message_id"],
            "newer"
        );
        assert_eq!(issue.metadata.0["badges"][0]["url"], completed.content);
        assert_eq!(issue.metadata.0["badges"].as_array().unwrap().len(), 1);
        assert!(!project_runtime_completion(mysql, &completed, false).await?);
        let updated: NaiveDateTime = mysql
            .fetch_one(
                "SELECT updated_at FROM loop_items WHERE id='review-fixture-issue'",
                (),
            )
            .await?;
        crate::socketio::issue_timestamp_tests::assert_current(
            &json!(crate::socketio::project_chat_messages::utc_isoformat(
                updated
            )),
            since,
        );
        Ok(())
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
            Utc::now().naive_utc(),
            None
        ));
        assert_eq!(metadata, original);
        let mut settled = json!({"ai_state":{"run_id":"new","status":"completed","project_chat_message_id":"new-message"},"content_revision":7});
        let original = settled.clone();
        assert!(!project_ai_state(
            &mut settled,
            &message(),
            "completed",
            "",
            Utc::now().naive_utc(),
            Some(2)
        ));
        assert_eq!(settled, original);
    }

    #[test]
    fn terminal_before_start_installs_only_a_newer_activity() {
        for status in ["failed", "cancelled"] {
            let mut metadata = json!({"ai_state":{"run_id":"previous","status":"completed","project_chat_message_id":"previous"}});
            let mut current = message();
            current.id = 2;
            assert!(project_ai_state(
                &mut metadata,
                &current,
                status,
                "rejected before start",
                Utc::now().naive_utc(),
                Some(1)
            ));
            assert_eq!(metadata["ai_state"]["status"], status);
            assert_eq!(metadata["ai_state"]["run_id"], "old");
            let saved = metadata.clone();
            let mut older = message();
            older.metadata.0["run_id"] = json!("previous");
            assert!(!project_ai_state(
                &mut metadata,
                &older,
                "completed",
                "",
                Utc::now().naive_utc(),
                Some(2)
            ));
            assert_eq!(metadata, saved);
        }
    }

    #[test]
    fn failure_retries_and_revision_keep_unrelated_issue_metadata() {
        let mut metadata = json!({"ai_state":{"run_id":"old","status":"running","auto_retry_count":2,"prompt":"Keep prompt"},"content_revision":7,"read_revisions":{"7":5},"custom":"kept"});
        assert!(project_ai_state(
            &mut metadata,
            &message(),
            "failed",
            "timeout",
            Utc::now().naive_utc(),
            None
        ));
        assert_eq!(metadata["ai_state"]["auto_retry_count"], 3);
        assert_eq!(metadata["ai_state"]["last_error"], "timeout");
        assert_eq!(metadata["ai_state"]["prompt"], "Keep prompt");
        assert_eq!(metadata["content_revision"], 8);
        assert_eq!(metadata["read_revisions"]["7"], 5);
        assert_eq!(metadata["custom"], "kept");
    }

    #[test]
    fn only_explicit_low_risk_policy_can_auto_publish_the_assistant_summary() {
        let mut metadata = json!({
            "assistant_dispatch_role":"member",
            "assistant_owner_user_id":7,
            "risk_level":"low",
            "awaiting_public_summary":true,
            "publish_policy":"summary_only",
            "assistant_autonomy_policy":{
                "automatic":true,
                "ask_before_act":false,
                "risk_ceiling":"low"
            }
        });
        let mut completed = message();
        completed.project_id = "project".into();
        completed.content = "Verified summary".into();
        let task = task("in_progress");
        assert!(apply_assistant_publication(
            &task,
            &mut metadata,
            &mut completed,
            "completed"
        ));
        assert_eq!(metadata["awaiting_public_summary"], false);
        assert_eq!(
            completed.metadata.0["assistant_publication"]["published_by"],
            "ai"
        );

        metadata["awaiting_public_summary"] = json!(true);
        metadata["assistant_autonomy_policy"]["ask_before_act"] = json!(true);
        assert!(!apply_assistant_publication(
            &task,
            &mut metadata,
            &mut completed,
            "completed"
        ));
        metadata["assistant_autonomy_policy"]["ask_before_act"] = json!(false);
        metadata["risk_level"] = json!("high");
        assert!(!apply_assistant_publication(
            &task,
            &mut metadata,
            &mut completed,
            "completed"
        ));
    }

    #[test]
    fn automatic_assistant_results_do_not_override_user_review_states() {
        assert_eq!(
            assistant_transition("in_progress", false, false, true),
            Some("completed")
        );
        assert_eq!(assistant_transition("in_review", false, false, true), None);
        assert_eq!(assistant_transition("completed", false, false, true), None);
    }

    #[test]
    fn stale_or_completed_dispatch_results_cannot_enter_review() {
        let mut metadata = json!({
            "assistant_dispatch_role":"member",
            "assistant_owner_user_id":7,
            "awaiting_public_summary":true,
            "publish_policy":"summary_only",
            "ai_state":{"project_chat_message_id":"old-message"}
        });
        let message = message();
        let running = task("in_progress");
        assert!(dispatch_review_allowed(
            &running,
            &metadata,
            &message,
            "completed",
            true,
            false
        ));
        assert!(!dispatch_review_allowed(
            &running,
            &metadata,
            &message,
            "completed",
            false,
            false
        ));
        metadata["ai_state"]["project_chat_message_id"] = json!("newer-message");
        assert!(!dispatch_review_allowed(
            &running,
            &metadata,
            &message,
            "completed",
            true,
            false
        ));
        assert!(!dispatch_review_allowed(
            &task("completed"),
            &json!({
                "assistant_dispatch_role":"member",
                "assistant_owner_user_id":7,
                "awaiting_public_summary":true,
                "publish_policy":"summary_only",
                "ai_state":{"project_chat_message_id":"old-message"}
            }),
            &message,
            "completed",
            true,
            false
        ));
    }
}
