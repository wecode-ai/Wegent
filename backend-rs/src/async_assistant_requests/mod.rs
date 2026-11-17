//! Explicit asynchronous work reuses personal-assistant authority and Runtime.

mod events;
mod model;
mod service;
mod turns;
pub(crate) use turns::terminal_is_current;
#[cfg(test)]
mod tests;

use brz_http_server::StatusCode;
use brz_mysql::{MysqlError, MysqlResult, MysqlTransaction};
use serde_json::{Value, json};

use crate::auth::SessionUser;
use crate::background_jobs::project::{authority, store};
use crate::background_jobs::robot::{self, model::Execution};
use crate::http_compat::FastApiError;
use crate::loop_tasks::auth::FlexibleUser;
use crate::plugins_marketplace::query::PluginQuery;
use crate::state::AppState;

use model::{Action, COLUMNS, RequestRow};

pub(crate) fn enabled() -> bool {
    crate::config::env_or_dotenv("ASYNC_ASSISTANT_REQUESTS_ENABLED").is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "true" | "1" | "yes" | "on"
        )
    })
}

fn reject(code: u16, message: &str) -> MysqlError {
    MysqlError::InvalidQuery {
        reason: format!("ASSISTANT_REQUEST:{code}:{message}"),
    }
}

fn is_rejection(error: &MysqlError) -> bool {
    matches!(error, MysqlError::InvalidQuery { reason } if reason.starts_with("ASSISTANT_REQUEST:"))
}

fn http_error(error: MysqlError) -> FastApiError {
    if let MysqlError::InvalidQuery { reason } = &error
        && let Some(value) = reason.strip_prefix("ASSISTANT_REQUEST:")
        && let Some((code, message)) = value.split_once(':')
    {
        let code = match code {
            "403" => StatusCode::FORBIDDEN,
            "404" => StatusCode::NOT_FOUND,
            "409" => StatusCode::CONFLICT,
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        return FastApiError::detail(code, message);
    }
    tracing::error!(%error, "assistant request persistence failed");
    FastApiError::unhandled()
}

async fn issue_on(
    tx: &mut impl MysqlTransaction,
    project: &str,
    issue: &str,
    owner: i64,
) -> MysqlResult<store::Node> {
    let mut query = &mut *tx;
    let access = authority::execution_access_on(&mut query, project, owner)
        .await
        .map_err(|error| {
            if robot::authority::infrastructure(&error) {
                MysqlError::InvalidQuery {
                    reason: error.to_string(),
                }
            } else {
                reject(403, "Issue execution permission is unavailable")
            }
        })?;
    let issue: Option<store::Node> = tx
        .fetch_optional(
            format!(
                "SELECT {} FROM loop_items WHERE resource_type='task' AND id=? AND {} FOR UPDATE",
                store::COLUMNS,
                store::LIVE
            ),
            (issue,),
        )
        .await?;
    let issue = issue
        .filter(|issue| issue.cloud_project_id == project)
        .ok_or_else(|| reject(404, "Issue not found"))?;
    authority::require_issue_with_priority_on(
        &mut &mut *tx,
        &access.project,
        &issue,
        owner,
        access.priority,
    )
    .await
    .map_err(|error| {
        if robot::authority::infrastructure(&error) {
            MysqlError::InvalidQuery {
                reason: error.to_string(),
            }
        } else {
            reject(404, "Issue not found")
        }
    })?;
    Ok(issue)
}

async fn rows_on(
    query: &mut impl PluginQuery,
    project: &str,
    issue: &str,
    owner: i64,
) -> MysqlResult<Vec<RequestRow>> {
    let rows: Vec<RequestRow> = query.fetch_all(
        format!("SELECT {COLUMNS} FROM loop_item_executions WHERE cloud_project_id=? AND loop_item_id=? AND executor_owner_user_id=? AND execution_scope LIKE 'assistant-request:%' ORDER BY id DESC"),
        (project, issue, owner),
    ).await?;
    let mut scopes = std::collections::HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|row| scopes.insert(row.execution_scope.clone()))
        .collect())
}

async fn view_on(query: &mut impl PluginQuery, row: &RequestRow) -> MysqlResult<Value> {
    let position = if matches!(row.status.as_str(), "waiting_runtime" | "claimed") {
        let count:Option<(i64,)>=query.fetch_optional("SELECT COUNT(*) FROM loop_item_executions candidate WHERE candidate.executor_owner_user_id=? AND candidate.execution_device_id=? AND candidate.execution_scope LIKE 'assistant-request:%' AND candidate.status IN ('waiting_runtime','claimed') AND candidate.id<=? AND NOT EXISTS (SELECT 1 FROM loop_item_executions newer WHERE newer.executor_owner_user_id=candidate.executor_owner_user_id AND newer.cloud_project_id=candidate.cloud_project_id AND newer.loop_item_id=candidate.loop_item_id AND newer.execution_scope=candidate.execution_scope AND newer.id>candidate.id)",(row.executor_owner_user_id,row.execution_device_id.as_str(),row.id)).await?;
        count.map(|value| value.0 as usize).unwrap_or(1).max(1)
    } else {
        0
    };
    Ok(row.view(position))
}

async fn request_on(
    query: &mut impl PluginQuery,
    project: &str,
    issue: &str,
    owner: i64,
    request: &str,
) -> MysqlResult<RequestRow> {
    if !model::valid_id(request) {
        return Err(reject(404, "Request not found"));
    }
    optional_request_on(query, project, issue, owner, request)
        .await?
        .ok_or_else(|| reject(404, "Request not found"))
}

async fn optional_request_on(
    query: &mut impl PluginQuery,
    project: &str,
    issue: &str,
    owner: i64,
    request: &str,
) -> MysqlResult<Option<RequestRow>> {
    query.fetch_optional(
        format!("SELECT {COLUMNS} FROM loop_item_executions WHERE cloud_project_id=? AND loop_item_id=? AND executor_owner_user_id=? AND execution_scope=? ORDER BY id DESC LIMIT 1 FOR UPDATE"),
        (project, issue, owner, format!("assistant-request:{request}")),
    ).await
}

#[brz_http_server::get("/api/v1/cloud-projects/:project_id/loop-items/:item_id/assistant-requests")]
#[tracing::instrument(
    name = "collaboration.assistant_request.list",
    skip_all,
    fields(project_id, item_id)
)]
async fn list_assistant_requests(
    #[inject(state)] state: &AppState,
    project_id: &str,
    item_id: &str,
    #[auth] current_user: FlexibleUser,
) -> Result<Value, FastApiError> {
    let requests = state
        .mysql
        .with_transaction(async |tx| {
            issue_on(tx, project_id, item_id, i64::from(current_user.id)).await?;
            let rows = rows_on(
                &mut &mut *tx,
                project_id,
                item_id,
                i64::from(current_user.id),
            )
            .await?;
            let mut values = Vec::with_capacity(rows.len());
            for row in rows.iter().rev() {
                values.push(view_on(&mut &mut *tx, row).await?);
            }
            Ok(values)
        })
        .await
        .map_err(http_error)?;
    Ok(json!({"enabled":enabled(),"requests":requests}))
}

#[brz_http_server::post(
    "/api/v1/cloud-projects/:project_id/loop-items/:item_id/assistant-requests"
)]
async fn act_on_assistant_request(
    #[inject(state)] state: &AppState,
    project_id: &str,
    item_id: &str,
    #[auth] current_user: FlexibleUser,
    body: &[u8],
) -> Result<Value, FastApiError> {
    let action: Action = serde_json::from_slice(body).map_err(|_| {
        FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid assistant request action",
        )
    })?;
    action
        .validate()
        .map_err(|message| FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, message))?;
    let (value, cancellations, message) = state
        .mysql
        .with_transaction(async |tx| {
            let issue = issue_on(tx, project_id, item_id, i64::from(current_user.id)).await?;
            service::act_on(tx, &issue, i64::from(current_user.id), &action).await
        })
        .await
        .map_err(http_error)?;
    // The accepted receipt is durable before any Runtime is contacted.
    publish_receipt(state, message).await;
    robot::request_runtime_cancellations(state, &cancellations).await;
    Ok(value)
}

async fn publish_receipt(
    state: &AppState,
    message: Option<crate::background_jobs::project::completion::Message>,
) {
    if let (Some(redis), Some(message)) = (&state.redis, message)
        && let Err(error) =
            crate::background_jobs::project::completion::publish(redis, &message).await
    {
        tracing::warn!(%error,message_id=message.message_id,"Assistant request timeline delivery failed after commit");
    }
}

#[brz_http_server::post(
    "/api/v1/cloud-projects/:project_id/loop-items/:item_id/assistant-requests/:request_id/events"
)]
async fn acknowledge_request_event(
    #[inject(state)] state: &AppState,
    project_id: &str,
    item_id: &str,
    request_id: &str,
    #[auth] current_user: FlexibleUser,
    body: &[u8],
) -> Result<Value, FastApiError> {
    let event: events::Event = serde_json::from_slice(body).map_err(|_| {
        FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid assistant request event",
        )
    })?;
    let (value, message) = state
        .mysql
        .with_transaction(async |tx| {
            let issue = issue_on(tx, project_id, item_id, i64::from(current_user.id)).await?;
            events::acknowledge_on(tx, &issue, i64::from(current_user.id), request_id, event).await
        })
        .await
        .map_err(http_error)?;
    publish_receipt(state, message).await;
    Ok(value)
}

/// Human approval cannot be granted by a Runtime task token or personal API key.
#[brz_http_server::post(
    "/api/v1/cloud-projects/:project_id/loop-items/:item_id/assistant-requests/:request_id/merge"
)]
async fn approve_request_merge(
    #[inject(state)] state: &AppState,
    project_id: &str,
    item_id: &str,
    request_id: &str,
    #[auth] current_user: SessionUser,
    body: &[u8],
) -> Result<Value, FastApiError> {
    let approval: service::MergeApproval = serde_json::from_slice(body).map_err(|_| {
        FastApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Invalid merge confirmation",
        )
    })?;
    approval
        .validate()
        .map_err(|message| FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, message))?;
    state
        .mysql
        .with_transaction(async |tx| {
            let issue = issue_on(tx, project_id, item_id, i64::from(current_user.id)).await?;
            service::approve_merge_on(tx, &issue, i64::from(current_user.id), request_id, approval)
                .await
        })
        .await
        .map_err(http_error)
}

/// A request's execution identity is independent of the assignment's first run.
pub(crate) async fn require_current_on(
    query: &mut impl PluginQuery,
    issue: &store::Node,
    row: &Execution,
) -> anyhow::Result<()> {
    let context = row.context();
    let id = context["assistant_request_id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("Missing request identity"))?;
    let current = request_on(
        query,
        &issue.cloud_project_id,
        &issue.id,
        row.executor_owner_user_id,
        id,
    )
    .await?;
    anyhow::ensure!(
        current.id == row.id
            && current.executor_owner_user_id == issue.assignee_user_id
            && row.assigner_user_id == row.executor_owner_user_id
            && !current.terminal()
            && current.status != "cancel_requested",
        "Assistant request is no longer current"
    );
    service::require_assignment_on(query, issue, row.executor_owner_user_id, &context).await?;
    Ok(())
}

pub(crate) async fn aggregate_current_on(
    tx: &mut impl MysqlTransaction,
    issue: &store::Node,
    id: i64,
    owner: i64,
    context: &Value,
) -> MysqlResult<bool> {
    let Some(request) = context["assistant_request_id"].as_str() else {
        return Ok(false);
    };
    let Some(current) = optional_request_on(
        &mut &mut *tx,
        &issue.cloud_project_id,
        &issue.id,
        owner,
        request,
    )
    .await?
    else {
        return Ok(false);
    };
    if current.id != id
        || matches!(current.status.as_str(), "cancelled" | "cancel_requested")
        || issue.assignee_user_id != owner
    {
        return Ok(false);
    }
    match service::require_assignment_on(&mut &mut *tx, issue, owner, context).await {
        Ok(()) => Ok(true),
        Err(error) if is_rejection(&error) => Ok(false),
        Err(error) => Err(error),
    }
}
