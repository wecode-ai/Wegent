// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use brz_http::Method;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

fn scrape() -> String {
    let mut output = String::new();
    std::io::Read::read_to_string(&mut brz_metrics::PrometheusReader::new(), &mut output).unwrap();
    output
}

async fn serve_objects(listener: TcpListener, count: usize) -> Vec<(String, Vec<u8>)> {
    let mut requests = Vec::new();
    for _ in 0..count {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = BufReader::new(socket);
        let mut request_line = String::new();
        socket.read_line(&mut request_line).await.unwrap();
        let mut length = 0;
        loop {
            let mut header = String::new();
            assert!(socket.read_line(&mut header).await.unwrap() > 0);
            if header == "\r\n" {
                break;
            }
            if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await.unwrap();
        let response_body = if request_line.starts_with("GET ") {
            "object"
        } else {
            ""
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
            response_body.len()
        );
        socket
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
        requests.push((request_line, body));
    }
    requests
}

#[tokio::test]
async fn object_operations_aggregate_metrics_without_changing_wire_requests() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(serve_objects(listener, 8));
    let client = HttpClient::builder()
        .read_timeout(Duration::from_secs(5))
        .configure(|builder| builder.no_proxy())
        .build()
        .unwrap();
    let config = MinioConfig {
        endpoint: origin.clone(),
        access_key: "access".to_string(),
        secret_key: "secret".to_string(),
        bucket: "metrics-objects".to_string(),
        region: "us-east-1".to_string(),
    };
    let keys = [
        "attachments/0a9f6d44e793_20261024225930_256_1422538",
        "users/6519/transcripts/unique-session/中文 file.tgz",
    ];
    for key in keys {
        assert_eq!(
            get_object(&client, &config, key).await.ok().unwrap(),
            b"object"
        );
        assert!(stat_object(&client, &config, key).await.is_ok());
        assert!(put_object(&client, &config, key, b"upload").await.is_ok());
        assert!(delete_object(&client, &config, key).await.is_ok());
    }
    let requests = server.await.unwrap();
    for (index, key) in keys.iter().enumerate() {
        for (offset, method) in ["GET", "HEAD", "PUT", "DELETE"].iter().enumerate() {
            let (line, body) = &requests[index * 4 + offset];
            assert_eq!(
                line,
                &format!(
                    "{method} /metrics-objects/{} HTTP/1.1\r\n",
                    encode_object_path(key)
                )
            );
            assert_eq!(
                body.as_slice(),
                if *method == "PUT" {
                    &b"upload"[..]
                } else {
                    &[]
                }
            );
        }
    }
    let output = scrape();
    let totals: Vec<_> = output
        .lines()
        .filter(|line| line.starts_with("brz_req_total{type=\"HTTP\",") && line.contains(&origin))
        .collect();
    assert_eq!(totals.len(), 4);
    for method in ["GET", "HEAD", "PUT", "DELETE"] {
        let expected = format!(
            "brz_req_total{{type=\"HTTP\",name=\"{method} {origin}/metrics-objects/{{key}}\"}} 2"
        );
        assert!(totals.contains(&expected.as_str()), "{expected}");
    }
    assert!(!output.contains("0a9f6d44e793_20261024225930_256_1422538"));
    assert!(!output.contains("unique-session"));
}

#[test]
fn object_metric_names_exclude_secrets_and_keep_origins_and_buckets_distinct() {
    let client = HttpClient::new();
    let cases = [
        (
            "http://user:password@metrics-s3.invalid:9100/first/users/42/object?signature=secret#part",
            "first",
            "http://metrics-s3.invalid:9100/first/{key}",
        ),
        (
            "http://metrics-s3.invalid:9100/second/workspace-archives/123/archive.tar.gz",
            "second",
            "http://metrics-s3.invalid:9100/second/{key}",
        ),
        (
            "https://metrics-s3.invalid/first/attachments/another-id",
            "first",
            "https://metrics-s3.invalid/first/{key}",
        ),
    ];
    for (url, bucket, name) in cases {
        let request = object_request(&client, Method::HEAD, url, bucket)
            .unwrap()
            .build()
            .unwrap();
        let expected = client.as_reqwest().head(url).build().unwrap();
        assert_eq!(request.url(), expected.url());
        assert_eq!(request.headers(), expected.headers());
        assert_eq!(request.method(), Method::HEAD);
        let output = scrape();
        assert!(output.contains(&format!("name=\"HEAD {name}\"")));
        assert!(!output.contains("user:password@metrics-s3.invalid"));
        assert!(!output.contains("signature=secret"));
        assert!(!output.contains("workspace-archives/123"));
        assert!(!output.contains("another-id"));
    }
}
