// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::http::{Cursor, Http, datetime, retry_after};
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn now() -> NaiveDateTime {
    datetime(&json!("2026-10-23T12:00:00Z"))
        .unwrap()
        .naive_utc()
}

#[test]
fn polling_hashes_sorted_compact_utf8_json_independent_of_map_features() {
    let value: Value = serde_json::from_str(r#"{"z":"你好","a":{"z":[],"a":{}}}"#).unwrap();
    assert_eq!(
        String::from_utf8(payload_bytes(&value)).unwrap(),
        r#"{"a":{"a":{},"z":[]},"z":"你好"}"#
    );
}

#[test]
fn cursors_commit_watermarks_only_after_a_complete_scan_and_overlap_by_two_minutes() {
    let cursor = Cursor::new(
        &json!({"watermark":"2026-10-23T11:00:00Z","scan_started_at":"2026-10-23T12:00:00Z","page":4}),
    );
    assert_eq!(
        cursor.cutoff().unwrap().timestamp(),
        datetime(&json!("2026-10-23T10:58:00Z"))
            .unwrap()
            .timestamp()
    );
    assert_eq!(
        cursor.next(false),
        json!({"watermark":"2026-10-23T11:00:00Z","scan_started_at":"2026-10-23T12:00:00Z","page":5})
    );
    assert_eq!(
        cursor.next(true),
        json!({"watermark":"2026-10-23T12:00:00Z","page":1})
    );
    assert!(!http::after(&json!("invalid"), cursor.cutoff()));
    assert!(http::after(&json!("invalid"), None));
}

#[test]
fn success_clears_failure_and_lease_while_failure_preserves_cursor_and_bounds_backoff() {
    let metadata = json!({"poll":{"cursor":{"page":8},"failure_count":7,"lease_started_at":"old"},"health":{"last_error":"error"}});
    let success = success_metadata(&metadata, now(), 3);
    assert_eq!(success["poll"]["failure_count"], 0);
    assert_eq!(success["poll"]["cursor"]["page"], 8);
    assert!(success["poll"]["lease_started_at"].is_null());
    assert!(success["health"]["last_error"].is_null());
    assert_eq!(success["health"]["status"], "healthy");
    assert_eq!(success["last_event_at"], iso(now()));
    let (failed, delay) = failure_metadata(&metadata, &PollError::new("temporary"), now());
    assert_eq!(failed["poll"]["failure_count"], 8);
    assert_eq!(failed["poll"]["cursor"]["page"], 8);
    assert_eq!(delay, 3600);
    let mut error = PollError::new("limited");
    error.retry_after = Some(24);
    assert_eq!(failure_metadata(&metadata, &error, now()).1, 24);
    assert_eq!(
        failure_metadata(&json!({}), &PollError::new("first"), now()).1,
        60
    );
    let interval = jitter("hook", &success["poll"]);
    assert!((270..=330).contains(&interval));
    assert_eq!(interval, jitter("hook", &success["poll"]));
    assert!(jitter("hook", &json!({"interval_seconds":1})) >= 60);
}

#[test]
fn credential_paths_and_rate_limit_semantics_match_the_source() {
    assert_eq!(
        credentials::host("https://git.example.invalid:8443/path", "gitlab"),
        "git.example.invalid:8443"
    );
    assert_eq!(credentials::host("", "github"), "github.com");
    assert_eq!(
        credentials::yaml_token(
            "hosts:\n  git.example.invalid:\n    token: test-token\n",
            "gitlab",
            "git.example.invalid"
        )
        .as_deref(),
        Some("test-token")
    );
    assert_eq!(
        credentials::yaml_token(
            "github.com:\n  oauth_token: test-token\n",
            "github",
            "github.com"
        )
        .as_deref(),
        Some("test-token")
    );
    assert!(credentials::yaml_token("not: [valid", "github", "github.com").is_none());
    let error=credentials::provider_token("key","gitlab",&json!({"domain":"git.example.invalid","repository":"org/repo","credential":{"version":2,"algorithm":"aes-256-gcm","context":"wrong","nonce":"x","ciphertext":"x"}})).unwrap_err();
    assert!(error.disable);
    assert_eq!(
        error.message,
        "provider credential context does not match project"
    );
    let mut headers = brz_http::reqwest::header::HeaderMap::new();
    headers.insert("retry-after", "999999".parse().unwrap());
    assert_eq!(retry_after(&headers, 100), 86400);
    headers.insert("retry-after", "0".parse().unwrap());
    assert_eq!(retry_after(&headers, 100), 1);
    headers.remove("retry-after");
    headers.insert("x-ratelimit-reset", "150".parse().unwrap());
    assert_eq!(retry_after(&headers, 100), 50);
}

struct Server {
    base: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server(route: fn(&str) -> Value) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = Vec::new();
            loop {
                let mut chunk = [0; 2048];
                let count = socket.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                buffer.extend_from_slice(&chunk[..count]);
                if buffer.windows(4).any(|v| v == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(buffer).unwrap();
            let target = request
                .lines()
                .next()
                .unwrap()
                .split_whitespace()
                .nth(1)
                .unwrap();
            let body = route(target).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    Server { base, task }
}

fn github_route(target: &str) -> Value {
    let url = url::Url::parse(&format!("http://test{target}")).unwrap();
    let path = url.path();
    if path.ends_with("/pulls") {
        if url
            .query_pairs()
            .any(|(k, v)| k == "state" && v == "closed")
        {
            return json!([{"number":2,"merged":true,"merge_commit_sha":"merged-sha","updated_at":"2026-10-23T11:00:00Z"}]);
        }
        return json!([{"number":1,"updated_at":"2026-10-23T11:00:00Z"}]);
    }
    if path.ends_with("/pulls/1") {
        return json!({"number":1,"mergeable":false,"head":{"sha":"head-sha"},"updated_at":"2026-10-23T11:00:00Z","base":{"repo":{"full_name":"org/repo"}}});
    }
    if path.ends_with("/check-runs") {
        return json!({"check_runs":[{"id":5,"status":"completed","conclusion":"failure"}]});
    }
    if path.ends_with("/reviews") {
        return json!([{"id":6,"submitted_at":"2026-10-23T11:00:00Z"}]);
    }
    if path.ends_with("/comments") {
        return json!([{"id":7,"created_at":"2026-10-23T11:00:00Z"}]);
    }
    panic!("unexpected test route: {target}")
}

#[tokio::test]
async fn github_polling_emits_all_incremental_and_merge_health_inputs() {
    let server = server(github_route).await;
    let client = crate::decisions::provider::build_client().unwrap();
    let http = Http {
        client: &client,
        source: "github",
        credential: "test",
    };
    let page = github::fetch(
        &http,
        &json!({"path":"org/repo","instance_url":server.base}),
        &json!({}),
    )
    .await
    .unwrap();
    assert!(page.complete);
    assert_eq!(page.inputs.len(), 6);
    let identities = page
        .inputs
        .iter()
        .map(|v| v.identity.as_str())
        .collect::<Vec<_>>();
    for identity in [
        "pull_request:1:conflict:head-sha",
        "check_run:5:failure:head-sha",
        "pull_request_review:6",
        "issue_comment:7",
        "pull_request_review_comment:7",
        "pull_request:2:merged:merged-sha",
    ] {
        assert!(identities.contains(&identity));
    }
    let check = page
        .inputs
        .iter()
        .find(|v| v.identity.starts_with("check_run"))
        .unwrap();
    assert_eq!(check.payload["check_run"]["pull_requests"][0]["number"], 1);
}

fn gitlab_route(target: &str) -> Value {
    let url = url::Url::parse(&format!("http://test{target}")).unwrap();
    let path = url.path();
    if path.ends_with("/merge_requests") {
        if url
            .query_pairs()
            .any(|(k, v)| k == "state" && v == "merged")
        {
            return json!([{"iid":2,"state":"merged","sha":"merge-sha"}]);
        }
        return json!([{"iid":1,"project_id":42}]);
    }
    if path.ends_with("/merge_requests/1") {
        return json!({"iid":1,"project_id":42,"has_conflicts":true,"sha":"head","source_branch":"feature"});
    }
    if path.ends_with("/pipelines") {
        return json!([{"id":8,"status":"failed","updated_at":"2026-10-23T11:00:00Z"}]);
    }
    if path.ends_with("/notes") {
        return json!([{"id":9,"system":false,"created_at":"2026-10-23T11:00:00Z"},{"id":10,"system":true}]);
    }
    panic!("unexpected test route: {target}")
}

#[tokio::test]
async fn gitlab_polling_emits_conflicts_pipelines_user_notes_and_merges() {
    let server = server(gitlab_route).await;
    let client = crate::decisions::provider::build_client().unwrap();
    let http = Http {
        client: &client,
        source: "gitlab",
        credential: "test",
    };
    let page = gitlab::fetch(
        &http,
        &json!({"path":"org/repo","instance_url":server.base}),
        &json!({}),
    )
    .await
    .unwrap();
    assert!(page.complete);
    assert_eq!(page.inputs.len(), 4);
    let pipeline = page
        .inputs
        .iter()
        .find(|v| v.identity == "pipeline:8:failed")
        .unwrap();
    assert_eq!(pipeline.payload["object_attributes"]["sha"], "head");
    assert_eq!(pipeline.payload["object_attributes"]["ref"], "feature");
    assert!(
        page.inputs
            .iter()
            .any(|v| v.identity == "merge_request:2:merged:merge-sha")
    );
}
