// SPDX-License-Identifier: Apache-2.0

use super::*;

struct UploaderAccess;

#[async_trait::async_trait]
impl KnowledgeAttachmentAccess for UploaderAccess {
    async fn check_attachment(&self, _: i64, _: i32) -> MysqlResult<Option<bool>> {
        panic!("the uploader fixture does not require an unlinked attachment ACL check");
    }
}

#[async_trait::async_trait]
impl TaskAttachmentShareAccess for UploaderAccess {
    async fn resolve_share(
        &self,
        _: &str,
        _: Option<i64>,
    ) -> Result<Option<ShareInfo>, FastApiError> {
        panic!("the uploader fixture does not authenticate with a task share token");
    }
}

pub(crate) fn state(mysql: MysqlService) -> Arc<AttachmentState> {
    Arc::new(AttachmentState {
        task_store: Arc::new(task_store::DefaultTaskStore::new(mysql.clone())),
        mysql,
        auth: config::AuthConfig {
            jwt_key: "attachment-test-key".into(),
            algorithm: "HS256".into(),
            legacy_jwt_keys: Vec::new(),
        },
        frontend_url: String::new(),
        attachment_http: minio_client::build_client().unwrap(),
        attachment_upload: Arc::new(upload::MySqlStorageBackend),
        media_policy: Arc::new(media_policy::DefaultMediaPolicy),
        external_media: Arc::new(external_media::NoExternalMediaRelay),
        external_playback: Arc::new(external_media::NoExternalPlaybackResolver),
        knowledge_access: Arc::new(UploaderAccess),
        share_access: Arc::new(UploaderAccess),
    })
}
