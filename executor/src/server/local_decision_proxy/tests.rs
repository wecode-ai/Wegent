// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn backend_urls_preserve_deployment_prefix_and_normalize_api() {
    for (base, expected) in [
        (
            "https://example.com",
            "https://example.com/api/models/decisions",
        ),
        (
            "https://example.com/api/",
            "https://example.com/api/models/decisions",
        ),
        (
            "https://example.com/work",
            "https://example.com/work/api/models/decisions",
        ),
    ] {
        assert_eq!(backend_url(base).unwrap().as_str(), expected);
    }
    for base in [
        "",
        "file:///etc/passwd",
        "ftp://example.com",
        "https://user:pass@example.com",
    ] {
        assert!(backend_url(base).is_none());
    }
}

#[test]
fn model_ids_and_local_authorization_are_validated() {
    assert!(is_valid_model("model-a"));
    for model in ["", " ", "model?endpoint", &"x".repeat(129)] {
        assert!(!is_valid_model(model));
    }
    let mut headers = HeaderMap::new();
    for value in [
        "Bearer wrong",
        "Bearer wework-local-router extra",
        "Basic abc",
    ] {
        headers.insert(header::AUTHORIZATION, value.parse().unwrap());
        assert!(!has_local_marker(&headers));
    }
}

#[derive(Clone)]
struct NoopRunner;

impl crate::server::TaskRunner for NoopRunner {
    type SubmitFuture = std::future::Ready<crate::server::RunnerResult>;

    fn submit(&self, _: crate::protocol::ExecutionRequest) -> Self::SubmitFuture {
        std::future::ready(crate::server::RunnerResult {
            status: crate::protocol::TaskStatus::Failed,
            message: None,
        })
    }
}

#[test]
fn every_request_reuses_the_backend_http_pool() {
    let state = crate::server::AppState::new(NoopRunner);
    let first: DecisionProxyState = FromRef::from_ref(&state);
    let second: DecisionProxyState = FromRef::from_ref(&state);
    assert!(Arc::ptr_eq(&first.runtime, &second.runtime));
}
