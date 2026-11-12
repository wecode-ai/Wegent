// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! CORS boundary for the Socket.IO protocol mount.
//!
//! The Python source mounts `socketio.ASGIApp` outside the FastAPI CORS
//! middleware, so the Starlette policy (which adds
//! `Access-Control-Expose-Headers` and `Vary: Origin`) never reaches this
//! mount. Engine.IO renders its own headers on every HTTP response:
//! `_cors_headers` (`engineio/base_server.py:319-337`) with
//! `cors_allowed_origins="*"` and `cors_credentials=True`
//! (`app/core/socketio.py`) reflects the request Origin, always allows
//! credentials, and adds `OPTIONS, GET, POST` plus the requested header names
//! on preflight; it never sets `Vary` or `Access-Control-Expose-Headers`.
//!
//! A WebSocket upgrade is accepted by
//! `engineio/async_drivers/asgi.py:221-235` with only the Engine.IO handshake
//! headers: the recorded source 101 response has `connection`, `date`,
//! `sec-websocket-accept`, `server` and `upgrade`, and no CORS headers at all.
//!
//! The public gateway applies one boundary policy to every response. Its
//! protocol mount honors a response-local opt-out: an internal origin response
//! carrying `x-breeze-response-cors: skip` keeps its headers without adding
//! CORS permissions or Origin variance (`brz_http_cors::ResponseCors`). This
//! adapter therefore writes the Engine.IO policy for ordinary HTTP responses
//! and leaves successful protocol switches exactly as the server produced them.

use std::future::Future;
use std::pin::Pin;

use http::header::{HeaderMap, HeaderName, HeaderValue, ORIGIN};
use http::{Method, Request, Response, StatusCode};
use hyper::service::Service;

/// The trusted internal response-CORS control header
/// (`brz_http_cors::RESPONSE_CORS_HEADER`). The gateway and this crate pin the
/// same `brz-http-cors` version, and the name is the protocol contract between
/// the internal origin and the public gateway.
const RESPONSE_CORS_HEADER: HeaderName = HeaderName::from_static("x-breeze-response-cors");

/// `HTTP_ACCESS_CONTROL_REQUEST_HEADERS` (`engineio/base_server.py:333-335`).
const ACCESS_CONTROL_REQUEST_HEADERS: HeaderName =
    HeaderName::from_static("access-control-request-headers");

/// One request's Engine.IO `_cors_headers` inputs.
///
/// The ASGI driver joins repeated request headers with commas before Engine.IO
/// reads them (`engineio/async_drivers/asgi.py:200-212`), so the adapter joins
/// them the same way instead of reading only the first value.
#[derive(Clone, Debug, Default)]
struct EngineIoCors {
    origin: Option<HeaderValue>,
    requested_headers: Option<HeaderValue>,
    preflight: bool,
}

impl EngineIoCors {
    fn from_request<B>(request: &Request<B>) -> Self {
        Self {
            origin: joined(request.headers(), &ORIGIN),
            requested_headers: joined(request.headers(), &ACCESS_CONTROL_REQUEST_HEADERS),
            preflight: request.method() == Method::OPTIONS,
        }
    }

    fn apply(&self, headers: &mut HeaderMap) {
        // `cors_allowed_origins="*"` reflects whatever Origin the client sent.
        if let Some(origin) = &self.origin {
            headers.insert("access-control-allow-origin", origin.clone());
        }
        if self.preflight {
            headers.insert(
                "access-control-allow-methods",
                HeaderValue::from_static("OPTIONS, GET, POST"),
            );
        }
        if let Some(requested) = &self.requested_headers {
            headers.insert("access-control-allow-headers", requested.clone());
        }
        // `cors_credentials` defaults to true in Engine.IO, with or without an
        // Origin header.
        headers.insert(
            "access-control-allow-credentials",
            HeaderValue::from_static("true"),
        );
    }
}

fn joined(headers: &HeaderMap, name: &HeaderName) -> Option<HeaderValue> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?;
    let mut bytes = first.as_bytes().to_vec();
    for value in values {
        bytes.push(b',');
        bytes.extend_from_slice(value.as_bytes());
    }
    HeaderValue::from_bytes(&bytes).ok()
}

/// Marks this protocol mount's responses so the gateway leaves the Engine.IO
/// CORS policy in place instead of applying the FastAPI boundary policy.
#[derive(Clone)]
pub struct CorsOptOut<S> {
    inner: S,
}

impl<S> CorsOptOut<S> {
    /// Wraps one protocol service.
    pub const fn new(inner: S) -> Self {
        Self { inner }
    }
}

impl<S, ReqBody, B> Service<Request<ReqBody>> for CorsOptOut<S>
where
    ReqBody: Send + 'static,
    S: Service<Request<ReqBody>, Response = Response<B>, Error = std::convert::Infallible>,
    S::Future: Send + 'static,
    B: Send + 'static,
{
    type Response = Response<B>;
    type Error = std::convert::Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn call(&self, request: Request<ReqBody>) -> Self::Future {
        let cors = EngineIoCors::from_request(&request);
        let future = self.inner.call(request);
        Box::pin(async move {
            let mut response = future.await?;
            if response.status() != StatusCode::SWITCHING_PROTOCOLS {
                cors.apply(response.headers_mut());
            }
            response
                .headers_mut()
                .insert(RESPONSE_CORS_HEADER, HeaderValue::from_static("skip"));
            Ok(response)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::Empty;

    #[derive(Clone)]
    struct Fixed(StatusCode);

    impl Service<Request<Empty<Bytes>>> for Fixed {
        type Response = Response<Empty<Bytes>>;
        type Error = std::convert::Infallible;
        type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

        fn call(&self, _request: Request<Empty<Bytes>>) -> Self::Future {
            let status = self.0;
            Box::pin(async move {
                Ok(Response::builder()
                    .status(status)
                    .body(Empty::new())
                    .unwrap())
            })
        }
    }

    fn request(method: Method, headers: &[(&str, &str)]) -> Request<Empty<Bytes>> {
        let mut builder = Request::builder()
            .method(method)
            .uri("/socket.io/?EIO=4&transport=polling");
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        builder.body(Empty::new()).unwrap()
    }

    async fn call(request: Request<Empty<Bytes>>, status: StatusCode) -> Response<Empty<Bytes>> {
        CorsOptOut::new(Fixed(status)).call(request).await.unwrap()
    }

    fn header<'a>(response: &'a Response<Empty<Bytes>>, name: &str) -> Option<&'a str> {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    }

    #[tokio::test]
    async fn protocol_switch_keeps_its_headers_out_of_every_cors_policy() {
        let response = call(
            request(Method::GET, &[("origin", "https://wegent.example")]),
            StatusCode::SWITCHING_PROTOCOLS,
        )
        .await;
        assert_eq!(
            response.headers().get(RESPONSE_CORS_HEADER).unwrap(),
            "skip"
        );
        assert_eq!(header(&response, "access-control-allow-origin"), None);
        assert_eq!(header(&response, "access-control-allow-credentials"), None);
        assert_eq!(header(&response, "vary"), None);
    }

    #[tokio::test]
    async fn engine_io_responses_reflect_the_origin_without_exposing_headers() {
        let response = call(
            request(Method::GET, &[("origin", "https://wegent.example")]),
            StatusCode::OK,
        )
        .await;
        assert_eq!(
            response.headers().get(RESPONSE_CORS_HEADER).unwrap(),
            "skip"
        );
        assert_eq!(
            header(&response, "access-control-allow-origin"),
            Some("https://wegent.example")
        );
        assert_eq!(
            header(&response, "access-control-allow-credentials"),
            Some("true")
        );
        assert_eq!(
            header(&response, "access-control-expose-headers"),
            None,
            "the FastAPI boundary policy must not reach the Socket.IO mount"
        );
        assert_eq!(
            header(&response, "vary"),
            None,
            "Engine.IO never varies its responses by Origin"
        );
    }

    #[tokio::test]
    async fn engine_io_responses_allow_credentials_without_an_origin() {
        let response = call(request(Method::GET, &[]), StatusCode::OK).await;
        assert_eq!(
            response.headers().get(RESPONSE_CORS_HEADER).unwrap(),
            "skip"
        );
        assert_eq!(header(&response, "access-control-allow-origin"), None);
        assert_eq!(
            header(&response, "access-control-allow-credentials"),
            Some("true")
        );
        assert_eq!(header(&response, "vary"), None);
    }

    #[tokio::test]
    async fn engine_io_preflight_echoes_its_methods_and_request_headers() {
        let response = call(
            request(
                Method::OPTIONS,
                &[
                    ("origin", "https://wegent.example"),
                    ("access-control-request-method", "GET"),
                    ("access-control-request-headers", "authorization,x-custom"),
                ],
            ),
            StatusCode::OK,
        )
        .await;
        assert_eq!(
            header(&response, "access-control-allow-methods"),
            Some("OPTIONS, GET, POST")
        );
        assert_eq!(
            header(&response, "access-control-allow-headers"),
            Some("authorization,x-custom")
        );
        assert_eq!(
            header(&response, "access-control-allow-origin"),
            Some("https://wegent.example")
        );
        assert_eq!(header(&response, "vary"), None);
    }

    #[tokio::test]
    async fn repeated_origin_values_are_joined_like_the_asgi_environment() {
        let response = call(
            request(
                Method::GET,
                &[
                    ("origin", "https://first.example"),
                    ("origin", "https://second.example"),
                ],
            ),
            StatusCode::OK,
        )
        .await;
        assert_eq!(
            header(&response, "access-control-allow-origin"),
            Some("https://first.example,https://second.example")
        );
    }
}
