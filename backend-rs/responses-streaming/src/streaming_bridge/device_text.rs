// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Consumer-side replay and overlap trimming for identified device text.

use std::collections::HashMap;

use serde_json::Value;

use wegent_execution_events::event::ExecutionEvent;

#[derive(Default)]
pub(super) struct DeviceTextOffsets {
    ends: HashMap<String, u64>,
}

impl DeviceTextOffsets {
    /// Offsets count Unicode code points, matching the device producer.
    pub(super) fn unseen_suffix<'a>(&mut self, event: &'a ExecutionEvent) -> &'a str {
        if event.content.is_empty() {
            return "";
        }
        let Some(block_id) = event.data.get("block_id").and_then(Value::as_str) else {
            return &event.content;
        };
        let current = self.ends.entry(block_id.to_owned()).or_default();
        let offset = event
            .data
            .get("block_offset")
            .and_then(Value::as_u64)
            .unwrap_or(*current);
        let end = offset.saturating_add(event.content.chars().count() as u64);
        if end <= *current {
            return "";
        }
        let skip = current.saturating_sub(offset) as usize;
        *current = end;
        // Keep forward-gap deltas; the terminal snapshot supplies any missing text.
        if skip == 0 {
            return &event.content;
        }
        event
            .content
            .char_indices()
            .nth(skip)
            .map_or("", |(byte, _)| &event.content[byte..])
    }
}
