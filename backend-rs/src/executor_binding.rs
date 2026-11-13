// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Persist a scheduler-confirmed executor before it can run the assistant turn.
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json, MysqlRow, MysqlTransaction as _};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::internal_callback::completion::{
    dispatchable_task_status, is_active_task, latest_assistant_id, task_column,
};
use crate::{http_compat::FastApiError, state::AppState, task_routing::ByTaskId};

const PURPOSE: &str = "executor_binding";
pub(crate) const AUTHORIZATION_SCHEME: &str = "WegentExecutorBinding";

pub(crate) struct DispatchRequest {
    pub body: Value,
    pub binding_token: String,
}

pub(crate) fn dispatch_request(
    state: &AppState,
    request: &crate::responses::create::dispatch::ExecutionRequest,
) -> Result<DispatchRequest, String> {
    let payload = crate::responses::create::dispatch::assemble(request, false, true);
    let claims = json!({
        "type": PURPOSE,
        "task_id": request.task_id,
        "subtask_id": request.subtask_id,
        "user_id": request.user_id,
        "exp": chrono::Utc::now().timestamp() + 24 * 60 * 60,
    });
    let token = crate::responses::create::tokens::sign(state, &claims, PURPOSE)
        .map_err(|_| "Could not sign executor binding credential".to_owned())?;
    let body = serde_json::to_value(payload)
        .map_err(|_| "Could not serialize executor dispatch request".to_owned())?;
    Ok(DispatchRequest {
        body,
        binding_token: token,
    })
}

#[derive(Deserialize)]
struct BindingClaims {
    #[serde(rename = "type")]
    purpose: String,
    task_id: i64,
    subtask_id: i64,
    user_id: i64,
    exp: i64,
}

impl BindingClaims {
    fn matches(&self, task_id: i64, subtask_id: i64, now: i64) -> bool {
        self.purpose == PURPOSE
            && self.task_id == task_id
            && self.subtask_id == subtask_id
            && task_id > 0
            && subtask_id > 0
            && self.user_id > 0
            && self.exp > now
    }
}

#[derive(Deserialize)]
pub(crate) struct BindingRequest {
    pub(crate) executor_name: String,
    #[serde(default)]
    pub(crate) executor_namespace: String,
}

impl BindingRequest {
    fn valid(&self) -> bool {
        fn valid_part(part: &str) -> bool {
            part.len() <= 100
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        }

        !self.executor_name.is_empty()
            && !self.executor_name.starts_with("device-")
            && valid_part(&self.executor_name)
            && valid_part(&self.executor_namespace)
    }
}

#[derive(FromMysqlRow)]
struct BoundSubtask {
    status: String,
    executor_name: Option<String>,
    executor_namespace: Option<String>,
    executor_deleted_at: i64,
}

#[derive(Debug, PartialEq, Eq)]
enum BindingDecision {
    Write,
    AlreadyBound,
    Conflict,
    Obsolete,
}

impl BoundSubtask {
    fn binding_decision(&self, request: &BindingRequest) -> BindingDecision {
        let name = self.executor_name.as_deref().unwrap_or_default();
        let namespace = self.executor_namespace.as_deref().unwrap_or_default();
        if !matches!(self.status.as_str(), "PENDING" | "RUNNING") {
            BindingDecision::Obsolete
        } else if self.status != "RUNNING"
            || (!name.is_empty() && name != request.executor_name)
            || (!namespace.is_empty() && namespace != request.executor_namespace)
        {
            BindingDecision::Conflict
        } else if name == request.executor_name
            && namespace == request.executor_namespace
            && self.executor_deleted_at == 0
        {
            BindingDecision::AlreadyBound
        } else {
            BindingDecision::Write
        }
    }
}

// The dispatcher credential is purpose-bound and never sent to the runtime.
#[brz_http_server::post("/api/internal/tasks/:task_id/subtasks/:subtask_id/executor-binding", access = public)]
async fn bind_executor(
    #[inject(state)] state: &AppState,
    task_id: i64,
    subtask_id: i64,
    #[header("authorization")] authorization: Option<&str>,
    body: Value,
) -> Result<Value, FastApiError> {
    let claims = crate::jwt_compat::decode_pyjwt::<BindingClaims>(
        &crate::auth::extract_authorization_token(authorization),
        state.jwt_secret_keys.iter().map(|key| key.as_bytes()),
        crate::auth::algorithm(&state.auth).ok_or_else(FastApiError::internal)?,
    )
    .filter(|claims| claims.matches(task_id, subtask_id, chrono::Utc::now().timestamp()))
    .ok_or_else(|| FastApiError::forbidden("A matching executor binding credential is required"))?;
    let request = serde_json::from_value::<BindingRequest>(body)
        .ok()
        .filter(BindingRequest::valid)
        .ok_or_else(|| {
            FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, "Invalid executor binding")
        })?;
    persist_binding(state, task_id, subtask_id, claims.user_id, &request).await
}

pub(crate) async fn persist_binding(
    state: &AppState,
    task_id: i64,
    subtask_id: i64,
    user_id: i64,
    request: &BindingRequest,
) -> Result<Value, FastApiError> {
    let tables = state.task_store.table_templates();
    let table = tables.subtasks;
    let mysql = state.mysql.route(ByTaskId(task_id as u64));
    mysql
        .with_transaction(async |tx| {
            let task: Option<MysqlRow> = tx
                .fetch_optional(
                    crate::task_store::task_for_update_first_statement(tables.tasks),
                    (task_id,),
                )
                .await?;
            let Some(task) = task.filter(is_active_task) else {
                return Ok(Err(obsolete_dispatch()));
            };
            let payload = task_column::<Json<Value>>(&task, "json");
            let Some(status) = payload
                .as_ref()
                .and_then(|json| dispatchable_task_status(&json.0))
            else {
                return Ok(Err(obsolete_dispatch()));
            };
            let latest = latest_assistant_id(tx, table, task_id).await?;
            if latest != Some(subtask_id) {
                return Ok(Err(obsolete_dispatch()));
            }
            let identity = (subtask_id, task_id, user_id);
            let row: Option<BoundSubtask> = tx
                .fetch_optional(
                    format!(
                        "SELECT status, executor_name, executor_namespace, executor_deleted_at \
                     FROM {table} WHERE id = ? AND task_id = ? AND user_id = ? \
                     AND role = 'ASSISTANT' FOR UPDATE"
                    ),
                    identity,
                )
                .await?;
            let Some(row) = row else {
                return Ok(Err(FastApiError::not_found("Assistant subtask not found")));
            };
            match row.binding_decision(request) {
                BindingDecision::Obsolete => return Ok(Err(obsolete_dispatch())),
                _ if status != "RUNNING" => {
                    return Ok(Err(FastApiError::detail(
                        StatusCode::CONFLICT,
                        "Task is not running",
                    )));
                }
                BindingDecision::Conflict => {
                    return Ok(Err(FastApiError::detail(
                        StatusCode::CONFLICT,
                        "Subtask is not running or is bound to another executor",
                    )));
                }
                BindingDecision::AlreadyBound => {}
                BindingDecision::Write => {
                    tx.execute(
                        format!(
                            "UPDATE {table} SET executor_name = ?, executor_namespace = ?, \
                             executor_deleted_at = 0, updated_at = NOW() \
                             WHERE id = ? AND task_id = ? AND user_id = ?"
                        ),
                        (
                            request.executor_name.as_str(),
                            request.executor_namespace.as_str(),
                            subtask_id,
                            task_id,
                            user_id,
                        ),
                    )
                    .await?;
                }
            }
            Ok(Ok(json!({"status": "bound"})))
        })
        .await
        .map_err(|error| {
            tracing::error!(task_id, subtask_id, %error, "could not persist executor binding");
            FastApiError::internal()
        })?
}

fn obsolete_dispatch() -> FastApiError {
    FastApiError::detail(StatusCode::GONE, "Execution turn is no longer dispatchable")
}

#[cfg(test)]
mod tests;
