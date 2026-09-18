// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! FastAPI's default routing responses for requests the router cannot match.
//!
//! The source service is FastAPI/Starlette: a path that matches no route
//! receives `404 {"detail":"Not Found"}`, and a known path with an
//! unsupported method receives `405 {"detail":"Method Not Allowed"}` plus an
//! `Allow` header (recorded `GET /api/auth/logout` and `GET /api/auth/login`
//! cases of run 20260908120415; no `/auth/logout` route exists in
//! `Wegent/backend/app/api/endpoints/auth.py`, so the framework default
//! renders the response). The platform router's built-in unmatched responses
//! carry empty bodies, so the fully composed router is wrapped once at the
//! listener root and every unmatched request is rendered like the source.
use crate::http_compat::FastApiError;
use brz_http_server::{
    ApiMetrics, Authenticator, Handler, IntoHttpError, Request, Response, StatusCode,
};

/// Standard method bit order shared with the platform router's bitset.
const METHODS: [&str; 7] = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

/// Serves FastAPI's default JSON bodies for requests the inner router cannot
/// dispatch and delegates everything else to it unchanged.
pub struct FastApiFallback<H> {
    inner: H,
}

impl<H> FastApiFallback<H> {
    /// Wraps the fully composed application router served by the listener.
    #[must_use]
    pub fn new(inner: H) -> Self {
        Self { inner }
    }
}

impl<A, H> Handler<A> for FastApiFallback<H>
where
    A: Authenticator,
    H: Handler<A>,
{
    fn register_metrics(&self) {
        self.inner.register_metrics();
    }

    fn route_metrics(&self, path: &str, method: &str) -> Option<(usize, ApiMetrics)> {
        self.inner.route_metrics(path, method)
    }

    async fn call<'a>(&'a self, request: Request<'a>, authenticator: &'a A) -> Response {
        let path = request.path();
        let method = request.method();
        if self.inner.route_priority(path, method).is_some() {
            return self.inner.call(request, authenticator).await;
        }
        let allowed = self.inner.route_methods(path);
        if allowed == 0 {
            return FastApiError::detail(StatusCode::NOT_FOUND, "Not Found")
                .into_http_error(request.response_arena());
        }
        let allow = METHODS
            .into_iter()
            .enumerate()
            .filter(|(index, _)| allowed & (1 << index) != 0)
            .map(|(_, method)| method)
            .collect::<Vec<_>>()
            .join(", ");
        let mut error = FastApiError::detail(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
        error = error.with_header("allow", allow);
        error.into_http_error(request.response_arena())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;

    // A dedicated test group (separate from the crate's real `http_apis`
    // group) so the probe's `/api/startup` route does not collide with the
    // real startup endpoint during the test build.
    mod probe {
        brz_http_server::registry!(group = fallback_probe, dependencies());
    }

    #[brz_http_server::get("/api/startup", group = probe::fallback_probe)]
    async fn startup() -> &'static str {
        "ok"
    }

    /// Drives the wrapped router over a real `http-server` socket so status,
    /// headers, and body are asserted exactly as the runtime renders them.
    async fn serve(request: &str) -> String {
        let handler = brz_http_server::handlers!(
            ;
            group = probe::fallback_probe
        )
        .expect("probe router");
        let server = brz_http_server::Server::bind(
            "127.0.0.1:0".parse().unwrap(),
            FastApiFallback::new(handler),
        )
        .await
        .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = TcpStream::connect(address).await.expect("connect");
        client.write_all(request.as_bytes()).await.expect("send");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read");
        serve.abort();
        String::from_utf8_lossy(&raw).into_owned()
    }

    fn body_of(raw: &str) -> &str {
        raw.split_once("\r\n\r\n").map_or("", |(_, body)| body)
    }

    fn header_of<'a>(raw: &'a str, name: &str) -> &'a str {
        raw.lines()
            .find(|line| line.to_ascii_lowercase().starts_with(name))
            .map_or("", |line| line[name.len()..].trim())
    }

    #[tokio::test]
    async fn unmatched_path_renders_fastapi_not_found_body() {
        let raw = serve(
            "GET /api/auth/logout HTTP/1.1\r\n\
             Host: localhost\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 404"));
        assert_eq!(body_of(&raw), r#"{"detail":"Not Found"}"#);
        assert_eq!(header_of(&raw, "content-type:"), "application/json");
    }

    #[tokio::test]
    async fn unmatched_method_renders_fastapi_method_not_allowed_body() {
        // A known path with an unsupported method: FastAPI answers 405 with
        // the `Allow` header and the default JSON body.
        let raw = serve(
            "POST /api/startup HTTP/1.1\r\n\
             Host: localhost\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 405"));
        assert_eq!(body_of(&raw), r#"{"detail":"Method Not Allowed"}"#);
        assert_eq!(header_of(&raw, "allow:"), "GET");
        assert_eq!(header_of(&raw, "content-type:"), "application/json");
    }

    #[tokio::test]
    async fn matched_route_is_delegated_unchanged() {
        let raw = serve(
            "GET /api/startup HTTP/1.1\r\n\
             Host: localhost\r\nConnection: close\r\n\r\n",
        )
        .await;
        assert!(raw.starts_with("HTTP/1.1 200"));
        assert_eq!(body_of(&raw), r#""ok""#);
    }
}
