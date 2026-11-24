// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;

use serde_json::{Map, Value, json};

const KNOWLEDGE_MCP_SERVER: &str = "wegent-knowledge";
const KNOWLEDGE_TOOL_PREFIX: &str = "wegent-knowledge_";
const MAX_JS_INTEGER: u64 = (1 << 53) - 1;

fn knowledge_id(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    let id = match value {
        Value::String(text)
            if text.len() <= 16 && text.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            text.parse().ok()?
        }
        _ => value.as_u64()?,
    };
    (1..=MAX_JS_INTEGER).contains(&id).then_some(id)
}

#[derive(Clone, Copy)]
pub(super) enum KnowledgeTool {
    Head,
    Read,
    Search,
}

impl KnowledgeTool {
    pub(super) fn from_block(block: &Map<String, Value>) -> Option<Self> {
        if block.get("status")?.as_str()? != "done" {
            return None;
        }
        let name = block.get("tool_name")?.as_str()?;
        if name == "kb_head"
            && block.get("tool_protocol").and_then(Value::as_str) == Some("function_call")
        {
            return Some(Self::Head);
        }

        // Stored native MCP blocks can omit their server label and retain the qualified name.
        let server_label = match block.get("server_label") {
            Some(Value::String(label)) => label.as_str(),
            None | Some(Value::Null) => "",
            _ => return None,
        };
        let tool = name.strip_prefix(KNOWLEDGE_TOOL_PREFIX).unwrap_or(name);
        match server_label {
            KNOWLEDGE_MCP_SERVER => {}
            "" if tool != name => {}
            _ => return None,
        }
        let tool = tool.strip_prefix(KNOWLEDGE_TOOL_PREFIX).unwrap_or(tool);
        match tool {
            "wegent_kb_read_document_content" => Some(Self::Read),
            "wegent_kb_search_knowledge_base" => Some(Self::Search),
            _ => None,
        }
    }
}

pub(super) struct KnowledgeSources {
    identities: HashSet<(u64, u64)>,
    next_index: u64,
    added: Vec<Value>,
}

impl KnowledgeSources {
    pub(super) fn from_existing(existing: Option<&Value>) -> Self {
        let mut identities = HashSet::new();
        let mut next_index = 1;
        if let Some(Value::Array(sources)) = existing {
            for source in sources {
                if let Some(index) = knowledge_id(source.get("index")) {
                    next_index = next_index.max(index + 1);
                }
                if let (Some(kb_id), Some(document_id)) = (
                    knowledge_id(source.get("kb_id")),
                    knowledge_id(source.get("document_id")),
                ) {
                    identities.insert((kb_id, document_id));
                }
            }
        }
        Self {
            identities,
            next_index,
            added: Vec::new(),
        }
    }

    pub(super) fn collect(&mut self, tool: KnowledgeTool, payload: &Map<String, Value>) {
        if payload.contains_key("error") {
            return;
        }
        match tool {
            KnowledgeTool::Head => {
                if let Some(Value::Array(documents)) = payload.get("documents") {
                    for document in documents {
                        if has_text(document.get("content")) {
                            self.add(
                                document.get("kb_id"),
                                document.get("id"),
                                document.get("name"),
                            );
                        }
                    }
                }
            }
            KnowledgeTool::Read => {
                if has_text(payload.get("content")) {
                    self.add(
                        payload.get("kb_id"),
                        payload.get("document_id"),
                        payload.get("name"),
                    );
                }
            }
            KnowledgeTool::Search => {
                if payload.get("mode").and_then(Value::as_str) == Some("rag_retrieval")
                    && let Some(Value::Array(sources)) = payload.get("sources")
                {
                    for source in sources {
                        self.add(
                            source.get("knowledge_base_id"),
                            source.get("document_id"),
                            source.get("document_name"),
                        );
                    }
                }
            }
        }
    }

    fn add(
        &mut self,
        knowledge_base_id: Option<&Value>,
        document_id: Option<&Value>,
        title: Option<&Value>,
    ) {
        let (Some(kb_id), Some(document_id), Some(title)) = (
            knowledge_id(knowledge_base_id),
            knowledge_id(document_id),
            title
                .and_then(Value::as_str)
                .filter(|title| !title.trim().is_empty()),
        ) else {
            return;
        };
        if self.identities.insert((kb_id, document_id)) {
            self.added.push(json!({
                "index": self.next_index,
                "kb_id": kb_id,
                "document_id": document_id,
                "title": title,
            }));
            self.next_index += 1;
        }
    }

    pub(super) fn append_to(self, result: &mut Map<String, Value>) {
        if self.added.is_empty() {
            return;
        }
        match result.get_mut("sources") {
            Some(Value::Array(existing)) => existing.extend(self.added),
            _ => {
                result.insert("sources".into(), Value::Array(self.added));
            }
        }
    }
}

fn has_text(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::super::enrich_tool_result;
    use serde_json::json;

    #[test]
    fn completed_result_appends_proven_knowledge_documents_once() {
        let existing =
            json!({"index": 3, "title": "External", "source_uri": "https://example.com"});
        let read = json!({"kb_id": 42, "document_id": 72, "name": "Read.md", "content": "marker"});
        let tool = "wegent-knowledge_wegent_kb_read_document_content";
        let mut result = json!({
            "sources": [existing.clone()],
            "blocks": [
                {
                    "type": "tool", "status": "done", "tool_name": tool, "server_label": "",
                    "tool_output": [{"type": "text", "text": read.to_string()}]
                },
                {
                    "type": "tool", "status": "done", "tool_name": tool, "server_label": "",
                    "tool_output": read
                },
                {
                    "type": "tool", "status": "done",
                    "tool_name": "wegent-knowledge_wegent_kb_search_knowledge_base",
                    "tool_output": {
                        "mode": "rag_retrieval",
                        "sources": [
                            {"knowledge_base_id": 42, "document_id": "73", "document_name": "Hit.md"},
                            {"knowledge_base_id": 42, "document_id": 9007199254740992_u64, "document_name": "Invalid.md"}
                        ]
                    }
                },
                {
                    "type": "tool", "status": "done", "tool_name": "kb_head",
                    "tool_protocol": "function_call",
                    "tool_output": {"documents": [
                        {"kb_id": 42, "id": 74, "name": "Head.md", "content": "marker"}
                    ]}
                },
                {
                    "type": "tool", "status": "error", "tool_name": tool,
                    "tool_output": {"kb_id": 42, "document_id": 80, "name": "Failed.md", "content": "marker"}
                },
                {
                    "type": "tool", "status": "done", "tool_name": tool, "server_label": "other",
                    "tool_output": {"kb_id": 42, "document_id": 81, "name": "Foreign.md", "content": "marker"}
                },
                {
                    "type": "tool", "status": "done", "tool_name": "wegent_kb_read_document_content",
                    "tool_output": {"kb_id": 42, "document_id": 82, "name": "Unqualified.md", "content": "marker"}
                }
            ]
        });

        enrich_tool_result(result.as_object_mut().unwrap(), true);

        assert_eq!(
            result["sources"],
            json!([
                existing,
                {"index": 4, "kb_id": 42, "document_id": 72, "title": "Read.md"},
                {"index": 5, "kb_id": 42, "document_id": 73, "title": "Hit.md"},
                {"index": 6, "kb_id": 42, "document_id": 74, "title": "Head.md"},
            ])
        );
    }

    #[test]
    fn unsuccessful_completion_keeps_embedded_blocks_without_adding_citations() {
        let result_payload = json!({
            "kb_id": 42, "document_id": 72, "name": "Read.md", "content": "marker",
            "result_data": {"blocks": [{"id": "image-1", "type": "image", "image_attachment_ids": [40]}]}
        });
        let mut result = json!({
            "blocks": [{
                "type": "tool", "status": "done",
                "tool_name": "wegent-knowledge_wegent_kb_read_document_content",
                "tool_output": result_payload.to_string()
            }]
        });

        enrich_tool_result(result.as_object_mut().unwrap(), false);

        assert!(result.get("sources").is_none());
        assert_eq!(
            result["blocks"][1],
            json!({"id": "image-1", "type": "image", "image_attachment_ids": [40]})
        );
    }
}
