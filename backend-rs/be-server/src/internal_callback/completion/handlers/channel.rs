// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/services/channels/callback.py:805 handle_channel_task_completed`.
//!
//! Every registered channel service probes its own
//! `channel:task_callback:{channel_type}:{task_id}` registration key. A channel
//! with saved callback info forwards the terminal result through
//! `send_task_result`, which is outside this callback's recorded traffic.
use brz_mysql::Mysql;
use brz_redis::{Redis, RedisBytes};

use crate::internal_callback::channel::channel_key_prefixes;
use crate::internal_callback::completion::Completion;
use crate::internal_callback::completion::TaskCompletedEvent;

/// `handle_channel_task_completed`.
pub(crate) async fn handle_channel_task_completed<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    event: &TaskCompletedEvent<'_>,
) {
    for prefix in channel_key_prefixes() {
        let key = format!("{prefix}{}", event.task_id);
        match ctx.redis.get::<_, RedisBytes>(&key).await {
            Ok(Some(_)) => {
                tracing::debug!(channel_key = %key, "channel callback registered");
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, channel_key = %key, "channel callback probe failed");
            }
        }
    }
}
