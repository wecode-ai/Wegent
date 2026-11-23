// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Durable video polling and research continuations for hosted model providers.

#![forbid(unsafe_code)]

mod card;
mod create;

pub use create::dispatch;
mod poll;
mod recovery;
mod store;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use wegent_job_runtime::{BackgroundJobRegistry, BackgroundJobsClient};

pub struct VideoJobs {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub auth: wegent_backend_config::AuthConfig,
    pub task_store: Arc<dyn wegent_task_store::task_store::TaskStore>,
    pub background_jobs: BackgroundJobsClient,
    pub entity_resolvers: wegent_access::permissions::EntityResolvers,
    pub celery: wegent_celery::CeleryBroker,
    pub attachment_upload: Arc<dyn wegent_attachments::AttachmentUploadBackend>,
    pub video_extensions: Arc<dyn VideoExtensions>,
    pub model_config: fn(&Value, i64, &str) -> Result<Value>,
}

impl VideoJobs {
    fn upload_services(&self) -> wegent_attachments::UploadServices<'_> {
        wegent_attachments::UploadServices {
            mysql: &self.mysql,
            attachment_upload: &self.attachment_upload,
        }
    }
}

/// Commit terminal state and invoke the installed execution lifecycle handlers.
#[async_trait::async_trait]
pub trait FinishExecution: Send + Sync {
    async fn finish(
        &self,
        task_id: i64,
        subtask_id: i64,
        status: &str,
        result: Option<&Value>,
        error: Option<&str>,
    ) -> Result<bool>;
}

pub const POLL: &str = "app.tasks.video_tasks.poll_video_job";
pub const RECOVERY: &str = "video.recover_jobs";

#[derive(Clone, Deserialize, Serialize)]
pub struct Poll {
    pub subtask_id: i64,
    pub task_id: i64,
    pub user_id: i64,
    pub job_id: String,
    pub provider_protocol: String,
    pub video_block_id: String,
    pub model_config: Value,
    pub message_id: Option<i64>,
    #[serde(default)]
    pub intent_result: Option<Value>,
    #[serde(default)]
    pub poll_count: u32,
    #[serde(default)]
    pub last_progress: i64,
    #[serde(default)]
    pub card_context: Option<Value>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub scheduled_token: Option<String>,
}

pub use wegent_media::video::{
    DefaultVideoExtensions, VideoArtifact, VideoExtensions, VideoResult, VideoStatus,
};

pub fn register(registry: &mut BackgroundJobRegistry, state: Arc<VideoJobs>) -> Result<()> {
    let copy = state.clone();
    registry.register_outcome(POLL, move |context, value| {
        let state = copy.clone();
        async move { poll::run(&state, &context, serde_json::from_value(value)?).await }
    })?;
    registry.max_failures(POLL, 3)?;
    registry.register(RECOVERY, move |context, _| {
        let state = state.clone();
        async move { recovery::run(&state, &context).await }
    })?;
    registry.max_failures(RECOVERY, 1)?;
    registry.startup(RECOVERY, Duration::ZERO)?;
    registry.startup(
        RECOVERY,
        Duration::from_secs(setting("VIDEO_RECOVERY_STALE_SECONDS", 10) as u64 + 1),
    )
}

fn setting(name: &str, default: i64) -> i64 {
    wegent_backend_config::env_or_dotenv(name)
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}
fn interval() -> i64 {
    setting("VIDEO_POLL_INTERVAL_SECONDS", 3)
}
fn maximum() -> u32 {
    u32::try_from(setting("VIDEO_MAX_POLL_COUNT", 600)).unwrap_or(u32::MAX)
}
