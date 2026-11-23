// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Task detail projection, membership checks, and version-aware share links.

#![forbid(unsafe_code)]

use std::sync::Arc;

use wegent_access::permissions::EntityResolvers;
use wegent_backend_config::AuthConfig;
use wegent_backend_users::user_profile::UserViewExtension;
use wegent_directory::erp_provider::ErpProvider;
use wegent_identity::auth::AppAuthenticator;
use wegent_media::video_result_urls::VideoResultUrlRefresh;
use wegent_task_store::task_store::TaskStore;

pub mod share_access;
mod subtasks;
pub mod task_detail_api;
mod task_share_api;

pub struct TaskViewsState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub entity_resolvers: EntityResolvers,
    pub erp: Arc<dyn ErpProvider>,
    pub task_store: Arc<dyn TaskStore>,
    pub auth: AuthConfig,
    pub attachment_http: brz_http::Client,
    pub video_result_urls: Arc<dyn VideoResultUrlRefresh>,
    pub user_profile: Arc<dyn UserViewExtension>,
}

brz_http_server::registry!(
    dependencies(state: Arc<TaskViewsState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<TaskViewsState>,
) -> Result<brz_http_server::Router<AppAuthenticator>, brz_http_server::RegistryError> {
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
