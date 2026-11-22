// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::Value;
use wegent_protocol::dispatch::ExecutionRequest;
use wegent_video_jobs::{FinishExecution, VideoJobs};

use crate::AppState;
use crate::internal_callback::{self, completion};

pub use wegent_video_jobs::{
    DefaultVideoExtensions, POLL, Poll, RECOVERY, VideoArtifact, VideoExtensions, VideoResult,
    VideoStatus,
};

fn services(app: &AppState) -> VideoJobs {
    VideoJobs {
        mysql: app.mysql.clone(),
        redis: app.redis.clone(),
        auth: app.auth.clone(),
        task_store: Arc::clone(&app.task_store),
        background_jobs: app.background_jobs.clone(),
        entity_resolvers: app.entity_resolvers.clone(),
        celery: app.celery.clone(),
        attachment_upload: Arc::clone(&app.attachment_upload),
        video_extensions: Arc::clone(&app.video_extensions),
        model_config: super::execution::model_config,
    }
}

pub(crate) fn register(
    registry: &mut super::BackgroundJobRegistry,
    app: Arc<AppState>,
) -> Result<()> {
    wegent_video_jobs::register(registry, Arc::new(services(&app)))
}

pub(crate) async fn dispatch(app: &AppState, request: &ExecutionRequest) -> Result<()> {
    wegent_video_jobs::dispatch(&services(app), request, &Completion(app)).await
}

struct Completion<'a>(&'a AppState);

#[async_trait::async_trait]
impl FinishExecution for Completion<'_> {
    async fn finish(
        &self,
        task_id: i64,
        subtask_id: i64,
        status: &str,
        result: Option<&Value>,
        error: Option<&str>,
    ) -> Result<bool> {
        let app = self.0;
        let context = completion::Completion {
            app: Some(app),
            mysql: &app.mysql,
            redis: app
                .redis
                .as_ref()
                .context("Polling execution requires Redis")?,
            tables: internal_callback::tables(app),
            executor_manager: &app.executor_manager,
        };
        let committed = completion::complete_terminal(
            &context, task_id, subtask_id, status, result, error, None, None, None,
        )
        .await?;
        Ok(committed.is_some())
    }
}
