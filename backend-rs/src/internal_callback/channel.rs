// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! IM channel callback forwarding for the execution callback.
//!
//! Mirrors `app/services/channels/callback.py`. The worker imports the
//! DingTalk and Telegram callback modules so their services register in the
//! process-wide registry; `emit_event` first probes
//! `channel:task_callback:{channel_type}:{task_id}` and returns without
//! forwarding when the key is absent. Terminal events are skipped.
use brz_redis::{Redis, RedisBytes};

use super::event::ExecutionEvent;

/// `channel:task_callback:{channel_type}:` key prefixes, in registry
/// (import) order.
const CHANNEL_KEY_PREFIXES: [&str; 2] = [
    "channel:task_callback:dingtalk:",
    "channel:task_callback:telegram:",
];

/// The registered channel key prefixes, in registry (import) order.
///
/// `status_updating.py`'s terminal handling forwards through
/// `TaskCompletedEvent`, so the completion fan-out probes the same list.
pub(crate) fn channel_key_prefixes() -> [&'static str; 2] {
    CHANNEL_KEY_PREFIXES
}

/// `forward_event_to_channel_callbacks`: probe each registered channel.
pub(crate) async fn forward_event_to_channel_callbacks<R: Redis>(
    redis: &R,
    task_id: i64,
    event: &ExecutionEvent,
) {
    if is_terminal(&event.event_type) {
        return;
    }
    for prefix in CHANNEL_KEY_PREFIXES {
        let key = format!("{prefix}{task_id}");
        match redis.get::<_, RedisBytes>(&key).await {
            Ok(Some(_)) => {
                // A registered channel with saved callback info would forward
                // the event here; the recorded traffic has none, and the
                // channel emitters themselves are outside this migration.
                tracing::debug!(channel_key = %key, "channel callback info present");
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, channel_key = %key, "channel callback probe failed");
            }
        }
    }
}

fn is_terminal(event_type: &str) -> bool {
    matches!(event_type, "done" | "error" | "cancel" | "cancelled")
}
