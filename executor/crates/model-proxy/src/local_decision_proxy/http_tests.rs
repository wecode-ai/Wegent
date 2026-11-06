// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::{test_support::*, *};
use axum::body::Body;
use serde_json::json;

#[tokio::test]
async fn status_uses_the_live_backend_catalog_and_strips_unknown_fields() {
    let mut body = catalog();
    body["apiKey"] = json!("must-not-leak");
    body["models"][0]["apiKey"] = json!("must-not-leak");
    let backend = start_backend(body, Duration::ZERO).await;
    let token = register_route(&backend, "decision-http-catalog");
    let app = app(UPSTREAM_TIMEOUT);
    let (status, body) = send(app.clone(), request(&token, Method::GET, Value::Null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, catalog());
    assert_eq!(backend.requests()[0].method, Method::GET);
    assert_eq!(
        backend.requests()[0].headers[header::AUTHORIZATION],
        format!("Bearer {LOGIN_TOKEN}")
    );

    backend.set_reply(
        StatusCode::OK,
        json!({"protocolVersion": 1, "defaultModel": "", "models": []}),
    );
    let (status, body) = send(app, request(&token, Method::GET, Value::Null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["models"], json!([]));
    assert_eq!(
        backend.requests().len(),
        2,
        "catalog changes must not be cached"
    );
    unregister(&token);
}

#[tokio::test]
async fn decision_forwards_only_the_normalized_body_and_current_login() {
    let backend = start_backend(
        json!({"model": "model-a", "answers": {}, "debug": "must-not-leak"}),
        Duration::ZERO,
    )
    .await;
    let snapshot = connection(&backend);
    let token = register("decision-http-login", Arc::clone(&snapshot));
    let app = app(UPSTREAM_TIMEOUT);
    for login in ["first-token", "rotated-token"] {
        snapshot.lock().unwrap().as_mut().unwrap().auth_token = login.to_owned();
        let (status, body) = send(app.clone(), request(&token, Method::POST, valid_body())).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.get("debug").is_none());
        let recorded = backend.requests().pop().unwrap();
        assert_eq!(recorded.body, valid_body());
        assert_eq!(
            recorded.headers[header::AUTHORIZATION],
            format!("Bearer {login}")
        );
        assert!(!recorded.headers.contains_key(header::COOKIE));
        assert!(!recorded.headers.contains_key("x-api-key"));
    }
    *snapshot.lock().unwrap() = None;
    let (status, body) = send(app, request(&token, Method::POST, valid_body())).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body["error"]["code"], "credential_unavailable");
    assert_eq!(backend.requests().len(), 2);
    unregister(&token);
}

#[tokio::test]
async fn local_marker_and_live_route_are_required_for_both_methods() {
    let backend = start_backend(catalog(), Duration::ZERO).await;
    let token = register_route(&backend, "decision-http-authorize");
    let app = app(UPSTREAM_TIMEOUT);
    for method in [Method::GET, Method::POST] {
        let mut bad = request(&token, method.clone(), valid_body());
        bad.headers_mut().remove(header::AUTHORIZATION);
        let (status, _) = send(app.clone(), bad).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    unregister(&token);
    for method in [Method::GET, Method::POST] {
        let (status, body) = send(app.clone(), request(&token, method, valid_body())).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "route_not_found");
    }
    assert!(backend.requests().is_empty());
}

#[tokio::test]
async fn malformed_requests_never_reach_the_backend() {
    let backend = start_backend(catalog(), Duration::ZERO).await;
    let token = register_route(&backend, "decision-http-validation");
    let app = app(UPSTREAM_TIMEOUT);
    for body in [
        json!({"model": "", "state": "text", "questions": {"q": {}}}),
        json!({"model": "model-a", "state": null, "questions": {"q": {}}}),
        json!({"model": "model-a", "state": "text", "questions": {}}),
        json!({"model": "model-a", "state": "text", "questions": {"q": {}}, "apiKey": "injected"}),
    ] {
        let (status, _) = send(app.clone(), request(&token, Method::POST, body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let mut bad_type = request(&token, Method::POST, valid_body());
    bad_type
        .headers_mut()
        .insert(header::CONTENT_TYPE, "text/plain".parse().unwrap());
    assert_eq!(
        send(app.clone(), bad_type).await.0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    let mut oversized = request(&token, Method::POST, valid_body());
    *oversized.body_mut() = Body::from("x".repeat(MAX_REQUEST_BYTES + 1));
    assert_eq!(send(app, oversized).await.0, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(backend.requests().is_empty());
    unregister(&token);
}

#[tokio::test]
async fn backend_errors_are_sanitized_without_retrying() {
    let backend = start_backend(Value::Null, Duration::ZERO).await;
    let token = register_route(&backend, "decision-http-errors");
    let app = app(UPSTREAM_TIMEOUT);
    for (status, code) in [
        (StatusCode::NOT_FOUND, "model_not_found"),
        (StatusCode::TOO_MANY_REQUESTS, "upstream_rate_limited"),
        (StatusCode::BAD_REQUEST, "invalid_request"),
        (StatusCode::BAD_GATEWAY, "upstream_invalid_response"),
    ] {
        backend.set_reply(
            status,
            json!({"error": {"code": code, "message": "credential must-not-leak"}}),
        );
        let (actual_status, body) =
            send(app.clone(), request(&token, Method::POST, valid_body())).await;
        assert_eq!(actual_status, status);
        assert_eq!(body["error"]["code"], code);
        assert!(!body.to_string().contains("must-not-leak"));
    }
    assert_eq!(
        backend.requests().len(),
        4,
        "execution must not retry a rejected request"
    );
    unregister(&token);
}

#[tokio::test]
async fn timeout_is_reported_and_malformed_catalog_is_rejected() {
    let backend = start_backend(catalog(), Duration::from_millis(100)).await;
    let token = register_route(&backend, "decision-http-timeout");
    assert_eq!(
        send(
            app(Duration::from_millis(5)),
            request(&token, Method::POST, valid_body())
        )
        .await
        .0,
        StatusCode::GATEWAY_TIMEOUT,
    );
    unregister(&token);
    let backend = start_backend(json!({"protocolVersion": 2, "models": []}), Duration::ZERO).await;
    let token = register_route(&backend, "decision-http-bad-catalog");
    assert_eq!(
        send(
            app(UPSTREAM_TIMEOUT),
            request(&token, Method::GET, Value::Null)
        )
        .await
        .0,
        StatusCode::BAD_GATEWAY,
    );
    unregister(&token);
}
