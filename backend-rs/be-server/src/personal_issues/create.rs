// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::OnceLock;
use std::time::Duration;

use brz_http_server::{Response, StatusCode};
use serde_json::{Map, Value, json};

use super::{CreateLoopIssue, FastApiError, SessionUser, create_loop_issue, invalid};
use crate::{auth, state::AppState};

const PROJECT_ISSUE_MAX_ATTEMPTS: usize = 3;

#[brz_http_server::post("/api/v1/loop-items", access = public)]
async fn create(
    #[inject(state)] state: &AppState,
    #[header("authorization")] authorization: Option<&str>,
    #[header("x-api-key")] api_key: Option<&str>,
    #[header("x-request-id")] trace_id: Option<&str>,
    body: CreateLoopIssue<Map<String, Value>>,
) -> Result<Response, FastApiError> {
    if let Some(project_id) = &body.project_id
        && body.request_id.is_none()
        && body.project_status.is_none()
    {
        let project_id = crate::cloud_projects::parse_project_id(project_id)?;
        return create_board_issue(project_id, body.issue, authorization, api_key, trace_id).await;
    }

    let user = auth::get_current_user(&state.auth, &state.mysql, authorization)
        .await
        .map_err(auth::session_auth_error)?;
    let issue = serde_json::from_value(Value::Object(body.issue))
        .map_err(|error| invalid(&error.to_string()))?;
    let created = create_loop_issue(
        state,
        SessionUser(user),
        CreateLoopIssue {
            issue,
            project_id: body.project_id,
            project_status: body.project_status,
            request_id: body.request_id,
        },
    )
    .await?;
    Ok(Response::owned_bytes(
        StatusCode::CREATED,
        serde_json::to_vec(&created).map_err(|_| FastApiError::internal())?,
    )
    .content_type("application/json"))
}

// Project providers still own board automation, external issue creation and
// support for task tokens. Forward the original credentials to that owner.
async fn create_board_issue(
    project_id: i64,
    mut issue: Map<String, Value>,
    authorization: Option<&str>,
    api_key: Option<&str>,
    trace_id: Option<&str>,
) -> Result<Response, FastApiError> {
    static CLIENT: OnceLock<Result<brz_http::Client, brz_http::reqwest::Error>> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        brz_http::Client::builder()
            .timeout(Duration::from_secs(60))
            .configure(|builder| {
                builder
                    .no_proxy()
                    .redirect(brz_http::reqwest::redirect::Policy::none())
                    .retry(brz_http::reqwest::retry::never())
            })
            .build()
    });
    let client = client.as_ref().map_err(|_| upstream_error())?;
    let upstream = std::env::var("WEGENT_PYTHON_UPSTREAM_URL")
        .unwrap_or_else(|_| wegent_backend_config::DEFAULT_PYTHON_UPSTREAM.to_owned());
    let project_path = format!("/api/v1/cloud-projects/{project_id}/loop-items");
    let url = format!("{}{project_path}", upstream.trim_end_matches('/'));
    let request_id = ensure_project_issue_request_id(&mut issue);
    let (status, body, bearer_challenge) =
        request_project_issue(client, &url, &issue, authorization, api_key, trace_id)
            .await
            .map_err(|error| {
                tracing::warn!(
                    project_id,
                    request_id,
                    %error,
                    "project Issue upstream request failed"
                );
                upstream_error()
            })?;
    let mut response = Response::owned_bytes(status, body).content_type("application/json");
    if bearer_challenge {
        response = response.www_authenticate("Bearer");
    }
    Ok(response)
}

async fn request_project_issue(
    client: &brz_http::Client,
    url: &str,
    issue: &Map<String, Value>,
    authorization: Option<&str>,
    api_key: Option<&str>,
    trace_id: Option<&str>,
) -> Result<(StatusCode, Vec<u8>, bool), brz_http::reqwest::Error> {
    let mut last_error = None;
    for attempt in 0..PROJECT_ISSUE_MAX_ATTEMPTS {
        let mut request = client.as_reqwest().post(url).json(issue);
        for (name, value) in [
            ("authorization", authorization),
            ("x-api-key", api_key),
            ("x-request-id", trace_id),
        ] {
            if let Some(value) = value {
                request = request.header(name, value);
            }
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) if retryable_project_issue_error(&error, attempt) => {
                tracing::warn!(
                    attempt,
                    %error,
                    "project Issue upstream request failed; retrying idempotent create"
                );
                last_error = Some(error);
                tokio::time::sleep(project_issue_retry_delay(attempt)).await;
                continue;
            }
            Err(error) => return Err(error),
        };
        let status = response.status();
        let bearer_challenge = response
            .headers()
            .get("www-authenticate")
            .is_some_and(|header| header == "Bearer");
        match response.bytes().await {
            Ok(body) => return Ok((status, body.to_vec(), bearer_challenge)),
            Err(error) if retryable_project_issue_error(&error, attempt) => {
                tracing::warn!(
                    attempt,
                    %error,
                    "project Issue upstream response failed; retrying idempotent create"
                );
                last_error = Some(error);
                tokio::time::sleep(project_issue_retry_delay(attempt)).await;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.expect("project Issue retry loop records its final error"))
}

fn retryable_project_issue_error(error: &brz_http::reqwest::Error, attempt: usize) -> bool {
    attempt + 1 < PROJECT_ISSUE_MAX_ATTEMPTS
        && (error.is_connect() || error.is_timeout() || error.is_body() || error.is_decode())
}

fn project_issue_retry_delay(attempt: usize) -> Duration {
    Duration::from_millis(75 * (attempt as u64 + 1))
}

fn project_issue_request_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_ok() {
        return bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    }
    format!("project-issue-{}", chrono::Utc::now().timestamp_millis())
}

fn ensure_project_issue_request_id(issue: &mut Map<String, Value>) -> String {
    issue
        .entry("request_id".to_owned())
        .or_insert_with(|| json!(project_issue_request_id()));
    issue
        .get("request_id")
        .and_then(Value::as_str)
        .unwrap_or("<provided>")
        .to_owned()
}

fn upstream_error() -> FastApiError {
    FastApiError::detail(
        StatusCode::BAD_GATEWAY,
        "Unable to reach the project Issue provider",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_issue_retry_keeps_one_request_id() {
        let mut issue = Map::new();
        let first = ensure_project_issue_request_id(&mut issue);
        let second = ensure_project_issue_request_id(&mut issue);
        assert_eq!(first, second);
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn project_issue_preserves_a_caller_request_id() {
        let mut issue = Map::new();
        issue.insert("request_id".to_owned(), json!("caller-request"));
        assert_eq!(
            ensure_project_issue_request_id(&mut issue),
            "caller-request"
        );
    }
}
