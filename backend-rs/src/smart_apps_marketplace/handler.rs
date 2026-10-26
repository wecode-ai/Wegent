// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/smart-apps/marketplace` handler.
use brz_http_server::{HttpResponse, StatusCode};

use super::models::SmartAppMarketplaceListResponse;
use super::service::{ListError, MarketplaceQuery, list_marketplace};
use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::smart_apps_download::artifact;
use crate::state::AppState;

/// `list_marketplace` (`app/api/endpoints/smart_apps.py`): required session
/// authentication, optional `q`/`source`/`tag` filters, then the service's
/// catalog.
#[brz_http_server::get("/api/smart-apps/marketplace")]
async fn list_smart_apps_marketplace(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<MarketplaceQuery>,
) -> Result<HttpResponse<SmartAppMarketplaceListResponse>, FastApiError> {
    match list_marketplace(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        i64::from(user.id),
        &query,
    )
    .await
    {
        // `response_model=SmartAppMarketplaceListResponse` renders as JSON;
        // the serializable view keeps that content type.
        Ok(response) => Ok(HttpResponse::new(response)),
        Err(ListError::NotFound(detail)) => {
            Err(FastApiError::detail(StatusCode::NOT_FOUND, detail))
        }
        Err(ListError::Dependency) => Err(FastApiError::unhandled()),
        Err(ListError::Storage) => Err(artifact::storage_unavailable()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated test group (separate from the crate's real `http_apis`
    // group) so the probe's route does not collide with the real handler.
    mod probe {
        brz_http_server::registry!(group = smart_app_marketplace_probe, dependencies());
    }

    /// Renders the catalog through the route macro over a real socket. The
    /// source declares `response_model=SmartAppMarketplaceListResponse`, so
    /// the response must answer `application/json` with `{"items":[...]}`.
    #[brz_http_server::get(
        "/api/smart-apps/marketplace",
        group = probe::smart_app_marketplace_probe,
        access = public
    )]
    async fn marketplace_probe()
    -> Result<HttpResponse<SmartAppMarketplaceListResponse>, FastApiError> {
        Ok(HttpResponse::new(SmartAppMarketplaceListResponse {
            items: Vec::new(),
        }))
    }

    async fn serve_probe() -> String {
        let handler = brz_http_server::handlers!(; group = probe::smart_app_marketplace_probe)
            .expect("probe router");
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
                b"GET /api/smart-apps/marketplace HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("send request");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read response");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    #[tokio::test]
    async fn catalog_answers_application_json() {
        let raw = serve_probe().await;
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

    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/smart-apps/marketplace";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;

        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(!table.matches(&http::Method::GET, PATH));
        assert!(!table.matches(&http::Method::POST, PATH));

        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
