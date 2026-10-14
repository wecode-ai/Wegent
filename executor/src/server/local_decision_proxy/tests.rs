// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Configuration and state tests for the decision proxy.

use std::collections::HashMap;

use super::*;

const VALID_UPSTREAM: &str = "https://decision-upstream.example.com/v1/decisions";

fn config_from(entries: &[(&str, &str)]) -> Result<DecisionProxyConfig, DecisionProxyConfigError> {
    let map: HashMap<String, String> = entries
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    DecisionProxyConfig::from_lookup(|name| map.get(name).cloned())
}

fn enabled_settings(entries: &[(&str, &str)]) -> DecisionProxySettings {
    match config_from(entries).expect("config must be valid") {
        DecisionProxyConfig::Enabled(settings) => settings,
        DecisionProxyConfig::Unconfigured => panic!("expected a configured router"),
    }
}

fn upstream_entries(upstream: &str) -> [(&str, &str); 2] {
    [(ENV_UPSTREAM_URL, upstream), (ENV_DEFAULT_MODEL, "model-a")]
}

fn model_entries(default: &str) -> [(&str, &str); 2] {
    [
        (ENV_UPSTREAM_URL, VALID_UPSTREAM),
        (ENV_DEFAULT_MODEL, default),
    ]
}

#[test]
fn empty_environment_is_unconfigured_rather_than_disabled() {
    let error = config_from(&[]).expect_err("upstream is required");
    assert_eq!(error.reason(), "missing_upstream_url");
}

#[test]
fn enabled_without_upstream_is_invalid() {
    let error = config_from(&[(ENV_DEFAULT_MODEL, "model-a")])
        .expect_err("upstream is required when enabled");
    assert_eq!(error.reason(), "missing_upstream_url");
}

#[test]
fn upstream_must_be_a_plain_https_decisions_url() {
    for upstream in [
        "http://decision-upstream.example.com/v1/decisions",
        "ftp://decision-upstream.example.com/v1/decisions",
        "https://user:secret@decision-upstream.example.com/v1/decisions",
        "https://decision-upstream.example.com/v1/decisions?x=1",
        "https://decision-upstream.example.com/v1/decisions#fragment",
        "https://decision-upstream.example.com/v1/decisions/",
        "https://decision-upstream.example.com/v1/other",
        "https://decision-upstream.example.com/",
        "not-a-url",
    ] {
        let error = config_from(&upstream_entries(upstream)).expect_err(upstream);
        assert_eq!(
            error.reason(),
            "invalid_upstream_url",
            "upstream={upstream}"
        );
    }
}

#[test]
fn any_https_host_is_accepted_because_the_deployment_owns_the_upstream() {
    for upstream in [
        "https://decision-upstream.example.com/v1/decisions",
        "https://decisions-eu.example.net:8443/v1/decisions",
    ] {
        let settings = enabled_settings(&upstream_entries(upstream));
        assert_eq!(settings.upstream_url.as_str(), upstream);
    }
}

#[test]
fn default_model_must_be_present_and_non_blank() {
    for default in ["", "   "] {
        let error = config_from(&model_entries(default)).expect_err("blank default model");
        assert_eq!(
            error.reason(),
            "missing_default_model",
            "default={default:?}"
        );
    }
    let error =
        config_from(&[(ENV_UPSTREAM_URL, VALID_UPSTREAM)]).expect_err("missing default model");
    assert_eq!(error.reason(), "missing_default_model");
}

#[test]
fn default_model_must_use_the_supported_identifier_shape() {
    for default in [
        "decision model",
        "decision?model",
        "决策模型",
        &"x".repeat(MAX_MODEL_LENGTH + 1),
    ] {
        let error = config_from(&model_entries(default)).expect_err("invalid default model");
        assert_eq!(
            error.reason(),
            "invalid_default_model",
            "default={default:?}"
        );
    }
}

#[test]
fn default_model_accepts_every_supported_identifier_separator() {
    let default = "vendor/model.preview_v1:latest";
    let settings = enabled_settings(&model_entries(default));
    assert_eq!(settings.default_model, default);
}

#[test]
fn valid_config_parses_into_stable_settings() {
    let entries = model_entries("model-a");
    let first = enabled_settings(&entries);
    let second = enabled_settings(&entries);
    assert_eq!(first, second);
    assert_eq!(first.upstream_url.as_str(), VALID_UPSTREAM);
    assert_eq!(first.default_model, "model-a");
    assert_eq!(
        first.models,
        vec![DecisionModel {
            id: "model-a".to_owned(),
            display_name: "model-a".to_owned(),
        }]
    );
}

#[test]
fn config_error_display_never_leaks_the_upstream_value() {
    let error = config_from(&upstream_entries(
        "https://user:secret@decision-upstream.example.com/v1/decisions",
    ))
    .expect_err("invalid upstream");
    let text = error.to_string();
    assert!(!text.contains("secret"), "error leaked a value: {text}");
    assert!(
        !text.contains("decision-upstream.example.com"),
        "error leaked a value: {text}"
    );
}

#[test]
fn safe_url_strips_credentials_query_and_fragment() {
    let url = url::Url::parse("https://user:secret@example.com:8443/v1/decisions?x=1#frag")
        .expect("parse url");
    let safe = safe_url(&url);
    assert_eq!(safe, "https://example.com:8443/v1/decisions");
    assert!(!safe.contains("secret"));
    assert!(!safe.contains("x=1"));
}

#[derive(Clone)]
struct NoopRunner;

impl crate::server::TaskRunner for NoopRunner {
    type SubmitFuture = std::future::Ready<crate::server::RunnerResult>;

    fn submit(&self, _request: crate::protocol::ExecutionRequest) -> Self::SubmitFuture {
        std::future::ready(crate::server::RunnerResult {
            status: crate::protocol::TaskStatus::Failed,
            message: Some("noop runner".to_owned()),
        })
    }
}

/// The served router extracts `DecisionProxyState` from `AppState` for every
/// request. Building a fresh exchanger there would trade the login token on
/// every decision request instead of reusing the cached credential.
#[tokio::test]
async fn every_request_shares_the_process_runtime() {
    let state = crate::server::AppState::new(NoopRunner);
    let first: DecisionProxyState = FromRef::from_ref(&state);
    let second: DecisionProxyState = FromRef::from_ref(&state);
    assert!(
        Arc::ptr_eq(&first.runtime, &second.runtime),
        "each request must reuse the process-wide credential cache and client"
    );
}
