// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{http::HeaderMap, response::IntoResponse, routing::get, Router};
use tokio::net::TcpListener;
use wegent_executor::services::updater::BinaryReplacer;

#[derive(Clone, Default)]
struct DownloadLog {
    private_tokens: Arc<Mutex<Vec<String>>>,
}

#[test]
fn binary_replacer_initializes_with_download_url_and_token() {
    let replacer = BinaryReplacer::new("https://example.com/download", Some("token123"));

    assert_eq!(replacer.download_url(), "https://example.com/download");
    assert_eq!(replacer.auth_token(), Some("token123"));
}

#[tokio::test]
async fn download_binary_streams_to_temp_file_with_private_token_and_progress() {
    let (download_url, log) = download_server(axum::http::StatusCode::OK, b"chunk1chunk2").await;
    let target_dir = unique_dir("binary-download");
    let replacer = BinaryReplacer::new(&download_url, Some("token123"));
    let progress = Arc::new(Mutex::new(Vec::new()));

    let downloaded = replacer
        .download_binary_to(&target_dir, {
            let progress = progress.clone();
            move |downloaded, total| {
                progress.lock().unwrap().push((downloaded, total));
            }
        })
        .await
        .unwrap();

    assert_eq!(fs::read(downloaded).unwrap(), b"chunk1chunk2");
    assert_eq!(log.private_tokens.lock().unwrap().as_slice(), ["token123"]);
    assert_eq!(progress.lock().unwrap().last(), Some(&(12, Some(12))));
}

#[tokio::test]
async fn download_binary_reports_http_errors() {
    let (download_url, _log) = download_server(axum::http::StatusCode::NOT_FOUND, b"missing").await;
    let replacer = BinaryReplacer::new(&download_url, None);

    let error = replacer
        .download_binary_to(&unique_dir("binary-http-error"), |_downloaded, _total| {})
        .await
        .unwrap_err();

    assert!(error.to_string().contains("Failed to download binary"));
}

#[test]
fn replace_binary_creates_backup_sets_executable_permissions_and_replaces_atomically() {
    let root = unique_dir("binary-replace");
    let current = root.join("wegent-executor");
    let new_binary = root.join("new-binary");
    fs::write(&current, b"old").unwrap();
    fs::write(&new_binary, b"new").unwrap();

    let replacer = BinaryReplacer::new("https://example.com/download", None);

    assert!(replacer.replace_binary(&new_binary, &current));
    assert_eq!(fs::read(&current).unwrap(), b"new");
    assert_eq!(
        fs::read(root.join("wegent-executor.backup")).unwrap(),
        b"old"
    );
    assert_eq!(
        fs::metadata(&current).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert!(!new_binary.exists());
}

#[test]
fn cleanup_backup_succeeds_when_backup_exists_or_is_missing() {
    let root = unique_dir("binary-cleanup");
    let current = root.join("wegent-executor");
    fs::write(root.join("wegent-executor.backup"), b"old").unwrap();
    let replacer = BinaryReplacer::new("https://example.com/download", None);

    assert!(replacer.cleanup_backup(&current));
    assert!(!root.join("wegent-executor.backup").exists());
    assert!(replacer.cleanup_backup(&current));
}

#[test]
fn format_progress_bar_matches_legacy_display_shape() {
    let half = BinaryReplacer::format_progress_bar(25 * 1024 * 1024, Some(50 * 1024 * 1024), 40);
    assert!(half.contains("50%"));
    assert!(half.contains("25 MB / 50 MB"));
    assert!(half.contains('['));
    assert!(half.contains(']'));

    let unknown = BinaryReplacer::format_progress_bar(25 * 1024 * 1024, None, 40);
    assert!(unknown.contains("25 MB downloaded"));
    assert!(unknown.contains('['));
    assert!(unknown.contains(']'));

    let full = BinaryReplacer::format_progress_bar(50 * 1024 * 1024, Some(50 * 1024 * 1024), 40);
    assert!(full.contains("100%"));
    assert!(full.contains("50 MB / 50 MB"));
}

async fn download_server(
    status: axum::http::StatusCode,
    body: &'static [u8],
) -> (String, DownloadLog) {
    let log = DownloadLog::default();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let download_url = format!("http://{}/download", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/download",
        get({
            let log = log.clone();
            move |headers: HeaderMap| async move {
                log.private_tokens.lock().unwrap().push(
                    headers
                        .get("private-token")
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("")
                        .to_owned(),
                );
                (status, [("content-length", body.len().to_string())], body).into_response()
            }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (download_url, log)
}

fn unique_dir(prefix: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("{prefix}-{suffix}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}
