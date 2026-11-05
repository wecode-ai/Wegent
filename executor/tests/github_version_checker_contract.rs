// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Arc, Mutex};

use axum::{extract::Query, http::HeaderMap, routing::get, Json, Router};
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpListener;
use wegent_executor::services::updater::GithubVersionChecker;

#[derive(Clone, Default)]
struct RequestLog {
    accept_headers: Arc<Mutex<Vec<String>>>,
    auth_headers: Arc<Mutex<Vec<String>>>,
    pages: Arc<Mutex<Vec<usize>>>,
    user_agents: Arc<Mutex<Vec<String>>>,
}

#[test]
fn github_init_without_token() {
    let checker = GithubVersionChecker::new(None);

    assert_eq!(checker.github_token(), None);
}

#[test]
fn github_init_with_token() {
    let checker = GithubVersionChecker::new(Some("ghp_test_token"));

    assert_eq!(checker.github_token(), Some("ghp_test_token"));
}

#[tokio::test]
async fn github_returns_update_for_matching_asset() {
    let (api_base, _log) = github_server(release_json("v1.6.6")).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", &api_base);

    let update = checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-macos-arm64")
        .await
        .unwrap();

    assert_eq!(update.version, "1.6.6");
    assert!(update.download_url.contains("wegent-executor-macos-arm64"));
}

#[tokio::test]
async fn github_strips_v_prefix_from_tag() {
    let (api_base, _log) = github_server(release_json("1.6.6")).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", &api_base);

    let update = checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-macos-arm64")
        .await
        .unwrap();

    assert_eq!(update.version, "1.6.6");
}

#[tokio::test]
async fn github_returns_none_when_already_latest_or_ahead() {
    let (api_base, _log) = github_server(release_json("v1.6.6")).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", &api_base);
    assert!(checker
        .check_for_updates_for_binary("1.6.6", "wegent-executor-macos-arm64")
        .await
        .is_none());

    let (api_base, _log) = github_server(release_json("v1.6.6")).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", &api_base);
    assert!(checker
        .check_for_updates_for_binary("2.0.0", "wegent-executor-macos-arm64")
        .await
        .is_none());
}

#[tokio::test]
async fn github_returns_none_when_platform_asset_missing() {
    let (api_base, _log) = github_server(release_json("v1.6.6")).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", &api_base);

    assert!(checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-freebsd-amd64")
        .await
        .is_none());
}

#[tokio::test]
async fn github_sends_accept_header_and_no_auth_without_token() {
    let (api_base, log) = github_server(release_json("v1.0.0")).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", &api_base);

    let _ = checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-macos-arm64")
        .await;

    assert_eq!(
        log.accept_headers.lock().unwrap().as_slice(),
        ["application/vnd.github+json"]
    );
    assert_eq!(log.auth_headers.lock().unwrap().as_slice(), [""]);
    assert!(log.user_agents.lock().unwrap()[0].starts_with("wegent-executor/"));
}

#[tokio::test]
async fn github_sends_bearer_token_when_configured() {
    let (api_base, log) = github_server(release_json("v1.0.0")).await;
    let checker =
        GithubVersionChecker::with_api_base(Some("ghp_test_token"), "wecode-ai/Wegent", &api_base);

    let _ = checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-macos-arm64")
        .await;

    assert_eq!(
        log.auth_headers.lock().unwrap().as_slice(),
        ["Bearer ghp_test_token"]
    );
}

#[tokio::test]
async fn github_returns_none_on_http_error() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let app = Router::new().route(
            "/repos/wecode-ai/Wegent/releases",
            get(|| async { axum::http::StatusCode::FORBIDDEN }),
        );
        axum::serve(listener, app).await.unwrap();
    });
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", &api_base);

    assert!(checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-macos-arm64")
        .await
        .is_none());
}

async fn github_server(response: serde_json::Value) -> (String, RequestLog) {
    let releases = if response.is_array() {
        response
    } else {
        json!([response])
    };
    github_pages_server(vec![releases]).await
}

#[derive(Deserialize)]
struct ReleaseQuery {
    page: usize,
    per_page: usize,
}

async fn github_pages_server(pages: Vec<serde_json::Value>) -> (String, RequestLog) {
    let log = RequestLog::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_base = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/repos/wecode-ai/Wegent/releases",
        get({
            let log = log.clone();
            move |headers: HeaderMap, Query(query): Query<ReleaseQuery>| {
                assert_eq!(query.per_page, 100);
                let response = pages
                    .get(query.page - 1)
                    .cloned()
                    .unwrap_or_else(|| json!([]));
                async move {
                    log.pages.lock().unwrap().push(query.page);
                    log.user_agents.lock().unwrap().push(
                        headers
                            .get("user-agent")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or("")
                            .to_owned(),
                    );
                    log.accept_headers.lock().unwrap().push(
                        headers
                            .get("accept")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or("")
                            .to_owned(),
                    );
                    log.auth_headers.lock().unwrap().push(
                        headers
                            .get("authorization")
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
    (api_base, log)
}

fn mixed_releases() -> serde_json::Value {
    serde_json::from_str(include_str!(
        "../../.github/fixtures/executor-platform-releases.json"
    ))
    .unwrap()
}

#[tokio::test]
async fn github_selects_platform_release_instead_of_desktop_draft_or_prerelease() {
    let (api_base, log) = github_server(mixed_releases()).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", api_base);
    let update = checker
        .check_for_updates_for_binary("2.0.24", "wegent-executor-macos-arm64")
        .await
        .unwrap();
    assert_eq!(update.version, "2.0.25");
    assert!(update.download_url.contains("/v2.0.25/"));
    assert_eq!(*log.pages.lock().unwrap(), vec![1]);
}

#[tokio::test]
async fn github_resolves_windows_executable_from_registry_package_identity() {
    let (api_base, _) = github_server(mixed_releases()).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", api_base);
    let update = checker
        .check_for_updates_for_binary("2.0.24", "wegent-executor-windows-amd64")
        .await
        .unwrap();
    assert!(update
        .download_url
        .ends_with("wegent-executor-windows-amd64.exe"));
}

#[tokio::test]
async fn github_paginates_past_a_full_page_of_desktop_releases() {
    let fixture = mixed_releases();
    let desktop = fixture[0].clone();
    let (api_base, log) = github_pages_server(vec![json!(vec![desktop; 100]), fixture]).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", api_base);
    let update = checker
        .check_for_updates_for_binary("2.0.24", "wegent-executor-linux-amd64")
        .await
        .unwrap();
    assert_eq!(update.version, "2.0.25");
    assert_eq!(*log.pages.lock().unwrap(), vec![1, 2]);
}

#[tokio::test]
async fn github_does_not_install_an_older_release_when_the_newest_asset_is_missing() {
    let mut fixture = mixed_releases();
    fixture[3]["assets"] = json!([]);
    let (api_base, _) = github_server(fixture).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", api_base);
    assert!(checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-macos-arm64")
        .await
        .is_none());
}

#[tokio::test]
async fn github_returns_none_without_a_stable_platform_release() {
    let fixture = mixed_releases().as_array().unwrap()[..3].to_vec();
    let (api_base, log) = github_server(json!(fixture)).await;
    let checker = GithubVersionChecker::with_api_base(None, "wecode-ai/Wegent", api_base);
    assert!(checker
        .check_for_updates_for_binary("1.0.0", "wegent-executor-macos-arm64")
        .await
        .is_none());
    assert_eq!(*log.pages.lock().unwrap(), vec![1]);
}

fn release_json(tag_name: &str) -> serde_json::Value {
    json!({
        "tag_name": tag_name,
        "name": "Release",
        "assets": [
            {
                "name": "wegent-executor-macos-arm64",
                "browser_download_url": "https://github.com/wecode-ai/Wegent/releases/download/v1.6.6/wegent-executor-macos-arm64"
            },
            {
                "name": "wegent-executor-linux-amd64",
                "browser_download_url": "https://github.com/wecode-ai/Wegent/releases/download/v1.6.6/wegent-executor-linux-amd64"
            }
        ]
    })
}
