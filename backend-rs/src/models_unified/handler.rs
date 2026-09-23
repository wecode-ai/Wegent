// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/models/unified` HTTP endpoint, ported from
//! `app/api/endpoints/adapter/models.py`.
use brz_mysql::Mysql;
use serde::Deserialize;
use serde_json::json;

use super::aggregation::list_available_models;
use super::auth::AuthError;
use super::models::{UnifiedModelResponse, UnifiedQuery};
use super::state::AppState;

#[derive(serde::Serialize)]
struct UnifiedModelsResponse {
    data: Vec<UnifiedModelResponse>,
}

const SUPPORTED_CLIENT_ORIGINS: [&str; 2] = ["frontend", "wework"];

#[derive(Debug, Default, Deserialize)]
pub struct UnifiedParams {
    #[serde(default)]
    shell_type: Option<String>,
    #[serde(default)]
    include_config: Option<bool>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    group_name: Option<String>,
    #[serde(default)]
    model_category_type: Option<String>,
    #[serde(default)]
    client_origin: Option<String>,
}

/// GET /api/models/unified: the models-unified free function, injecting the
/// module's own dependency state.
#[brz_http_server::get(
    "/api/models/unified",
    group = models_unified
)]
async fn list_unified_models(
    #[inject(mu)] state: &crate::startup::ModelsState,
    #[auth] user: super::auth::AuthenticatedUser,
    query: brz_http_server::Query<UnifiedParams>,
) -> Result<UnifiedModelsResponse, AuthError> {
    unified_models(state, &user, &query).await
}

/// Handler body for `GET /api/models/unified`.
async fn unified_models(
    state: &std::sync::Arc<AppState<impl Mysql, impl brz_redis::Redis>>,
    user: &super::auth::AuthenticatedUser,
    params: &UnifiedParams,
) -> Result<UnifiedModelsResponse, AuthError> {
    if let Some(client_origin) = &params.client_origin
        && !SUPPORTED_CLIENT_ORIGINS.contains(&client_origin.as_str())
    {
        return Err(AuthError::Internal(
            json!({
                "detail": [
                    {
                        "type": "string_pattern_mismatch",
                        "loc": ["query", "client_origin"],
                        "msg": "String should match pattern '^(frontend|wework)$'",
                        "input": client_origin,
                    }
                ]
            })
            .to_string(),
        ));
    }

    let query = UnifiedQuery {
        shell_type: params.shell_type.clone(),
        include_config: params.include_config.unwrap_or(false),
        scope: params
            .scope
            .clone()
            .unwrap_or_else(|| "personal".to_string()),
        group_name: params.group_name.clone(),
        model_category_type: params.model_category_type.clone(),
        client_origin: params.client_origin.clone(),
    };

    if !matches!(query.scope.as_str(), "personal" | "group" | "all") {
        return Err(AuthError::Internal("Internal Server Error".to_string()));
    }

    match list_available_models(
        &state.mysql,
        state.erp.as_ref(),
        state.redis(),
        &user.0,
        &query,
    )
    .await
    {
        Ok(data) => Ok(UnifiedModelsResponse { data }),
        Err(error) => {
            tracing::error!(error = %error, "unified model aggregation failed");
            Err(AuthError::Internal("Internal Server Error".to_string()))
        }
    }
}
