// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bind attachment writes and indexing to the knowledge routes.

use std::sync::Arc;

use serde_json::{Map, Value};
use wegent_attachments::UploadServices;
use wegent_attachments::upload::{
    AttachmentUploadBackend, OverwriteError, Preflush, overwrite_attachment_internal,
};
use wegent_backend_persistence::request_sql::StatementArgs;
use wegent_knowledge::{DocumentAttachmentWriter, IndexDispatcher, KnowledgeState};
use wegent_knowledge_access::open_auth::ApiFailure;

use crate::state::AppState;

pub(crate) fn build_state(app: &Arc<AppState>) -> KnowledgeState {
    KnowledgeState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        entity_resolvers: app.entity_resolvers.clone(),
        erp: app.erp.clone(),
        attachment_writer: Arc::new(AppAttachmentWriter {
            mysql: app.mysql.clone(),
            backend: Arc::clone(&app.attachment_upload),
        }),
        document_download_policy: Arc::clone(&app.document_download_policy),
        index_dispatcher: Arc::new(AppIndexDispatcher(Arc::clone(app))),
    }
}

struct AppAttachmentWriter {
    mysql: brz_mysql::MysqlService,
    backend: Arc<dyn AttachmentUploadBackend>,
}

#[async_trait::async_trait]
impl DocumentAttachmentWriter for AppAttachmentWriter {
    async fn overwrite(
        &self,
        attachment_id: i64,
        filename: &str,
        content: &[u8],
        caller_flush: Option<(String, StatementArgs)>,
    ) -> Result<(), ApiFailure> {
        overwrite_attachment_internal(
            UploadServices {
                mysql: &self.mysql,
                attachment_upload: &self.backend,
            },
            // Knowledge has already enforced its document-scoped manage check.
            None,
            attachment_id,
            filename,
            content,
            &Map::new(),
            caller_flush.map(|(sql, params)| Preflush { sql, params }),
        )
        .await
        .map(|_| ())
        .map_err(overwrite_failure)
    }
}

/// The knowledge path catches the attachment's status/detail errors. Parse
/// errors fall through to the application's generic 500 handler.
fn overwrite_failure(error: OverwriteError) -> ApiFailure {
    match error.into_detail() {
        Some(error) => ApiFailure::new(
            error.status(),
            error
                .detail_message()
                .unwrap_or("Internal Server Error")
                .to_string(),
        ),
        None => internal_failure("document parsing failed"),
    }
}

struct AppIndexDispatcher(Arc<AppState>);

#[async_trait::async_trait]
impl IndexDispatcher for AppIndexDispatcher {
    async fn dispatch(
        &self,
        document_id: i64,
        generation: i64,
        payload: Value,
    ) -> Result<(), ApiFailure> {
        let state = &self.0;
        let name = wegent_knowledge_jobs::INDEX_JOB;
        let task_id = crate::wework_auth_tokens::uuid4_hex()
            .map_err(|_| internal_failure("task id generation failed"))?;
        let dispatch: Result<(), ApiFailure> = async {
            if state.background_jobs.is_enabled(name) {
                state
                    .background_jobs
                    .submit(name, &payload, None, Some(task_id))
                    .await
                    .map_err(internal_failure)?;
            } else {
                let redis = state
                    .redis
                    .as_ref()
                    .ok_or_else(|| internal_failure("knowledge task broker is unavailable"))?;
                state
                    .celery
                    .dispatch(
                        redis,
                        &crate::celery_broker::CeleryTask {
                            task_name: name,
                            queue: "wegent_online",
                            task_id: &task_id,
                            kwargs: payload.as_object().expect("index payload is an object"),
                            expires_at: None,
                        },
                    )
                    .await
                    .map_err(internal_failure)?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = dispatch {
            wegent_knowledge_jobs::dispatch_failed(
                &crate::attachment_access::upload_services(state),
                document_id,
                generation,
            )
            .await
            .map_err(internal_failure)?;
            return Err(error);
        }
        Ok(())
    }
}

fn internal_failure(error: impl std::fmt::Display) -> ApiFailure {
    ApiFailure::internal(error.to_string())
}
