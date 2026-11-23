// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `shared/prompts/selected_knowledge.py` + `shared/models/knowledge.py`: the
//! provider-neutral selected-knowledge prompt the create flow renders into
//! `metadata.selected_knowledge_prompt`.
//!
//! The recorded `queued` case (`2834ba9c`, run `20261010055652`) pins the
//! output: one `  <source provider="wegent" knowledge_base_id="239607"
//! knowledge_base_name="ns-a-Group" routing_summary="…" routing_topics="…"
//! retrieval_mode="vector" />` line between
//! `<selected_knowledge_sources>`/`</selected_knowledge_sources>`, then the
//! inherited-sources (`evidence_required = false`) guidance block.
use serde_json::Value;

/// `KnowledgeScopeType`.
pub const SCOPE_FOLDER: &str = "folder";
/// `KnowledgeScopeType`.
pub const SCOPE_DOCUMENT: &str = "document";

/// `SelectedKnowledgeResource`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectedKnowledgeResource {
    pub scope_type: String,
    pub resource_id: Option<String>,
    pub resource_name: Option<String>,
    pub resource_path: Option<String>,
    pub resource_url: Option<String>,
}

/// `SelectedKnowledgeRef`. `retrieval_capabilities` is the raw dict the
/// normalizer filters.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SelectedKnowledgeRef {
    pub provider: String,
    pub knowledge_base_id: String,
    pub knowledge_base_name: String,
    pub resources: Vec<SelectedKnowledgeResource>,
    pub routing_summary: Option<String>,
    pub routing_topics: Vec<String>,
    pub retrieval_capabilities: Value,
}

/// `SelectedKnowledgeContext`.
#[derive(Debug, Clone, Default)]
pub struct SelectedKnowledgeContext {
    pub refs: Vec<SelectedKnowledgeRef>,
    pub evidence_required: bool,
}

/// `render_selected_knowledge_prompt`: the stable prompt shared by the Chat
/// Shell and coding runtimes; an empty context renders `""`.
pub fn render_selected_knowledge_prompt(context: &SelectedKnowledgeContext) -> String {
    let normalized: Vec<Value> = context.refs.iter().filter_map(normalize_ref).collect();
    if normalized.is_empty() {
        return String::new();
    }

    let mut lines = vec!["<selected_knowledge_sources>".to_string()];
    for reference in &normalized {
        lines.extend(render_source(reference));
    }
    lines.push("</selected_knowledge_sources>".to_string());

    lines.push("<selected_knowledge_guidance>".to_string());
    lines.extend(render_evidence_policy(context.evidence_required));
    let guidance = [
        "- First distinguish source metadata, content overview, content questions, and management requests.",
        "- For source metadata, answer from the source information above without retrieving content.",
        "- Routing summaries and topics are metadata for choosing a source; they are not content evidence and must not be used to answer content questions.",
        "- For a content overview, use the provider's native listing capability.",
        "- For content questions, search or read evidence only within the sources above.",
        "- Use only the MCP tools belonging to each source's provider; do not translate the selection into a cross-provider query.",
        "- A source without resource children selects the whole knowledge base.",
        "- A folder resource selects the entire folder subtree; keep discovery within that subtree.",
        "- For a document resource, read that exact document before using broader search.",
        "- Use knowledge_base_id and resource_id as provider-native tool arguments; names, paths, and URLs are context only.",
        "- Do not broaden to other knowledge sources unless the user explicitly authorizes it.",
    ];
    lines.extend(guidance.iter().map(|line| line.to_string()));
    lines.extend(render_outcome_policy());
    lines.extend(
        [
            "- Cite the actual source when using knowledge content.",
            "- Create or update content only when the user explicitly requests a management action.",
            "- This scope guides model routing; the provider remains the authority for access control.",
            "- If a provider cannot perform a scoped search, traverse its native hierarchy or read the exact resource instead of using an unscoped global search.",
            "- If search is unavailable or unsupported for a selected source, use the provider's native listing and exact-read capabilities to gather evidence.",
            "- If search results are insufficient to support a precision-sensitive claim, read the relevant original document content before answering.",
        ]
        .iter()
        .map(|line| line.to_string()),
    );
    lines.push("</selected_knowledge_guidance>".to_string());
    lines.join("\n")
}

/// `_render_evidence_policy`.
fn render_evidence_policy(evidence_required: bool) -> Vec<String> {
    if evidence_required {
        vec![
            "- These sources were explicitly selected by the user for this request.".to_string(),
            "- For content questions, you must obtain evidence from these sources before answering."
                .to_string(),
            "- If there is no relevant evidence, say so; you must not use general knowledge to fill the gap."
                .to_string(),
        ]
    } else {
        vec![
            "- These are inherited task sources. Prefer them for the current request.".to_string(),
            "- For content questions, obtain evidence from these sources first.".to_string(),
            "- If there is no relevant result, state that the knowledge sources had no relevant result; you may use general knowledge afterward."
                .to_string(),
        ]
    }
}

/// `_render_outcome_policy`.
fn render_outcome_policy() -> Vec<String> {
    vec![
        "- Treat a result as empty only when the provider call succeeded but returned no relevant evidence."
            .to_string(),
        "- If access is denied, a call is rate-limited, or a tool fails, report that condition; you must not claim that the knowledge sources contain no relevant content, and do not retry after a rate limit."
            .to_string(),
    ]
}

/// `_normalize_ref`: the prompt-facing projection, or `None` when the ref is
/// unusable (empty provider/id, or resources that all fail to normalize).
fn normalize_ref(reference: &SelectedKnowledgeRef) -> Option<Value> {
    let provider = reference.provider.trim();
    let knowledge_base_id = reference.knowledge_base_id.trim();
    if provider.is_empty() || knowledge_base_id.is_empty() {
        return None;
    }
    let normalized_resources: Vec<Value> = reference
        .resources
        .iter()
        .filter_map(normalize_resource)
        .collect();
    if !reference.resources.is_empty() && normalized_resources.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "provider": provider,
        "knowledge_base_id": knowledge_base_id,
        "knowledge_base_name": reference.knowledge_base_name.trim(),
        "routing_summary": optional_string(reference.routing_summary.as_deref()),
        "routing_topics": reference
            .routing_topics
            .iter()
            .filter_map(|topic| optional_string(Some(topic.as_str())))
            .collect::<Vec<_>>(),
        "resources": normalized_resources,
        "retrieval_capabilities": normalize_retrieval_capabilities(
            &reference.retrieval_capabilities
        ),
    }))
}

/// `_normalize_retrieval_capabilities`: keep only the safe capability summary.
fn normalize_retrieval_capabilities(value: &Value) -> Value {
    let Some(map) = value.as_object() else {
        return Value::Object(serde_json::Map::new());
    };
    let mode = map.get("retrieval_mode").and_then(Value::as_str);
    match mode {
        Some(mode @ ("vector" | "keyword" | "hybrid")) => {
            let flag = |key: &str| map.get(key) == Some(&Value::Bool(true));
            serde_json::json!({
                "retrieval_mode": mode,
                "semantic_query": flag("semantic_query"),
                "keywords": flag("keywords"),
                "phrases": flag("phrases"),
            })
        }
        _ => Value::Object(serde_json::Map::new()),
    }
}

/// `_normalize_resource`: a folder/document with a resource id, else `None`.
fn normalize_resource(resource: &SelectedKnowledgeResource) -> Option<Value> {
    if resource.scope_type != SCOPE_FOLDER && resource.scope_type != SCOPE_DOCUMENT {
        return None;
    }
    let resource_id = optional_string(resource.resource_id.as_deref())?;
    Some(serde_json::json!({
        "scope_type": resource.scope_type,
        "resource_id": resource_id,
        "resource_name": optional_string(resource.resource_name.as_deref()),
        "resource_path": optional_string(resource.resource_path.as_deref()),
        "resource_url": optional_string(resource.resource_url.as_deref()),
    }))
}

/// `_render_source`.
fn render_source(reference: &Value) -> Vec<String> {
    let text = |key: &str| {
        reference
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let topics = reference
        .get("routing_topics")
        .and_then(Value::as_array)
        .map(|topics| {
            topics
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();

    let mut attributes: Vec<(String, String)> = vec![
        ("provider".to_string(), text("provider").to_string()),
        (
            "knowledge_base_id".to_string(),
            text("knowledge_base_id").to_string(),
        ),
        (
            "knowledge_base_name".to_string(),
            text("knowledge_base_name").to_string(),
        ),
        (
            "routing_summary".to_string(),
            text("routing_summary").to_string(),
        ),
        ("routing_topics".to_string(), topics),
    ];
    let capabilities = reference
        .get("retrieval_capabilities")
        .cloned()
        .unwrap_or(Value::Null);
    if capabilities.as_object().is_some_and(|map| !map.is_empty()) {
        attributes.push((
            "retrieval_mode".to_string(),
            capabilities
                .get("retrieval_mode")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ));
        let hints: Vec<&str> = ["semantic_query", "keywords", "phrases"]
            .into_iter()
            .filter(|name| capabilities.get(*name) == Some(&Value::Bool(true)))
            .collect();
        if !hints.is_empty() {
            attributes.push(("search_hints".to_string(), hints.join(",")));
        }
    }
    let rendered = render_attributes(&attributes);

    let resources = reference
        .get("resources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if resources.is_empty() {
        return vec![format!("  <source {rendered} />")];
    }
    let mut lines = vec![format!("  <source {rendered}>")];
    for resource in &resources {
        let resource_text = |key: &str| {
            resource
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
        };
        let resource_attributes: Vec<(String, String)> = [
            "scope_type",
            "resource_id",
            "resource_name",
            "resource_path",
            "resource_url",
        ]
        .into_iter()
        .map(|key| (key.to_string(), resource_text(key).to_string()))
        .collect();
        lines.push(format!(
            "    <resource {} />",
            render_attributes(&resource_attributes)
        ));
    }
    lines.push("  </source>".to_string());
    lines
}

/// `_render_attributes`: `name="escaped value"`, dropping none/empty values.
fn render_attributes(attributes: &[(String, String)]) -> String {
    attributes
        .iter()
        .filter(|(_name, value)| !value.is_empty())
        .map(|(name, value)| format!("{name}=\"{}\"", escape(value)))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `html.escape(value, quote=True)`.
fn escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#x27;"),
            other => escaped.push(other),
        }
    }
    escaped
}

/// `_optional_string`: trimmed text, or `None` when empty.
fn optional_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn recorded_ref() -> SelectedKnowledgeRef {
        SelectedKnowledgeRef {
            provider: "wegent".to_string(),
            knowledge_base_id: "239607".to_string(),
            knowledge_base_name: "ns-a-Group".to_string(),
            resources: Vec::new(),
            routing_summary: Some(
                "社交平台移动客户端数据埋点、行为编码与反垃圾风控体系知识库".to_string(),
            ),
            routing_topics: [
                "数据埋点与编码规则",
                "反垃圾风控策略",
                "用户行为分析",
                "垃圾用户识别模型",
                "移动端开发管理",
            ]
            .iter()
            .map(|topic| topic.to_string())
            .collect(),
            retrieval_capabilities: json!({
                "retrieval_mode": "vector",
                "semantic_query": false,
                "keywords": false,
                "phrases": false,
            }),
        }
    }

    #[test]
    fn an_empty_context_renders_nothing() {
        assert_eq!(
            render_selected_knowledge_prompt(&SelectedKnowledgeContext::default()),
            ""
        );
    }

    #[test]
    fn the_recorded_source_line_and_guidance_are_reproduced() {
        let prompt = render_selected_knowledge_prompt(&SelectedKnowledgeContext {
            refs: vec![recorded_ref()],
            evidence_required: false,
        });
        let lines: Vec<&str> = prompt.split('\n').collect();
        assert_eq!(lines[0], "<selected_knowledge_sources>");
        assert_eq!(
            lines[1],
            "  <source provider=\"wegent\" knowledge_base_id=\"239607\" \
             knowledge_base_name=\"ns-a-Group\" \
             routing_summary=\"社交平台移动客户端数据埋点、行为编码与反垃圾风控体系知识库\" \
             routing_topics=\"数据埋点与编码规则, 反垃圾风控策略, 用户行为分析, \
             垃圾用户识别模型, 移动端开发管理\" retrieval_mode=\"vector\" />"
        );
        assert_eq!(lines[2], "</selected_knowledge_sources>");
        assert_eq!(lines[3], "<selected_knowledge_guidance>");
        assert_eq!(
            lines[4],
            "- These are inherited task sources. Prefer them for the current request."
        );
        assert_eq!(*lines.last().unwrap(), "</selected_knowledge_guidance>");
    }

    #[test]
    fn resources_render_one_line_each_and_empty_attributes_are_dropped() {
        let mut reference = recorded_ref();
        reference.resources = vec![SelectedKnowledgeResource {
            scope_type: "folder".to_string(),
            resource_id: Some("42".to_string()),
            ..Default::default()
        }];
        let prompt = render_selected_knowledge_prompt(&SelectedKnowledgeContext {
            refs: vec![reference],
            evidence_required: true,
        });
        assert!(prompt.contains("  <source provider=\"wegent\""));
        assert!(
            prompt.contains(
                ">\n    <resource scope_type=\"folder\" resource_id=\"42\" />\n  </source>"
            )
        );
        assert!(
            prompt
                .contains("- These sources were explicitly selected by the user for this request.")
        );
        // A ref whose resources all normalize away is dropped.
        let dropped = render_selected_knowledge_prompt(&SelectedKnowledgeContext {
            refs: vec![SelectedKnowledgeRef {
                provider: "wegent".to_string(),
                knowledge_base_id: "1".to_string(),
                resources: vec![SelectedKnowledgeResource {
                    scope_type: "bogus".to_string(),
                    resource_id: Some("9".to_string()),
                    ..Default::default()
                }],
                ..Default::default()
            }],
            evidence_required: false,
        });
        assert_eq!(dropped, "");
    }
}
