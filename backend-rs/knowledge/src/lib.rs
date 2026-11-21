// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Knowledge bases, document content, artifacts, and access control.

#![forbid(unsafe_code)]

use std::sync::Arc;

use serde_json::Value;
use wegent_access::permissions;
use wegent_attachments::{AttachmentUploadBackend, UploadServices};
use wegent_backend_config as config;
use wegent_backend_persistence::sql_support;
use wegent_http_compat as http_compat;
use wegent_identity::auth;
use wegent_knowledge_access::{download_policy::DocumentDownloadPolicy, open_auth::ApiFailure};
use wegent_python_compat::{json_compat, py_set_order};
use wegent_resource_store::crd;

#[cfg(test)]
use wegent_backend_test_support as sql_test_support;

mod attachment_access;
pub mod knowledge_artifacts;
mod knowledge_base_detail;
pub mod knowledge_bases_all_grouped;
mod knowledge_bases_list;
pub mod knowledge_documents_content;
mod knowledge_documents_detail;
mod knowledge_documents_list;
mod knowledge_external_import_status;
mod knowledge_folders;
mod knowledge_multimodal_prompts;
mod knowledge_organization_namespace;
mod knowledge_wiki_bindings;
mod share_knowledge_base_my_permission;

pub use attachment_access::check_knowledge_base_access;

/// Submit the prepared indexing generation on the deployment's job runtime.
#[async_trait::async_trait]
pub trait IndexDispatcher: Send + Sync {
    async fn dispatch(
        &self,
        document_id: i64,
        generation: i64,
        payload: Value,
    ) -> Result<(), ApiFailure>;
}

pub struct KnowledgeState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub entity_resolvers: permissions::EntityResolvers,
    pub attachment_upload: Arc<dyn AttachmentUploadBackend>,
    pub document_download_policy: Arc<dyn DocumentDownloadPolicy>,
    pub index_dispatcher: Arc<dyn IndexDispatcher>,
}

impl KnowledgeState {
    fn upload_services(&self) -> UploadServices<'_> {
        UploadServices {
            mysql: &self.mysql,
            attachment_upload: &self.attachment_upload,
        }
    }
}

brz_http_server::registry!(
    dependencies(state: Arc<KnowledgeState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<KnowledgeState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
}

/// Paths and method bits for gateway route ownership verification.
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
