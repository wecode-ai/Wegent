// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Resolve shared agent and model inputs before dispatch.

#![forbid(unsafe_code)]

use wegent_access::permissions;
use wegent_backend_config as config;
use wegent_backend_persistence::request_sql;
#[cfg(test)]
use wegent_backend_test_support as sql_test_support;
use wegent_capabilities::task_skills;
use wegent_directory::erp_provider;
use wegent_http_compat as http_compat;
use wegent_http_compat::FastApiError;
use wegent_identity::user_reader;
use wegent_mcp_providers::{mcp_provider_registry, mcp_user_service, user_mcp_oauth};
use wegent_python_compat::json_compat;
use wegent_task_store::task_store_statements;

pub mod bot_config;
pub mod ghost;
pub mod mcp_servers;
pub mod model;
pub mod model_config;
pub mod model_selection;
pub mod provider_guidance;
pub mod reasoning;
pub mod resolution;
pub mod skills;
pub mod subtask_bot;

pub fn dependency(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "responses create dependency failure");
    FastApiError::internal()
}

pub fn request_dependency(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "build_execution_request dependency failure");
    FastApiError::internal()
}
