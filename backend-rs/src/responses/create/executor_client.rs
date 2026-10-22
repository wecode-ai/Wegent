// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/execution/dispatcher.py`'s executor-manager HTTP client
//! (`ExecutionDispatcher._dispatch_http_callback`).
//!
//! The recorded `queued` case (`2834ba9c`, recording `20261010055652`) pins the
//! single outbound exchange: `POST
//! http://<executor-manager>/executor-manager/v1/responses` posting the
//! [`assemble`](super::dispatch::assemble) envelope with `stream=false` and
//! `background=true`, returning
//! `200 {"id": "resp_…", "status": "queued", "message": "Task enqueued for
//! processing"}`.
//!
//! The source dispatches fire-and-forget
//! (`asyncio.create_task(execution_dispatcher.dispatch(...))`): the create
//! handler returns the `queued` response immediately while the POST runs in the
//! background, and a transport failure is logged rather than surfaced. The flow
//! wires this client into a startup-owned dispatcher instead of spawning a
//! request-owned task.
use async_trait::async_trait;
use brz_http::Client as HttpClient;
use serde_json::Value;

use super::dispatch::DispatchPayload;

/// `settings.EXECUTOR_MANAGER_URL`.
pub const EXECUTOR_MANAGER_URL_ENV: &str = "EXECUTOR_MANAGER_URL";

/// `settings.EXECUTOR_MANAGER_URL` default.
pub const DEFAULT_EXECUTOR_MANAGER_URL: &str = "http://localhost:8001";

/// `execution_router._init_service_urls` appends this for the executor shells
/// (`ClaudeCode`, `Codex`, `Agno`, `Dify`).
pub const EXECUTOR_MANAGER_PATH_PREFIX: &str = "/executor-manager";

/// `ExecutionTarget.url` for an executor-backed shell:
/// `{EXECUTOR_MANAGER_URL}/executor-manager`.
pub fn executor_target_url(base_url: &str) -> String {
    format!(
        "{}{EXECUTOR_MANAGER_PATH_PREFIX}",
        base_url.trim_end_matches('/')
    )
}

/// `_dispatch_http_callback`: `base_url = f"{target.url}/v1"`, and the OpenAI
/// client appends `/responses`.
pub fn executor_responses_url(target_url: &str) -> String {
    format!("{}/v1/responses", target_url.trim_end_matches('/'))
}

/// The executor-manager acknowledgement recorded for the `queued` case.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct ExecutorAck {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
}

/// An executor-manager dispatch failure.
#[derive(Debug)]
pub enum ExecutorDispatchError {
    /// The HTTP transport failed.
    Transport(String),
    /// `raise_for_status` on a non-2xx response.
    HttpStatus(u16),
    /// The response body was not the expected JSON envelope.
    Body(String),
}

impl std::fmt::Display for ExecutorDispatchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(message) => write!(f, "executor-manager transport error: {message}"),
            Self::HttpStatus(status) => write!(f, "executor-manager HTTP error: {status}"),
            Self::Body(message) => write!(f, "executor-manager response error: {message}"),
        }
    }
}

impl std::error::Error for ExecutorDispatchError {}

/// `client.responses.create(...)` over the outbound HTTP client.
#[async_trait]
pub trait ExecutorHttp: Send + Sync {
    /// POST one JSON body and decode the JSON response.
    async fn post_json(&self, url: &str, body: &Value) -> Result<Value, ExecutorDispatchError>;
}

#[async_trait]
impl ExecutorHttp for HttpClient {
    async fn post_json(&self, url: &str, body: &Value) -> Result<Value, ExecutorDispatchError> {
        let response = self
            .post(url)
            .map_err(|error| ExecutorDispatchError::Transport(error.to_string()))?
            .header("content-type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|error| ExecutorDispatchError::Transport(error.to_string()))?;
        if !response.status().is_success() {
            return Err(ExecutorDispatchError::HttpStatus(
                response.status().as_u16(),
            ));
        }
        response
            .json::<Value>()
            .await
            .map_err(|error| ExecutorDispatchError::Body(error.to_string()))
    }
}

/// The executor-manager `/v1/responses` client.
pub struct ExecutorClient<H: ExecutorHttp> {
    http: H,
}

impl<H: ExecutorHttp> ExecutorClient<H> {
    /// Wrap an HTTP client.
    pub fn new(http: H) -> Self {
        Self { http }
    }

    /// `_dispatch_http_callback`: post the `stream=false, background=true`
    /// envelope and read the `queued` acknowledgement.
    pub async fn dispatch(
        &self,
        target_url: &str,
        payload: &DispatchPayload,
    ) -> Result<ExecutorAck, ExecutorDispatchError> {
        let url = executor_responses_url(target_url);
        let body = serde_json::to_value(payload)
            .map_err(|error| ExecutorDispatchError::Body(error.to_string()))?;
        let response = self.http.post_json(&url, &body).await?;
        serde_json::from_value(response)
            .map_err(|error| ExecutorDispatchError::Body(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn target_and_response_urls_match_the_recorded_exchange() {
        let target = executor_target_url("http://preview.cs.example");
        assert_eq!(target, "http://preview.cs.example/executor-manager");
        assert_eq!(
            executor_responses_url(&target),
            "http://preview.cs.example/executor-manager/v1/responses"
        );
        // A trailing slash on the configured base is tolerated.
        assert_eq!(
            executor_responses_url(&executor_target_url("http://host:8001/")),
            "http://host:8001/executor-manager/v1/responses"
        );
    }

    struct ScriptedHttp {
        posts: Mutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl ExecutorHttp for ScriptedHttp {
        async fn post_json(&self, url: &str, body: &Value) -> Result<Value, ExecutorDispatchError> {
            self.posts
                .lock()
                .unwrap()
                .push((url.to_string(), body.clone()));
            Ok(json!({
                "id": "resp_801406538446280",
                "status": "queued",
                "message": "Task enqueued for processing",
            }))
        }
    }

    #[tokio::test]
    async fn dispatch_posts_the_envelope_and_reads_the_ack() {
        let http = ScriptedHttp {
            posts: Mutex::new(Vec::new()),
        };
        let client = ExecutorClient::new(http);
        let payload = DispatchPayload {
            model: "qwen3.7-plus".to_string(),
            stream: false,
            input: "hi".to_string(),
            instructions: "sys".to_string(),
            background: true,
            ..DispatchPayload::new()
        };
        let ack = client
            .dispatch("http://host:8001/executor-manager", &payload)
            .await
            .expect("dispatch");
        assert_eq!(
            ack,
            ExecutorAck {
                id: "resp_801406538446280".to_string(),
                status: "queued".to_string(),
                message: Some("Task enqueued for processing".to_string()),
            }
        );
        let posts = client.http.posts.lock().unwrap();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].0, "http://host:8001/executor-manager/v1/responses");
        let body = &posts[0].1;
        assert_eq!(body["model"], "qwen3.7-plus");
        assert_eq!(body["stream"], false);
        assert_eq!(body["background"], true);
    }
}
