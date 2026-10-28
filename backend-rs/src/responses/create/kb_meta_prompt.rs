// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `_build_kb_meta_prompt` (`app/services/chat/preprocessing/contexts.py:2225`)
//! and the pure `kb_meta.py` formatter.
//!
//! The create flow assembles the request-scoped knowledge-base metadata prompt
//! from the resolved KB ids. The source always builds it — the two dependency
//! reads (`task_knowledge_base_service.get_knowledge_bases_by_ids` and
//! `KnowledgeService.get_document_prompt_stats`) run — and
//! `chat/trigger/unified.py:467` later discards the text when a provider-native
//! knowledge shell is used.
use brz_mysql::{Json, Mysql, MysqlResult};
use serde_json::Value;
use std::collections::BTreeMap;

use super::selected_knowledge::{
    derive_retrieval_capabilities, document_prompt_stats, sanitize_prompt_text,
};

/// `SHORT_SUMMARY_THRESHOLD`.
const SHORT_SUMMARY_THRESHOLD: usize = 3;
/// `SAFE_IDENTIFIER_MAX_LEN`.
const SAFE_IDENTIFIER_MAX_LEN: usize = 120;
/// `SAFE_ROUTING_HINT_MAX_LEN`.
const SAFE_ROUTING_HINT_MAX_LEN: usize = 200;
/// `SAFE_ROUTING_TOPIC_MAX_LEN`.
const SAFE_ROUTING_TOPIC_MAX_LEN: usize = 48;
/// `MAX_ROUTING_TOPICS`.
const MAX_ROUTING_TOPICS: usize = 5;

/// `db.query(Kind)`'s labeled full-entity projection, matching the projection
/// `task_knowledge_base_service.get_knowledge_bases_by_ids` reads.
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// One active knowledge-base `Kind` row.
#[derive(Debug, Clone, PartialEq)]
pub struct KbEntity {
    pub name: String,
    pub json: Value,
}

/// `task_knowledge_base_service.get_knowledge_bases_by_ids`: the active
/// knowledge-base rows among `ids`, keyed by id.
pub async fn knowledge_bases_by_ids<M: Mysql>(
    mysql: &M,
    ids: &[i64],
) -> MysqlResult<BTreeMap<i64, KbEntity>> {
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    #[derive(brz_mysql::FromMysqlRow)]
    struct KbRow {
        kinds_id: i64,
        kinds_name: String,
        kinds_json: Json<Value>,
    }
    let placeholders = vec!["?"; ids.len()].join(", ");
    let rows: Vec<KbRow> = mysql
        .fetch_all(
            &format!(
                "SELECT {KIND_COLUMNS} \nFROM kinds \n\
                 WHERE kinds.id IN ({placeholders}) AND kinds.kind = 'KnowledgeBase' \
                 AND kinds.is_active = true"
            ),
            ids.to_vec(),
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.kinds_id,
                KbEntity {
                    name: row.kinds_name,
                    json: row.kinds_json.0,
                },
            )
        })
        .collect())
}

/// One assembled `kb_meta_list` entry.
#[derive(Debug, Clone, PartialEq)]
struct KbMeta {
    kb_id: i64,
    kb_name: String,
    search_available: bool,
    retrieval_capabilities: Value,
    total_document_count: i64,
    searchable_document_count: i64,
    spreadsheet_document_count: i64,
    summary_text: String,
    topics: Vec<String>,
}

/// `_build_kb_meta_prompt`: resolve the KB rows and document stats, assemble
/// the metadata list, then render it. A dependency or decode failure yields the
/// source's empty string.
pub async fn build_kb_meta_prompt<M: Mysql>(
    mysql: &M,
    knowledge_base_ids: &[i64],
    restricted: bool,
) -> MysqlResult<String> {
    if knowledge_base_ids.is_empty() {
        return Ok(String::new());
    }
    let knowledge_bases = knowledge_bases_by_ids(mysql, knowledge_base_ids).await?;
    let stats = document_prompt_stats(mysql, knowledge_base_ids).await?;

    let mut kb_meta_list = Vec::with_capacity(knowledge_base_ids.len());
    for kb_id in knowledge_base_ids {
        let Some(knowledge_base) = knowledge_bases.get(kb_id) else {
            kb_meta_list.push(KbMeta {
                kb_id: *kb_id,
                kb_name: "Unknown".to_string(),
                search_available: false,
                retrieval_capabilities: Value::Null,
                total_document_count: 0,
                searchable_document_count: 0,
                spreadsheet_document_count: 0,
                summary_text: String::new(),
                topics: Vec::new(),
            });
            continue;
        };
        let spec = knowledge_base
            .json
            .get("spec")
            .cloned()
            .unwrap_or(Value::Null);
        let spec = if spec.is_object() { spec } else { Value::Null };
        let kb_name = spec
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .or_else(|| (!knowledge_base.name.is_empty()).then(|| knowledge_base.name.clone()))
            .unwrap_or_else(|| "Unknown".to_string());
        let summary_data = spec.get("summary").cloned().unwrap_or(Value::Null);
        let (summary_text, topics) = summary_fields(&spec, &summary_data, knowledge_base_ids.len());
        let counts = stats
            .get(kb_id)
            .map(|row| row.counts())
            .unwrap_or((0, 0, 0));
        let retrieval_config = spec.get("retrievalConfig").cloned().unwrap_or(Value::Null);
        let search_available = retrieval_config
            .get("retriever_name")
            .is_some_and(json_truthy);
        kb_meta_list.push(KbMeta {
            kb_id: *kb_id,
            kb_name,
            search_available,
            retrieval_capabilities: derive_retrieval_capabilities(&retrieval_config),
            total_document_count: counts.0,
            searchable_document_count: counts.1,
            spreadsheet_document_count: counts.2,
            summary_text,
            topics,
        });
    }

    Ok(if restricted {
        format_restricted_kb_meta_prompt(&kb_meta_list)
    } else {
        format_kb_meta_prompt(&kb_meta_list)
    })
}

/// The `summary_text` / `topics` pair for one KB.
fn summary_fields(spec: &Value, summary_data: &Value, kb_count: usize) -> (String, Vec<String>) {
    if let Some(manual) = summary_data
        .get("manual_long_summary")
        .and_then(truthy_string)
    {
        return (manual, string_list(summary_data.get("topics")));
    }
    let summary_enabled = spec.get("summaryEnabled").is_some_and(json_truthy);
    let completed = summary_data.get("status").and_then(Value::as_str) == Some("completed");
    if summary_enabled && completed {
        return (
            select_kb_summary_text(summary_data, kb_count),
            string_list(summary_data.get("topics")),
        );
    }
    (String::new(), Vec::new())
}

/// `select_kb_summary_text`: short summaries for 3+ KBs, long otherwise.
fn select_kb_summary_text(summary_data: &Value, kb_count: usize) -> String {
    let use_short = kb_count >= SHORT_SUMMARY_THRESHOLD;
    let (first, second) = if use_short {
        ("short_summary", "long_summary")
    } else {
        ("long_summary", "short_summary")
    };
    summary_data
        .get(first)
        .and_then(truthy_string)
        .or_else(|| summary_data.get(second).and_then(truthy_string))
        .unwrap_or_default()
}

/// `sanitize_prompt_identifier`.
fn sanitize_prompt_identifier(value: &str, fallback: &str) -> String {
    sanitize_prompt_text(value, fallback, SAFE_IDENTIFIER_MAX_LEN)
}

/// `format_kb_meta_prompt`.
fn format_kb_meta_prompt(kb_meta_list: &[KbMeta]) -> String {
    if kb_meta_list.is_empty() {
        return String::new();
    }
    let mut kb_lines: Vec<String> = Vec::new();
    for kb_meta in kb_meta_list {
        let kb_name = sanitize_prompt_identifier(&kb_meta.kb_name, "Unknown");
        let kb_id = sanitize_prompt_identifier(&kb_meta.kb_id.to_string(), "N/A");
        let search = if kb_meta.search_available {
            "available"
        } else {
            "unavailable"
        };
        kb_lines.push(format!(
            "- KB Name: {kb_name}, KB ID: {kb_id}, Search: {search}, Total Docs: {}, Searchable Docs: {}, Spreadsheets: {}",
            kb_meta.total_document_count,
            kb_meta.searchable_document_count,
            kb_meta.spreadsheet_document_count,
        ));

        if let Some(mode) = kb_meta
            .retrieval_capabilities
            .get("retrieval_mode")
            .and_then(Value::as_str)
        {
            let hints: Vec<&str> = ["semantic_query", "keywords", "phrases"]
                .into_iter()
                .filter(|name| {
                    kb_meta
                        .retrieval_capabilities
                        .get(name)
                        .is_some_and(json_truthy)
                })
                .collect();
            let hint_suffix = if hints.is_empty() {
                String::new()
            } else {
                format!("; Optional Search Hints: {}", hints.join(", "))
            };
            kb_lines.push(format!("  - Retrieval: {mode}{hint_suffix}"));
        }

        if !kb_meta.summary_text.is_empty() {
            kb_lines.push(format!("  - Summary: {}", kb_meta.summary_text));
        }
        if !kb_meta.topics.is_empty() {
            kb_lines.push(format!("  - Topics: {}", kb_meta.topics.join(", ")));
        }
    }

    let kb_list_str = kb_lines.join("\n");
    let target_kb_note = if kb_meta_list.len() == 1 {
        let selected = &kb_meta_list[0];
        let kb_name = sanitize_prompt_identifier(&selected.kb_name, "Unknown");
        let kb_id = sanitize_prompt_identifier(&selected.kb_id.to_string(), "N/A");
        format!("\nCurrent Target KB:\n- KB Name: {kb_name}\n- KB ID: {kb_id}\n")
    } else {
        String::new()
    };

    format!(
        "Knowledge Bases In Scope:\n{kb_list_str}\n{target_kb_note}\nNote:\n\
         - This block is request-scoped metadata only.\n\
         - Use KB tools to retrieve actual content when needed."
    )
}

/// `format_restricted_kb_meta_prompt`.
fn format_restricted_kb_meta_prompt(kb_meta_list: &[KbMeta]) -> String {
    if kb_meta_list.is_empty() {
        return String::new();
    }
    let mut kb_lines: Vec<String> = Vec::new();
    for kb_meta in kb_meta_list {
        let kb_name = sanitize_prompt_identifier(&kb_meta.kb_name, "Unknown");
        let kb_id = sanitize_prompt_identifier(&kb_meta.kb_id.to_string(), "N/A");
        kb_lines.push(format!("- KB Name: {kb_name}, KB ID: {kb_id}"));

        let summary_text =
            sanitize_prompt_text(&kb_meta.summary_text, "", SAFE_ROUTING_HINT_MAX_LEN);
        let topics: Vec<String> = kb_meta
            .topics
            .iter()
            .take(MAX_ROUTING_TOPICS)
            .map(|topic| sanitize_prompt_text(topic, "", SAFE_ROUTING_TOPIC_MAX_LEN))
            .filter(|topic| !topic.is_empty())
            .collect();

        if !summary_text.is_empty() {
            kb_lines.push(format!("  - Routing Hint: {summary_text}"));
        }
        if !topics.is_empty() {
            kb_lines.push(format!("  - Routing Keywords: {}", topics.join(", ")));
        }
    }

    let kb_list_str = kb_lines.join("\n");
    format!(
        "Restricted Knowledge Bases In Scope:\n{kb_list_str}\n\nNote:\n\
         - These routing hints are for retrieval guidance only.\n\
         - Do not use them as final answer content."
    )
}

/// `if value:` for a JSON scalar.
fn json_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// `str(value)` for a truthy JSON value.
fn truthy_string(value: &Value) -> Option<String> {
    if !json_truthy(value) {
        return None;
    }
    Some(match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    })
}

/// `list(topics) if isinstance(topics, (list, tuple)) else []`, stringified.
fn string_list(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items.iter().map(text_of).collect()
}

/// `str(value)` for a JSON value (`Value::to_string` would re-quote a string).
fn text_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(id: i64, name: &str) -> KbMeta {
        KbMeta {
            kb_id: id,
            kb_name: name.to_string(),
            search_available: true,
            retrieval_capabilities: derive_retrieval_capabilities(
                &json!({"retrieval_mode": "hybrid"}),
            ),
            total_document_count: 7,
            searchable_document_count: 7,
            spreadsheet_document_count: 3,
            summary_text: "summary".to_string(),
            topics: vec!["a".to_string(), "b".to_string()],
        }
    }

    #[test]
    fn single_kb_prompt_matches_the_source_layout() {
        let prompt = format_kb_meta_prompt(&[meta(263078, "转发+评论日志分析助手")]);
        assert_eq!(
            prompt,
            "Knowledge Bases In Scope:\n\
             - KB Name: 转发+评论日志分析助手, KB ID: 263078, Search: available, Total Docs: 7, Searchable Docs: 7, Spreadsheets: 3\n  \
             - Retrieval: hybrid; Optional Search Hints: semantic_query, keywords, phrases\n  \
             - Summary: summary\n  \
             - Topics: a, b\n\
             \nCurrent Target KB:\n- KB Name: 转发+评论日志分析助手\n- KB ID: 263078\n\n\
             Note:\n\
             - This block is request-scoped metadata only.\n\
             - Use KB tools to retrieve actual content when needed."
        );
    }

    #[test]
    fn multiple_kbs_omit_the_target_note() {
        let prompt = format_kb_meta_prompt(&[meta(1, "a"), meta(2, "b")]);
        assert!(!prompt.contains("Current Target KB"));
        assert!(prompt.starts_with("Knowledge Bases In Scope:\n- KB Name: a"));
    }

    #[test]
    fn restricted_prompt_uses_routing_hints() {
        let prompt = format_restricted_kb_meta_prompt(&[meta(263078, "kb")]);
        assert_eq!(
            prompt,
            "Restricted Knowledge Bases In Scope:\n\
             - KB Name: kb, KB ID: 263078\n  \
             - Routing Hint: summary\n  \
             - Routing Keywords: a, b\n\n\
             Note:\n\
             - These routing hints are for retrieval guidance only.\n\
             - Do not use them as final answer content."
        );
    }

    #[test]
    fn short_summary_is_preferred_for_three_or_more_kbs() {
        let summary = json!({"long_summary": "long", "short_summary": "short"});
        assert_eq!(select_kb_summary_text(&summary, 2), "long");
        assert_eq!(select_kb_summary_text(&summary, 3), "short");
    }

    #[test]
    fn empty_lists_render_empty() {
        assert_eq!(format_kb_meta_prompt(&[]), "");
        assert_eq!(format_restricted_kb_meta_prompt(&[]), "");
    }

    #[test]
    fn summary_fields_prefer_the_manual_summary() {
        let spec = json!({"summaryEnabled": true});
        let summary = json!({
            "manual_long_summary": "manual",
            "topics": ["t1"],
            "status": "completed",
            "short_summary": "short",
        });
        let (text, topics) = summary_fields(&spec, &summary, 1);
        assert_eq!(text, "manual");
        assert_eq!(topics, vec!["t1".to_string()]);
    }

    #[test]
    fn summary_fields_require_enabled_and_completed() {
        let spec = json!({"summaryEnabled": false});
        let summary = json!({"status": "completed", "short_summary": "s", "topics": ["t"]});
        let (text, topics) = summary_fields(&spec, &summary, 3);
        assert_eq!(text, "");
        assert!(topics.is_empty());
    }
}
