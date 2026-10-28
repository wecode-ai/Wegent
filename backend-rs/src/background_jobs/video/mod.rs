// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Durable polling continuations share the existing subtask result schema.

mod card;
pub(crate) mod create;
mod poll;
mod recovery;
mod store;

use crate::{AppState, background_jobs::BackgroundJobRegistry};
use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{sync::Arc, time::Duration};

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

#[derive(Clone, Debug)]
pub struct VideoStatus {
    pub progress: i64,
    pub completed: bool,
    pub failed: bool,
    pub error: Option<String>,
}
#[derive(Clone, Debug)]
pub struct VideoResult {
    pub video_url: String,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub metadata: Map<String, Value>,
}
#[derive(Clone, Debug)]
pub struct VideoArtifact {
    pub video_url: String,
    pub websocket_video_url: String,
    pub attachment_id: i64,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub block_metadata: Map<String, Value>,
}

/// Deployment-owned parsing, trusted workflow endpoints and artifact storage.
/// The public implementation keeps ordinary Seedance and attachment behavior.
#[async_trait]
pub trait VideoExtensions: Send + Sync {
    fn resolve_material(&self, _type_data: &Value, _media_type: &str) -> Option<Value> {
        None
    }
    fn provider_content(
        &self,
        _protocol: &str,
        _media_type: &str,
        _descriptor: &Value,
        _role: &str,
    ) -> Option<Value> {
        None
    }
    async fn stage_images(
        &self,
        _state: &AppState,
        _images: Vec<Value>,
        _user_id: i64,
    ) -> Result<Option<Vec<Value>>> {
        Ok(None)
    }
    fn parse_status(&self, _data: &Value, status: VideoStatus) -> VideoStatus {
        status
    }
    fn parse_result(&self, _data: &Value, result: VideoResult) -> VideoResult {
        result
    }
    fn allows_card_url(&self, _url: &str) -> bool {
        false
    }
    fn normalize_card(&self, card: Value) -> Value {
        card
    }
    async fn prepare_artifact(
        &self,
        _state: &Arc<AppState>,
        _result: &VideoResult,
        _user_id: i64,
        _task_id: i64,
        _subtask_id: i64,
    ) -> Result<Option<VideoArtifact>> {
        Ok(None)
    }
}
pub struct DefaultVideoExtensions;
impl VideoExtensions for DefaultVideoExtensions {}

pub(crate) fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
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

pub(super) fn setting(name: &str, default: i64) -> i64 {
    crate::config::env_or_dotenv(name)
        .and_then(|value| value.parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}
pub(super) fn interval() -> i64 {
    setting("VIDEO_POLL_INTERVAL_SECONDS", 3)
}
pub(super) fn maximum() -> u32 {
    u32::try_from(setting("VIDEO_MAX_POLL_COUNT", 600)).unwrap_or(u32::MAX)
}
