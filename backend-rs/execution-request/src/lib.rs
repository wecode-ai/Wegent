// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Compile execution payloads from authorized task and workspace inputs.

#![forbid(unsafe_code)]

use std::sync::Arc;

use wegent_access::permissions::EntityResolvers;
use wegent_backend_config::{AuthConfig, InternalChatConfig};
use wegent_backend_users::user_profile::UserInfoExtension;
use wegent_directory::erp_provider::ErpProvider;
use wegent_git_repositories::repository_tokens::RepositoryTokenResolver;
use wegent_llm_proxy::LlmProxyCredentials;
use wegent_task_store::task_store::TaskStore;

mod background;
mod connectors;
pub mod contexts;
pub mod git_identity;
mod knowledge_resolution;
pub mod memory_context;
mod preflight;
mod project_workspace;
pub mod request;
pub mod runtime_config;
pub mod schema;
mod session_context;
pub mod shell;
pub mod skill_generation;
pub mod subscription_window;
pub mod tokens;

use wegent_execution_preparation::{
    bot_config, ghost, mcp_servers, model_config, reasoning, resolution, skills, subtask_bot,
};
use wegent_protocol::dispatch;

pub struct RequestServices<'a> {
    pub mysql: &'a brz_mysql::MysqlService,
    pub redis: &'a Option<brz_redis::RedisService>,
    pub task_store: &'a Arc<dyn TaskStore>,
    pub entity_resolvers: &'a EntityResolvers,
    pub erp: &'a dyn ErpProvider,
    pub llm_proxy_credentials: &'a Arc<dyn LlmProxyCredentials>,
    pub repository_tokens: &'a Arc<dyn RepositoryTokenResolver>,
    pub user_info_extension: &'a Arc<dyn UserInfoExtension>,
    pub internal_chat: &'a InternalChatConfig,
    pub auth: &'a AuthConfig,
}
