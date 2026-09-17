// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/plugins/marketplace` handler (source
//! `app/api/endpoints/marketplace.py` + `PluginMarketplaceService`).
use brz_http_server::{Binary, HttpResponse};
use serde_json::json;

use super::{MarketplaceQuery, auth, list_plugins};
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// GET /api/plugins/marketplace: the marketplace free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/plugins/marketplace")]
async fn get_marketplace_plugins(
    #[inject(state)] state: &AppState,
    #[header] authorization: Option<&str>,
    #[header("x-request-id")] request_id: Option<&str>,
    query: brz_http_server::Query<MarketplaceQuery>,
) -> Result<HttpResponse<Binary>, FastApiError> {
    marketplace(state, authorization, request_id, &query).await
}

/// Handler body for `GET /api/plugins/marketplace`.
async fn marketplace(
    state: &AppState,
    authorization: Option<&str>,
    request_id: Option<&str>,
    query: &MarketplaceQuery,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let user = auth::current_user_optional(
        &state.mysql,
        &state.jwt_secret_keys,
        &state.jwt_algorithm,
        authorization,
    )
    .await;
    match list_plugins(
        &state.mysql,
        state.redis.as_ref(),
        &state.entity_resolvers,
        user.as_ref(),
        query,
    )
    .await
    {
        Ok(response) => {
            let body = match serde_json::to_vec(&response) {
                Ok(body) => body,
                Err(error) => {
                    tracing::error!(%error, "failed to serialize marketplace response");
                    return Err(internal_error());
                }
            };
            let reply = HttpResponse::new(Binary::new(body));
            let reply = match request_id {
                Some(request_id) => reply.header("x-request-id", request_id).map_err(|error| {
                    FastApiError::detail(
                        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                        error.to_string(),
                    )
                })?,
                None => reply,
            };
            Ok(reply)
        }
        Err(error) => {
            tracing::error!(%error, "marketplace listing failed");
            Err(internal_error())
        }
    }
}

/// Source `python_exception_handler` 500 response shape.
fn internal_error() -> FastApiError {
    FastApiError::detail(
        brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
        json!({"error_code": 500, "detail": "Internal server error"}).to_string(),
    )
}
