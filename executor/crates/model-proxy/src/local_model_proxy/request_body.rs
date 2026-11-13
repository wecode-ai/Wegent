// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::io::Read;

/// Decode transport bytes before inspecting task identity or rewriting JSON.
pub(super) fn decode(headers: &mut HeaderMap, body: Bytes) -> Result<Bytes, HttpError> {
    decode_with_limit(headers, body, MAX_REQUEST_BODY_BYTES)
}

fn decode_with_limit(
    headers: &mut HeaderMap,
    body: Bytes,
    limit: usize,
) -> Result<Bytes, HttpError> {
    let Some(encoding) = headers.get(header::CONTENT_ENCODING) else {
        return Ok(body);
    };
    let encoding = encoding.to_str().unwrap_or_default().trim();
    if encoding.eq_ignore_ascii_case("identity") {
        return Ok(body);
    }
    if !encoding.eq_ignore_ascii_case("zstd") {
        return Err(HttpError {
            status: StatusCode::UNSUPPORTED_MEDIA_TYPE,
            detail: "Unsupported local model proxy request content encoding".to_owned(),
        });
    }
    let invalid_body = |error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid zstd local model proxy request body: {error}"),
    };
    let decoder = zstd::stream::read::Decoder::new(body.as_ref()).map_err(invalid_body)?;
    let mut decoded = Vec::new();
    decoder
        .take(limit as u64 + 1)
        .read_to_end(&mut decoded)
        .map_err(invalid_body)?;
    if decoded.len() > limit {
        return Err(HttpError {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            detail: "Decoded local model proxy request body exceeds size limit".to_owned(),
        });
    }
    headers.remove(header::CONTENT_ENCODING);
    headers.remove(header::CONTENT_LENGTH);
    Ok(Bytes::from(decoded))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::Request, routing::post, Json, Router};
    use tower::ServiceExt;

    fn compressed_headers() -> HeaderMap {
        HeaderMap::from_iter([
            (header::CONTENT_ENCODING, HeaderValue::from_static("zstd")),
            (header::CONTENT_LENGTH, HeaderValue::from_static("1")),
        ])
    }

    #[test]
    fn decodes_zstd_and_removes_obsolete_transport_headers() {
        let input = br#"{"client_metadata":{"thread_id":"compressed-thread"}}"#;
        let compressed = zstd::encode_all(input.as_slice(), 0).unwrap();
        let mut headers = compressed_headers();
        let body = decode(&mut headers, Bytes::from(compressed)).unwrap();
        assert_eq!(body.as_ref(), input);
        assert!(!headers.contains_key(header::CONTENT_ENCODING));
        assert!(!headers.contains_key(header::CONTENT_LENGTH));
    }

    #[test]
    fn rejects_invalid_unsupported_and_oversized_encoded_bodies() {
        let mut headers = compressed_headers();
        let error = decode(&mut headers, Bytes::from_static(b"broken zstd")).unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        let compressed = zstd::encode_all(&[0_u8; 1025][..], 0).unwrap();
        let error = decode_with_limit(&mut headers, Bytes::from(compressed), 1024).unwrap_err();
        assert_eq!(error.status, StatusCode::PAYLOAD_TOO_LARGE);
        headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        let error = decode(&mut headers, Bytes::new()).unwrap_err();
        assert_eq!(error.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[test]
    fn preserves_uncompressed_bodies_and_accepts_the_decoded_size_boundary() {
        let input = Bytes::from_static(b"plain request");
        for encoding in [None, Some("identity")] {
            let mut headers = HeaderMap::new();
            if let Some(encoding) = encoding {
                headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
            }
            assert_eq!(decode(&mut headers, input.clone()).unwrap(), input);
        }
        let compressed = zstd::encode_all(input.as_ref(), 0).unwrap();
        assert_eq!(
            decode_with_limit(
                &mut compressed_headers(),
                Bytes::from(compressed),
                input.len()
            )
            .unwrap(),
            input
        );
    }

    #[tokio::test]
    async fn compressed_requests_resolve_task_routes_and_preserve_thread_authorization() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(3);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/responses",
                    post(move |headers: HeaderMap, Json(body): Json<Value>| {
                        let tx = tx.clone();
                        async move {
                            tx.send((headers, body)).await.unwrap();
                            (
                                StatusCode::BAD_REQUEST,
                                Json(json!({"error":{"message":"upstream reached"}})),
                            )
                        }
                    }),
                ),
            )
            .await
            .unwrap();
        });
        let token = register(
            "compressed-route-test",
            LocalModelProxyUpstream {
                base_url: format!("http://{address}"),
                request_url: None,
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                native_tool_search: false,
                native_namespace_tools: false,
                api_key: "synthetic".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: Some("upstream-model".to_owned()),
                routing_model_id: None,
                codex_request_mode: Default::default(),
                max_output_tokens: None,
                model_context_window: None,
            },
        );
        bind_thread(&token, "compressed-route-thread").unwrap();
        let app = Router::new()
            .route(ROUTE, route())
            .route(TOKEN_ROUTE, token_route());
        for path in [
            ROUTE.to_owned(),
            format!("/v1/codex-router/{token}/responses"),
            "/v1/codex-router/task-expired-compressed/responses".to_owned(),
        ] {
            let response = app
                .clone()
                .oneshot(compressed_request(&path, "compressed-route-thread"))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let response_body = to_bytes(response.into_body(), 4096).await.unwrap();
            assert!(String::from_utf8_lossy(&response_body).contains("upstream reached"));
            let (headers, body) = rx.recv().await.unwrap();
            assert!(!headers.contains_key(header::CONTENT_ENCODING));
            assert_eq!(
                body["client_metadata"]["thread_id"],
                "compressed-route-thread"
            );
            assert_eq!(body["model"], "upstream-model");
        }
        let path = format!("/v1/codex-router/{token}/responses");
        let response = app
            .oneshot(compressed_request(&path, "unrelated-thread"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert!(rx.try_recv().is_err());
        unregister(&token);
        server.abort();
    }

    fn compressed_request(path: &str, thread: &str) -> Request<Body> {
        let body = serde_json::to_vec(&json!({
            "model":"routing-model", "input":"synthetic request", "stream":true,
            "client_metadata":{"thread_id":thread}
        }))
        .unwrap();
        Request::builder()
            .method("POST")
            .uri(path)
            .header(header::AUTHORIZATION, format!("Bearer {API_KEY}"))
            .header(header::CONTENT_ENCODING, "zstd")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(zstd::encode_all(body.as_slice(), 0).unwrap()))
            .unwrap()
    }
}
