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

pub async fn build_execution_request(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    preload_skills: &[String],
) -> Result<ExecutionRequest, FastApiError> {
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
    request::build_background_execution_request(&services(state), input).await
}

#[cfg(test)]
#[path = "request_tests.rs"]
mod request_tests;
