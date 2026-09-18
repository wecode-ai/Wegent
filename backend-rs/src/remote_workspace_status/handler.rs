// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/remote-workspace/status` matching
//! `app.services.remote_workspace_service.RemoteWorkspaceService.get_status`.
use crate::remote_workspace_payload::ExecutorPayload;
use brz_http_server::StatusCode;
use brz_mysql::Mysql;
#[cfg(test)]
use serde_json::json;
use tracing::warn;

use super::app_state::AppState;
use super::task_detail;
use super::users;

const WORKSPACE_ROOT: &str = "/workspace";
const SANDBOX_HOME_ROOT: &str = "/home/user";

#[derive(serde::Serialize)]
pub struct RemoteWorkspaceStatusResponse {
    pub connected: bool,
    pub available: bool,
    pub root_path: String,
    pub reason: Option<&'static str>,
}

/// Extracts the bearer credential like `extract_authorization_token`.
fn extract_authorization_token(authorization: Option<&str>) -> Option<String> {
    let value = authorization?;
    let mut parts = value.splitn(2, ' ');
    let scheme = parts.next().unwrap_or("");
    let token = parts.next().unwrap_or("").trim();
    if scheme.eq_ignore_ascii_case("bearer") {
        Some(token.to_string())
    } else {
        Some(value.to_string())
    }
}

/// GET /api/tasks/{task_id}/remote-workspace/status: the remote-workspace
/// status free function, injecting the module's own dependency state.
#[brz_http_server::get(
    "/api/tasks/:task_id/remote-workspace/status",
    group = remote_workspace_status
)]
async fn get_remote_workspace_status(
    #[inject(rws)] state: &crate::startup::StatusState,
    task_id: i64,
    #[header] authorization: Option<&str>,
) -> Result<(StatusCode, RemoteWorkspaceStatusResponse), StatusError> {
    status(state, task_id, authorization).await
}

/// A mapped status-endpoint failure.
pub struct StatusError {
    status: StatusCode,
    detail: String,
}

impl From<StatusError> for crate::http_compat::FastApiError {
    fn from(error: StatusError) -> Self {
        crate::http_compat::FastApiError::detail(error.status, error.detail)
    }
}

impl brz_http_server::IntoHttpError for StatusError {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        crate::http_compat::FastApiError::from(self).into_http_error(arena)
    }
}

/// Handler body for `GET /api/tasks/{task_id}/remote-workspace/status`.
async fn status(
    state: &std::sync::Arc<AppState<impl Mysql, impl brz_redis::Redis>>,
    task_id: i64,
    authorization: Option<&str>,
) -> Result<(StatusCode, RemoteWorkspaceStatusResponse), StatusError> {
    // `security.get_current_user`.
    let token = extract_authorization_token(authorization).ok_or_else(unauthorized)?;
    let username = state
        .jwt
        .verify_session(&token)
        .map_err(|_| unauthorized())?
        .ok_or_else(unauthorized)?;
    let user = users::get_by_name(state, &username)
        .await
        .map_err(internal_error)?
        .ok_or_else(unauthorized)?;
    if user.users_is_active == 0 {
        return Err(unauthorized());
    }
    let user_id = i64::from(user.users_id);

    // `remote_workspace_service.get_status`:
    // `_get_task_detail` -> `_get_sandbox_payload` -> `_has_executor_binding`.
    let detail_load = task_detail::load_task_detail(state, task_id, user_id).await;

    let detail = match detail_load {
        Ok(detail) => detail,
        Err(error) => {
            if error.downcast_ref::<task_detail::TaskNotFound>().is_some() {
                return Err(not_found());
            }
            return Err(internal_error(error));
        }
    };

    let sandbox_payload = get_sandbox_payload(state, task_id)
        .await
        .map_err(internal_error)?;
    let connected =
        connected_executor_binding(&detail.subtasks).is_some() || sandbox_payload.is_some();

    let response = if !connected {
        RemoteWorkspaceStatusResponse {
            connected: false,
            available: false,
            root_path: format!("{WORKSPACE_ROOT}/{task_id}"),
            reason: Some("not_connected"),
        }
    } else {
        // `_resolve_workspace_base_url`: the sandbox payload is re-queried
        // when the first query produced none, then falls back to the
        // connected executor binding's address lookup.
        let base_url =
            resolve_workspace_base_url(state, task_id, &detail.subtasks, &sandbox_payload)
                .await
                .map_err(internal_error)?;
        let available = base_url.is_some();
        let root_path = if sandbox_available(&sandbox_payload) {
            SANDBOX_HOME_ROOT.to_string()
        } else {
            format!("{WORKSPACE_ROOT}/{task_id}")
        };
        RemoteWorkspaceStatusResponse {
            connected: true,
            available,
            root_path,
            reason: if available {
                None
            } else {
                Some("sandbox_not_running")
            },
        }
    };

    Ok((StatusCode::OK, response))
}

/// `RemoteWorkspaceService._get_sandbox_payload`: a non-200 or undecodable
/// sandbox response yields no payload, not an error.
async fn get_sandbox_payload(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
) -> anyhow::Result<Option<ExecutorPayload>> {
    let endpoint = state.http.sandbox_status_endpoint(task_id)?;
    let response = match endpoint.get().send().await {
        Ok(response) => response,
        Err(error) => {
            warn!(%task_id, %error, "[remote_workspace] sandbox query failed");
            return Ok(None);
        }
    };
    if response.status().as_u16() != 200 {
        warn!(
            %task_id,
            status = response.status().as_u16(),
            "[remote_workspace] sandbox query non_200"
        );
        return Ok(None);
    }
    Ok(response
        .bytes()
        .await
        .ok()
        .and_then(|body| ExecutorPayload::parse(&body)))
}

/// `RemoteWorkspaceService._resolve_workspace_base_url`: the sandbox payload
/// when available, else the executor address fallback
/// (`_get_executor_payload` + status/base_url interpretation). A `None`
/// sandbox payload is re-queried first, exactly like the source's
/// `if sandbox_payload is None: sandbox_payload = self._get_sandbox_payload(...)`.
async fn resolve_workspace_base_url(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    subtasks: &[task_detail::SubtaskRow],
    sandbox_payload: &Option<ExecutorPayload>,
) -> anyhow::Result<Option<String>> {
    let sandbox_payload = match sandbox_payload {
        Some(payload) => Some(payload.clone()),
        None => get_sandbox_payload(state, task_id).await?,
    };
    if sandbox_available(&sandbox_payload)
        && let Some(base_url) = sandbox_payload
            .as_ref()
            .and_then(|payload| payload.base_url.as_deref())
            .filter(|base_url| !base_url.is_empty())
    {
        return Ok(Some(base_url.trim_end_matches('/').to_string()));
    }
    let Some((executor_name, executor_namespace)) = connected_executor_binding(subtasks) else {
        return Ok(None);
    };
    let executor_payload = get_executor_payload(state, &executor_name, &executor_namespace).await?;
    let Some(payload) = executor_payload else {
        return Ok(None);
    };
    let status = payload
        .status
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let base_url = payload.base_url.as_deref();
    let Some(base_url) = base_url.filter(|base_url| !base_url.is_empty()) else {
        return Ok(None);
    };
    if !status.is_empty() && status != "success" {
        return Ok(None);
    }
    Ok(Some(base_url.trim_end_matches('/').to_string()))
}

/// `RemoteWorkspaceService._get_executor_payload`: GET
/// `{executor-manager}/executor/address?executor_name=...&executor_namespace=...`.
/// Transport failures, non-200 responses, and non-object payloads yield
/// `None`, not an error.
async fn get_executor_payload(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    executor_name: &str,
    executor_namespace: &str,
) -> anyhow::Result<Option<ExecutorPayload>> {
    let endpoint = state.http.executor_address_endpoint()?;
    let response = endpoint
        .get()
        .query(&[
            ("executor_name", executor_name),
            ("executor_namespace", executor_namespace),
        ])
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            warn!(%error, executor_name, "[remote_workspace] executor address query failed");
            return Ok(None);
        }
    };
    if response.status().as_u16() != 200 {
        warn!(
            status = response.status().as_u16(),
            executor_name, "[remote_workspace] executor address query non_200"
        );
        return Ok(None);
    }
    let body = response.bytes().await.ok();
    if body.as_ref().is_some_and(|body| body.is_empty()) {
        warn!(
            executor_name,
            "[remote_workspace] executor address query empty body"
        );
        return Ok(None);
    }
    Ok(body.as_deref().and_then(ExecutorPayload::parse))
}

fn unauthorized() -> StatusError {
    StatusError {
        status: StatusCode::UNAUTHORIZED,
        detail: "Could not validate credentials".to_string(),
    }
}

fn sandbox_available(payload: &Option<ExecutorPayload>) -> bool {
    payload
        .as_ref()
        .is_some_and(ExecutorPayload::sandbox_available)
}

/// `RemoteWorkspaceService._has_executor_binding` via
/// `_get_connected_executor_binding`: the newest subtask with a non-deleted
/// executor binding, else the latest deleted binding.
fn connected_executor_binding(subtasks: &[task_detail::SubtaskRow]) -> Option<(String, String)> {
    let mut latest_deleted: Option<(String, String)> = None;
    for subtask in subtasks.iter().rev() {
        let Some(executor_name) = subtask.executor_name.as_deref() else {
            continue;
        };
        let normalized_name = executor_name.trim();
        if normalized_name.is_empty() {
            continue;
        }
        let normalized_namespace = subtask
            .executor_namespace
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        if !subtask.executor_deleted_at {
            return Some((normalized_name.to_string(), normalized_namespace));
        }
        if latest_deleted.is_none() {
            latest_deleted = Some((normalized_name.to_string(), normalized_namespace));
        }
    }
    latest_deleted
}

fn not_found() -> StatusError {
    StatusError {
        status: StatusCode::NOT_FOUND,
        detail: "Task not found".to_string(),
    }
}

fn internal_error(error: anyhow::Error) -> StatusError {
    warn!(%error, "[remote_workspace] internal error");
    StatusError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: "Internal server error".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sandbox_available(value: &Option<serde_json::Value>) -> bool {
        super::sandbox_available(
            &value
                .as_ref()
                .and_then(|value| ExecutorPayload::parse(&serde_json::to_vec(value).unwrap())),
        )
    }

    #[test]
    fn extracts_bearer_token() {
        assert_eq!(
            extract_authorization_token(Some("Bearer abc")).as_deref(),
            Some("abc")
        );
    }

    #[test]
    fn sandbox_availability_requires_running_status_and_base_url() {
        let payload = json!({"status": "running", "base_url": "http://sandbox"});
        assert!(sandbox_available(&Some(payload.clone())));
        let stopped = json!({"status": "stopped", "base_url": "http://sandbox"});
        assert!(!sandbox_available(&Some(stopped)));
        assert!(!sandbox_available(&None));
    }
}
