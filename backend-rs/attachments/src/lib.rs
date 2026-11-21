// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Attachment metadata, content storage, and upload/download routes.

#![deny(unsafe_code)]

use std::sync::Arc;

use brz_mysql::{MysqlResult, MysqlService};
use wegent_backend_config as config;
use wegent_http_compat::{self as http_compat, FastApiError};
use wegent_identity::{auth, headers, internal_auth, jwt_compat, user_reader};
use wegent_media::media_policy;
use wegent_python_compat::json_compat;
use wegent_task_store::task_store::{self, TaskStore};

#[cfg(test)]
use wegent_backend_test_support as sql_test_support;

pub mod attachment_block;
mod attachments;
pub mod attachments_task_all;
mod internal_attachments_download;
#[cfg(test)]
mod test_support;

pub use attachments::context_store::{SubtaskContextRow, get_context_optional_with_user};
pub use attachments::external_media::{
    AttachmentDownload, ExternalMediaReference, ExternalMediaRelay, ExternalMediaRequest,
    ExternalPlayback, ExternalPlaybackResolver, MediaStream, NoExternalPlaybackResolver,
    PlaybackDeliveryMode,
};
pub use attachments::share_token::ShareInfo;
pub use attachments::storage::get_attachment_binary_data;
pub use attachments::upload::{
    AttachmentUploadBackend, ExternalAttachmentStorageResult, ExternalAttachmentUploadError,
    ExternalAttachmentUploadRequest, ImagePid, ImageUploadRequest, S3StorageBackend,
    StoreObjectRequest, UploadBackendError,
};
pub use attachments::{
    content_type, context_store, external_media, handler, minio_client, public_link, s3_signing,
    storage, upload,
};

/// Permission of an unlinked attachment that may belong to a knowledge document.
#[async_trait::async_trait]
pub trait KnowledgeAttachmentAccess: Send + Sync {
    async fn check_attachment(&self, attachment_id: i64, user_id: i32)
    -> MysqlResult<Option<bool>>;
}

/// Resolve a task share link and enforce its version-specific permissions.
#[async_trait::async_trait]
pub trait TaskAttachmentShareAccess: Send + Sync {
    async fn resolve_share(
        &self,
        token: &str,
        viewer_id: Option<i64>,
    ) -> Result<Option<ShareInfo>, FastApiError>;
}

pub struct AttachmentState {
    pub mysql: MysqlService,
    pub task_store: Arc<dyn TaskStore>,
    pub auth: config::AuthConfig,
    pub frontend_url: String,
    pub attachment_http: brz_http::Client,
    pub attachment_upload: Arc<dyn AttachmentUploadBackend>,
    pub media_policy: Arc<dyn media_policy::MediaPolicy>,
    pub external_media: Arc<dyn ExternalMediaRelay>,
    pub external_playback: Arc<dyn ExternalPlaybackResolver>,
    pub knowledge_access: Arc<dyn KnowledgeAttachmentAccess>,
    pub share_access: Arc<dyn TaskAttachmentShareAccess>,
}

/// Upload transactions used by attachment endpoints, importers, and converters.
pub struct UploadServices<'a> {
    pub mysql: &'a MysqlService,
    pub attachment_upload: &'a Arc<dyn AttachmentUploadBackend>,
}

impl AttachmentState {
    fn upload_services(&self) -> UploadServices<'_> {
        UploadServices {
            mysql: &self.mysql,
            attachment_upload: &self.attachment_upload,
        }
    }
}

brz_http_server::registry!(
    dependencies(state: Arc<AttachmentState>),
    auth = auth::AppAuthenticator
);

pub fn routes(
    state: Arc<AttachmentState>,
) -> Result<brz_http_server::Router<auth::AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
}

/// Paths and method bits for gateway ownership verification.
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
