use std::sync::{Arc, Mutex};

use crate::config::device::ConnectionConfig;

use super::{HttpError, LocalModelProxyUpstream, StatusCode};

#[derive(Clone)]
pub struct GatewayCredentials {
    snapshot: Arc<Mutex<Option<ConnectionConfig>>>,
    backend_url: String,
    request_url: String,
    user_id: i64,
}

impl GatewayCredentials {
    pub fn new(
        snapshot: Arc<Mutex<Option<ConnectionConfig>>>,
        backend_url: String,
        request_url: String,
        user_id: i64,
    ) -> Self {
        Self {
            snapshot,
            backend_url,
            request_url,
            user_id,
        }
    }

    pub(super) fn matches(&self, upstream: &LocalModelProxyUpstream) -> bool {
        upstream.api_format == "openai-responses"
            && upstream.resolved_request_url() == self.request_url
    }

    pub(super) fn current_token(&self) -> Result<String, HttpError> {
        self.snapshot
            .lock()
            .ok()
            .and_then(|connection| {
                let connection = connection.as_ref()?;
                (connection.authenticated_user_id == Some(self.user_id)
                    && connection.backend_url == self.backend_url
                    && !connection.auth_token.trim().is_empty())
                .then(|| connection.auth_token.clone())
            })
            .ok_or_else(|| HttpError {
                status: StatusCode::UNAUTHORIZED,
                detail: "The model gateway's connected account is no longer available".to_owned(),
            })
    }
}

impl std::fmt::Debug for GatewayCredentials {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GatewayCredentials")
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Bytes, http::HeaderMap, routing::post, Router};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn active_route_uses_rotated_gateway_token_but_never_switches_accounts() {
        let path = "/api/runtime-work/llm-responses-proxy/responses";
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_url = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicUsize::new(0));
        let gateway_calls = Arc::clone(&accepted);
        let gateway = Router::new().route(
            path,
            post(move |headers: HeaderMap| {
                let calls = Arc::clone(&gateway_calls);
                async move {
                    let expected = match calls.fetch_add(1, Ordering::Relaxed) {
                        0 => "Bearer wg-before-rotation",
                        _ => "Bearer wg-after-rotation",
                    };
                    if headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        == Some(expected)
                    {
                        StatusCode::OK
                    } else {
                        StatusCode::UNAUTHORIZED
                    }
                }
            }),
        );
        let server = tokio::spawn(async move { axum::serve(listener, gateway).await.unwrap() });
        let snapshot = Arc::new(Mutex::new(Some(ConnectionConfig {
            authenticated_user_id: Some(7),
            backend_url: backend_url.clone(),
            auth_token: "wg-before-rotation".to_owned(),
            ..Default::default()
        })));
        let request_url = format!("{backend_url}{path}");
        let upstream = super::super::upstream_from_model_config(&json!({
            "base_url": backend_url,
            "request_url": request_url,
            "api_key": "short-lived-session",
            "proxy_url": "http://127.0.0.1:1",
        }))
        .unwrap()
        .unwrap();
        let token = super::super::register("cloud-gateway-rotation-test", upstream);
        assert!(!super::super::bind_gateway_credentials(
            &token,
            GatewayCredentials::new(
                Arc::clone(&snapshot),
                backend_url.clone(),
                "https://example.invalid/responses".to_owned(),
                7,
            ),
        ));
        assert!(super::super::bind_gateway_credentials(
            &token,
            GatewayCredentials::new(Arc::clone(&snapshot), backend_url, request_url, 7),
        ));
        let send = |thread: &str| {
            super::super::handlers::handle_for_token(
                token.clone(),
                HeaderMap::new(),
                Bytes::from(
                    json!({
                        "model": "m", "input": "hi", "stream": false,
                        "client_metadata": { "thread_id": thread },
                    })
                    .to_string(),
                ),
            )
        };

        let parent = "cloud-gateway-parent";
        let prediction = "cloud-gateway-prediction";
        super::super::bind_thread(&token, parent).unwrap();
        assert_eq!(send(parent).await.unwrap().status(), StatusCode::OK);
        snapshot.lock().unwrap().as_mut().unwrap().auth_token = "wg-after-rotation".to_owned();
        assert_eq!(send(parent).await.unwrap().status(), StatusCode::OK);
        super::super::unregister(&token);
        assert_eq!(
            send(parent).await.unwrap_err().status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            super::super::bind_prediction_thread("unused-prepared-route", parent, prediction)
                .unwrap(),
            token,
        );
        assert_eq!(send(prediction).await.unwrap().status(), StatusCode::OK);
        snapshot
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .authenticated_user_id = Some(8);
        assert_eq!(
            send(prediction).await.unwrap_err().status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(accepted.load(Ordering::Relaxed), 3);

        super::super::unregister(&token);
        server.abort();
    }
}
