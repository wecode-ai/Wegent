// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Request ID compatibility for APIs selected by the Rust gateway route table.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::net::SocketAddr;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU32, Ordering};

use http::header::{HeaderName, HeaderValue};
use http::{HeaderMap, Request};
use hyper::body::Incoming;

use crate::{GatewayResponse, RustApi};

const X_REQUEST_ID: HeaderName = HeaderName::from_static("x-request-id");
const HEX: &[u8; 16] = b"0123456789abcdef";
static NEXT_REQUEST_ID: OnceLock<AtomicU32> = OnceLock::new();

/// Reuses the incoming request ID or generates one for every non-root Rust API.
#[derive(Clone)]
pub(crate) struct RequestIdFilter<S> {
    inner: S,
}

impl<S> RequestIdFilter<S> {
    pub(crate) const fn new(inner: S) -> Self {
        Self { inner }
    }
}

impl<S> RustApi for RequestIdFilter<S>
where
    S: RustApi,
{
    async fn call(&self, request: Request<Incoming>, peer_addr: SocketAddr) -> GatewayResponse {
        let request_id = response_request_id(request.uri().path(), request.headers());
        let mut response = self.inner.call(request, peer_addr).await;
        if let Some(request_id) = request_id {
            response.headers_mut().insert(X_REQUEST_ID, request_id);
        }
        response
    }
}

fn response_request_id(path: &str, headers: &HeaderMap) -> Option<HeaderValue> {
    if path == "/" {
        return None;
    }
    Some(
        headers
            .get(X_REQUEST_ID)
            .filter(|value| !value.as_bytes().is_empty())
            // HeaderValue clones share their backing bytes, so forwarding an
            // existing request ID does not copy the header contents.
            .cloned()
            .unwrap_or_else(generated_request_id),
    )
}

fn generated_request_id() -> HeaderValue {
    // Randomize the process-local sequence once, then keep the hot path to a
    // relaxed atomic increment and stack-only encoding. The response must own
    // its header bytes, so HeaderValue performs the only required copy here.
    let value = NEXT_REQUEST_ID
        .get_or_init(|| {
            let mut hasher = RandomState::new().build_hasher();
            hasher.write_u32(std::process::id());
            AtomicU32::new(hasher.finish() as u32)
        })
        .fetch_add(1, Ordering::Relaxed);
    let mut encoded = [0_u8; 8];
    for (byte, pair) in value.to_be_bytes().into_iter().zip(encoded.chunks_mut(2)) {
        pair[0] = HEX[(byte >> 4) as usize];
        pair[1] = HEX[(byte & 0x0f) as usize];
    }
    HeaderValue::from_bytes(&encoded).expect("hex request ID is a valid header value")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reuses_the_incoming_request_id() {
        let headers = HeaderMap::from_iter([(
            X_REQUEST_ID,
            HeaderValue::from_static("wework-http-d2ca12c2-a9f8-4241-b93b-56fff44367e6"),
        )]);

        let request_id = response_request_id("/api/devices", &headers).unwrap();

        assert_eq!(
            request_id,
            "wework-http-d2ca12c2-a9f8-4241-b93b-56fff44367e6"
        );
    }

    #[test]
    fn generates_an_eight_character_hex_id_when_absent_or_empty() {
        for headers in [
            HeaderMap::new(),
            HeaderMap::from_iter([(X_REQUEST_ID, HeaderValue::from_static(""))]),
        ] {
            let request_id = response_request_id("/api/devices", &headers).unwrap();
            let request_id = request_id.to_str().unwrap();
            assert_eq!(request_id.len(), 8);
            assert!(request_id.bytes().all(|byte| byte.is_ascii_hexdigit()));
        }
    }

    #[test]
    fn generated_ids_are_distinct() {
        assert_ne!(generated_request_id(), generated_request_id());
    }

    #[test]
    fn skips_the_root_path_even_when_the_request_has_an_id() {
        let headers = HeaderMap::from_iter([(
            X_REQUEST_ID,
            HeaderValue::from_static("wework-http-request-1"),
        )]);

        assert_eq!(response_request_id("/", &headers), None);
    }
}
