//! Calendar policy runs only after the candidate's device and collaboration checks.

use brz_mysql::MysqlResult;
use chrono::{NaiveDateTime, Utc};
use serde_json::Value;

use crate::AppState;
use crate::background_jobs::{
    project::{due::permits_scheduled_run, store},
    robot::{
        self,
        model::{Execution, unset},
    },
};
use wegent_backend_persistence::mysql_query::MysqlQuery;

const NON_WORKDAY_NOTE: &str =
    "Scheduled execution cancelled: today is not a China statutory workday";

fn initial_start(execution: &Execution) -> bool {
    matches!(execution.status.as_str(), "queued" | "claimed")
        && unset(execution.start_requested_at)
        && execution.owns_automation_run()
        && execution.context()["comment_trigger_message_id"]
            .as_str()
            .is_none_or(str::is_empty)
}

fn permits(
    execution: &Execution,
    run_status: &str,
    source: &str,
    metadata: &Value,
    now: NaiveDateTime,
) -> anyhow::Result<bool> {
    if !initial_start(execution)
        || !matches!(
            run_status,
            "pending" | "queued" | "waiting_runtime" | "waiting_device"
        )
    {
        return Ok(true);
    }
    let trigger = metadata["trigger"]
        .as_str()
        .filter(|value| !value.is_empty())
        .unwrap_or(source);
    permits_scheduled_run(metadata, trigger, now)
}

pub(crate) async fn check_on(
    query: &mut impl MysqlQuery,
    execution: &Execution,
    now: NaiveDateTime,
) -> MysqlResult<anyhow::Result<bool>> {
    if !initial_start(execution) {
        return Ok(Ok(true));
    }
    let run = store::get_on(query, "automation_run", &execution.automation_run_id).await?;
    Ok(match run {
        Some(run) => permits(execution, &run.status, &run.source, &run.metadata.0, now),
        None => Ok(true),
    })
}

pub(crate) async fn eligible(app: &AppState, execution: &Execution) -> anyhow::Result<bool> {
    match check_on(&mut &app.mysql, execution, Utc::now().naive_utc()).await? {
        Ok(true) => Ok(true),
        Ok(false) => {
            robot::cancel(app, execution, NON_WORKDAY_NOTE).await?;
            Ok(false)
        }
        Err(error) => {
            robot::defer_workday(app, execution, &error.to_string()).await?;
            tracing::warn!(execution_id=execution.id,%error,"Scheduled execution awaits workday calendar update");
            Ok(false)
        }
    }
}

#[cfg(test)]
#[path = "device_pull_workday_tests.rs"]
mod tests;
