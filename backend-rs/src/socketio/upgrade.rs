// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! CORS boundary for the Socket.IO protocol mount.
//!
//! The Python source mounts `socketio.ASGIApp` outside the FastAPI CORS
//! middleware. Its Engine.IO HTTP responses carry `_cors_headers`
//! (`engineio/base_server.py:319-337`), but a WebSocket upgrade is accepted by
//! `engineio/async_drivers/asgi.py:221-235` with only the Engine.IO handshake
//! headers: the recorded source 101 response has `connection`, `date`,
//! `sec-websocket-accept`, `server` and `upgrade`, and no `Vary`,
//! `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials` or
//! `Access-Control-Expose-Headers`.
//!
//! The public gateway applies one boundary policy to every response. Its
//! protocol mount honors a response-local opt-out: an internal origin response
//! carrying `x-breeze-response-cors: skip` keeps its headers without adding
//! CORS permissions or Origin variance (`brz_http_cors::ResponseCors`).
//! This adapter marks exactly the successful protocol switch, so ordinary HTTP
//! and Engine.IO polling responses keep the gateway CORS policy.

use std::future::Future;
use std::pin::Pin;

use http::header::{HeaderName, HeaderValue};
use http::{Request, Response, StatusCode};
use hyper::service::Service;

/// The trusted internal response-CORS control header
/// (`brz_http_cors::RESPONSE_CORS_HEADER`). The gateway and this crate pin the
/// same `brz-http-cors` version, and the name is the protocol contract between
/// the internal origin and the public gateway.
const RESPONSE_CORS_HEADER: HeaderName = HeaderName::from_static("x-breeze-response-cors");

/// Marks successful protocol switches so the gateway leaves their headers
/// exactly as the Socket.IO server produced them.
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
        let future = self.inner.call(request);
        Box::pin(async move {
            let mut response = future.await?;
            if response.status() == StatusCode::SWITCHING_PROTOCOLS {
                response
                    .headers_mut()
                    .insert(RESPONSE_CORS_HEADER, HeaderValue::from_static("skip"));
            }
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

    async fn call(status: StatusCode) -> Response<Empty<Bytes>> {
        let request = Request::builder()
            .uri("/socket.io/?EIO=4&transport=websocket")
            .body(Empty::new())
            .unwrap();
        CorsOptOut::new(Fixed(status)).call(request).await.unwrap()
    }

    #[tokio::test]
    async fn protocol_switch_keeps_its_headers_out_of_the_gateway_cors_policy() {
        let response = call(StatusCode::SWITCHING_PROTOCOLS).await;
        assert_eq!(
            response.headers().get(RESPONSE_CORS_HEADER).unwrap(),
            "skip"
        );
    }

    #[tokio::test]
    async fn ordinary_http_responses_keep_the_gateway_cors_policy() {
        let response = call(StatusCode::OK).await;
        assert!(response.headers().get(RESPONSE_CORS_HEADER).is_none());
    }
}
