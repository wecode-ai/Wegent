// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::emitter::{EventEnvelope, ResponsesEventBuilder};

/// Adapts desktop deltas to the callback protocol used by standard executors.
#[derive(Default)]
pub(super) struct StandardEventProjection {
    blocks: BTreeMap<String, Map<String, Value>>,
    published_blocks: BTreeSet<String>,
    output_text: BTreeMap<String, String>,
    output_offset: usize,
}

impl StandardEventProjection {
    pub(super) fn begin_response(&mut self) {
        self.published_blocks.clear();
        self.output_text.clear();
        self.output_offset = 0;
    }

    pub(super) fn project(
        &mut self,
        event_type: &str,
        mut data: Value,
        builder: &ResponsesEventBuilder,
    ) -> Result<Option<EventEnvelope>, String> {
        match event_type {
            "response.block.created" => {
                let block = data["block"]
                    .as_object_mut()
                    .ok_or("Codex block event has no block")?;
                if block.get("type").and_then(Value::as_str) == Some("subagent") {
                    normalize_subagent_status(block);
                }
                let id = block["id"].as_str().ok_or("Codex block has no ID")?;
                self.blocks.insert(id.to_owned(), block.clone());
                self.published_blocks.insert(id.to_owned());
            }
            "response.block.updated" => {
                let id = data["block_id"]
                    .as_str()
                    .ok_or("Codex block update has no ID")?
                    .to_owned();
                let updates = data["updates"]
                    .as_object_mut()
                    .ok_or("Codex block update has no updates")?;
                return Ok(Some(self.update_block(&id, updates, builder)));
            }
            "response.output_text.delta" | "response.output_text.done" => {
                return self.project_output(event_type, &data, builder);
            }
            _ => {}
        }
        Ok(Some(builder.envelope(event_type, data)))
    }

    fn update_block(
        &mut self,
        id: &str,
        updates: &mut Map<String, Value>,
        builder: &ResponsesEventBuilder,
    ) -> EventEnvelope {
        let block = self.blocks.entry(id.to_owned()).or_default();
        if block.get("type").and_then(Value::as_str) == Some("subagent") {
            normalize_subagent_status(updates);
        }
        for (delta_key, content_key) in [
            ("content_delta", "content"),
            ("tool_output_delta", "tool_output"),
        ] {
            if let Some(Value::String(delta)) = updates.remove(delta_key) {
                let previous = block.get(content_key).and_then(Value::as_str).unwrap_or("");
                updates.insert(content_key.to_owned(), json!(format!("{previous}{delta}")));
            }
        }
        block.extend(updates.clone());
        if !self.published_blocks.contains(id) && block.contains_key("type") {
            // A resumed form uses a new subtask, whose consumers have no old blocks.
            self.published_blocks.insert(id.to_owned());
            return builder.envelope(
                "response.block.created",
                json!({"type": "response.block.created", "block": block}),
            );
        }
        builder.envelope(
            "response.block.updated",
            json!({"type": "response.block.updated", "block_id": id, "updates": updates}),
        )
    }

    fn project_output(
        &mut self,
        event_type: &str,
        data: &Value,
        builder: &ResponsesEventBuilder,
    ) -> Result<Option<EventEnvelope>, String> {
        let id = data["item_id"]
            .as_str()
            .ok_or("Codex output has no item ID")?;
        let completed = event_type == "response.output_text.done";
        let text = data[if completed { "text" } else { "delta" }]
            .as_str()
            .ok_or("Codex output has no text")?;
        // An item's final phase can arrive after its text was already shown as a block.
        let block_id = self.blocks.iter().find_map(|(block_id, block)| {
            (block.get("type").and_then(Value::as_str) == Some("text")
                && (block.get("process_item_id").and_then(Value::as_str) == Some(id)
                    || block_id == id))
                .then(|| block_id.clone())
        });
        if let Some(block_id) = block_id {
            let mut updates = Map::from_iter([
                (
                    (if completed {
                        "content"
                    } else {
                        "content_delta"
                    })
                    .to_owned(),
                    json!(text),
                ),
                (
                    "status".to_owned(),
                    json!(if completed { "done" } else { "streaming" }),
                ),
            ]);
            return Ok(Some(self.update_block(&block_id, &mut updates, builder)));
        }
        let previous = self.output_text.entry(id.to_owned()).or_default();
        let delta = if completed {
            match text.strip_prefix(previous.as_str()) {
                Some(suffix) => suffix,
                // A delta cannot replace emitted text; response.completed carries the result.
                None => return Ok(None),
            }
        } else {
            text
        };
        // Standard callbacks merge body chunks by subtask, without retaining item IDs.
        let event = (!delta.is_empty())
            .then(|| builder.response_text_delta_for_item(id, delta, self.output_offset));
        self.output_offset += delta.chars().count();
        if completed {
            *previous = text.to_owned();
        } else {
            previous.push_str(text);
        }
        Ok(event)
    }
}

fn normalize_subagent_status(fields: &mut Map<String, Value>) {
    let status = match fields.get("status").and_then(Value::as_str) {
        Some("running") => "pending",
        Some("interrupted") => "error",
        _ => return,
    };
    fields.insert("status".to_owned(), json!(status));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consecutive_output_items_share_the_callback_text_offset() {
        let mut projection = StandardEventProjection::default();
        let builder = ResponsesEventBuilder::new("task", "first", "model");
        for (id, text, expected_offset) in [("one", "你好🙂", 0), ("two", "继续", 3)] {
            let event = projection
                .project(
                    "response.output_text.done",
                    json!({"item_id": id, "text": text}),
                    &builder,
                )
                .unwrap()
                .unwrap();
            assert_eq!(event.data["delta"], text);
            assert_eq!(event.data["offset"], expected_offset);
        }
    }

    #[test]
    fn rewritten_completed_text_is_not_appended_as_a_delta() {
        let mut projection = StandardEventProjection::default();
        let builder = ResponsesEventBuilder::new("task", "first", "model");
        projection
            .project(
                "response.output_text.delta",
                json!({"item_id": "message", "delta": "abc"}),
                &builder,
            )
            .unwrap();
        let completed = projection
            .project(
                "response.output_text.done",
                json!({"item_id": "message", "text": "xyz123"}),
                &builder,
            )
            .unwrap();
        assert!(completed.is_none());
    }

    #[test]
    fn late_final_phase_finishes_existing_text_without_creating_duplicate_output() {
        let mut projection = StandardEventProjection::default();
        let builder = ResponsesEventBuilder::new("task", "first", "model");
        projection
            .project(
                "response.block.created",
                json!({"block": {
                    "id": "process-block", "type": "text", "process_item_id": "message",
                    "content": "正在", "status": "streaming"
                }}),
                &builder,
            )
            .unwrap();

        let completed = projection
            .project(
                "response.output_text.done",
                json!({"item_id": "message", "text": "正在输出完整正文"}),
                &builder,
            )
            .unwrap()
            .unwrap();

        assert_eq!(completed.event_type, "response.block.updated");
        assert_eq!(completed.data["block_id"], "process-block");
        assert_eq!(completed.data["updates"]["content"], "正在输出完整正文");
        assert_eq!(completed.data["updates"]["status"], "done");
    }

    #[test]
    fn resumed_response_restores_tool_identity_and_restarts_body_offsets() {
        let mut projection = StandardEventProjection::default();
        let first = ResponsesEventBuilder::new("task", "first", "model");
        projection
            .project(
                "response.block.created",
                json!({"block": {
                    "id": "tool", "type": "tool", "tool_name": "shell",
                    "tool_input": {"command": "pwd"}, "tool_output": "开始",
                    "parent_tool_use_id": "parent", "status": "streaming"
                }}),
                &first,
            )
            .unwrap();
        projection
            .project(
                "response.output_text.delta",
                json!({"item_id": "message", "delta": "之前"}),
                &first,
            )
            .unwrap();

        projection.begin_response();
        let second = ResponsesEventBuilder::new("task", "second", "model");
        let tool = projection
            .project(
                "response.block.updated",
                json!({"block_id": "tool", "updates": {
                    "tool_output_delta": "完成", "status": "done"
                }}),
                &second,
            )
            .unwrap()
            .unwrap();
        let body = projection
            .project(
                "response.output_text.delta",
                json!({"item_id": "message", "delta": "继续"}),
                &second,
            )
            .unwrap()
            .unwrap();

        assert_eq!(tool.event_type, "response.block.created");
        assert_eq!(tool.subtask_id, "second");
        assert_eq!(tool.data["block"]["tool_name"], "shell");
        assert_eq!(tool.data["block"]["parent_tool_use_id"], "parent");
        assert_eq!(tool.data["block"]["tool_input"]["command"], "pwd");
        assert_eq!(tool.data["block"]["tool_output"], "开始完成");
        assert_eq!(body.subtask_id, "second");
        assert_eq!(body.data["offset"], 0);
        assert_eq!(body.data["delta"], "继续");
    }
}
