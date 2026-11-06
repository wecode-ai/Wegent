use anyhow::{Context, Result};
use brz_mysql::{FromMysqlRow, Json, Mysql};
use chrono::{DateTime, NaiveDateTime, Utc};
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) const EXECUTION_COLUMNS: &str = "id,user_id,subscription_id,task_id,inbox_message_id,trigger_type,trigger_reason,prompt,status,result_summary,error_message,retry_attempt,version,started_at,completed_at,created_at,updated_at";

/// `_find_execution_by_task_id`'s active-execution read
/// (`app/services/subscription/task_completion_handler.py:208-222`): the newest
/// execution of one task that has not reached a terminal state.
pub(crate) fn execution_running_by_task() -> String {
    format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM background_executions \n\
         WHERE background_executions.task_id = ? \
         AND background_executions.status IN ('PENDING', 'RUNNING') \n\
         ORDER BY background_executions.id DESC \n LIMIT 1"
    )
}

/// `_find_execution_by_task_id`'s status-free fallback read
/// (`task_completion_handler.py:229-236`): the newest execution of one task,
/// whatever its status.
pub(crate) fn execution_latest_by_task() -> String {
    format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM background_executions \n\
         WHERE background_executions.task_id = ? \n\
         ORDER BY background_executions.id DESC \n LIMIT 1"
    )
}

/// `recover_scheduled_execution_for_task`'s primary-key load
/// (`app/services/knowledge/code_wiki/subscription_integration.py:71`), which
/// `db.get` renders without column aliases.
pub(crate) fn execution_by_id() -> String {
    format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM background_executions \n\
         WHERE background_executions.id = ?"
    )
}

/// `update_execution_status`'s status read
/// (`app/services/subscription/execution.py:820-824`): the ORM entity read by
/// primary key through `db.query(...).first()`, so it ends in `LIMIT 1`.
pub(crate) fn execution_status_read() -> String {
    format!(
        "SELECT {EXECUTION_COLUMNS} \nFROM background_executions \n\
         WHERE background_executions.id = ? \n LIMIT 1"
    )
}
#[derive(Clone, Debug, FromMysqlRow)]
pub(crate) struct Subscription {
    pub id: i64,
    pub user_id: i64,
    pub name: String,
    pub json: Json<Value>,
    pub is_active: i64,
}

/// The `kinds` entity projection `db.query(Kind)` renders
/// (`app/models/kind.py`), in the mapper's column order.
pub(crate) const KIND_COLUMNS: &str =
    "id,user_id,kind,name,namespace,json,is_active,created_at,updated_at";
pub(crate) const SUBSCRIPTION_COLUMNS: &str = KIND_COLUMNS;

/// One subscription read as the source renders it: the full `kinds` entity,
/// filtered by id and kind, optionally restricted to an active row.
pub(crate) fn subscription_statement(active: bool) -> String {
    format!(
        "SELECT {SUBSCRIPTION_COLUMNS} FROM kinds WHERE kinds.id = ? \
         AND kinds.kind = 'Subscription'{} LIMIT 1",
        if active {
            " AND kinds.is_active = true"
        } else {
            ""
        }
    )
}

/// `db.get(Kind, id)` (`task_completion_handler.py:193`) as
/// `_is_code_wiki_scheduled_update` issues it: the entity projection by primary
/// key, without a kind filter and without `LIMIT`.
pub(crate) fn kind_by_id_statement() -> String {
    format!("SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.id = ?")
}

/// `_dispatch_notifications`'s team display-name read
/// (`task_completion_handler.py:552-562`): the referenced Team filtered by name,
/// namespace, kind and `is_active`, in the source's filter order. The source
/// builds a display string from it that it never uses.
pub(crate) fn team_display_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.name = ? \
         AND kinds.namespace = ? AND kinds.kind = 'Team' AND kinds.is_active = true LIMIT 1"
    )
}

/// `_execution_to_in_db`'s Team read
/// (`app/services/subscription/execution.py:285-296`): the Team named by a
/// subscription's `teamRef`, read without an owner filter.
pub(crate) fn team_by_ref_statement() -> String {
    format!(
        "SELECT {KIND_COLUMNS} FROM kinds WHERE kinds.kind = 'Team' \
         AND kinds.name = ? AND kinds.namespace = ? LIMIT 1"
    )
}

/// `dispatch_execution_notifications`'s accepted-follower read
/// (`app/services/subscription/notification_dispatcher.py`): the full
/// `subscription_follows` entity of one subscription.
pub(crate) fn accepted_followers_statement() -> String {
    "SELECT subscription_follows.id, subscription_follows.subscription_id, \
     subscription_follows.follower_user_id, subscription_follows.follow_type, \
     subscription_follows.invited_by_user_id, subscription_follows.invitation_status, \
     subscription_follows.invited_at, subscription_follows.responded_at, \
     subscription_follows.created_at, subscription_follows.updated_at, \
     subscription_follows.config FROM subscription_follows \
     WHERE subscription_follows.subscription_id = ? \
     AND subscription_follows.invitation_status = 'accepted'"
        .to_string()
}
#[derive(Clone, Debug, FromMysqlRow)]
pub(crate) struct Execution {
    pub id: i64,
    pub user_id: i64,
    pub subscription_id: i64,
    pub task_id: i64,
    pub inbox_message_id: i64,
    pub trigger_reason: String,
    pub prompt: String,
    pub status: String,
    pub result_summary: String,
    pub error_message: String,
    pub version: i64,
    pub started_at: NaiveDateTime,
    /// Mirrors the `BackgroundExecution` column; the completion reads the row
    /// back after its CAS write instead of deriving the timestamp in memory.
    #[allow(dead_code)]
    pub completed_at: NaiveDateTime,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Execute {
    pub subscription_id: i64,
    pub execution_id: i64,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}
pub(crate) fn setting(name: &str, default: u64) -> u64 {
    crate::config::env_or_dotenv(name)
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}
pub(crate) fn enabled(name: &str, default: bool) -> bool {
    crate::config::env_or_dotenv(name)
        .map(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(default)
}
pub(crate) fn iso(now: NaiveDateTime) -> String {
    now.format("%Y-%m-%dT%H:%M:%S%.f").to_string()
}
pub(crate) fn datetime(raw: &Value) -> Option<NaiveDateTime> {
    let raw = raw.as_str()?;
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|v| v.with_timezone(&Utc).naive_utc())
        .or_else(|| NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f").ok())
        .or_else(|| NaiveDateTime::parse_from_str(raw, "%Y-%m-%d %H:%M:%S%.f").ok())
}
pub(crate) fn code_wiki_id(row: &Subscription) -> Option<i64> {
    row.json.0["spec"]["codeWikiRef"]["id"]
        .as_i64()
        .filter(|v| *v > 0)
}
pub(crate) fn terminal(status: &str) -> bool {
    matches!(
        status,
        "COMPLETED" | "COMPLETED_SILENT" | "FAILED" | "CANCELLED"
    )
}
pub(crate) async fn subscription<M: Mysql>(
    mysql: &M,
    id: i64,
    active: bool,
) -> Result<Option<Subscription>> {
    Ok(mysql
        .fetch_optional(subscription_statement(active), (id,))
        .await?)
}
pub(crate) async fn execution<M: Mysql>(mysql: &M, id: i64) -> Result<Option<Execution>> {
    Ok(mysql
        .fetch_optional(
            format!("SELECT {EXECUTION_COLUMNS} FROM background_executions WHERE id=?"),
            (id,),
        )
        .await?)
}
pub(crate) fn trigger_config(value: &Value) -> Value {
    let kind = value["_internal"]["trigger_type"]
        .as_str()
        .or(value["spec"]["trigger"]["type"].as_str())
        .unwrap_or("");
    value["_internal"]
        .get("trigger_config")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| value["spec"]["trigger"][kind].clone())
}
pub(crate) fn valid_trigger(value: &Value) -> bool {
    let trigger = &value["spec"]["trigger"];
    let min = setting("SUBSCRIPTION_MIN_INTERVAL_MINUTES", 15) as i64;
    match trigger["type"].as_str() {
        Some("interval") if trigger["interval"]["unit"] == "minutes" => {
            trigger["interval"]["value"].as_i64().unwrap_or(1) >= min
        }
        Some("cron") => {
            let expr = trigger["cron"]["expression"].as_str().unwrap_or("");
            let fields = expr.split_whitespace().collect::<Vec<_>>();
            fields.len() != 5
                || fields[0]
                    .strip_prefix("*/")
                    .and_then(|v| v.parse::<i64>().ok())
                    .is_none_or(|v| v >= min)
        }
        _ => true,
    }
}
pub(crate) fn reason(row: &Subscription, kind: &str) -> String {
    let c = trigger_config(&row.json.0);
    match kind {
        "cron" => format!(
            "Scheduled (cron: {})",
            c["expression"].as_str().unwrap_or("")
        ),
        "interval" => format!(
            "Scheduled (interval: {} {})",
            c["value"].as_i64().unwrap_or(1),
            c["unit"].as_str().unwrap_or("hours")
        ),
        "one_time" => "Scheduled (one-time)".into(),
        _ => format!("Scheduled ({kind})"),
    }
}
pub(crate) fn prompt(template: &str, name: &str, now: DateTime<chrono::Local>) -> Result<String> {
    let result = template
        .replace("{{date}}", &now.format("%Y-%m-%d").to_string())
        .replace("{{time}}", &now.format("%H:%M:%S").to_string())
        .replace("{{datetime}}", &now.format("%Y-%m-%d %H:%M:%S").to_string())
        .replace("{{timestamp}}", &now.timestamp().to_string())
        .replace("{{subscription_name}}", name);
    (!result.trim().is_empty())
        .then_some(result)
        .context("Prompt template resolved to empty string")
}
pub(crate) fn statistics(
    value: &mut Value,
    status: &str,
    summary: &str,
    error: &str,
    now: NaiveDateTime,
) {
    if status == "COMPLETED_SILENT" && value["spec"]["codeWikiRef"]["id"].as_i64().is_none() {
        return;
    }
    let timestamp = iso(now);
    for (root, time_key, status_key, count_key, success_key, failure_key) in [
        (
            "status",
            "lastExecutionTime",
            "lastExecutionStatus",
            "executionCount",
            "successCount",
            "failureCount",
        ),
        (
            "_internal",
            "last_execution_time",
            "last_execution_status",
            "execution_count",
            "success_count",
            "failure_count",
        ),
    ] {
        if !value[root].is_object() {
            value[root] = json!({})
        }
        let target = &mut value[root];
        target[time_key] = json!(timestamp);
        target[status_key] = json!(status);
        target[count_key] = json!(target[count_key].as_i64().unwrap_or(0) + 1);
        if status == "COMPLETED" {
            target[success_key] = json!(target[success_key].as_i64().unwrap_or(0) + 1)
        }
        if status == "FAILED" {
            target[failure_key] = json!(target[failure_key].as_i64().unwrap_or(0) + 1)
        }
    }
    value["_internal"]["last_execution_message"] =
        json!(if !summary.is_empty() { summary } else { error });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn silent_statistics_only_count_code_wiki_checks() {
        let mut ordinary = json!({"spec":{},"_internal":{}});
        statistics(
            &mut ordinary,
            "COMPLETED_SILENT",
            "skipped",
            "",
            Utc::now().naive_utc(),
        );
        assert!(ordinary["status"].is_null());
        ordinary["spec"]["codeWikiRef"] = json!({"id":9});
        statistics(
            &mut ordinary,
            "COMPLETED_SILENT",
            "skipped",
            "",
            Utc::now().naive_utc(),
        );
        assert_eq!(ordinary["status"]["executionCount"], 1);
        assert!(ordinary["status"]["successCount"].is_null());
    }
    #[test]
    fn templates_preserve_unknown_variables_and_unicode() {
        let now = Utc::now().with_timezone(&chrono::Local);
        assert_eq!(
            prompt("{{subscription_name}} {{custom}}", "日报", now).unwrap(),
            "日报 {{custom}}"
        );
        assert!(prompt("  ", "x", now).is_err());
    }
    #[test]
    fn short_cron_and_interval_are_rejected_without_rejecting_hourly() {
        assert!(!valid_trigger(
            &json!({"spec":{"trigger":{"type":"cron","cron":{"expression":"*/5 * * * *"}}}})
        ));
        assert!(valid_trigger(
            &json!({"spec":{"trigger":{"type":"cron","cron":{"expression":"0 * * * *"}}}})
        ));
    }
}
