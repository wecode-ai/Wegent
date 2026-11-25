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
        let upstream = std::env::var("WEGENT_PYTHON_UPSTREAM_URL")
            .unwrap_or_else(|_| wegent_backend_config::DEFAULT_PYTHON_UPSTREAM.to_owned());
        return create_board_issue(
            &upstream,
            project_id,
            body.issue,
            authorization,
            api_key,
            trace_id,
        )
        .await;
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
    upstream: &str,
    project_id: i64,
    issue: Map<String, Value>,
    authorization: Option<&str>,
    api_key: Option<&str>,
    trace_id: Option<&str>,
) -> Result<Response, FastApiError> {
    const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
    static CLIENT: OnceLock<Result<brz_http::Client, brz_http::reqwest::Error>> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        brz_http::Client::builder()
            .timeout(PROVIDER_REQUEST_TIMEOUT)
            // Breeze's default read timeout is 400ms, shorter than the provider request budget.
            .read_timeout(PROVIDER_REQUEST_TIMEOUT)
            .configure(|builder| {
                builder
                    .no_proxy()
                    .redirect(brz_http::reqwest::redirect::Policy::none())
                    .retry(brz_http::reqwest::retry::never())
            })
            .build()
    });
    let client = client.as_ref().map_err(|_| upstream_error())?;
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

fn upstream_error() -> FastApiError {
    FastApiError::detail(
        StatusCode::BAD_GATEWAY,
        "Unable to reach the project Issue provider",
    )
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use http_body_util::{BodyExt, Full};
    use hyper::{
        body::{Bytes, Incoming},
        service::service_fn,
    };
    use serde_json::json;
    use tokio::net::TcpListener;

    use super::*;

    #[tokio::test]
    async fn board_issue_waits_for_slow_provider_without_retrying_creation() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let received_calls = calls.clone();
        let server = tokio::spawn(brz_http_server::hyper::serve(
            listener,
            move |_| {
                let calls = received_calls.clone();
                service_fn(move |request: http::Request<Incoming>| {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        assert_eq!(request.method(), http::Method::POST);
                        assert_eq!(
                            request.uri().path(),
                            "/api/v1/cloud-projects/1001/loop-items"
                        );
                        assert_eq!(request.headers()["authorization"], "Bearer fixture-token");
                        assert_eq!(request.headers()["x-request-id"], "fixture-trace");
                        let body = request.into_body().collect().await.unwrap().to_bytes();
                        assert_eq!(
                            serde_json::from_slice::<Value>(&body).unwrap(),
                            json!({"title": "Slow Issue"})
                        );
                        // The provider responds after Breeze's default socket read deadline.
                        tokio::time::sleep(
                            brz_http::DEFAULT_READ_TIMEOUT + Duration::from_millis(100),
                        )
                        .await;
                        Ok::<_, Infallible>(
                            http::Response::builder()
                                .status(StatusCode::CREATED)
                                .body(Full::new(Bytes::from_static(br#"{"id":"created-issue"}"#)))
                                .unwrap(),
                        )
                    }
                })
            },
            std::future::pending(),
            Default::default(),
        ));

        let issue = json!({"title": "Slow Issue"}).as_object().unwrap().clone();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            create_board_issue(
                &upstream,
                1001,
                issue,
                Some("Bearer fixture-token"),
                None,
                Some("fixture-trace"),
            ),
        )
        .await;
        server.abort();
        let response = result
            .expect("The test provider must respond promptly")
            .expect("The provider must complete within the configured request deadline");
        assert_eq!(response.status(), StatusCode::CREATED);
        let brz_http_server::ResponseBody::Owned(body) = response.body() else {
            panic!("Expected the provider's response body");
        };
        assert_eq!(
            serde_json::from_slice::<Value>(body).unwrap(),
            json!({"id": "created-issue"})
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
