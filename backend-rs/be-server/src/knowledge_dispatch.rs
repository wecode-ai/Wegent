// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bind the application's index transport and compensation to knowledge routes.

use std::sync::Arc;

use serde_json::Value;
use wegent_knowledge::{IndexDispatcher, KnowledgeState};
use wegent_knowledge_access::open_auth::ApiFailure;

use crate::state::AppState;

pub(crate) fn build_state(app: &Arc<AppState>) -> KnowledgeState {
    KnowledgeState {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        entity_resolvers: app.entity_resolvers.clone(),
        attachment_upload: Arc::clone(&app.attachment_upload),
        document_download_policy: Arc::clone(&app.document_download_policy),
        index_dispatcher: Arc::new(AppIndexDispatcher(Arc::clone(app))),
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
        let name = crate::background_jobs::knowledge::index::NAME;
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
            crate::background_jobs::knowledge::index::dispatch_failed(
                state,
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
