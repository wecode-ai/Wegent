// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/plugins/marketplace` handler (source
//! `app/api/endpoints/marketplace.py` + `PluginMarketplaceService`).
use brz_http_server::HttpResponse;
use serde_json::json;

use super::models::MarketplaceListResponse;
use super::{MarketplaceQuery, auth, list_plugins};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// GET /api/plugins/marketplace: the marketplace free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/plugins/marketplace", access = optional)]
async fn get_marketplace_plugins(
    #[inject(state)] state: &AppState,
    #[auth] user: Option<auth::MarketplaceUser>,
    #[header("x-request-id")] request_id: Option<&str>,
    query: brz_http_server::Query<MarketplaceQuery>,
) -> Result<HttpResponse<MarketplaceListResponse>, FastApiError> {
    marketplace(state, user.as_ref(), request_id, &query).await
}

/// Handler body for `GET /api/plugins/marketplace`.
///
/// The source declares `response_model=PluginMarketplaceListResponse`, so
/// FastAPI renders the model as `application/json`; returning the serializable
/// view keeps that content type instead of the raw-bytes
/// `application/octet-stream` default.
async fn marketplace(
    state: &AppState,
    user: Option<&auth::MarketplaceUser>,
    request_id: Option<&str>,
    query: &MarketplaceQuery,
) -> Result<HttpResponse<MarketplaceListResponse>, FastApiError> {
    match list_plugins(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        user.map(|user| &user.0),
        query,
    )
    .await
    {
        Ok(response) => {
            let reply = HttpResponse::new(response);
            let reply = match request_id {
                Some(request_id) => reply.header("x-request-id", request_id).map_err(|error| {
                    FastApiError::detail(
                        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                        error.to_string(),
                    )
                })?,
                None => reply,
            };
            Ok(reply)
        }
        Err(error) => {
            tracing::error!(%error, "marketplace listing failed");
            Err(internal_error())
        }
    }
}

/// Source `python_exception_handler` 500 response shape.
fn internal_error() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error_code": 500, "detail": "Internal server error"}).to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated test group (separate from the crate's real `http_apis`
    // group) so the probe's `/api/plugins/marketplace` route does not collide
    // with the real handler's registration.
    mod probe {
        brz_http_server::registry!(group = marketplace_probe, dependencies());
    }

    /// Renders the marketplace success value through the route macro over a
    /// real socket. The source declares
    /// `response_model=PluginMarketplaceListResponse`, so the response must
    /// answer `application/json`; returning raw `Binary` bytes would answer
    /// `application/octet-stream`.
    #[brz_http_server::get(
        "/api/plugins/marketplace",
        group = probe::marketplace_probe,
        access = public
    )]
    async fn marketplace_probe() -> Result<HttpResponse<MarketplaceListResponse>, FastApiError> {
        Ok(HttpResponse::new(MarketplaceListResponse {
            items: Vec::new(),
        }))
    }

    async fn serve_marketplace() -> String {
        let handler =
            brz_http_server::handlers!(; group = probe::marketplace_probe).expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client
            .write_all(
                b"GET /api/plugins/marketplace HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("send request");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read response");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    #[tokio::test]
    async fn marketplace_answers_application_json() {
        let raw = serve_marketplace().await;
        assert!(raw.starts_with("HTTP/1.1 200"), "{raw}");
        let content_type = raw
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("content-type:"))
            .expect("content-type header");
        assert_eq!(
            content_type["content-type:".len()..].trim(),
            "application/json",
            "{raw}"
        );
        let body = raw.split_once("\r\n\r\n").map_or("", |(_, body)| body);
        assert_eq!(body, "{\"items\":[]}", "{raw}");
    }
}
