// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authenticated decision-model catalog and execution, matching the Python contract.
use brz_http_server::{HttpResponse, StatusCode};
use serde_json::{Value, json};

use crate::{http_compat::FastApiError, models_unified::auth::AuthenticatedUser, state::AppState};

mod catalog;
mod config;
pub(crate) use config::validate_spec;
mod protocol;
pub(crate) mod provider;
mod schema;

const MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
struct DecisionError {
    status: u16,
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

impl DecisionError {
    fn new(status: u16, code: &'static str, message: &'static str, retryable: bool) -> Self {
        Self {
            status,
            code,
            message,
            retryable,
        }
    }
    fn invalid_config() -> Self {
        Self::new(
            503,
            "invalid_model_config",
            "Decision model configuration is unusable",
            false,
        )
    }
    fn invalid_response() -> Self {
        Self::new(
            502,
            "upstream_invalid_response",
            "Decision upstream response is unusable",
            false,
        )
    }
    fn timeout() -> Self {
        Self::new(504, "upstream_timeout", "Decision upstream timed out", true)
    }
    fn unavailable() -> Self {
        Self::new(
            502,
            "upstream_rejected",
            "Decision upstream is unavailable",
            true,
        )
    }
    fn credential() -> Self {
        Self::new(
            503,
            "credential_unavailable",
            "Decision credential is unavailable",
            true,
        )
    }

    fn response(self, request_id: &str) -> FastApiError {
        FastApiError::json_body(StatusCode::from_u16(self.status).expect("static status"), json!({"error": {
            "code": self.code, "message": self.message, "retryable": self.retryable, "requestId": request_id,
        }})).with_header("cache-control", "no-store")
    }
}

fn no_store(value: Value) -> HttpResponse<Value> {
    HttpResponse::new(value)
        .header("cache-control", "no-store")
        .expect("static header")
}

#[brz_http_server::get("/api/models/decisions")]
async fn list_decision_models(
    #[inject(state)] state: &AppState,
    #[auth] user: AuthenticatedUser,
) -> Result<HttpResponse<Value>, FastApiError> {
    let models = catalog::available(state, &user.0).await?;
    Ok(no_store(catalog::project(&models)))
}

fn parse_request(
    content_type: Option<&str>,
    body: &[u8],
) -> Result<schema::DecisionRequest, DecisionError> {
    if !content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .eq_ignore_ascii_case("application/json")
    {
        return Err(DecisionError::new(
            415,
            "invalid_content_type",
            "Content type must be application/json",
            false,
        ));
    }
    if body.len() > MAX_BYTES {
        return Err(DecisionError::new(
            413,
            "request_too_large",
            "Decision request exceeds the limit",
            false,
        ));
    }
    schema::DecisionRequest::parse(body)
        .map_err(|_| DecisionError::new(400, "invalid_request", "Invalid decision request", false))
}

#[brz_http_server::post("/api/models/decisions")]
async fn create_decision(
    #[inject(state)] state: &AppState,
    #[auth] user: AuthenticatedUser,
    #[header("content-type")] content_type: Option<&str>,
    body: &[u8],
) -> Result<HttpResponse<Value>, FastApiError> {
    let request_id = format!("decision_{}", crate::wework_auth_tokens::uuid4_hex()?);
    let request = parse_request(content_type, body).map_err(|error| error.response(&request_id))?;
    let models = catalog::available(state, &user.0).await?;
    let result = async {
        let resource = catalog::select(models, &request.model)?;
        let (protocol, config, endpoint) =
            config::resolve(&resource.json.0["spec"], user.0.id, &user.0.user_name)?;
        provider::Execution {
            client: &state.decision_http,
            credentials: state.llm_proxy_credentials.as_ref(),
            user: &user.0,
            config: &config,
            endpoint: &endpoint,
            protocol,
        }
        .run(&request, &request_id, provider::TIMEOUT)
        .await
    }
    .await;
    result
        .map(no_store)
        .map_err(|error: DecisionError| error.response(&request_id))
}

#[cfg(test)]
mod provider_tests;
#[cfg(test)]
mod tests;
