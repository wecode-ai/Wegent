// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bounded, single-attempt provider transport and request-user credential resolution.
use serde_json::Value;
use std::time::{Duration, Instant};

use super::{
    DecisionError, MAX_BYTES,
    protocol::{self, Protocol},
    schema::DecisionRequest,
};
use crate::llm_proxy::{CredentialRequest, LlmProxyCredentials, model_config::ModelConfig};
use crate::models_unified::mysql::UserRow;

pub(super) const TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn build_client() -> anyhow::Result<brz_http::Client> {
    Ok(brz_http::Client::builder()
        .connect_timeout(TIMEOUT)
        .read_timeout(TIMEOUT)
        .timeout(TIMEOUT)
        .configure(|builder| {
            let builder = builder
                .redirect(brz_http::reqwest::redirect::Policy::none())
                .retry(brz_http::reqwest::retry::never());
            match crate::http_trust::trust_anchor() {
                Some(anchor) => builder.add_root_certificate(anchor),
                None => builder,
            }
        })
        .build()?)
}

fn headers(config: &ModelConfig, key: &str, request_id: &str) -> Vec<(String, String)> {
    let protected = [
        "authorization",
        "content-type",
        "accept",
        "host",
        "content-length",
        "connection",
        "cookie",
        "proxy-authorization",
        "x-request-id",
    ];
    let mut headers: Vec<_> = config
        .default_headers
        .iter()
        .filter(|(name, _)| !protected.contains(&name.to_ascii_lowercase().as_str()))
        .cloned()
        .collect();
    headers.extend([
        ("authorization".into(), format!("Bearer {key}")),
        ("content-type".into(), "application/json".into()),
        ("accept".into(), "application/json".into()),
        ("x-request-id".into(), request_id.into()),
    ]);
    headers
}

pub(super) fn check_status(status: u16) -> Result<(), DecisionError> {
    match status {
        200..=299 => Ok(()),
        429 => Err(DecisionError::new(
            429,
            "upstream_rate_limited",
            "Decision upstream is rate limited",
            true,
        )),
        500.. => Err(DecisionError::unavailable()),
        _ => Err(DecisionError::new(
            502,
            "upstream_rejected",
            "Decision upstream rejected the request",
            false,
        )),
    }
}

fn transport(error: brz_http::Error) -> DecisionError {
    if error.is_timeout() {
        DecisionError::timeout()
    } else {
        DecisionError::unavailable()
    }
}

async fn fetch(
    client: &brz_http::Client,
    endpoint: &str,
    headers: &[(String, String)],
    payload: &Value,
) -> Result<Value, DecisionError> {
    // Breeze's profiled request wrapper logs body excerpts on slow requests.
    // Reuse its configured transport directly so decision state stays private.
    let mut request = client.as_reqwest().post(endpoint);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let mut response = request
        .body(serde_json::to_vec(payload).map_err(|_| DecisionError::invalid_response())?)
        .timeout(TIMEOUT)
        .send()
        .await
        .map_err(transport)?;
    check_status(response.status().as_u16())?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(transport)? {
        if chunk.len() > MAX_BYTES.saturating_sub(body.len()) {
            return Err(DecisionError::invalid_response());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| DecisionError::invalid_response())
}

pub(super) struct Execution<'a> {
    pub client: &'a brz_http::Client,
    pub credentials: &'a dyn LlmProxyCredentials,
    pub user: &'a UserRow,
    pub config: &'a ModelConfig,
    pub endpoint: &'a str,
    pub protocol: Protocol,
}

impl Execution<'_> {
    pub async fn run(
        &self,
        request: &DecisionRequest,
        request_id: &str,
        timeout: Duration,
    ) -> Result<Value, DecisionError> {
        let started = Instant::now();
        let result = tokio::time::timeout(timeout, async {
            let key = self
                .credentials
                .provider_api_key(CredentialRequest {
                    api_key: &self.config.api_key,
                    api_key_template: self.config.api_key_template.as_deref(),
                    user_id: i64::from(self.user.id),
                    user_name: &self.user.user_name,
                })
                .await
                .map_err(|_| DecisionError::credential())?;
            if key.trim().is_empty() || key.contains(['\r', '\n']) || key.contains("${") {
                return Err(DecisionError::credential());
            }
            let payload = protocol::payload(request, self.protocol, &self.config.model_id);
            let value = fetch(
                self.client,
                self.endpoint,
                &headers(self.config, key.trim(), request_id),
                &payload,
            )
            .await?;
            protocol::normalize(&value, request, self.protocol)
                .map_err(|_| DecisionError::invalid_response())
        })
        .await
        .map_err(|_| DecisionError::timeout())??;
        let mut result = result;
        result["request_id"] = Value::from(request_id);
        result["latency_ms"] =
            Value::from(started.elapsed().as_millis().min(u64::MAX as u128) as u64);
        tracing::info!(request_id, user_id = self.user.id, model = request.model, protocol = ?self.protocol,
            questions = request.questions.len(), "Decision completed");
        Ok(result)
    }
}
