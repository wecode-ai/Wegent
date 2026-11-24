// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use crate::auth::DeferredResponsesUser;
use crate::rate_limit::RateLimit;
use crate::{CreateRequest, ResponsesState};
use wegent_http_compat::FastApiError;

/// The create response: a JSON `ResponseObject` or the SSE framing stream.
pub type CreateResponse = brz_http_server::HttpResponse<crate::BodyStream>;

/// `POST /api/v1/responses`.
#[brz_http_server::post("/api/v1/responses")]
async fn create_response(
    #[inject(state)] state: &ResponsesState,
    #[auth] principal: DeferredResponsesUser,
    #[header("x-forwarded-for")] x_forwarded_for: Option<&str>,
    #[header("x-request-id")] request_id: Option<&str>,
    #[header("auto_delete_executor")] auto_delete_executor: Option<&str>,
    #[header("auto-delete-executor")] auto_delete_executor_dash: Option<&str>,
    body: serde_json::Value,
) -> Result<CreateResponse, FastApiError> {
    // `@limiter.limit(settings.RATE_LIMIT_CREATE_RESPONSE)`: the key and window
    // are resolved here, but the hit runs on the request transaction because
    // `get_current_user`'s post-commit `api_keys` refresh opens it first (see
    // `create_response_flow`).
    let client_ip = client_ip(x_forwarded_for);
    let limit_key = principal
        .rate_limit_key()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("ip:{client_ip}"));
    let limit = RateLimit::create_response();

    state
        .commands
        .create(CreateRequest {
            principal,
            body,
            limit,
            limit_key,
            request_id,
            auto_delete_executor: auto_delete_executor.or(auto_delete_executor_dash),
        })
        .await
}

fn client_ip(x_forwarded_for: Option<&str>) -> String {
    x_forwarded_for
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}
