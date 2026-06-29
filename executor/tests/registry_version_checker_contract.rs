// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Arc, Mutex};

use axum::{http::HeaderMap, routing::get, Json, Router};
use serde_json::json;
use tokio::net::TcpListener;
use wegent_executor::services::updater::RegistryVersionChecker;

#[derive(Clone, Default)]
struct RequestLog {
    auth_headers: Arc<Mutex<Vec<String>>>,
}

#[test]
fn registry_init_without_token() {
    let checker = RegistryVersionChecker::new("https://example.com/ai-tool-box", None);

    assert_eq!(checker.registry_url(), "https://example.com/ai-tool-box");
    assert_eq!(checker.auth_token(), None);
}

#[test]
fn registry_init_with_custom_token() {
    let checker =
        RegistryVersionChecker::new("https://example.com/ai-tool-box", Some("custom_token"));

    assert_eq!(checker.registry_url(), "https://example.com/ai-tool-box");
    assert_eq!(checker.auth_token(), Some("custom_token"));
}

#[test]
fn registry_builds_update_json_url_from_base() {
    let checker = RegistryVersionChecker::new("https://example.com/registry", None);

    assert_eq!(
        checker.build_api_url_for("wegent-executor-macos-arm64"),
        "https://example.com/registry/wegent-executor-macos-arm64/update.json"
    );
}

#[test]
fn registry_trims_trailing_slash() {
    let checker = RegistryVersionChecker::new("https://example.com/registry/", None);

    assert_eq!(
        checker.build_api_url_for("wegent-executor-linux-amd64"),
        "https://example.com/registry/wegent-executor-linux-amd64/update.json"
    );
}

#[test]
fn registry_keeps_complete_update_json_url() {
    let checker = RegistryVersionChecker::new(
        "https://example.com/registry/wegent-executor-linux-amd64/update.json",
        None,
    );

    assert_eq!(
        checker.build_api_url_for("wegent-executor-macos-arm64"),
        "https://example.com/registry/wegent-executor-linux-amd64/update.json"
    );
}

#[test]
fn registry_keeps_url_ending_with_update_json() {
    let checker = RegistryVersionChecker::new("https://example.com/some/path/update.json", None);

    assert_eq!(
        checker.build_api_url_for("wegent-executor-macos-arm64"),
        "https://example.com/some/path/update.json"
    );
}

#[test]
fn registry_keeps_url_containing_binary_path() {
    let checker = RegistryVersionChecker::new(
        "https://example.com/registry/wegent-executor-linux-amd64",
        None,
    );

    assert_eq!(
        checker.build_api_url_for("wegent-executor-macos-arm64"),
        "https://example.com/registry/wegent-executor-linux-amd64"
    );
}

#[test]
fn registry_builds_url_for_supplied_binary_name() {
    let checker = RegistryVersionChecker::new("https://example.com/registry", None);

    assert_eq!(
        checker.build_api_url_for("wegent-executor-linux-arm64"),
        "https://example.com/registry/wegent-executor-linux-arm64/update.json"
    );
}

#[tokio::test]
async fn registry_returns_update_when_remote_is_newer() {
    let (base_url, _log) = registry_server(json!({
        "version": "1.6.6",
        "url": "https://example.com/download"
    }))
    .await;
    let checker = RegistryVersionChecker::new(&base_url, None);

    let update = checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-linux-amd64")
        .await
        .unwrap();

    assert_eq!(update.version, "1.6.6");
    assert_eq!(update.download_url, "https://example.com/download");
}

#[tokio::test]
async fn registry_returns_none_when_already_latest() {
    let (base_url, _log) = registry_server(json!({
        "version": "1.6.6",
        "url": "https://example.com/download"
    }))
    .await;
    let checker = RegistryVersionChecker::new(&base_url, None);

    assert!(checker
        .check_for_updates_for_binary("1.6.6", "wegent-executor-linux-amd64")
        .await
        .is_none());
}

#[tokio::test]
async fn registry_returns_none_when_current_is_ahead() {
    let (base_url, _log) = registry_server(json!({
        "version": "1.6.6",
        "url": "https://example.com/download"
    }))
    .await;
    let checker = RegistryVersionChecker::new(&base_url, None);

    assert!(checker
        .check_for_updates_for_binary("2.0.0", "wegent-executor-linux-amd64")
        .await
        .is_none());
}

#[tokio::test]
async fn registry_returns_none_for_missing_version_or_url() {
    let (base_url, _log) = registry_server(json!({"version": "1.6.6"})).await;
    let checker = RegistryVersionChecker::new(&base_url, None);
    assert!(checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-linux-amd64")
        .await
        .is_none());

    let (base_url, _log) = registry_server(json!({"url": "https://example.com/download"})).await;
    let checker = RegistryVersionChecker::new(&base_url, None);
    assert!(checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-linux-amd64")
        .await
        .is_none());
}

#[tokio::test]
async fn registry_sends_private_token_header_when_token_provided() {
    let (base_url, log) = registry_server(json!({
        "version": "1.6.6",
        "url": "https://example.com/download"
    }))
    .await;
    let checker = RegistryVersionChecker::new(&base_url, Some("my_token"));

    let _ = checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-linux-amd64")
        .await;

    assert_eq!(log.auth_headers.lock().unwrap().as_slice(), ["my_token"]);
}

#[tokio::test]
async fn registry_omits_private_token_header_without_token() {
    let (base_url, log) = registry_server(json!({
        "version": "1.6.6",
        "url": "https://example.com/download"
    }))
    .await;
    let checker = RegistryVersionChecker::new(&base_url, None);

    let _ = checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-linux-amd64")
        .await;

    assert_eq!(log.auth_headers.lock().unwrap().as_slice(), [""]);
}

#[tokio::test]
async fn registry_returns_none_on_http_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let app = Router::new().route(
            "/wegent-executor-linux-amd64/update.json",
            get(|| async { axum::http::StatusCode::INTERNAL_SERVER_ERROR }),
        );
        axum::serve(listener, app).await.unwrap();
    });
    let checker = RegistryVersionChecker::new(&base_url, None);

    assert!(checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-linux-amd64")
        .await
        .is_none());
}

async fn registry_server(response: serde_json::Value) -> (String, RequestLog) {
    let log = RequestLog::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/wegent-executor-linux-amd64/update.json",
        get({
            let log = log.clone();
            move |headers: HeaderMap| {
                let response = response.clone();
                async move {
                    log.auth_headers.lock().unwrap().push(
                        headers
                            .get("private-token")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or("")
                            .to_owned(),
                    );
                    Json(response)
                }
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (base_url, log)
}
