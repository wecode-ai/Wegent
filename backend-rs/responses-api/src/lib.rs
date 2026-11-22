// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication, retrieval, cancellation, and deletion for the Responses API.

#![forbid(unsafe_code)]

use std::sync::Arc;
use wegent_backend_config as config;
use wegent_backend_persistence::{request_sql, sql_support};
#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
use wegent_execution_runtime::{task_run_metric_hooks, task_run_metrics};
use wegent_http_compat::{self as http_compat, FastApiError};
use wegent_identity::{auth as identity_auth, headers, jwt_compat, user_reader};
use wegent_models as models_unified;
use wegent_python_compat::json_compat;
use wegent_resource_store::crd;
use wegent_task_store::task_store;
#[cfg(test)]
use wegent_task_store::task_store_statements;

pub mod auth;
mod auth_error;
mod cancel;
pub mod continuation;
mod create;
pub use create::CreateResponse;
mod delete;
pub mod error;
mod generation_output;
mod handler;
mod http_error;
pub mod output_builder;
#[cfg(test)]
mod output_builder_tests;
mod output_result;
pub mod python_json;
pub mod rate_limit;
pub mod responses_repository;
mod shell_output;

pub type BodyStream = std::pin::Pin<
    Box<dyn futures_util::Stream<Item = Result<brz_http_server::Bytes, std::io::Error>> + Send>,
>;

pub struct CreateRequest<'a> {
    pub principal: auth::DeferredResponsesUser,
    pub body: serde_json::Value,
    pub limit: rate_limit::RateLimit,
    pub limit_key: String,
    pub request_id: Option<&'a str>,
    pub auto_delete_executor: Option<&'a str>,
}

pub trait ResponseCommands: Send + Sync {
    fn create<'a>(
        &'a self,
        request: CreateRequest<'a>,
    ) -> futures_util::future::BoxFuture<'a, Result<CreateResponse, FastApiError>>;

    fn delete(
        &self,
        user_id: i64,
        task_id: i64,
    ) -> futures_util::future::BoxFuture<'_, Result<(), FastApiError>>;
}

pub struct ResponsesState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub task_store: Arc<dyn task_store::TaskStore>,
    pub user_reader: Arc<dyn user_reader::UserByIdReader>,
    pub auth: config::AuthConfig,
    pub commands: Arc<dyn ResponseCommands>,
}

brz_http_server::registry!(
    dependencies(state: Arc<ResponsesState>),
    auth = identity_auth::AppAuthenticator
);

pub fn routes(
    state: Arc<ResponsesState>,
) -> Result<brz_http_server::Router<identity_auth::AppAuthenticator>, brz_http_server::RegistryError>
{
    brz_http_server::handlers!(state = state)
}

pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_http_apis::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
