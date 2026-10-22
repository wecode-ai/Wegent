// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::Instant;

use serde_json::Value;

use crate::logging::log_executor_event;

pub(super) struct ClaudeStreamDiagnostics {
    started: Instant,
    previous: Instant,
    events: usize,
    partial_events: usize,
    root_text_deltas: usize,
}

impl ClaudeStreamDiagnostics {
    pub(super) fn new() -> Self {
        let started = Instant::now();
        Self {
            started,
            previous: started,
            events: 0,
            partial_events: 0,
            root_text_deltas: 0,
        }
    }

    pub(super) fn observe(&mut self, value: &Value, task_id: &str, subtask_id: &str) {
        let now = Instant::now();
        let gap_ms = now.duration_since(self.previous).as_millis();
        self.previous = now;
        self.events += 1;
        let kind = value["type"].as_str().unwrap_or_default();
        let partial = kind == "stream_event" || kind == "content_block_delta";
        self.partial_events += usize::from(partial);
        let payload = if kind == "stream_event" {
            &value["event"]
        } else {
            value
        };
        let child = !value["parent_tool_use_id"].is_null();
        let root_text = !child && payload["delta"]["type"] == "text_delta";
        self.root_text_deltas += usize::from(root_text);
        // Log snapshots and the first delta, not every token. Never log payload text.
        if !(self.events == 1
            || matches!(kind, "assistant" | "result")
            || partial && self.partial_events == 1
            || root_text && self.root_text_deltas == 1)
        {
            return;
        }
        let mut fields = self.fields(task_id, subtask_id);
        fields.extend(metadata(value));
        fields.push(("gap_ms", gap_ms.to_string()));
        log_executor_event("claude stdout event received", &fields);
    }

    pub(super) fn finish(&self, task_id: &str, subtask_id: &str) {
        log_executor_event(
            "claude stdout stream finished",
            &self.fields(task_id, subtask_id),
        );
    }

    fn fields(&self, task_id: &str, subtask_id: &str) -> Vec<(&'static str, String)> {
        vec![
            ("task_id", task_id.to_owned()),
            ("subtask_id", subtask_id.to_owned()),
            (
                "since_start_ms",
                self.started.elapsed().as_millis().to_string(),
            ),
            ("events", self.events.to_string()),
            ("partial_events", self.partial_events.to_string()),
            ("root_text_deltas", self.root_text_deltas.to_string()),
        ]
    }
}

fn metadata(value: &Value) -> Vec<(&'static str, String)> {
    let kind = match value["type"].as_str().unwrap_or_default() {
        kind @ ("assistant"
        | "user"
        | "system"
        | "result"
        | "stream_event"
        | "content_block_delta") => kind,
        _ => "other",
    };
    let mut text_chars = 0;
    let mut thinking_chars = 0;
    if kind == "assistant" {
        for block in value["message"]["content"].as_array().into_iter().flatten() {
            match block["type"].as_str() {
                Some("text") => {
                    text_chars += block["text"].as_str().unwrap_or_default().chars().count()
                }
                Some("thinking") => {
                    thinking_chars += block["thinking"]
                        .as_str()
                        .unwrap_or_default()
                        .chars()
                        .count()
                }
                _ => {}
            }
        }
    }
    vec![
        ("event_type", kind.to_owned()),
        (
            "child",
            (!value["parent_tool_use_id"].is_null()).to_string(),
        ),
        ("text_chars", text_chars.to_string()),
        ("thinking_chars", thinking_chars.to_string()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn diagnostics_log_lengths_without_message_or_tool_contents() {
        let fields = metadata(&json!({"type":"assistant", "message":{"content":[
            {"type":"text", "text":"secret"},
            {"type":"thinking", "thinking":"private"},
            {"type":"tool_use", "input":{"token":"credential"}}
        ]}}));
        assert!(fields.contains(&("text_chars", "6".into())));
        assert!(fields.contains(&("thinking_chars", "7".into())));
        let encoded = format!("{fields:?}");
        for secret in ["secret", "private", "credential"] {
            assert!(!encoded.contains(secret));
        }
        assert_eq!(metadata(&json!({"type":"credential"}))[0].1, "other");
    }

    #[test]
    fn diagnostics_distinguish_root_deltas_from_child_deltas_and_snapshots() {
        let mut diagnostics = ClaudeStreamDiagnostics::new();
        for event in [
            json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}}),
            json!({"type":"stream_event","parent_tool_use_id":"child","event":{"delta":{"type":"text_delta","text":"b"}}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"a"}]}}),
        ] {
            diagnostics.observe(&event, "1", "2");
        }
        assert_eq!(diagnostics.events, 3);
        assert_eq!(diagnostics.partial_events, 2);
        assert_eq!(diagnostics.root_text_deltas, 1);
    }
}
