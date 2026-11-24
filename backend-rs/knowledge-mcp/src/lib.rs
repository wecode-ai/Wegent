// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Knowledge tool routes and external document authorization.

#![forbid(unsafe_code)]

mod knowledge;
mod knowledge_external;
mod knowledge_tools;

use std::sync::Arc;

use wegent_identity::auth::AppAuthenticator;
use wegent_knowledge_access::auth::ExternalKnowledgeAuth;
use wegent_knowledge_access::download_policy::DocumentDownloadPolicy;
use wegent_mcp_transport::{protocol, tools, transport};

pub struct KnowledgeMcpState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub auth: wegent_backend_config::AuthConfig,
    pub entity_resolvers: wegent_access::permissions::EntityResolvers,
    pub attachment_http: brz_http::Client,
    pub external_knowledge_auth: Arc<dyn ExternalKnowledgeAuth>,
    pub document_download_policy: Arc<dyn DocumentDownloadPolicy>,
}

brz_http_server::registry!(
    dependencies(state: Arc<KnowledgeMcpState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<KnowledgeMcpState>,
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
