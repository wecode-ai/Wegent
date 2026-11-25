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
    static CLIENT: OnceLock<Result<brz_http::Client, brz_http::reqwest::Error>> = OnceLock::new();
    let client = CLIENT.get_or_init(|| {
        brz_http::Client::builder()
            .timeout(Duration::from_secs(60))
            .read_timeout(Duration::from_secs(60))
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
    use super::*;
    use http_body_util::{BodyExt, Full};
    use hyper::{body::Bytes, service::service_fn};
    use serde_json::json;
    use std::{
        convert::Infallible,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };
    use tokio::{net::TcpListener, sync::oneshot};

    #[tokio::test]
    async fn project_issue_create_awaits_provider_response_beyond_default_read_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let received = requests.clone();
        let (stop, shutdown) = oneshot::channel();
        let server = tokio::spawn(brz_http_server::hyper::serve(
            listener,
            move |_| {
                let received = received.clone();
                service_fn(move |request: http::Request<hyper::body::Incoming>| {
                    let received = received.clone();
                    async move {
                        received.fetch_add(1, Ordering::Relaxed);
                        assert_eq!(request.method(), http::Method::POST);
                        assert_eq!(request.uri().path(), "/api/v1/cloud-projects/42/loop-items");
                        assert_eq!(request.headers()["authorization"], "Bearer test-session");
                        assert_eq!(request.headers()["x-api-key"], "test-task-key");
                        assert_eq!(request.headers()["x-request-id"], "test-trace");
                        let body = request.into_body().collect().await.unwrap().to_bytes();
                        assert_eq!(
                            serde_json::from_slice::<Value>(&body).unwrap(),
                            json!({"title": "New Issue"})
                        );

                        // The board provider must be allowed to finish a write after
                        // the generic client's 400 ms per-read deadline.
                        tokio::time::sleep(
                            brz_http::DEFAULT_READ_TIMEOUT + Duration::from_millis(100),
                        )
                        .await;
                        Ok::<_, Infallible>(
                            http::Response::builder()
                                .status(StatusCode::CREATED)
                                .header("content-type", "application/json")
                                .body(Full::new(Bytes::from_static(br#"{"id":"created"}"#)))
                                .unwrap(),
                        )
                    }
                })
            },
            async {
                let _ = shutdown.await;
            },
            brz_http_server::hyper::Config {
                shutdown_grace: Duration::ZERO,
                ..Default::default()
            },
        ));

        let response = tokio::time::timeout(
            Duration::from_secs(5),
            create_board_issue(
                &format!("http://{address}"),
                42,
                json!({"title": "New Issue"}).as_object().unwrap().clone(),
                Some("Bearer test-session"),
                Some("test-task-key"),
                Some("test-trace"),
            ),
        )
        .await;
        let _ = stop.send(());
        server.await.unwrap().unwrap();

        let response = response.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let brz_http_server::ResponseBody::Owned(body) = response.body() else {
            panic!("expected the provider's response body");
        };
        assert_eq!(
            serde_json::from_slice::<Value>(body).unwrap(),
            json!({"id": "created"})
        );
        assert_eq!(requests.load(Ordering::Relaxed), 1);
    }
}
