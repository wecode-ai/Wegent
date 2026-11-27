// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Provider hooks for video polling, material staging, and durable results.

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Map, Value};

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
    /// Resolve one authorized uploaded reference before sending it to a provider.
    async fn resolve_uploaded_material(
        &self,
        type_data: &Value,
        media_type: &str,
        _user_id: i64,
        _attachment_id: i64,
    ) -> Result<Option<Value>> {
        Ok(self.resolve_material(type_data, media_type))
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
    async fn stage_images(&self, _images: Vec<Value>, _user_id: i64) -> Result<Option<Vec<Value>>> {
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
