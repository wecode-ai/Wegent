// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::OnceLock;
use std::time::Duration;

use brz_http_server::{Response, StatusCode};
use serde_json::{Map, Value};

use super::{CreateLoopIssue, FastApiError, SessionUser, create_loop_issue, invalid};
use crate::{auth, state::AppState};

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
    issue: Map<String, Value>,
    authorization: Option<&str>,
    api_key: Option<&str>,
    trace_id: Option<&str>,
) -> Result<Response, FastApiError> {
    let client = board_issue_client()?;
    let upstream = std::env::var("WEGENT_PYTHON_UPSTREAM_URL")
        .unwrap_or_else(|_| wegent_backend_config::DEFAULT_PYTHON_UPSTREAM.to_owned());
    let project_path = format!("/api/v1/cloud-projects/{project_id}/loop-items");
    let url = format!("{}{project_path}", upstream.trim_end_matches('/'));
    let mut request = client.as_reqwest().post(url).json(&issue);
    for (name, value) in [
        ("authorization", authorization),
        ("x-api-key", api_key),
        ("x-request-id", trace_id),
    ] {
        if let Some(value) = value {
            request = request.header(name, value);
        }
    }
    let response = request.send().await.map_err(|_| upstream_error())?;
    let status = response.status();
    let bearer_challenge = response
        .headers()
        .get("www-authenticate")
        .is_some_and(|header| header == "Bearer");
    let body = response.bytes().await.map_err(|_| upstream_error())?;
    let mut response = Response::owned_bytes(status, body).content_type("application/json");
    if bearer_challenge {
        response = response.www_authenticate("Bearer");
    }
    Ok(response)
}

fn board_issue_client() -> Result<&'static brz_http::Client, FastApiError> {
    const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
    static CLIENT: OnceLock<Result<brz_http::Client, brz_http::reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            brz_http::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                // The default socket read deadline is shorter than a project Issue transaction.
                .read_timeout(REQUEST_TIMEOUT)
                .configure(|builder| {
                    builder
                        .no_proxy()
                        .redirect(brz_http::reqwest::redirect::Policy::none())
                        .retry(brz_http::reqwest::retry::never())
                })
                .build()
        })
        .as_ref()
        .map_err(|_| upstream_error())
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
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn board_issue_client_reads_a_response_after_the_default_read_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let provider = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut line = String::new();
            loop {
                line.clear();
                assert_ne!(stream.read_line(&mut line).await.unwrap(), 0);
                if line == "\r\n" {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(600)).await;
            stream
                .get_mut()
                .write_all(b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\n{}")
                .await
                .unwrap();
        });

        let response = board_issue_client()
            .ok()
            .expect("project Issue client")
            .as_reqwest()
            .post(format!("http://{address}"))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"{}");
        provider.await.unwrap();
    }
}
