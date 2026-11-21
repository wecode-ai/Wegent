// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/services/health` — the internal service health probe
//! (`app.api.endpoints.internal.services.health_check`).
//!
//! The source route (`app/api/endpoints/internal/services.py:67`) declares only
//! `GET`, so FastAPI rejects every other method before the handler or any
//! router dependency runs: `405 {"detail":"Method Not Allowed"}` with
//! `Allow: GET`. The recorded group exercises `POST` against this GET-only
//! route, so the target owns that recorded method and reproduces the source
//! framework response. The `GET` health body itself is not part of the recorded
//! group and stays on the Python fallback.

use brz_http_server::{Response, StatusCode};

/// The source framework's `405` body for the GET-only health route.
const METHOD_NOT_ALLOWED_BODY: &[u8] = br#"{"detail":"Method Not Allowed"}"#;

/// POST /api/internal/services/health: reproduce the source framework's
/// method mismatch for the GET-only health route.
#[brz_http_server::post("/api/internal/services/health", access = public)]
async fn health_post_method_not_allowed(#[header("origin")] origin: Option<&str>) -> Response {
    health_post_method_not_allowed_response(origin)
}

/// The source framework's `405` response for the health path.
///
/// `Allow` reports the source route's only method (`GET`), not the target
/// router's method set. Starlette's `CORSMiddleware` returns before installing
/// its response wrapper when the request carries no `Origin`, so a headerless
/// request emits neither CORS permissions nor `Vary: Origin`; the gateway
/// boundary varies by origin unconditionally, so that response is rendered
/// outside it. A cross-origin request keeps the configured policy.
fn health_post_method_not_allowed_response(origin: Option<&str>) -> Response {
    let response = Response::static_bytes(StatusCode::METHOD_NOT_ALLOWED, METHOD_NOT_ALLOWED_BODY)
        .content_type("application/json")
        .allow("GET");
    if origin.is_some() {
        response
    } else {
        response.without_cors()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::ResponseCors;

    fn body_bytes(response: &Response) -> &[u8] {
        match response.body() {
            brz_http_server::ResponseBody::Static(bytes) => bytes,
            other => panic!("unexpected response body: {other:?}"),
        }
    }

    #[test]
    fn response_is_the_source_method_not_allowed_body() {
        let response = health_post_method_not_allowed_response(None);
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body_bytes(&response), METHOD_NOT_ALLOWED_BODY);
    }

    /// The recorded requests carry no `Origin`; Starlette's `CORSMiddleware`
    /// returns before installing its wrapper, so the source emits no
    /// `Vary: Origin`. The gateway boundary varies by origin unconditionally,
    /// so the headerless response must skip it while a cross-origin request
    /// keeps the configured policy.
    #[test]
    fn headerless_responses_skip_gateway_cors() {
        assert_eq!(
            health_post_method_not_allowed_response(None).cors_policy(),
            ResponseCors::Skip
        );
        assert_eq!(
            health_post_method_not_allowed_response(Some("https://app.example")).cors_policy(),
            ResponseCors::Apply
        );
    }

    // A dedicated test group (separate from the crate's real `http_apis`
    // group, whose dependencies need the full application state) so the probe
    // route renders the same error without application state.
    mod probe {
        brz_http_server::registry!(group = internal_services_probe, dependencies());
    }

    #[brz_http_server::post(
        "/api/internal/services/health",
        group = probe::internal_services_probe,
        access = public
    )]
    async fn probe_health_post(#[header("origin")] origin: Option<&str>) -> Response {
        health_post_method_not_allowed_response(origin)
    }

    async fn render_probe(origin: Option<&str>) -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let handler = brz_http_server::handlers!(; group = probe::internal_services_probe)
            .expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = tokio::net::TcpStream::connect(address)
            .await
            .expect("connect");
        let origin = origin.map_or_else(String::new, |origin| format!("Origin: {origin}\r\n"));
        client
            .write_all(
                format!(
                    "POST /api/internal/services/health HTTP/1.1\r\n\
                     Host: localhost\r\n{origin}Connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .expect("send");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    /// Renders the probe through the production gateway boundary
    /// (`hybrid`): the internal origin exports the response-local CORS
    /// decision, and the public gateway applies the configured policy.
    async fn render_through_gateway(origin: Option<&str>) -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let handler = brz_http_server::handlers!(; group = probe::internal_services_probe)
            .expect("probe router");
        let server = brz_http_server::Server::bind_with_config(
            "127.0.0.1:0".parse().unwrap(),
            handler,
            crate::filters::server_config(),
        )
        .await
        .expect("bind origin");
        let origin_address = server.local_addr().expect("local address");
        let inner = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let api_origin = format!("http://{origin_address}").parse().unwrap();
        let routes = brz_http_gateway::RouteTable::compile(
            toml::from_str::<brz_http_gateway::RoutesConfig>(
                "[[routes]]\nmethods = [\"POST\"]\npath = \"/api/internal/*path\"",
            )
            .unwrap(),
        )
        .unwrap();
        let gateway = brz_http_gateway::Gateway::new(
            routes,
            brz_http_gateway::OriginService::new(&api_origin)
                .unwrap()
                .with_response_cors(),
            &"http://127.0.0.1:1".parse().unwrap(),
        )
        .unwrap()
        .with_cors(crate::filters::gateway_cors())
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let outer = tokio::spawn(brz_http_gateway::serve(
            listener,
            gateway,
            std::future::pending(),
            std::time::Duration::from_secs(1),
        ));
        let mut client = tokio::net::TcpStream::connect(address)
            .await
            .expect("connect");
        let origin = origin.map_or_else(String::new, |origin| format!("Origin: {origin}\r\n"));
        client
            .write_all(
                format!(
                    "POST /api/internal/services/health HTTP/1.1\r\n\
                     Host: localhost\r\n{origin}Connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .expect("send");
        let mut raw = Vec::new();
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            client.read_to_end(&mut raw),
        )
        .await
        .expect("response deadline")
        .expect("read");
        outer.abort();
        inner.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    #[tokio::test]
    async fn renders_405_with_allow_get_over_http() {
        let raw = render_probe(None).await;
        assert!(raw.starts_with("HTTP/1.1 405"), "{raw}");
        assert!(raw.contains("Allow: GET"), "{raw}");
        assert!(raw.contains("Content-Type: application/json"), "{raw}");
        assert!(raw.contains(r#"{"detail":"Method Not Allowed"}"#), "{raw}");
    }

    /// The recorded case has no `Origin` header. Starlette returns before
    /// installing its CORS response wrapper, so the source emits no
    /// `Vary: Origin`; the gateway boundary must not add one either.
    #[tokio::test]
    async fn headerless_gateway_response_has_no_vary_header() {
        let raw = render_through_gateway(None).await;
        assert!(raw.starts_with("HTTP/1.1 405"), "{raw}");
        assert!(raw.to_ascii_lowercase().contains("allow: get"), "{raw}");
        assert!(!raw.to_ascii_lowercase().contains("vary:"), "{raw}");
    }

    /// A cross-origin request keeps the configured source-CORS policy, which
    /// reflects the origin and varies by it.
    #[tokio::test]
    async fn cross_origin_gateway_response_keeps_the_source_cors_policy() {
        let raw = render_through_gateway(Some("https://app.example")).await;
        assert!(raw.starts_with("HTTP/1.1 405"), "{raw}");
        let lowered = raw.to_ascii_lowercase();
        assert!(
            lowered.contains("access-control-allow-origin: https://app.example"),
            "{raw}"
        );
        assert!(lowered.contains("vary: origin"), "{raw}");
    }

    /// The recorded `POST` method is selected for the Rust listener and its
    /// handler is registered by the shared router.
    #[test]
    fn recorded_post_method_is_rust_owned() {
        let table = crate::app_test_support::cutover_route_table(&[(
            "/api/internal/services/health",
            &["POST"],
        )]);
        assert!(table.matches(&http::Method::POST, "/api/internal/services/health"));
        // The source `GET` health body is not part of the recorded group.
        assert!(!table.matches(&http::Method::GET, "/api/internal/services/health"));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == "/api/internal/services/health" && route.methods & POST != 0);
        assert!(
            registered,
            "POST /api/internal/services/health must be registered by the router"
        );
    }
}
