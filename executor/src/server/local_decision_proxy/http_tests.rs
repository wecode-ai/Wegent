// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTTP-level tests for the decision router.

use std::{sync::Mutex, time::Duration};

use axum::{body::Body, http::Request};
use serde_json::json;

use super::test_support::*;
use super::*;
use crate::config::device::ConnectionConfig;

#[tokio::test]
async fn unconfigured_router_answers_503_on_both_routes() {
    let app = app(DecisionProxyConfig::Unconfigured, UPSTREAM_TIMEOUT);
    let (status, body) = send(
        app.clone(),
        status_request("decision-unknown", Some(&local_marker())),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&body), "decision_router_disabled");

    let (status, body) = send(
        app,
        decision_request(
            "decision-unknown",
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&body), "decision_router_disabled");
}

#[tokio::test]
async fn local_marker_is_required() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
    let token = register_route(&upstream, "http-tests-marker");
    let app = enabled_app(&upstream);

    for authorization in [None, Some("Bearer wrong"), Some("Basic abc")] {
        let (status, body) = send(app.clone(), status_request(&token, authorization)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "auth={authorization:?}");
        assert_eq!(error_code(&body), "invalid_local_authorization");
    }
}

#[tokio::test]
async fn unknown_token_is_not_found() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
    let app = enabled_app(&upstream);
    let (status, body) = send(
        app,
        status_request("decision-unknown", Some(&local_marker())),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&body), "route_not_found");
}

#[tokio::test]
async fn status_lists_only_the_configured_catalogue() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
    let token = register_route(&upstream, "http-tests-status");
    let (status, body) = send(
        enabled_app(&upstream),
        status_request(&token, Some(&local_marker())),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({
            "protocolVersion": 1,
            "defaultModel": "model-a",
            "models": [
                {"id": "model-a", "displayName": "Model A"},
                {"id": "model-b", "displayName": "model-b"},
            ],
        })
    );
    let serialized = body.to_string();
    assert!(!serialized.contains(&upstream.url.to_string()));
    assert!(!serialized.contains(EXCHANGED_KEY));
    assert!(!serialized.contains(LOGIN_TOKEN));
    assert_eq!(
        upstream.requests().len(),
        0,
        "status must not call upstream"
    );
    assert_eq!(
        upstream.key_requests().len(),
        0,
        "status must not trade the login token"
    );
}

#[tokio::test]
async fn request_validation_rejects_bad_shapes() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
    let token = register_route(&upstream, "http-tests-validation");

    let cases = [
        (
            "not json",
            Some("application/json"),
            Body::from("not json"),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "unknown field",
            Some("application/json"),
            json_body(json!({
                "model": "model-a",
                "state": {},
                "questions": {"q": {}},
                "baseUrl": "https://evil.example.com",
            })),
            StatusCode::BAD_REQUEST,
            "unsupported_field",
        ),
        (
            "blank model",
            Some("application/json"),
            json_body(json!({
                "model": "   ",
                "state": {},
                "questions": {"q": {}},
            })),
            StatusCode::BAD_REQUEST,
            "invalid_model",
        ),
        (
            "null state",
            Some("application/json"),
            json_body(json!({
                "model": "model-a",
                "state": null,
                "questions": {"q": {}},
            })),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "empty questions",
            Some("application/json"),
            json_body(json!({
                "model": "model-a",
                "state": {},
                "questions": {},
            })),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "questions not an object",
            Some("application/json"),
            json_body(json!({
                "model": "model-a",
                "state": {},
                "questions": ["q"],
            })),
            StatusCode::BAD_REQUEST,
            "invalid_request",
        ),
        (
            "wrong content type",
            Some("text/plain"),
            json_body(valid_body()),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "invalid_content_type",
        ),
        (
            "missing content type",
            None,
            json_body(valid_body()),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "invalid_content_type",
        ),
    ];

    for (name, content_type, body, expected_status, expected_code) in cases {
        let (status, payload) = send(
            enabled_app(&upstream),
            decision_request(&token, Some(&local_marker()), content_type, body),
        )
        .await;
        assert_eq!(status, expected_status, "case={name}");
        assert_eq!(error_code(&payload), expected_code, "case={name}");
    }
    assert_eq!(
        upstream.requests().len(),
        0,
        "rejected requests must never reach the upstream"
    );
}

#[tokio::test]
async fn oversized_body_is_rejected_locally() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
    let token = register_route(&upstream, "http-tests-oversized");
    let oversized = "x".repeat(MAX_REQUEST_BYTES + 1);
    let (status, _) = send(
        enabled_app(&upstream),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            Body::from(oversized),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(upstream.requests().len(), 0);
}

#[tokio::test]
async fn accepted_content_type_variants_are_allowed() {
    for content_type in ["application/json", "application/json; charset=utf-8"] {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
        let token = register_route(&upstream, "http-tests-content-type");
        let (status, _) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some(content_type),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "content-type={content_type}");
    }
}

#[tokio::test]
async fn upstream_receives_the_request_verbatim_and_no_client_headers() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {"q": {}}}))).await;
    let token = register_route(&upstream, "http-tests-forward");
    let body = json!({
        "model": "model-a",
        "state": "plain string state",
        "questions": {"sentiment": {"type": "choice", "criteria": {"positive": "正面"}}},
    });
    let request = Request::builder()
        .method("POST")
        .uri(format!("/v1/decision-router/{token}/v1/decisions"))
        .header(header::AUTHORIZATION, local_marker())
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, "session=client-cookie")
        .header(header::ORIGIN, "https://evil.example.com")
        .header(header::REFERER, "https://evil.example.com")
        .header("x-api-key", "client-key")
        .header("x-forwarded-for", "10.1.2.3")
        .body(json_body(body.clone()))
        .expect("request");

    let (status, payload) = send(enabled_app(&upstream), request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(payload, json!({"answers": {"q": {}}}));

    let recorded = upstream.only_request();
    assert_eq!(recorded.body, body);
    let names = recorded
        .headers
        .iter()
        .map(|(name, _)| name.to_ascii_lowercase())
        .collect::<Vec<_>>();
    for forbidden in [
        "cookie",
        "origin",
        "referer",
        "x-api-key",
        "x-forwarded-for",
    ] {
        assert!(
            !names.contains(&forbidden.to_owned()),
            "leaked header {forbidden}"
        );
    }
    assert_eq!(
        upstream.header("authorization").as_deref(),
        Some(format!("Bearer {EXCHANGED_KEY}").as_str())
    );
    let forwarded_request_id = upstream.header("x-request-id").unwrap_or_default();
    assert!(
        forwarded_request_id.starts_with("local_req_"),
        "the Executor must mint its own request id, got {forwarded_request_id}"
    );
    assert_ne!(forwarded_request_id, "client-supplied");
}

#[tokio::test]
async fn the_router_forwards_any_model_name_verbatim() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {"q": {}}}))).await;
    let token = register_route(&upstream, "http-tests-any-model");
    let body = json!({
        "model": "team-owned-model-2026",
        "state": "plain string state",
        "questions": {"q": {}},
    });

    let (status, _) = send(
        enabled_app(&upstream),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(body.clone()),
        ),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(upstream.only_request().body, body);
}

#[tokio::test]
async fn response_is_whitelisted_before_reaching_the_client() {
    let upstream = start_upstream(ScriptedResponse::json(
        200,
        json!({
            "model": "model-a",
            "request_id": "req_1",
            "answers": {"q": {"choice": "yes"}},
            "usage": {"total_tokens": 3},
            "latency_ms": 12,
            "debug": {"secret": true},
            "trace": "internal",
            "authorization": "Bearer leaked",
            "upstream_request": {"url": "https://decision-upstream.example.com"},
        }),
    ))
    .await;
    let token = register_route(&upstream, "http-tests-whitelist");
    let (status, payload) = send(
        enabled_app(&upstream),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        payload,
        json!({
            "model": "model-a",
            "request_id": "req_1",
            "answers": {"q": {"choice": "yes"}},
            "usage": {"total_tokens": 3},
            "latency_ms": 12,
        })
    );
}

#[tokio::test]
async fn upstream_statuses_map_to_the_fixed_table() {
    let cases = [
        (429, 429, "upstream_rate_limited", true),
        (400, 502, "upstream_rejected", false),
        (422, 502, "upstream_rejected", false),
        (500, 502, "upstream_rejected", true),
        (503, 502, "upstream_rejected", true),
    ];
    for (upstream_status, expected_status, expected_code, retryable) in cases {
        let upstream =
            start_upstream(ScriptedResponse::raw(upstream_status, "upstream failure")).await;
        let token = register_route(&upstream, "http-tests-status-map");
        let (status, payload) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(
            status.as_u16(),
            expected_status,
            "upstream={upstream_status}"
        );
        assert_eq!(
            error_code(&payload),
            expected_code,
            "upstream={upstream_status}"
        );
        assert_eq!(
            payload["error"]["retryable"], retryable,
            "upstream={upstream_status}"
        );
        assert_eq!(upstream.requests().len(), 1, "no upstream retry");
    }
}

#[tokio::test]
async fn success_without_json_maps_to_502() {
    let upstream = start_upstream(ScriptedResponse::raw(200, "<html>not json</html>")).await;
    let token = register_route(&upstream, "http-tests-bad-json");
    let (status, payload) = send(
        enabled_app(&upstream),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(error_code(&payload), "upstream_invalid_response");
}

#[tokio::test]
async fn timeout_maps_to_504() {
    let mut scripted = ScriptedResponse::json(200, json!({"answers": {}}));
    scripted.delay = Duration::from_millis(400);
    let upstream = start_upstream(scripted).await;
    let token = register_route(&upstream, "http-tests-timeout");
    let app = app(
        DecisionProxyConfig::Enabled(settings(&upstream.url)),
        Duration::from_millis(20),
    );
    let (status, payload) = send(
        app,
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(error_code(&payload), "upstream_timeout");
    assert_eq!(payload["error"]["retryable"], true);
}

#[tokio::test]
async fn upstream_failures_never_leak_internals() {
    let upstream = start_upstream(ScriptedResponse::raw(
        500,
        "upstream body with credential test-upstream-credential",
    ))
    .await;
    let token = register_route(&upstream, "http-tests-leak");
    let (status, payload) = send(
        enabled_app(&upstream),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    let serialized = payload.to_string();
    for needle in [
        EXCHANGED_KEY,
        LOGIN_TOKEN,
        "upstream body",
        upstream.url.as_str(),
        "127.0.0.1",
        "panicked",
    ] {
        assert!(!serialized.contains(needle), "leaked {needle}");
    }
}

#[tokio::test]
async fn login_token_is_traded_for_the_upstream_credential() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
    let token = register_route(&upstream, "http-tests-trade");
    let (status, _) = send(
        enabled_app(&upstream),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        upstream.last_key_authorization().as_deref(),
        Some(format!("Bearer {LOGIN_TOKEN}").as_str()),
        "the exchange must present the current login token"
    );
    assert_eq!(upstream.key_requests().len(), 1);
}

#[tokio::test]
async fn the_exchanged_key_is_cached_between_requests() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
    let token = register_route(&upstream, "http-tests-key-cache");
    let app = enabled_app(&upstream);
    for _ in 0..3 {
        let (status, _) = send(
            app.clone(),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
    }
    assert_eq!(
        upstream.key_requests().len(),
        1,
        "the traded key must be reused instead of traded again per request"
    );
    assert_eq!(
        upstream.header("authorization").as_deref(),
        Some(format!("Bearer {EXCHANGED_KEY}").as_str())
    );
}

#[tokio::test]
async fn upstream_401_drops_the_key_and_retries_once() {
    let upstream = start_backend(
        Script::sequence(vec![
            ScriptedResponse::raw(401, "unauthorized"),
            ScriptedResponse::json(200, json!({"answers": {}})),
        ]),
        Script::sequence(vec![
            exchange_response("sk-wecode-stale"),
            exchange_response("sk-wecode-fresh"),
        ]),
    )
    .await;
    let token = register_route(&upstream, "http-tests-rekey");
    let (status, _) = send(
        enabled_app(&upstream),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let authorizations = upstream
        .requests()
        .into_iter()
        .filter_map(|request| {
            request
                .headers
                .into_iter()
                .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                .map(|(_, value)| value)
        })
        .collect::<Vec<_>>();
    assert_eq!(
        authorizations,
        vec![
            "Bearer sk-wecode-stale".to_owned(),
            "Bearer sk-wecode-fresh".to_owned(),
        ],
        "the retry must carry a freshly traded key"
    );
    assert_eq!(upstream.key_requests().len(), 2);
}

#[tokio::test]
async fn persistent_upstream_401_is_reported_after_one_retry() {
    let upstream = start_upstream(ScriptedResponse::raw(401, "unauthorized")).await;
    let token = register_route(&upstream, "http-tests-rekey-failed");
    let (status, payload) = send(
        enabled_app(&upstream),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(error_code(&payload), "upstream_rejected");
    assert_eq!(
        (upstream.requests().len(), upstream.key_requests().len()),
        (2, 2)
    );
}

#[tokio::test]
async fn failed_exchange_answers_503_without_calling_upstream() {
    let upstream = start_backend(
        Script::from(ScriptedResponse::json(200, json!({"answers": {}}))),
        Script::from(ScriptedResponse::json(500, json!({"detail": "boom"}))),
    )
    .await;
    let token = register_route(&upstream, "http-tests-credential");
    let (status, payload) = send(
        enabled_app(&upstream),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&payload), "credential_unavailable");
    assert_eq!(upstream.requests().len(), 0);
}

#[tokio::test]
async fn login_routes_follow_the_live_snapshot() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
    let snapshot = Arc::new(Mutex::new(None::<ConnectionConfig>));
    let token = register("http-tests-login", Arc::clone(&snapshot));
    let app = app(
        DecisionProxyConfig::Enabled(settings(&upstream.url)),
        UPSTREAM_TIMEOUT,
    );

    let (status, payload) = send(
        app.clone(),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(error_code(&payload), "credential_unavailable");
    assert_eq!(
        upstream.key_requests().len(),
        0,
        "no login token means no exchange"
    );

    *snapshot.lock().expect("snapshot lock") = Some(ConnectionConfig {
        backend_url: upstream.backend_url.clone(),
        socket_url: String::new(),
        auth_token: "first-token".to_owned(),
        runtime_auth_token: String::new(),
    });
    let (status, _) = send(
        app.clone(),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        upstream.header("authorization").as_deref(),
        Some(format!("Bearer {EXCHANGED_KEY}").as_str())
    );
    assert_eq!(
        upstream.last_key_authorization().as_deref(),
        Some("Bearer first-token")
    );

    *snapshot.lock().expect("snapshot lock") = Some(ConnectionConfig {
        backend_url: upstream.backend_url.clone(),
        socket_url: String::new(),
        auth_token: "rotated-token".to_owned(),
        runtime_auth_token: String::new(),
    });
    let (status, _) = send(
        app,
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        upstream.last_key_authorization().as_deref(),
        Some("Bearer rotated-token"),
        "a new login token must be traded again instead of reusing the cache"
    );
    assert_eq!(
        upstream.header("authorization").as_deref(),
        Some(format!("Bearer {EXCHANGED_KEY}").as_str())
    );
}

#[tokio::test]
async fn released_route_stops_authenticating() {
    let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
    let token = register_route(&upstream, "http-tests-release");
    let app = enabled_app(&upstream);
    let (status, _) = send(
        app.clone(),
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    unregister(&token);
    let (status, payload) = send(
        app,
        decision_request(
            &token,
            Some(&local_marker()),
            Some("application/json"),
            json_body(valid_body()),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(error_code(&payload), "route_not_found");
}
