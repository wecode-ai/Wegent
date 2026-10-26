// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::ExecutorManager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn delete_response(status: &str, body: &str) -> anyhow::Result<()> {
    delete_response_after(status, body, std::time::Duration::ZERO).await
}

async fn delete_response_after(
    status: &str,
    body: &str,
    delay: std::time::Duration,
) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let manager =
        ExecutorManager::new(format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0, "delete request must finish before closing");
            request.extend_from_slice(&chunk[..count]);
            if let Some(end) = request.windows(4).position(|value| value == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    let payload: serde_json::Value =
                        serde_json::from_slice(&request[end + 4..]).unwrap();
                    assert_eq!(payload["executor_name"], "fixture-executor");
                    assert_eq!(payload["executor_namespace"], "fixture-namespace");
                    break;
                }
            }
        }
        assert!(request.starts_with(b"POST /executor-manager/executor/delete "));
        tokio::time::sleep(delay).await;
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    let result = manager
        .delete_executor_task("fixture-executor", "fixture-namespace")
        .await;
    server.await.unwrap();
    result
}

#[tokio::test]
async fn executor_delete_allows_reads_beyond_the_sdk_default_within_its_deadline() {
    delete_response_after(
        "200 OK",
        r#"{"status":"success"}"#,
        std::time::Duration::from_millis(700),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn executor_delete_accepts_only_confirmed_deletion_or_absence() {
    for body in [
        r#"{"status":"success"}"#,
        r#"{"status":"not_found"}"#,
        "true",
    ] {
        delete_response("200 OK", body).await.unwrap();
    }
}

#[tokio::test]
async fn executor_delete_rejects_http_200_business_failure_or_invalid_result() {
    for body in [
        r#"{"status":"failed","error_msg":"Kubernetes API unavailable"}"#,
        r#"{"status":"pending"}"#,
        "{}",
        "false",
        "null",
        "not-json",
    ] {
        assert!(delete_response("200 OK", body).await.is_err(), "{body}");
    }
}

#[tokio::test]
async fn executor_delete_rejects_http_error_even_with_success_body() {
    let error = delete_response("503 Service Unavailable", r#"{"status":"success"}"#)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("HTTP 503"));
}
