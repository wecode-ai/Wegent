// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Source-compatible CORS policy for the public hybrid gateway.

use std::time::Duration;

const EXPOSED_HEADERS: [&str; 2] = ["Content-Disposition", "X-Request-ID"];

/// Whole-request deadline for the exported Rust origin (request read plus
/// handler invocation, and each inactive response-write gap).
///
/// The Python source this gateway replaces is served by `uvicorn app.main:app`
/// (`backend/start.sh`), which sets no per-request handler deadline and no
/// worker timeout, so a source handler runs to completion however long it
/// takes. `DB_POOL_TIMEOUT` (30s) only bounds SQLAlchemy pool acquisition,
/// not request duration. Legitimate requests make hundreds of sequential
/// MySQL round trips (`GET /api/plugins/installed` resolves one query per
/// coalesced device row), so any horizon near the pool timeout kills requests
/// the deadline-free source serves. The framework default
/// (`brz_http_server::ServerConfig::default()`, 15s) and a previous 30s
/// horizon both did exactly that, answering an empty 408 the source never
/// produces. Chat Shell turns can also remain active for tens of minutes, so
/// size the origin deadline above that horizon while the per-read timeouts
/// still bound stalled streams. Keep a finite one-hour backstop for connection
/// hygiene.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3600);

/// Maximum fixed `Content-Length` request body the origin accepts.
///
/// The Python source's application-level upload cap is
/// `settings.MAX_UPLOAD_FILE_SIZE_MB` (default 100, `app/core/config.py`), and
/// its `uvicorn` server sets no body-size limit of its own; an oversized
/// upload is rejected by the handler with 400, not by the listener. The SDK
/// default (`brz_http_server::ServerConfig::default()`, 8 MiB) is not
/// source-derived and refuses a legitimate ≤100 MB upload with 413 before the
/// handler runs, so keep the listener cap on the source's 100 MB horizon.
const MAX_REQUEST_BODY_BYTES: usize = 100 * 1024 * 1024;

pub(crate) fn gateway_cors() -> brz_http_gateway::Cors {
    let mut cors = brz_http_gateway::Cors::permissive();
    cors.allow_credentials = true;
    cors.expose_headers = EXPOSED_HEADERS.map(str::to_owned).to_vec();
    // Preserve the source middleware's preflight cache policy. The shared
    // policy already adds Origin, request method and request header names;
    // this extra Vary member does not grant Private Network Access.
    cors.extra_preflight_vary = vec!["Access-Control-Request-Private-Network".to_owned()];
    // Starlette expands allow_methods=["*"] to this ordered list, including
    // QUERY. Preserve the source's preflight response independently of which
    // business methods the Rust cutover table selects.
    cors.allow_methods = [
        "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "QUERY",
    ]
    .map(str::to_owned)
    .to_vec();
    cors
}

pub(crate) fn server_config() -> brz_http_server::ServerConfig {
    brz_http_server::ServerConfig {
        request_timeout: REQUEST_TIMEOUT,
        max_request_body_bytes: MAX_REQUEST_BODY_BYTES,
        max_in_flight_request_body_bytes: MAX_REQUEST_BODY_BYTES,
        // This loopback-only listener exports decisions to the public gateway.
        export_cors_policy: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io::Write as _;

    use brz_http_server::{
        Handler, HeaderBlock, IntoHttpError, NoAuthenticator, Request, Response, StatusCode,
    };
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;

    struct Probe;

    impl Handler for Probe {
        fn call<'a>(
            &'a self,
            request: Request<'a>,
            _authenticator: &'a NoAuthenticator,
        ) -> impl Future<Output = Response> + Send + 'a {
            assert_ne!(
                request.method(),
                "OPTIONS",
                "preflight must stop at the gateway"
            );
            let error = match request.path() {
                "/api/unhandled" => Some(crate::http_compat::FastApiError::unhandled()),
                "/api/business" => Some(crate::http_compat::FastApiError::internal()),
                "/api/custom" => Some(crate::http_compat::FastApiError::json_body(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    serde_json::json!({"error_code": 500, "detail": "Internal server error"}),
                )),
                _ => None,
            };
            if let Some(error) = error {
                return std::future::ready(error.into_http_error(request.response_arena()));
            }
            let mut bytes = request.response_bytes(34);
            bytes
                .write_all(b"cache-control: private, no-store\r\n")
                .expect("write response header");
            let headers = HeaderBlock::new(bytes.freeze()).expect("valid response header");
            std::future::ready(
                Response::static_bytes(StatusCode::OK, b"ok")
                    .content_type("text/plain")
                    .headers(headers),
            )
        }
    }

    async fn serve(request: &str) -> String {
        let server = brz_http_server::Server::bind_with_config(
            "127.0.0.1:0".parse().unwrap(),
            Probe,
            server_config(),
        )
        .await
        .expect("bind test server");
        let origin = format!("http://{}", server.local_addr().expect("local address"))
            .parse()
            .unwrap();
        let inner = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let routes = brz_http_gateway::RouteTable::compile(
            toml::from_str::<brz_http_gateway::RoutesConfig>(
                "[[routes]]\nmethods = [\"GET\"]\npath = \"/api/*path\"",
            )
            .unwrap(),
        )
        .unwrap();
        let gateway = brz_http_gateway::Gateway::new(
            routes,
            crate::filters::RequestIdFilter::new(
                brz_http_gateway::OriginService::new(&origin)
                    .unwrap()
                    .with_response_cors(),
            ),
            &"http://127.0.0.1:1".parse().unwrap(),
        )
        .unwrap()
        .with_cors(gateway_cors())
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let outer = tokio::spawn(brz_http_gateway::serve(
            listener,
            gateway,
            std::future::pending(),
            Duration::from_secs(1),
        ));
        let mut client = TcpStream::connect(address).await.expect("connect");
        client.write_all(request.as_bytes()).await.expect("send");
        let mut raw = Vec::new();
        tokio::time::timeout(Duration::from_secs(3), client.read_to_end(&mut raw))
            .await
            .expect("response deadline")
            .expect("read");
        outer.abort();
        inner.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    fn header_of<'a>(raw: &'a str, name: &str) -> &'a str {
        raw.lines()
            .find(|line| line.to_ascii_lowercase().starts_with(name))
            .map_or("", |line| line[name.len()..].trim())
    }

    #[tokio::test]
    async fn adds_fastapi_compatible_headers_and_preserves_handler_headers() {
        let raw = serve(
            "GET /api/devices HTTP/1.1\r\n\
             Host: localhost\r\n\
             Origin: http://127.0.0.1:51577\r\n\
             Connection: close\r\n\r\n",
        )
        .await;

        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(
            header_of(&raw, "access-control-allow-origin:"),
            "http://127.0.0.1:51577"
        );
        assert_eq!(header_of(&raw, "access-control-allow-credentials:"), "true");
        assert_eq!(
            header_of(&raw, "access-control-expose-headers:"),
            "Content-Disposition, X-Request-ID"
        );
        assert_eq!(header_of(&raw, "vary:"), "Origin");
        assert_eq!(header_of(&raw, "cache-control:"), "private, no-store");
    }

    #[tokio::test]
    async fn responses_without_an_origin_vary_without_granting_cors_permissions() {
        let raw = serve(
            "GET /api/devices HTTP/1.1\r\n\
             Host: localhost\r\n\
             Connection: close\r\n\r\n",
        )
        .await;

        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(header_of(&raw, "access-control-allow-origin:"), "");
        assert_eq!(header_of(&raw, "access-control-allow-credentials:"), "");
        assert_eq!(header_of(&raw, "access-control-expose-headers:"), "");
        assert_eq!(header_of(&raw, "vary:"), "Origin");
        assert_eq!(header_of(&raw, "cache-control:"), "private, no-store");
    }

    #[tokio::test]
    async fn answers_preflight_without_an_options_route_or_live_fallback() {
        let raw = serve(
            "OPTIONS /api/apps/installed HTTP/1.1\r\n\
             Host: localhost\r\n\
             Origin: http://127.0.0.1:51577\r\n\
             Access-Control-Request-Method: GET\r\n\
             Access-Control-Request-Headers: authorization, content-type\r\n\
             Connection: close\r\n\r\n",
        )
        .await;

        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(
            header_of(&raw, "access-control-allow-origin:"),
            "http://127.0.0.1:51577"
        );
        assert_eq!(
            header_of(&raw, "access-control-allow-headers:"),
            "authorization, content-type"
        );
        assert_eq!(
            header_of(&raw, "access-control-allow-methods:"),
            "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT, QUERY"
        );
        assert_eq!(header_of(&raw, "access-control-max-age:"), "600");
        assert_eq!(header_of(&raw, "access-control-expose-headers:"), "");
        assert_eq!(
            header_of(&raw, "vary:"),
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network"
        );
        assert_eq!(raw.split_once("\r\n\r\n").unwrap().1, "OK");
    }

    #[test]
    fn request_deadline_covers_long_chat_turns() {
        // The framework default closes a legitimate long-running handler that
        // the deadline-free source would serve; the configured deadline must
        // stay above it and above the pool-acquisition horizon.
        assert_eq!(server_config().request_timeout, REQUEST_TIMEOUT);
        assert!(server_config().export_cors_policy);
        assert_eq!(
            server_config().max_request_body_bytes,
            MAX_REQUEST_BODY_BYTES
        );
        let configured = server_config();
        assert!(
            configured.max_in_flight_request_body_bytes >= configured.max_request_body_bytes,
            "the in-flight budget must admit at least one maximum-size upload"
        );
        assert!(
            server_config().cors.is_none(),
            "the public gateway owns CORS"
        );
        assert!(
            REQUEST_TIMEOUT > Duration::from_secs(30),
            "the configured deadline must exceed the source pool timeout"
        );
        assert!(
            REQUEST_TIMEOUT >= Duration::from_secs(3600),
            "the origin horizon must cover long-running Chat turns"
        );
    }

    #[tokio::test]
    async fn allows_query_preflight_like_the_source() {
        let raw = serve(
            "OPTIONS /api/unknown HTTP/1.1\r\n\
             Host: localhost\r\n\
             Origin: https://app.example\r\n\
             Access-Control-Request-Method: QUERY\r\n\
             Connection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(raw.split_once("\r\n\r\n").unwrap().1, "OK");
    }

    #[tokio::test]
    async fn ordinary_options_keeps_the_route_table_fallback() {
        let raw = serve(
            "OPTIONS /api/apps/installed HTTP/1.1\r\n\
             Host: localhost\r\n\
             Origin: https://app.example\r\n\
             Connection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 502"));
    }

    #[tokio::test]
    async fn unhandled_errors_bypass_cors_across_http_while_business_500_keeps_it() {
        for origin in ["", "Origin: https://app.example\r\n"] {
            for (path, body, skip) in [
                (
                    "/api/unhandled",
                    r#"{"error_code":500,"detail":"Internal server error"}"#,
                    true,
                ),
                (
                    "/api/business",
                    r#"{"detail":"Internal Server Error"}"#,
                    false,
                ),
                (
                    "/api/custom",
                    r#"{"error_code":500,"detail":"Internal server error"}"#,
                    false,
                ),
            ] {
                let raw = serve(&format!(
                    "GET {path} HTTP/1.1\r\nHost: localhost\r\n{origin}Connection: close\r\n\r\n"
                ))
                .await;
                assert!(raw.starts_with("HTTP/1.1 500"));
                assert_eq!(raw.split_once("\r\n\r\n").unwrap().1, body);
                assert_eq!(header_of(&raw, "content-type:"), "application/json");
                assert_eq!(header_of(&raw, "x-breeze-response-cors:"), "");
                let expected_origin = if !skip && !origin.is_empty() {
                    "https://app.example"
                } else {
                    ""
                };
                assert_eq!(
                    header_of(&raw, "access-control-allow-origin:"),
                    expected_origin
                );
                assert_eq!(header_of(&raw, "vary:"), if skip { "" } else { "Origin" });
                if skip {
                    assert_eq!(header_of(&raw, "access-control-allow-credentials:"), "");
                    assert_eq!(header_of(&raw, "access-control-expose-headers:"), "");
                }
            }
        }
    }
}
