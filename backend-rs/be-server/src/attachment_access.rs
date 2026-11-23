// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Inject knowledge and task-share access into the attachment routes.

use std::sync::Arc;

use brz_mysql::MysqlResult;
use wegent_attachments::{
    AttachmentState, KnowledgeAttachmentAccess, ShareInfo, TaskAttachmentShareAccess,
    UploadServices,
};
use wegent_http_compat::FastApiError;

use crate::state::AppState;

pub(crate) fn build_state(app: &Arc<AppState>) -> AttachmentState {
    AttachmentState {
        mysql: app.mysql.clone(),
        task_store: Arc::clone(&app.task_store),
        auth: app.auth.clone(),
        frontend_url: app.oidc_config.frontend_url.clone(),
        attachment_http: app.attachment_http.clone(),
        attachment_upload: Arc::clone(&app.attachment_upload),
        media_policy: Arc::clone(&app.media_policy),
        external_media: Arc::clone(&app.external_media),
        external_playback: Arc::clone(&app.external_playback),
        knowledge_access: Arc::new(KnowledgeAccess {
            mysql: app.mysql.clone(),
            redis: app.redis.clone(),
            resolvers: app.entity_resolvers.clone(),
        }),
        share_access: Arc::new(ShareAccess {
            mysql: app.mysql.clone(),
            task_store: Arc::clone(&app.task_store),
        }),
    }
}

pub(crate) fn upload_services(app: &AppState) -> UploadServices<'_> {
    UploadServices {
        mysql: &app.mysql,
        attachment_upload: &app.attachment_upload,
    }
}

struct KnowledgeAccess {
    mysql: brz_mysql::MysqlService,
    redis: Option<brz_redis::RedisService>,
    resolvers: crate::permissions::EntityResolvers,
}

#[async_trait::async_trait]
impl KnowledgeAttachmentAccess for KnowledgeAccess {
    async fn check_attachment(
        &self,
        attachment_id: i64,
        user_id: i32,
    ) -> MysqlResult<Option<bool>> {
        wegent_knowledge::check_knowledge_base_access(
            &self.mysql,
            self.redis.as_ref(),
            &self.resolvers,
            attachment_id,
            user_id,
        )
        .await
    }
}

struct ShareAccess {
    mysql: brz_mysql::MysqlService,
    task_store: Arc<dyn wegent_task_store::task_store::TaskStore>,
}

#[async_trait::async_trait]
impl TaskAttachmentShareAccess for ShareAccess {
    async fn resolve_share(
        &self,
        token: &str,
        viewer_id: Option<i64>,
    ) -> Result<Option<ShareInfo>, FastApiError> {
        let link = wegent_task_views::share_access::find_task_share_link(&self.mysql, token)
            .await
            .map_err(|error| {
                tracing::error!(%error, "share-token link lookup failed");
                FastApiError::detail(
                    brz_http_server::StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error",
                )
            })?;
        let Some(link) = link else {
            return Ok(None);
        };
        wegent_task_views::share_access::require_task_access(
            &self.mysql,
            self.task_store.as_ref(),
            link.token_version,
            link.resource_id,
            viewer_id,
        )
        .await?;
        Ok(Some(ShareInfo {
            user_id: link.created_by_user_id,
            task_id: link.resource_id,
        }))
    }
}
