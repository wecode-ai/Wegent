// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::{
    llm_proxy::{CredentialRequest, LlmProxyCredentials, model_config::ModelConfig},
    models_unified::mysql::UserRow,
};
use async_trait::async_trait;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[derive(Default)]
struct Credentials {
    calls: Mutex<Vec<(i64, String, Option<String>)>>,
    result: Option<&'static str>,
    pending: bool,
}

#[async_trait]
impl LlmProxyCredentials for Credentials {
    async fn provider_api_key(
        &self,
        request: CredentialRequest<'_>,
    ) -> Result<String, FastApiError> {
        self.calls.lock().unwrap().push((
            request.user_id,
            request.user_name.into(),
            request.api_key_template.map(str::to_owned),
        ));
        if self.pending {
            std::future::pending::<()>().await;
        }
        self.result
            .map(str::to_owned)
            .ok_or_else(FastApiError::internal)
    }
}

fn user() -> UserRow {
    UserRow {
        id: 17,
        user_name: "caller".into(),
        email: None,
        git_info: None,
        is_active: true,
        role: "user".into(),
        auth_source: "password".into(),
        preferences: None,
    }
}

fn config() -> ModelConfig {
    ModelConfig {
        api_key: "core-value".into(),
        api_key_template: Some("${deployment.user_key}".into()),
        base_url: "unused".into(),
        model_id: "provider-model".into(),
        default_headers: vec![
            ("AUTHORIZATION".into(), "wrong-key".into()),
            ("Cookie".into(), "private".into()),
            ("x-request-id".into(), "wrong-id".into()),
            ("x-tenant".into(), "caller".into()),
        ],
        ..Default::default()
    }
}

type CapturedRequests = Arc<Mutex<Vec<Vec<u8>>>>;

async fn server(
    status: u16,
    body: Vec<u8>,
    chunked: bool,
) -> (String, CapturedRequests, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/decisions", listener.local_addr().unwrap());
    let captured: CapturedRequests = Arc::default();
    let capture = Arc::clone(&captured);
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0; 4096];
        loop {
            let size = stream.read(&mut buf).await.unwrap();
            if size == 0 {
                return;
            }
            bytes.extend_from_slice(&buf[..size]);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .unwrap()
                    .trim()
                    .parse::<usize>()
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        capture.lock().unwrap().push(bytes);
        let header = if chunked {
            "transfer-encoding: chunked".into()
        } else {
            format!("content-length: {}", body.len())
        };
        let head = format!(
            "HTTP/1.1 {status} Test\r\n{header}\r\ncontent-type: application/json\r\nlocation: /redirect-must-not-be-followed\r\nconnection: close\r\n\r\n"
        );
        stream.write_all(head.as_bytes()).await.unwrap();
        if chunked {
            for chunk in body.chunks(16384) {
                if stream
                    .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
                    .await
                    .is_err()
                {
                    return;
                }
                if stream.write_all(chunk).await.is_err() {
                    return;
                }
                if stream.write_all(b"\r\n").await.is_err() {
                    return;
                }
            }
            let _ = stream.write_all(b"0\r\n\r\n").await;
        } else {
            let _ = stream.write_all(&body).await;
        }
    });
    (url, captured, task)
}

#[tokio::test]
async fn execution_resolves_for_caller_preserves_template_and_strips_protected_headers() {
    let body = serde_json::to_vec(&json!({"answers":[{"name":"urgent", "type":"predicate", "probability":0.9, "secret":"private"}], "debug":"private"})).unwrap();
    let (url, captured, task) = server(200, body, true).await;
    let credentials = Credentials {
        result: Some(" resolved-key "),
        ..Default::default()
    };
    let config = config();
    let user = user();
    let client = provider::build_client().unwrap();
    let execution = provider::Execution {
        client: &client,
        credentials: &credentials,
        user: &user,
        config: &config,
        endpoint: &url,
        protocol: protocol::Protocol::OpenAi,
    };
    let result = execution
        .run(&tests::request(), "decision_test", Duration::from_secs(1))
        .await
        .unwrap();
    task.await.unwrap();
    assert_eq!(
        result["answers"]["urgent"],
        json!({"type":"noul", "noul":0.9})
    );
    assert_eq!(result["request_id"], "decision_test");
    assert!(result["latency_ms"].is_u64());
    assert!(!result.to_string().contains("private"));
    assert_eq!(
        *credentials.calls.lock().unwrap(),
        vec![(17, "caller".into(), Some("${deployment.user_key}".into()))]
    );
    let captured = captured.lock().unwrap();
    assert_eq!(captured.len(), 1);
    let sent = String::from_utf8_lossy(&captured[0]);
    assert!(sent.contains("authorization: Bearer resolved-key\r\n"));
    assert!(sent.contains("x-tenant: caller\r\n"));
    assert!(sent.contains("x-request-id: decision_test\r\n"));
    for secret in [
        "wrong-key",
        "private",
        "wrong-id",
        "core-value",
        "deployment.user_key",
    ] {
        assert!(!sent.contains(secret));
    }
    let payload: Value = serde_json::from_str(sent.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(payload["model"], "provider-model");
    assert_eq!(payload["input"], "{\"comment\": \"urgent\"}");
}

#[tokio::test]
async fn provider_failures_have_safe_errors_and_never_follow_redirects_or_retry() {
    for (status, code, retryable) in [
        (307, "upstream_rejected", false),
        (400, "upstream_rejected", false),
        (429, "upstream_rate_limited", true),
        (503, "upstream_rejected", true),
    ] {
        let (url, captured, task) = server(status, b"private-provider-body".to_vec(), false).await;
        let credentials = Credentials {
            result: Some("resolved-key"),
            ..Default::default()
        };
        let config = config();
        let user = user();
        let client = provider::build_client().unwrap();
        let execution = provider::Execution {
            client: &client,
            credentials: &credentials,
            user: &user,
            config: &config,
            endpoint: &url,
            protocol: protocol::Protocol::SystemOne,
        };
        let error = execution
            .run(&tests::request(), "decision_test", Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.retryable, retryable);
        assert!(
            !error
                .response("decision_test")
                .validation_detail()
                .contains("private")
        );
        task.await.unwrap();
        assert_eq!(captured.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn malformed_or_oversized_chunked_response_is_rejected() {
    for body in [
        b"not json".to_vec(),
        b"[]".to_vec(),
        vec![b' '; MAX_BYTES + 1],
    ] {
        let (url, _, task) = server(200, body, true).await;
        let credentials = Credentials {
            result: Some("key"),
            ..Default::default()
        };
        let config = config();
        let user = user();
        let client = provider::build_client().unwrap();
        let execution = provider::Execution {
            client: &client,
            credentials: &credentials,
            user: &user,
            config: &config,
            endpoint: &url,
            protocol: protocol::Protocol::SystemOne,
        };
        let error = execution
            .run(&tests::request(), "decision_test", Duration::from_secs(2))
            .await
            .unwrap_err();
        assert_eq!(error.code, "upstream_invalid_response");
        task.await.unwrap();
    }
}

#[tokio::test]
async fn failed_empty_or_unresolved_credentials_never_reach_provider() {
    for result in [
        None,
        Some(""),
        Some("${unresolved}"),
        Some("key\r\ninjected"),
    ] {
        let credentials = Credentials {
            result,
            ..Default::default()
        };
        let config = config();
        let user = user();
        let client = provider::build_client().unwrap();
        let execution = provider::Execution {
            client: &client,
            credentials: &credentials,
            user: &user,
            config: &config,
            endpoint: "http://127.0.0.1:1",
            protocol: protocol::Protocol::SystemOne,
        };
        let error = execution
            .run(&tests::request(), "decision_test", Duration::from_secs(1))
            .await
            .unwrap_err();
        assert_eq!(error.code, "credential_unavailable");
        assert_eq!(error.status, 503);
    }
}

#[tokio::test]
async fn execution_timeout_includes_credential_resolution() {
    let credentials = Credentials {
        pending: true,
        ..Default::default()
    };
    let config = config();
    let user = user();
    let client = provider::build_client().unwrap();
    let execution = provider::Execution {
        client: &client,
        credentials: &credentials,
        user: &user,
        config: &config,
        endpoint: "http://127.0.0.1:1",
        protocol: protocol::Protocol::SystemOne,
    };
    let error = execution
        .run(
            &tests::request(),
            "decision_test",
            Duration::from_millis(10),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "upstream_timeout");
    assert_eq!(error.status, 504);
}
