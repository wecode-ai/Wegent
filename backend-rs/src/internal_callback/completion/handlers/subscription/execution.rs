// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Subscription execution transitions and their transactional projections.
use brz_mysql::{Json, MysqlResult, MysqlRow, MysqlTransaction};
use chrono::{NaiveDateTime, SubsecRound, Utc};
use serde_json::{Value, json};

use crate::admin_subscription_monitor_errors::EXECUTION_COLUMNS;
use crate::internal_callback::completion::{TaskCompletedEvent, sql, task_column};

pub(super) struct Execution {
    pub id: i64,
    pub user_id: i64,
    pub subscription_id: i64,
    pub task_id: i64,
    pub inbox_message_id: i64,
    pub status: String,
    pub version: i64,
    pub prompt: String,
    pub trigger_reason: String,
    pub result_summary: String,
    pub error_message: String,
    pub created_at: Option<NaiveDateTime>,
}

impl Execution {
    fn decode(row: MysqlRow) -> MysqlResult<Self> {
        Ok(Self {
            id: row.get_required("background_executions_id")?,
            user_id: row.get_required("background_executions_user_id")?,
            subscription_id: row.get_required("background_executions_subscription_id")?,
            task_id: row.get_required("background_executions_task_id")?,
            inbox_message_id: row.get_required("background_executions_inbox_message_id")?,
            status: row.get_required("background_executions_status")?,
            version: row
                .get::<i64>("background_executions_version")?
                .unwrap_or(0),
            prompt: row.get_required("background_executions_prompt")?,
            trigger_reason: row.get_required("background_executions_trigger_reason")?,
            result_summary: row.get_required("background_executions_result_summary")?,
            error_message: row.get_required("background_executions_error_message")?,
            created_at: row.get("background_executions_created_at")?,
        })
    }
}

pub(super) async fn find<T: MysqlTransaction>(
    transaction: &mut T,
    task: &MysqlRow,
    event: &TaskCompletedEvent<'_>,
) -> MysqlResult<Option<Execution>> {
    let task_id = event.task_id;
    let payload = task_column::<Json<Value>>(task, "json").map(|value| value.0);
    let labels = payload
        .as_ref()
        .and_then(|value| value.pointer("/metadata/labels"));
    let id = labels.and_then(|labels| {
        labels
            .get("backgroundExecutionId")
            .or_else(|| labels.get("executionId"))
    });
    let id = if let Some(id) = id {
        // Subscription creation updates these labels before dispatch. Combined
        // with the locked assistant round, this identifies one execution, not
        // whichever execution happens to be RUNNING when the callback arrives.
        id.as_str()
            .and_then(|id| id.parse::<i64>().ok())
            .filter(|id| *id > 0)
    } else {
        wiki_execution_id(transaction, task_id).await?
    };
    let Some(id) = id else {
        return Ok(None);
    };
    let row = transaction
        .fetch_optional(
            format!("SELECT {EXECUTION_COLUMNS} FROM background_executions WHERE id=? FOR UPDATE"),
            (id,),
        )
        .await?;
    let Some(mut execution) = row.map(Execution::decode).transpose()? else {
        return Ok(None);
    };
    if execution.user_id != event.user_id
        || (execution.task_id != 0 && execution.task_id != task_id)
    {
        return Ok(None);
    }
    if execution.task_id == 0 && matches!(execution.status.as_str(), "PENDING" | "RUNNING") {
        transaction
            .execute(
                "UPDATE background_executions SET task_id=? WHERE id=? AND task_id=0",
                (task_id, id),
            )
            .await?;
        execution.task_id = task_id;
    }
    Ok(Some(execution))
}

async fn wiki_execution_id<T: MysqlTransaction>(
    transaction: &mut T,
    task_id: i64,
) -> MysqlResult<Option<i64>> {
    let generation: Option<MysqlRow> = transaction
        .fetch_optional(sql::wiki_generation_latest(), (task_id,))
        .await?;
    Ok(generation
        .map(|row| row.get::<Json<Value>>("wiki_generations_ext"))
        .transpose()?
        .flatten()
        .and_then(|ext| ext.0.get("backgroundExecutionId").and_then(Value::as_i64))
        .filter(|id| *id > 0))
}

pub(super) struct Completed {
    pub execution: Execution,
    pub subscription: Option<Value>,
    pub payload: Value,
    pub notify: bool,
}

pub(super) fn terminal_status(event: &TaskCompletedEvent<'_>) -> &'static str {
    match event.status {
        "COMPLETED" if silent(event) => "COMPLETED_SILENT",
        "COMPLETED" => "COMPLETED",
        "CANCELLED" => "CANCELLED",
        _ => "FAILED",
    }
}

fn silent(event: &TaskCompletedEvent<'_>) -> bool {
    event
        .result
        .and_then(|value| value.get("silent_exit"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn valid_transition(current: &str, next: &str) -> bool {
    match current {
        "RUNNING" => true,
        "PENDING" => matches!(next, "FAILED" | "CANCELLED"),
        "RETRYING" => matches!(next, "FAILED" | "CANCELLED" | "COMPLETED_SILENT"),
        _ => false,
    }
}

pub(super) fn code_wiki(subscription: &Value) -> bool {
    subscription
        .pointer("/spec/codeWikiRef/id")
        .and_then(Value::as_i64)
        .is_some_and(|id| id > 0)
}

pub(super) async fn complete<T: MysqlTransaction>(
    transaction: &mut T,
    mut execution: Execution,
    event: &TaskCompletedEvent<'_>,
) -> MysqlResult<Option<Completed>> {
    let status = terminal_status(event);
    if !valid_transition(&execution.status, status) {
        tracing::info!(execution_id=execution.id, current_status=%execution.status, status, "subscription completion skipped");
        return Ok(None);
    }
    let summary = event
        .result
        .and_then(|value| value.get("value"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    let error = event.error.filter(|value| !value.is_empty());
    let now = Utc::now().naive_utc().trunc_subsecs(6);
    let datetime = now.format("%Y-%m-%d %H:%M:%S%.6f").to_string();
    let updated = transaction.execute(
        "UPDATE background_executions SET status=?, result_summary=COALESCE(?, result_summary), error_message=COALESCE(?, error_message), completed_at=?, updated_at=?, version=version+1 WHERE id=? AND task_id=? AND status=? AND version=?",
        (status, summary, error, datetime.as_str(), datetime.as_str(), execution.id, event.task_id, execution.status.as_str(), execution.version),
    ).await?;
    if updated.rows_affected == 0 {
        return Ok(None);
    }
    execution.status = status.to_owned();
    if let Some(summary) = summary {
        execution.result_summary = summary.to_owned();
    }
    if let Some(error) = error {
        execution.error_message = error.to_owned();
    }
    let row: Option<MysqlRow> = transaction.fetch_optional(
        "SELECT json, name FROM kinds WHERE id=? AND user_id=? AND kind='Subscription' FOR UPDATE",
        (execution.subscription_id, execution.user_id),
    ).await?;
    let mut subscription = row
        .as_ref()
        .map(|row| row.get_required::<Json<Value>>("json"))
        .transpose()?
        .map(|json| json.0);
    if let Some(subscription) = subscription.as_mut() {
        if update_statistics(
            subscription,
            status,
            &now.to_string().replace(' ', "T"),
            summary,
            error,
        ) {
            transaction
                .execute(
                    sql::update_kind_json(),
                    (
                        Json(subscription.clone()),
                        super::local_datetime(super::now_local()),
                        execution.subscription_id,
                    ),
                )
                .await?;
        }
    }
    write_inbox(transaction, &execution, event, &datetime, now).await?;
    let mut payload = json!({
        "execution_id": execution.id, "subscription_id": execution.subscription_id,
        "status": status, "is_silent": status == "COMPLETED_SILENT", "task_id": event.task_id,
        "prompt": execution.prompt, "result_summary": execution.result_summary,
        "error_message": execution.error_message, "trigger_reason": execution.trigger_reason,
        "created_at": execution.created_at.map(|value| value.to_string().replace(' ', "T")),
        "updated_at": now.to_string().replace(' ', "T"),
    });
    if let Some(row) = row {
        payload["subscription_name"] = row.get_required::<String>("name")?.into();
    }
    if let Some(subscription) = &subscription {
        for (key, pointer) in [
            ("subscription_display_name", "/spec/displayName"),
            ("team_name", "/spec/teamRef/name"),
        ] {
            if let Some(value) = subscription
                .pointer(pointer)
                .filter(|value| value.as_str().is_some_and(|text| !text.is_empty()))
            {
                payload[key] = value.clone();
            }
        }
        payload["task_type"] = subscription
            .pointer("/spec/taskType")
            .cloned()
            .unwrap_or(json!("collection"));
    }
    let notify = !silent(event)
        && matches!(status, "COMPLETED" | "FAILED")
        && !subscription.as_ref().is_some_and(code_wiki);
    Ok(Some(Completed {
        execution,
        subscription,
        payload,
        notify,
    }))
}

pub(super) fn update_statistics(
    subscription: &mut Value,
    status: &str,
    now: &str,
    summary: Option<&str>,
    error: Option<&str>,
) -> bool {
    if status == "CANCELLED" || (status == "COMPLETED_SILENT" && !code_wiki(subscription)) {
        return false;
    }
    for key in ["status", "_internal"] {
        if !subscription.get(key).is_some_and(Value::is_object) {
            subscription[key] = json!({});
        }
    }
    let projection = &mut subscription["status"];
    projection["lastExecutionTime"] = now.into();
    projection["lastExecutionStatus"] = status.into();
    increment(projection, "executionCount");
    if status == "COMPLETED" {
        increment(projection, "successCount");
    }
    if status == "FAILED" {
        increment(projection, "failureCount");
    }
    let internal = &mut subscription["_internal"];
    internal["last_execution_time"] = now.into();
    internal["last_execution_status"] = status.into();
    internal["last_execution_message"] = summary.or(error).unwrap_or("").into();
    increment(internal, "execution_count");
    if status == "COMPLETED" {
        increment(internal, "success_count");
    }
    if status == "FAILED" {
        increment(internal, "failure_count");
    }
    true
}

fn increment(value: &mut Value, key: &str) {
    value[key] = (value.get(key).and_then(Value::as_i64).unwrap_or(0) + 1).into();
}

async fn write_inbox<T: MysqlTransaction>(
    transaction: &mut T,
    execution: &Execution,
    event: &TaskCompletedEvent<'_>,
    datetime: &str,
    now: NaiveDateTime,
) -> MysqlResult<()> {
    if execution.inbox_message_id <= 0 {
        return Ok(());
    }
    let (status, result) = match event.status {
        "COMPLETED" => (
            "processed",
            json!({"summary": execution.result_summary, "completedAt": format!("{}+00:00", now.to_string().replace(' ', "T"))}),
        ),
        "CANCELLED" => ("unread", json!({"error": "Processing was cancelled"})),
        _ => (
            "failed",
            json!({"error": event.error.filter(|error| !error.is_empty()).unwrap_or("Execution failed")}),
        ),
    };
    let suffix = match event.status {
        "COMPLETED" => ", processed_at=? , process_task_id=?",
        "CANCELLED" => ", process_subscription_id=0",
        _ => ", process_task_id=?",
    };
    let statement = format!(
        "UPDATE queue_messages SET status=?, process_result=?, updated_at=?{suffix} WHERE id=?"
    );
    match event.status {
        "COMPLETED" => {
            transaction
                .execute(
                    statement,
                    (
                        status,
                        Json(result),
                        datetime,
                        datetime,
                        event.task_id,
                        execution.inbox_message_id,
                    ),
                )
                .await?;
        }
        "CANCELLED" => {
            transaction
                .execute(
                    statement,
                    (status, Json(result), datetime, execution.inbox_message_id),
                )
                .await?;
        }
        _ => {
            transaction
                .execute(
                    statement,
                    (
                        status,
                        Json(result),
                        datetime,
                        event.task_id,
                        execution.inbox_message_id,
                    ),
                )
                .await?;
        }
    }
    Ok(())
}
