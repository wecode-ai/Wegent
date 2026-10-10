// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::emitter::{EventEnvelope, ResponsesEventBuilder};

/// Web callbacks use existing Edit tools; native workbench events stay unchanged.
#[derive(Default)]
pub(super) struct FileChangeProjection {
    blocks: BTreeMap<String, Map<String, Value>>,
    published: BTreeMap<String, Value>,
}

impl FileChangeProjection {
    pub(super) fn include_details(data: &mut Value, notification: &Value) {
        let source = match notification["method"].as_str() {
            Some("item/fileChange/patchUpdated") => &notification["params"],
            Some("item/started" | "item/completed")
                if notification["params"]["item"]["type"] == "fileChange" =>
            {
                &notification["params"]["item"]
            }
            _ => return,
        };
        let Some(changes) = source["changes"].as_array() else {
            return;
        };
        let key = if data.get("block").is_some() {
            "block"
        } else {
            "updates"
        };
        let Some(summary) = data
            .get_mut(key)
            .and_then(|block| block.get_mut("file_changes"))
        else {
            return;
        };
        let workspace = summary["workspace_path"].as_str().unwrap_or("");
        let details: BTreeMap<_, _> = changes
            .iter()
            .filter_map(|change| crate::runtime_work::codex_file_change_content(change, workspace))
            .collect();
        if let Some(files) = summary["files"].as_array_mut() {
            for file in files {
                if let Some(detail) = file["path"].as_str().and_then(|path| details.get(path)) {
                    file.as_object_mut()
                        .unwrap()
                        .extend(detail.as_object().unwrap().clone());
                }
            }
        }
    }

    pub(super) fn begin_response(&mut self) {
        self.published.clear();
    }

    pub(super) fn handles(&self, event_type: &str, data: &Value) -> bool {
        match event_type {
            "response.block.created" => data["block"]["type"] == "file_changes",
            "response.block.updated" => {
                data["updates"].get("file_changes").is_some()
                    || data["block_id"]
                        .as_str()
                        .is_some_and(|id| self.blocks.contains_key(id))
            }
            _ => false,
        }
    }

    pub(super) fn project(
        &mut self,
        event_type: &str,
        data: Value,
        builder: &ResponsesEventBuilder,
    ) -> Result<Vec<EventEnvelope>, String> {
        let (id, fields) = if event_type == "response.block.created" {
            (&data["block"]["id"], &data["block"])
        } else {
            (&data["block_id"], &data["updates"])
        };
        let id = id.as_str().ok_or("Codex file change has no block ID")?;
        let fields = fields
            .as_object()
            .ok_or("Codex file change has no fields")?;
        let block = self.blocks.entry(id.to_owned()).or_default();
        // Native patch updates can repeat block.created; keep the first timestamp.
        for (key, value) in fields {
            if key != "timestamp" || !block.contains_key(key) {
                block.insert(key.clone(), value.clone());
            }
        }
        let files = block
            .get("file_changes")
            .and_then(|summary| summary.get("files"))
            .and_then(Value::as_array)
            .ok_or("Codex file change has no files")?;
        let mut events = Vec::new();
        for file in files {
            let tool = edit_tool(id, block, file)?;
            let tool_id = tool["id"].as_str().unwrap();
            if self.published.get(tool_id) == Some(&tool) {
                continue;
            }
            let event = if self.published.contains_key(tool_id) {
                builder.envelope(
                    "response.block.updated",
                    json!({
                        "type": "response.block.updated", "block_id": tool_id, "updates": tool
                    }),
                )
            } else {
                builder.envelope(
                    "response.block.created",
                    json!({
                        "type": "response.block.created", "block": tool
                    }),
                )
            };
            self.published.insert(tool_id.to_owned(), tool);
            events.push(event);
        }
        Ok(events)
    }
}

fn edit_tool(id: &str, block: &Map<String, Value>, file: &Value) -> Result<Value, String> {
    let path = file["path"]
        .as_str()
        .filter(|path| !path.is_empty())
        .ok_or("Codex file change has no path")?;
    let tool_id = format!("{id}:file:{path}");
    let status = match block.get("status").and_then(Value::as_str) {
        Some("done" | "completed" | "applied") => "done",
        Some("error" | "failed" | "interrupted" | "declined") => "error",
        Some("pending" | "queued") => "pending",
        _ => "streaming",
    };
    let change = file["change_type"].as_str().unwrap_or("modified");
    let additions = file["additions"].as_u64().unwrap_or(0);
    let deletions = file["deletions"].as_u64().unwrap_or(0);
    let mut output = format!("{change}: {path} (+{additions}, -{deletions})");
    if let Some(old_path) = file["old_path"].as_str() {
        output = format!("{change}: {old_path} -> {path} (+{additions}, -{deletions})");
    }
    let mut tool = json!({
        "id": tool_id, "type": "tool", "tool_use_id": tool_id,
        "tool_name": "Edit", "tool_input": {"file_path": path},
        "tool_output": output, "status": status,
    });
    if let Some(content) = file["content"].as_str() {
        tool["tool_name"] = json!("Write");
        tool["tool_input"]["content"] = json!(content);
    } else if let Some(diff) = file["diff"].as_str() {
        tool["tool_input"]["diff"] = json!(diff);
    }
    for key in [
        "parent_tool_use_id",
        "timestamp",
        "completedAt",
        "durationMs",
    ] {
        if let Some(value) = block.get(key) {
            tool[key] = value.clone();
        }
    }
    Ok(tool)
}

#[cfg(test)]
#[path = "standard_file_changes_tests.rs"]
mod tests;
