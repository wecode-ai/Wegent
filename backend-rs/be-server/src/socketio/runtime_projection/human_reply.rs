// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Exact input acknowledgements may follow the persisted terminal outcome.

use brz_mysql::{MysqlResult, MysqlTransaction};

use super::{ExecutionRow, RuntimeIdentity, activity, event_seq};
use crate::background_jobs::project::store;
use crate::loop_tasks::loop_repository::EXECUTION_COLUMNS;

#[cfg(test)]
#[path = "human_reply_tests.rs"]
mod tests;
#[cfg(test)]
pub(crate) use tests::verify as verify_late_human_reply_projection;

fn answer_identity(
    execution: &ExecutionRow,
    user_id: i64,
    devices: &[String],
    identity: &RuntimeIdentity<'_>,
) -> Option<(String, String)> {
    if execution.status_or_empty() != "completed"
        || execution.executor_owner_user_id != Some(user_id)
        || execution.runtime_task_id.as_deref() != Some(identity.runtime_task_id.as_str())
        || !execution
            .runtime_device_id
            .as_ref()
            .is_some_and(|id| devices.contains(id))
    {
        return None;
    }
    let origin = activity::execution_origin_context(execution);
    let request = origin
        .get("human_request_id")?
        .as_str()
        .filter(|id| !id.is_empty())?;
    let message = origin.get("comment_trigger_message_id")?.as_str()?;
    (activity::client_message_id(identity.payload) == Some(message))
        .then(|| (request.to_owned(), message.to_owned()))
}

async fn discover(
    tx: &mut impl MysqlTransaction,
    devices: &[String],
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<Option<ExecutionRow>> {
    let Some(found) = activity::completed_activity_for_turn(
        tx,
        devices,
        &identity.runtime_task_id,
        activity::runtime_turn_id(identity.payload),
        activity::client_message_id(identity.payload),
        false,
        true,
    )
    .await?
    else {
        return Ok(None);
    };
    let Some(id) = found
        .metadata
        .0
        .get("execution_id")
        .and_then(activity::coerce_execution_id)
    else {
        return Ok(None);
    };
    tx.fetch_optional(
        format!("SELECT {EXECUTION_COLUMNS} FROM loop_item_executions WHERE id=?"),
        (id,),
    )
    .await
}

pub(super) async fn settle(
    tx: &mut impl MysqlTransaction,
    user_id: i64,
    devices: &[String],
    identity: &RuntimeIdentity<'_>,
) -> MysqlResult<Option<(String, i64)>> {
    if identity.event_name != "response.created"
        || event_seq(identity.payload).is_none()
        || devices.is_empty()
        || activity::client_message_id(identity.payload).is_none()
    {
        return Ok(None);
    }
    let Some(candidate) = discover(tx, devices, identity).await? else {
        return Ok(None);
    };
    if answer_identity(&candidate, user_id, devices, identity).is_none() {
        return Ok(None);
    }
    let Some(issue_id) = candidate.loop_item_id.as_deref() else {
        return Ok(None);
    };
    // Match normal human-answer acceptance's Issue -> execution -> activity lock order.
    let Some(issue) = store::locked(tx, "task", issue_id).await? else {
        return Ok(None);
    };
    let Some(execution) = activity::reload_execution(tx, candidate.id).await? else {
        return Ok(None);
    };
    let Some((request, message)) = answer_identity(&execution, user_id, devices, identity) else {
        return Ok(None);
    };
    if execution.loop_item_id.as_deref() != Some(issue.id.as_str())
        || execution.cloud_project_id.as_deref() != Some(issue.cloud_project_id.as_str())
    {
        return Ok(None);
    }
    let client = (execution.attempt_no == Some(1)).then_some(message.as_str());
    let Some(completed) = activity::completed_activity_for_turn(
        tx,
        devices,
        &identity.runtime_task_id,
        activity::runtime_turn_id(identity.payload),
        client,
        true,
        true,
    )
    .await?
    else {
        return Ok(None);
    };
    if completed
        .metadata
        .0
        .get("execution_id")
        .is_none_or(|id| crate::json_compat::python_str(id) != execution.id.to_string())
        || completed.project_id != issue.cloud_project_id
        || completed.task_id != issue.id
    {
        return Ok(None);
    }
    if !super::super::project_chat_comment::settle_human_reply(tx, issue, &request, &message)
        .await?
    {
        return Ok(None);
    }
    Ok(Some((issue_id.to_owned(), user_id)))
}
