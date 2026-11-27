// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bind the shared request builder to the deployment's execution services.

use serde_json::Value;
use wegent_execution_request::RequestServices;
use wegent_execution_request::request;
use wegent_http_compat::FastApiError;
use wegent_protocol::dispatch::ExecutionRequest;

use crate::AppState;

pub use request::BuildExecutionRequestInput;
pub(super) use request::model_resolution_error;

#[cfg(test)]
use request::execution_device_id;
#[cfg(test)]
use wegent_execution_preparation::resolution::KindRow;

fn services(state: &AppState) -> RequestServices<'_> {
    RequestServices {
        mysql: &state.mysql,
        redis: &state.redis,
        task_store: &state.task_store,
        entity_resolvers: &state.entity_resolvers,
        erp: state.erp.as_ref(),
        llm_proxy_credentials: &state.llm_proxy_credentials,
        repository_tokens: &state.repository_tokens,
        user_info_extension: &state.user_info_extension,
        internal_chat: &state.internal_chat,
        auth: &state.auth,
    }
}

pub(crate) async fn authorize_pipeline(
    state: &AppState,
    user: i64,
    team: &wegent_execution_preparation::resolution::KindRow,
    task: Option<(i64, &Value)>,
) -> Result<(), FastApiError> {
    let allowed = if let Some((id, document)) = task
        && document
            .pointer("/metadata/labels/projectRobotExecutionId")
            .is_some()
    {
        if document["metadata"]["labels"]["projectRobotExecutionId"]
            .as_str()
            .and_then(|v| v.parse::<i64>().ok())
            .is_none()
        {
            false
        } else {
            crate::background_jobs::robot::managed::authorize_task(state, id, user)
                .await
                .map_err(|error| {
                    tracing::error!(%error,id,"Pipeline project authority check failed");
                    FastApiError::internal()
                })?
        }
    } else if team.user_id == user || team.user_id == 0 {
        true
    } else {
        let cache = crate::task_skills::kinds::KindCacheStore {
            mysql: &state.mysql,
            redis: state.redis.as_ref(),
            use_kind_cache: wegent_capabilities::kind_store::deployment_kind_cache_enabled(),
            erp: Some(state.erp.as_ref()),
            resolvers: Some(&state.entity_resolvers),
        };
        cache
            .resolve_team(user, &team.namespace, &team.name)
            .await
            .map_err(wegent_execution_preparation::dependency)?
            .is_some_and(|row| row.kinds_id == team.id)
            || cache
                .team_share_permission(team.id, user)
                .await
                .map_err(wegent_execution_preparation::dependency)?
    };
    if team.is_active != 1 || !allowed {
        return Err(FastApiError::detail(
            brz_http_server::StatusCode::FORBIDDEN,
            "Pipeline Team is unavailable",
        ));
    }
    Ok(())
}

async fn authorize_frozen_pipeline(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
) -> Result<(), FastApiError> {
    if input.task_json["spec"]["currentStage"].is_number() {
        authorize_pipeline(
            state,
            input.user_id,
            input.team,
            Some((input.task_id, input.task_json)),
        )
        .await?;
    }
    Ok(())
}

pub async fn build_execution_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    preload_skills: &[String],
) -> Result<ExecutionRequest, FastApiError> {
    authorize_frozen_pipeline(state, input).await?;
    request::build_execution_request(&services(state), input, preload_skills).await
}

pub(crate) async fn build_chat_execution_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    is_subscription: bool,
    preload_skills: &[Value],
    generation: Option<&Value>,
    model_options: Option<&Value>,
    created_git_repository: Option<&Value>,
) -> Result<ExecutionRequest, FastApiError> {
    authorize_frozen_pipeline(state, input).await?;
    let runtime_model = super::socket_runtime_model::resolve(state, input, model_options).await?;
    request::build_chat_execution_request(
        &services(state),
        input,
        is_subscription,
        preload_skills,
        generation,
        runtime_model,
        created_git_repository,
    )
    .await
}

pub(crate) async fn build_subscription_execution_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    preload_skills: &[Value],
) -> Result<ExecutionRequest, FastApiError> {
    request::build_subscription_execution_request(&services(state), input, preload_skills).await
}

pub(crate) async fn build_background_execution_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
) -> Result<ExecutionRequest, FastApiError> {
    authorize_frozen_pipeline(state, input).await?;
    request::build_background_execution_request(&services(state), input).await
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod request_tests;
