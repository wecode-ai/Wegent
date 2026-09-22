// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Extension point for `refresh_extended_video_result_urls`
//! (`app/services/execution/agents/video/extensions.py`): the assembled task
//! detail response lets a registered video-generation integration refresh the
//! temporary client-facing playback URLs of its result blocks.
use async_trait::async_trait;
use serde_json::value::RawValue;

/// `VideoGenerationExtension.refresh_result_urls`. The public build registers
/// no integration, so every result stays unchanged.
#[async_trait]
pub trait VideoResultUrlRefresh: Send + Sync {
    /// `refresh_extended_video_result_urls`: the task-level result first, then
    /// every subtask result in subtask order. Implementations rewrite the
    /// temporary video URLs they own and leave every other payload untouched.
    /// An error is the source's uncaught refresh failure, which fails the
    /// request.
    async fn refresh_result_urls(
        &self,
        _client: &brz_http::Client,
        _results: &mut [&mut Box<RawValue>],
    ) -> anyhow::Result<()> {
        Ok(())
    }
}

/// No internal video integration is registered.
pub struct NoVideoResultUrlRefresh;

#[async_trait]
impl VideoResultUrlRefresh for NoVideoResultUrlRefresh {}
