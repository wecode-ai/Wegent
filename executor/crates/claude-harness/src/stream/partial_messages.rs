// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use serde_json::{json, Value};

#[derive(Default)]
pub(crate) struct ClaudePartialMessages {
    message_started: bool,
    message_id: Option<String>,
    active_index: Option<u64>,
    blocks: BTreeMap<u64, PartialBlock>,
}

struct PartialBlock {
    field: &'static str,
    text: String,
}

impl ClaudePartialMessages {
    /// Convert native deltas to the existing event format and remove snapshot echoes.
    pub(crate) fn normalize(&mut self, mut value: Value) -> Result<Option<Value>, String> {
        if !value["parent_tool_use_id"].is_null() {
            // Child output is attributed by complete messages, not root deltas.
            return Ok((value["type"] != "stream_event").then_some(value));
        }
        if value["type"] == "stream_event" {
            return self.partial(&value["event"]);
        }
        let same_message = match (self.message_id.as_deref(), value["message"]["id"].as_str()) {
            (Some(expected), Some(actual)) => expected == actual,
            // Compatible providers may omit IDs on starts, snapshots, or both.
            // Without both IDs, only attribute snapshots inside the active root message.
            _ => self.message_started,
        };
        if value["type"] == "assistant" && same_message {
            self.remove_echoes(&mut value)?;
        }
        Ok(Some(value))
    }

    fn partial(&mut self, event: &Value) -> Result<Option<Value>, String> {
        match event["type"].as_str() {
            Some("message_start") => {
                self.message_started = true;
                self.message_id = event["message"]["id"].as_str().map(str::to_owned);
                self.active_index = None;
                self.blocks.clear();
            }
            Some("message_stop") => self.message_started = false,
            Some("content_block_start") => {
                let index = event["index"]
                    .as_u64()
                    .ok_or("Missing Claude block index")?;
                self.active_index = Some(index);
                let block = &event["content_block"];
                let field = match block["type"].as_str() {
                    Some("text") => "text",
                    Some("thinking") => "thinking",
                    _ => return Ok(None),
                };
                self.blocks.insert(
                    index,
                    PartialBlock {
                        field,
                        text: String::new(),
                    },
                );
                return self.delta(index, field, block[field].as_str().unwrap_or_default());
            }
            Some("content_block_delta") => {
                let field = match event["delta"]["type"].as_str() {
                    Some("text_delta") => "text",
                    Some("thinking_delta") => "thinking",
                    _ => return Ok(None),
                };
                let index = event["index"]
                    .as_u64()
                    .ok_or("Missing Claude delta index")?;
                return self.delta(
                    index,
                    field,
                    event["delta"][field].as_str().unwrap_or_default(),
                );
            }
            _ => {}
        }
        Ok(None)
    }

    fn delta(&mut self, index: u64, field: &str, text: &str) -> Result<Option<Value>, String> {
        if !self.message_started {
            return Err("Claude delta arrived outside an active message".into());
        }
        let block = self
            .blocks
            .get_mut(&index)
            .ok_or("Claude delta arrived before block start")?;
        if block.field != field {
            return Err("Claude delta content type does not match block start".into());
        }
        block.text.push_str(text);
        Ok((!text.is_empty()).then(|| {
            json!({
                "type": "content_block_delta",
                "delta": {"type": format!("{field}_delta"), field: text}
            })
        }))
    }

    fn remove_echoes(&mut self, value: &mut Value) -> Result<(), String> {
        let Some(content) = value["message"]["content"].as_array_mut() else {
            return Ok(());
        };
        // Claude emits one AssistantMessage per block, before content_block_stop.
        // A full multi-block snapshot instead uses its original array indices.
        let single = content.len() == 1;
        for (index, block) in content.iter_mut().enumerate() {
            let index = if single {
                self.active_index
            } else {
                Some(index as u64)
            };
            let Some(partial) = index.and_then(|index| self.blocks.get_mut(&index)) else {
                continue;
            };
            if block["type"] != partial.field {
                continue;
            }
            let Some(text) = block[partial.field].as_str() else {
                continue;
            };
            let suffix = text
                .strip_prefix(&partial.text)
                .ok_or("Claude snapshot does not match streamed content")?
                .to_owned();
            partial.text = text.to_owned();
            block[partial.field] = Value::String(suffix);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn partial(state: &mut ClaudePartialMessages, event: Value) -> Option<Value> {
        state
            .normalize(json!({"type":"stream_event", "event":event}))
            .unwrap()
    }

    fn start(state: &mut ClaudePartialMessages, id: &str, index: u64, field: &str) {
        partial(state, json!({"type":"message_start", "message":{"id":id}}));
        partial(
            state,
            json!({"type":"content_block_start", "index":index,
            "content_block":{"type":field}}),
        );
    }

    #[test]
    fn unicode_deltas_and_single_block_echo_share_identity_despite_snapshot_index_zero() {
        let mut state = ClaudePartialMessages::default();
        start(&mut state, "m1", 2, "text");
        let text = "\u{4f60}\u{597d}\u{1f600}";
        let delta = partial(
            &mut state,
            json!({"type":"content_block_delta", "index":2,
            "delta":{"type":"text_delta", "text":text}}),
        )
        .unwrap();
        assert_eq!(delta["delta"]["text"], text);
        let snapshot = json!({"type":"assistant", "message":{"id":"m1", "content":[
            {"type":"text", "text":format!("{text} tail")}
        ]}});
        assert_eq!(
            state.normalize(snapshot.clone()).unwrap().unwrap()["message"]["content"][0]["text"],
            " tail"
        );
        assert_eq!(
            state.normalize(snapshot).unwrap().unwrap()["message"]["content"][0]["text"],
            ""
        );
    }

    #[test]
    fn full_snapshot_preserves_tools_and_deduplicates_thinking_and_text() {
        let mut state = ClaudePartialMessages::default();
        start(&mut state, "m1", 0, "thinking");
        partial(
            &mut state,
            json!({"type":"content_block_delta", "index":0,
            "delta":{"type":"thinking_delta", "thinking":"plan"}}),
        );
        partial(
            &mut state,
            json!({"type":"content_block_start", "index":1,
            "content_block":{"type":"text", "text":"hello"}}),
        );
        let snapshot = json!({"type":"assistant", "message":{"id":"m1", "content":[
            {"type":"thinking", "thinking":"plan"},
            {"type":"text", "text":"hello"},
            {"type":"tool_use", "id":"tool1", "name":"Bash", "input":{"command":"true"}}
        ]}});
        let result = state.normalize(snapshot).unwrap().unwrap();
        assert_eq!(result["message"]["content"][0]["thinking"], "");
        assert_eq!(result["message"]["content"][1]["text"], "");
        assert_eq!(result["message"]["content"][2]["id"], "tool1");
    }

    #[test]
    fn child_and_new_message_do_not_consume_root_partial_state() {
        let mut state = ClaudePartialMessages::default();
        start(&mut state, "m1", 0, "text");
        let child = json!({"type":"assistant", "parent_tool_use_id":"agent1",
            "message":{"id":"child1", "content":[{"type":"text", "text":"child"}]}});
        assert_eq!(state.normalize(child.clone()).unwrap(), Some(child));
        assert_eq!(state.normalize(json!({"type":"stream_event", "parent_tool_use_id":"agent1",
            "event":{"type":"content_block_delta", "index":0, "delta":{"type":"text_delta","text":"child"}}})).unwrap(), None);
        start(&mut state, "m2", 0, "text");
        let snapshot = json!({"type":"assistant", "message":{"id":"m2", "content":[{"type":"text", "text":"answer"}]}});
        assert_eq!(state.normalize(snapshot.clone()).unwrap(), Some(snapshot));
    }

    #[test]
    fn conflicting_snapshot_fails_without_logging_content() {
        let mut state = ClaudePartialMessages::default();
        start(&mut state, "m1", 0, "text");
        partial(
            &mut state,
            json!({"type":"content_block_delta", "index":0,
            "delta":{"type":"text_delta", "text":"private"}}),
        );
        let error = state
            .normalize(json!({"type":"assistant", "message":{"id":"m1", "content":[
                {"type":"text", "text":"different"}
            ]}}))
            .unwrap_err();
        assert_eq!(error, "Claude snapshot does not match streamed content");
    }

    #[test]
    fn optional_ids_preserve_thinking_text_and_snapshot_deduplication() {
        for (start_id, snapshot_id) in [(None, None), (None, Some("m1")), (Some("m1"), None)] {
            let mut state = ClaudePartialMessages::default();
            let mut message = json!({"role":"assistant", "content":[]});
            if let Some(id) = start_id {
                message["id"] = json!(id);
            }
            partial(
                &mut state,
                json!({"type":"message_start", "message":message}),
            );
            for (index, field, text) in [(0, "thinking", "plan"), (1, "text", "hello")] {
                assert!(partial(
                    &mut state,
                    json!({"type":"content_block_start", "index":index,
                    "content_block":{"type":field, field:""}})
                )
                .is_none());
                let delta = partial(
                    &mut state,
                    json!({"type":"content_block_delta", "index":index,
                    "delta":{"type":format!("{field}_delta"), field:text}}),
                )
                .unwrap();
                assert_eq!(delta["delta"][field], text);
            }
            let mut snapshot = json!({"type":"assistant", "message":{"content":[
                {"type":"thinking", "thinking":"plan"}, {"type":"text", "text":"hello tail"}
            ]}});
            if let Some(id) = snapshot_id {
                snapshot["message"]["id"] = json!(id);
            }
            let normalized = state.normalize(snapshot.clone()).unwrap().unwrap();
            assert_eq!(normalized["message"]["content"][0]["thinking"], "");
            assert_eq!(normalized["message"]["content"][1]["text"], " tail");
            assert_eq!(
                state.normalize(snapshot).unwrap().unwrap()["message"]["content"][1]["text"],
                ""
            );
            partial(&mut state, json!({"type":"message_stop"}));
            let unrelated = json!({"type":"assistant", "message":{"content":[{"type":"text", "text":"hello"}]}});
            assert_eq!(state.normalize(unrelated.clone()).unwrap(), Some(unrelated));
        }
    }

    #[test]
    fn message_start_is_required_even_when_ids_are_optional() {
        let mut state = ClaudePartialMessages::default();
        let delta = json!({"type":"stream_event", "event":{"type":"content_block_delta", "index":0,
            "delta":{"type":"text_delta", "text":"hello"}}});
        assert!(state.normalize(delta.clone()).is_err());
        start(&mut state, "m1", 0, "text");
        partial(&mut state, json!({"type":"message_stop"}));
        assert!(state.normalize(delta).is_err());
    }
}
