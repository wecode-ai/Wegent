// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Source-compatible CORS for ordinary (non-preflight) responses.
//!
//! Starlette's `CORSMiddleware` rewrites an ordinary response only when the
//! request carries an `Origin` header, and it then emits the wildcard
//! permission for `allow_origins=["*"]` unless the request also carries a
//! cookie (`starlette/middleware/cors.py:159-176`). With a cookie it reflects
//! the origin and appends `Vary: Origin` instead.
//!
//! The shared gateway policy (`crate::filters::gateway_cors`) is configured
//! with credentials, so it always varies by origin and reflects it. That
//! matches the source's preflight answer but not its ordinary responses. This
//! filter renders the source's ordinary-response headers itself and marks the
//! response so the boundary policy leaves them untouched.

use std::net::SocketAddr;

use brz_http_server::ResponseCors;
use http::Request;
use http::header::{
    ACCESS_CONTROL_ALLOW_CREDENTIALS, ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS,
    COOKIE, HeaderMap, HeaderValue, ORIGIN, VARY,
};
use hyper::body::Incoming;

use crate::{GatewayResponse, RustApi};

use super::cors::EXPOSED_HEADERS_VALUE;

/// Applies the source's ordinary-response CORS policy to every response of the
/// wrapped Rust API service.
#[derive(Clone)]
pub struct SourceCorsFilter<S> {
    inner: S,
}

impl<S> SourceCorsFilter<S> {
    pub(crate) const fn new(inner: S) -> Self {
        Self { inner }
    }
}

impl<S> RustApi for SourceCorsFilter<S>
where
    S: RustApi,
{
    async fn call(&self, request: Request<Incoming>, peer_addr: SocketAddr) -> GatewayResponse {
        let origin = request.headers().get(ORIGIN).cloned();
        let has_cookie = request.headers().contains_key(COOKIE);
        let mut response = self.inner.call(request, peer_addr).await;
        apply_source_response_cors(&mut response, origin.as_ref(), has_cookie);
        response
    }
}

/// Renders the source's ordinary-response headers and opts the response out of
/// the gateway boundary policy.
///
/// A response that already decided to skip the boundary policy (a protocol
/// switch or an Engine.IO handshake) keeps its own headers untouched.
pub(crate) fn apply_source_response_cors<B>(
    response: &mut http::Response<B>,
    origin: Option<&HeaderValue>,
    has_cookie: bool,
) {
    if response.extensions().get::<ResponseCors>() == Some(&ResponseCors::Skip) {
        return;
    }
    match origin {
        None => {
            // Without an `Origin` the source middleware never runs, so the
            // response keeps no CORS permissions and no origin variance.
            let headers = response.headers_mut();
            headers.remove(ACCESS_CONTROL_ALLOW_ORIGIN);
            headers.remove(ACCESS_CONTROL_ALLOW_CREDENTIALS);
            headers.remove(ACCESS_CONTROL_EXPOSE_HEADERS);
        }
        Some(origin) if has_cookie => {
            let headers = response.headers_mut();
            headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
            add_vary_origin(headers);
            insert_permissions(headers);
        }
        Some(_) => {
            // `allow_all_origins` without a cookie keeps the wildcard.
            let headers = response.headers_mut();
            headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
            insert_permissions(headers);
        }
    }
    response.extensions_mut().insert(ResponseCors::Skip);
}

fn insert_permissions(headers: &mut HeaderMap) {
    headers.insert(
        ACCESS_CONTROL_ALLOW_CREDENTIALS,
        HeaderValue::from_static("true"),
    );
    headers.insert(
        ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSED_HEADERS_VALUE),
    );
}

/// Appends `Origin` to `Vary` unless an existing member already requests that
/// variance, matching the headers the source middleware produces.
fn add_vary_origin(headers: &mut HeaderMap) {
    let already_present = headers.get_all(VARY).iter().any(|value| {
        value.to_str().is_ok_and(|value| {
            value
                .split(',')
                .map(str::trim)
                .any(|token| token.eq_ignore_ascii_case("origin"))
        })
    });
    if !already_present {
        headers.append(VARY, HeaderValue::from_static("Origin"));
    }
}

#[cfg(test)]
mod tests {
    use http::Response;

    use super::*;

    fn response() -> Response<()> {
        Response::new(())
    }

    fn header(response: &Response<()>, name: impl http::header::AsHeaderName) -> Option<&str> {
        response.headers().get(name).and_then(|v| v.to_str().ok())
    }

    #[test]
    fn headerless_requests_keep_no_permissions_and_no_variance() {
        let mut response = response();
        apply_source_response_cors(&mut response, None, false);

        assert_eq!(header(&response, ACCESS_CONTROL_ALLOW_ORIGIN), None);
        assert_eq!(header(&response, ACCESS_CONTROL_ALLOW_CREDENTIALS), None);
        assert_eq!(header(&response, ACCESS_CONTROL_EXPOSE_HEADERS), None);
        assert_eq!(header(&response, VARY), None);
        assert_eq!(
            response.extensions().get::<ResponseCors>(),
            Some(&ResponseCors::Skip)
        );
    }

    #[test]
    fn cookie_less_cross_origin_responses_keep_the_wildcard_permission() {
        let mut response = response();
        apply_source_response_cors(
            &mut response,
            Some(&HeaderValue::from_static("http://127.0.0.1:49675")),
            false,
        );

        assert_eq!(header(&response, ACCESS_CONTROL_ALLOW_ORIGIN), Some("*"));
        assert_eq!(
            header(&response, ACCESS_CONTROL_ALLOW_CREDENTIALS),
            Some("true")
        );
        assert_eq!(
            header(&response, ACCESS_CONTROL_EXPOSE_HEADERS),
            Some("Content-Disposition, X-Request-ID")
        );
        assert_eq!(header(&response, VARY), None);
    }

    #[test]
    fn cookie_carrying_requests_reflect_the_origin_and_vary() {
        let mut response = response();
        apply_source_response_cors(
            &mut response,
            Some(&HeaderValue::from_static("https://wegent.example")),
            true,
        );

        assert_eq!(
            header(&response, ACCESS_CONTROL_ALLOW_ORIGIN),
            Some("https://wegent.example")
        );
        assert_eq!(header(&response, VARY), Some("Origin"));
    }

    #[test]
    fn existing_origin_variance_is_not_duplicated() {
        let mut response = response();
        response
            .headers_mut()
            .insert(VARY, HeaderValue::from_static("Accept-Encoding, Origin"));
        apply_source_response_cors(
            &mut response,
            Some(&HeaderValue::from_static("https://wegent.example")),
            true,
        );

        assert_eq!(header(&response, VARY), Some("Accept-Encoding, Origin"));
    }

    #[test]
    fn an_explicit_skip_keeps_the_protocol_switch_headers() {
        let mut response = response();
        response.extensions_mut().insert(ResponseCors::Skip);
        response
            .headers_mut()
            .insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));

        apply_source_response_cors(&mut response, None, false);

        assert_eq!(header(&response, ACCESS_CONTROL_ALLOW_ORIGIN), Some("*"));
    }
}

#[cfg(test)]
mod boundary_tests {
    use std::future::Future;
    use std::time::Duration;

    use brz_http_server::{Handler, NoAuthenticator, Request, Response, StatusCode};
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;
    use crate::filters::{RequestIdFilter, gateway_cors};

    struct Probe;

    impl Handler for Probe {
        fn call<'a>(
            &'a self,
            _request: Request<'a>,
            _authenticator: &'a NoAuthenticator,
        ) -> impl Future<Output = Response> + Send + 'a {
            std::future::ready(
                Response::owned_bytes(StatusCode::OK, b"{}".as_slice())
                    .content_type("application/json"),
            )
        }
    }

    /// Sends one request through the real Rust origin listener, the response-CORS
    /// exporter and the public gateway with the production CORS policy.
    async fn serve(request: &str) -> String {
        let server = brz_http_server::Server::bind_with_config(
            "127.0.0.1:0".parse().unwrap(),
            Probe,
            crate::filters::server_config(),
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
        let api = brz_http_gateway::OriginService::new(&origin)
            .unwrap()
            .with_response_cors();
        let gateway = brz_http_gateway::Gateway::new(
            routes,
            RequestIdFilter::new(SourceCorsFilter::new(api)),
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
    async fn headerless_responses_gain_no_origin_variance_at_the_boundary() {
        let raw = serve(
            "GET /api/v1/resources HTTP/1.1\r\n\
             Host: localhost\r\n\
             Connection: close\r\n\r\n",
        )
        .await;

        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(header_of(&raw, "access-control-allow-origin:"), "");
        assert_eq!(header_of(&raw, "access-control-allow-credentials:"), "");
        assert_eq!(header_of(&raw, "vary:"), "");
    }

    #[tokio::test]
    async fn cookie_less_origin_requests_keep_the_source_wildcard() {
        let raw = serve(
            "GET /api/v1/resources HTTP/1.1\r\n\
             Host: localhost\r\n\
             Origin: http://127.0.0.1:49675\r\n\
             Connection: close\r\n\r\n",
        )
        .await;

        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(header_of(&raw, "access-control-allow-origin:"), "*");
        assert_eq!(header_of(&raw, "access-control-allow-credentials:"), "true");
        assert_eq!(
            header_of(&raw, "access-control-expose-headers:"),
            "Content-Disposition, X-Request-ID"
        );
        assert_eq!(header_of(&raw, "vary:"), "");
    }

    #[tokio::test]
    async fn cookie_bearing_origin_requests_reflect_and_vary() {
        let raw = serve(
            "GET /api/v1/resources HTTP/1.1\r\n\
             Host: localhost\r\n\
             Origin: https://app.example.test\r\n\
             Cookie: auth_token=abc\r\n\
             Connection: close\r\n\r\n",
        )
        .await;

        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(
            header_of(&raw, "access-control-allow-origin:"),
            "https://app.example.test"
        );
        assert_eq!(header_of(&raw, "vary:"), "Origin");
    }
}
