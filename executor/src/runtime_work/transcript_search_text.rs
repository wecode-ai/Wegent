// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, sync::OnceLock};

use regex::Regex;
use serde_json::{json, Value};

use super::{
    transcript::{search_transcript_messages, visible_user_request_content},
    transcript_search_annotations::assistant_annotation_ranges,
    transcript_search_projection::{MappedSource, SearchRegion},
    util::{item_type, string_field},
};

#[derive(Default)]
pub(super) struct AsyncReplySearchProjection {
    pending: Vec<(String, Vec<String>)>,
    replies: HashMap<String, (String, Vec<String>)>,
}

impl AsyncReplySearchProjection {
    pub(super) fn reply_source(&self, item_id: &str) -> Option<&str> {
        self.replies.get(item_id).map(|reply| reply.0.as_str())
    }

    pub(super) fn reply_questions(&self, item_id: &str) -> Option<&[String]> {
        self.replies.get(item_id).map(|reply| reply.1.as_slice())
    }

    /// Match chat-core's next nonempty user reply, with the last valid question group winning.
    pub(super) fn message_text(&mut self, message: &Value, source: &str) -> Option<String> {
        if message["role"] == "assistant" {
            let questions = async_question_prompts(message);
            if !questions.is_empty() {
                self.pending.push((source.to_owned(), questions));
            }
            return None;
        }
        if message["role"] != "user" {
            return None;
        }
        let content =
            visible_comment_request_content(message["content"].as_str().unwrap_or_default());
        if content.trim().is_empty() {
            return Some(ordinary_user_search_text(content));
        }
        let groups = std::mem::take(&mut self.pending);
        for (source, questions) in groups.into_iter().rev() {
            let answers = if questions.len() == 1 {
                vec![content.trim()]
            } else {
                content
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .collect()
            };
            if questions.len() != answers.len() {
                continue;
            }
            let text = questions
                .iter()
                .zip(answers)
                .map(|(question, answer)| format!("{question}\n{answer}"))
                .collect::<Vec<_>>()
                .join("\n");
            if let Some(id) = message["id"].as_str() {
                self.replies.insert(id.to_owned(), (source, questions));
            }
            return Some(text);
        }
        Some(ordinary_user_search_text(content))
    }
}

fn ordinary_user_search_text(content: &str) -> String {
    let content = visible_user_request_content(content);
    // UserMessage normalizes plan confirmations only outside async reply rows.
    let content = if content
        .trim_start()
        .starts_with("PLEASE IMPLEMENT THIS PLAN:")
    {
        "是的，执行此计划"
    } else {
        content
    };
    markdown_search_text(content)
}

fn user_search_region(id: &str, raw: &str, visible: &str) -> SearchRegion {
    let content = visible_comment_request_content(raw);
    let request = visible_user_request_content(content);
    let mut source = MappedSource::new(id, raw);
    if ordinary_user_search_text(content) != visible {
        let start = content.as_ptr() as usize - raw.as_ptr() as usize;
        source.remove([start + content.len()..raw.len(), 0..start]);
        return source.reply_region(id, visible);
    }
    let start = request.as_ptr() as usize - raw.as_ptr() as usize;
    source.remove([start + request.len()..raw.len(), 0..start]);
    if request
        .trim_start()
        .starts_with("PLEASE IMPLEMENT THIS PLAN:")
    {
        source.projected_plain_region(id, visible)
    } else {
        source.markdown_region(id)
    }
}

/// Match chat-core's parseCodeCommentContexts before associating async answers.
fn visible_comment_request_content(content: &str) -> &str {
    const INSTRUCTION: &str = "The user attached the following comments. Treat browser_annotation items as comments on parts of the visible web page, and code_selection items as comments on selected code.";
    static CONTEXT: OnceLock<Regex> = OnceLock::new();
    let Some(block) = CONTEXT
        .get_or_init(|| {
            Regex::new(r"(?s)<workspace_comment_context>.*?</workspace_comment_context>\s*$")
                .expect("valid comment context regex")
        })
        .find(content)
    else {
        return content;
    };
    let inner = block.as_str();
    if !inner.contains(INSTRUCTION) {
        return content;
    }
    let Some((start, end)) = inner.find('[').zip(inner.rfind(']')) else {
        return content;
    };
    if end <= start {
        return content;
    }
    let Ok(Value::Array(comments)) = serde_json::from_str(&inner[start..=end]) else {
        return content;
    };
    if !comments.iter().any(valid_comment_context) {
        return content;
    }
    content[..block.start()].trim()
}

fn valid_comment_context(comment: &Value) -> bool {
    comment["commentNumber"].is_number()
        && matches!(
            comment["source"].as_str(),
            Some("browser_annotation" | "code_selection")
        )
        && [
            "location",
            "filePath",
            "fileName",
            "selectedText",
            "userComment",
        ]
        .iter()
        .all(|field| comment[field].is_string())
}

fn async_question_prompts(message: &Value) -> Vec<String> {
    message["blocks"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|block| {
            let payload = block
                .get("renderPayload")
                .or_else(|| block.get("render_payload"));
            payload
                .filter(|payload| {
                    block["type"] == "tool"
                        && payload["kind"] == "request_user_input"
                        && payload["delivery"] == "async"
                })
                .and_then(|payload| payload["questions"].as_array())
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(index, question)| {
                    question["question"]
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .or_else(|| {
                            question["id"]
                                .as_str()
                                .map(str::trim)
                                .filter(|value| !value.is_empty())
                        })
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("question_{}", index + 1))
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Index the same item projection that transcript hydration sends to the renderer.
pub(super) fn codex_turn_search_regions(
    turn: &Value,
    user_content_by_client_id: &HashMap<String, String>,
    root_thread_id: Option<&str>,
    projection: &mut AsyncReplySearchProjection,
) -> Vec<SearchRegion> {
    let mut turn = turn.clone();
    restore_search_user_content(&mut turn, user_content_by_client_id);
    let mut messages = search_transcript_messages(&json!({"id": root_thread_id, "turns": [turn]}));
    for message in messages
        .iter_mut()
        .filter(|message| message["role"] == "user")
    {
        let client_id =
            string_field(message, "clientUserMessageId").or_else(|| string_field(message, "id"));
        if let Some(content) = client_id.and_then(|id| user_content_by_client_id.get(&id)) {
            // Empty UI bodies must also override provider-injected attachment text.
            message["content"] = json!(content);
        }
    }
    projection.replies.clear();
    let source = turn["id"].as_str().unwrap_or_default();
    let user_texts = messages
        .iter()
        .filter_map(|message| {
            let text = projection.message_text(message, source)?;
            Some((message["id"].as_str()?.to_owned(), text))
        })
        .collect::<HashMap<_, _>>();
    let mut items = Vec::new();
    for message in &messages {
        if message["role"] == "user" {
            items.push(json!({"id": message["id"], "type": "user_message", "message": message}));
        } else if let Some(runtime_items) = message["runtimeItems"].as_array() {
            items.extend(runtime_items.iter().cloned());
        }
    }
    let terminal = messages.last().unwrap_or(&Value::Null);
    let status = terminal
        .get("runtimeStatus")
        .or_else(|| terminal.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("done");
    let error = terminal.get("error").and_then(Value::as_str);
    canonical_turn_search_regions(
        &json!({"items":items, "status":status, "error":error}),
        &user_texts,
    )
}

/// Cache and provider adapters share the renderer's user-delimited segments.
pub(super) fn canonical_turn_search_regions(
    turn: &Value,
    user_texts: &HashMap<String, String>,
) -> Vec<SearchRegion> {
    let Some(items) = turn["items"].as_array() else {
        return Vec::new();
    };
    let status = turn
        .get("runtimeStatus")
        .filter(|value| !value.is_null())
        .or_else(|| turn.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("done");
    let error = turn.get("error").and_then(Value::as_str);
    let mut regions = Vec::new();
    let mut start = 0;
    for (index, item) in items.iter().enumerate() {
        if item["type"] != "user_message" {
            continue;
        }
        regions.extend(projected_segment_search_regions(
            &items[start..index],
            "done",
            None,
        ));
        if let Some(id) = item["id"].as_str() {
            let raw = item["message"]["content"].as_str().unwrap_or_default();
            let text = user_texts
                .get(id)
                .cloned()
                .unwrap_or_else(|| ordinary_user_search_text(raw));
            regions.push(user_search_region(id, raw, &text));
        }
        start = index + 1;
    }
    regions.extend(projected_segment_search_regions(
        &items[start..],
        status,
        error,
    ));
    regions
}

#[cfg(test)]
pub(super) fn codex_turn_search_sources(
    turn: &Value,
    user_content_by_client_id: &HashMap<String, String>,
    root_thread_id: Option<&str>,
    projection: &mut AsyncReplySearchProjection,
) -> Vec<(String, String)> {
    codex_turn_search_regions(turn, user_content_by_client_id, root_thread_id, projection)
        .into_iter()
        .map(|region| (region.id, region.text))
        .collect()
}

fn restore_search_user_content(turn: &mut Value, content_by_id: &HashMap<String, String>) {
    for item in turn["items"].as_array_mut().into_iter().flatten() {
        let is_user = item_type(item) == "usermessage"
            || (item_type(item) == "message" && item["role"] == "user");
        if !is_user {
            continue;
        }
        let client_id = string_field(item, "clientId")
            .or_else(|| string_field(item, "client_id"))
            .or_else(|| string_field(item, "id"));
        if let Some(content) = client_id.and_then(|id| content_by_id.get(&id)) {
            // Restore before projection so an empty provider prompt is not dropped.
            item["text"] = json!(content);
        }
    }
}

fn projected_segment_search_regions(
    items: &[Value],
    status: &str,
    error: Option<&str>,
) -> Vec<SearchRegion> {
    let final_items: Vec<_> = items
        .iter()
        .filter(|item| item["type"] == "assistant_text")
        .collect();
    let content = final_items
        .iter()
        .map(|item| strip_codex_ui_directives(item["content"].as_str().unwrap_or_default()))
        .collect::<Vec<_>>()
        .join("\n\n");
    let visible = visible_assistant_content(&content, status, error);
    let display_items: Vec<_> = items
        .iter()
        .filter(|item| {
            if item["type"] == "assistant_text" {
                return !item["content"]
                    .as_str()
                    .unwrap_or_default()
                    .trim()
                    .is_empty();
            }
            let block = &item["block"];
            let text = block["content"].as_str().unwrap_or_default().trim();
            item["type"] == "block"
                && block["type"] != "thinking"
                && (block["type"] != "text" || (!text.is_empty() && text != visible.trim()))
        })
        .collect();
    let ordered_content = display_items
        .iter()
        .filter(|item| item["type"] == "assistant_text")
        .map(|item| {
            strip_plugin_workspace_results(&strip_codex_ui_directives(
                item["content"].as_str().unwrap_or_default(),
            ))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let interleaved = !visible.trim().is_empty()
        && ordered_content == visible
        && display_items.iter().enumerate().any(|(index, item)| {
            item["type"] == "assistant_text"
                && display_items[index + 1..]
                    .iter()
                    .any(|later| later["type"] == "block")
        });
    let mut regions = Vec::new();
    let mut pending: Option<(String, MappedSource)> = None;
    let mut final_source = MappedSource::default();
    for (index, item) in final_items.iter().enumerate() {
        let id = item["id"].as_str().unwrap_or_default();
        let mut source = MappedSource::new(id, item["content"].as_str().unwrap_or_default());
        remove_codex_ui_directives(&mut source);
        final_source.append(source, if index == 0 { "" } else { "\n\n" });
    }
    remove_plugin_workspace_results(&mut final_source);
    remove_assistant_annotations(&mut final_source);
    for item in display_items {
        let Some(id) = item["id"].as_str() else {
            continue;
        };
        if item["type"] == "assistant_text" {
            if visible.is_empty() {
                continue;
            }
            if !interleaved {
                continue;
            }
            let mut source = MappedSource::new(id, item["content"].as_str().unwrap_or_default());
            remove_codex_ui_directives(&mut source);
            remove_plugin_workspace_results(&mut source);
            if let Some((_, content)) = &mut pending {
                content.append(source, "\n\n");
            } else {
                pending = Some((id.to_owned(), source));
            }
            continue;
        }
        if let Some((id, mut content)) = pending.take() {
            remove_assistant_annotations(&mut content);
            regions.push(content.markdown_region(&id));
        }
        let block = &item["block"];
        if block["type"] == "text" {
            regions.push(
                assistant_mapped_source(id, block["content"].as_str().unwrap_or_default(), false)
                    .markdown_region(id),
            );
        }
    }
    if let Some((id, mut content)) = pending {
        remove_assistant_annotations(&mut content);
        regions.push(content.markdown_region(&id));
    }
    if !interleaved && !visible.is_empty() {
        if let Some(id) = final_items
            .iter()
            .find(|item| {
                !item["content"]
                    .as_str()
                    .unwrap_or_default()
                    .trim()
                    .is_empty()
            })
            .and_then(|item| item["id"].as_str())
        {
            regions.push(final_source.markdown_region(id));
        }
    }
    regions
}

/// Parse each complete renderer region once, including cross-item references/fences.
pub(super) fn markdown_search_text(content: &str) -> String {
    MappedSource::new("", content).markdown_region("").text
}

pub(super) fn assistant_mapped_source(id: &str, content: &str, directives: bool) -> MappedSource {
    let mut source = MappedSource::new(id, content);
    if directives {
        remove_codex_ui_directives(&mut source);
        remove_plugin_workspace_results(&mut source);
    }
    remove_assistant_annotations(&mut source);
    source
}

#[cfg(test)]
fn assistant_search_text(content: &str) -> String {
    assistant_mapped_source("", content, true)
        .markdown_region("")
        .text
}

fn strip_plugin_workspace_results(content: &str) -> String {
    let mut source = MappedSource::new("", content);
    remove_plugin_workspace_results(&mut source);
    source.text().to_owned()
}

// Match assistantMessagePresentation.ts after runtime transcript normalization.
pub(super) fn visible_assistant_content(
    content: &str,
    status: &str,
    error: Option<&str>,
) -> String {
    if status.eq_ignore_ascii_case("cancelled")
        && matches!(
            content.trim().to_ascii_lowercase().as_str(),
            "interrupted" | "cancelled" | "canceled" | "aborted"
        )
    {
        return String::new();
    }
    if status.eq_ignore_ascii_case("failed") {
        if let Some(error) = error.filter(|error| !error.is_empty()) {
            static RAW_FAILED_CONTENT: OnceLock<Regex> = OnceLock::new();
            let pattern = RAW_FAILED_CONTENT.get_or_init(|| {
                Regex::new(concat!(
                    r#"(?i)^api error:|^task failed|^error:|"error"\s*:|"error_(type|code)"\s*:|"#,
                    r"(?-u:\b)(status|type)\s*:\s*failed(?-u:\b)",
                ))
                .expect("valid failed assistant content pattern")
            });
            let trimmed = content.trim();
            if !trimmed.is_empty() && (trimmed == error.trim() || pattern.is_match(trimmed)) {
                return String::new();
            }
        }
    }
    strip_plugin_workspace_results(content)
}

#[cfg(test)]
fn assistant_block_search_text(content: &str) -> String {
    let mut source = MappedSource::new("", content);
    remove_assistant_annotations(&mut source);
    source.markdown_region("").text
}

fn remove_assistant_annotations(source: &mut MappedSource) {
    source.remove(assistant_annotation_ranges(source.text()));
}

// Keep this projection aligned with chat-core/codex-directives.ts.
pub(super) fn strip_codex_ui_directives(content: &str) -> String {
    let mut source = MappedSource::new("", content);
    remove_codex_ui_directives(&mut source);
    source.text().to_owned()
}

fn remove_codex_ui_directives(source: &mut MappedSource) {
    static DIRECTIVES: OnceLock<Regex> = OnceLock::new();
    static EMPTY_LINES: OnceLock<Regex> = OnceLock::new();
    let directives = DIRECTIVES.get_or_init(|| {
        Regex::new(concat!(
            r"^\s*::(?::)?(?:archive-thread|automation-citation|code-comment|created-thread|",
            r"github-details|git-commit|git-create-branch|git-create-pr|git-push|git-stage|",
            r"inbox-item|pr-auto-fix-progress)(?:(?-u:\b)|\{).*",
        ))
        .expect("valid Codex UI directive pattern")
    });
    let mut fenced = false;
    let mut offset = 0;
    let mut removals = Vec::new();
    for line in source.text().split('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
        } else if !fenced && directives.is_match(line) {
            removals.push(offset..offset + line.len());
        }
        offset += line.len() + 1;
    }
    if removals.is_empty() {
        return;
    }
    source.remove(removals);
    source.remove(
        EMPTY_LINES
            .get_or_init(|| Regex::new(r"\n{3,}").expect("valid empty line pattern"))
            .find_iter(source.text())
            .map(|found| found.start() + 2..found.end())
            .collect::<Vec<_>>(),
    );
    source.trim(false);
}

fn remove_plugin_workspace_results(source: &mut MappedSource) {
    let mut offset = 0;
    let mut removals = Vec::new();
    for line in source.text().split_inclusive('\n') {
        if is_plugin_workspace_result_line(line.trim_end_matches(['\r', '\n'])) {
            removals.push(offset..offset + line.len());
        } else if line.ends_with("\r\n") {
            removals.push(offset + line.len() - 2..offset + line.len() - 1);
        }
        offset += line.len();
    }
    source.remove(removals);
    source.trim(true);
}

// Invalid model-authored markers stay visible, matching plugin-workspace-result.ts.
fn is_plugin_workspace_result_line(line: &str) -> bool {
    let Some((_, payload)) = line.split_once("[WEGENT_PLUGIN_RESULT]") else {
        return false;
    };
    let Ok(result) = serde_json::from_str::<Value>(payload.trim()) else {
        return false;
    };
    let has_string_fields = [
        "taskId",
        "name",
        "displayName",
        "description",
        "version",
        "logo",
    ]
    .iter()
    .all(|key| result.get(key).is_some_and(Value::is_string));
    result.get("schemaVersion").and_then(Value::as_f64) == Some(1.0)
        && has_string_fields
        && result
            .get("relativePath")
            .and_then(Value::as_str)
            .is_some_and(is_safe_relative_path)
        && result
            .get("sha256")
            .and_then(Value::as_str)
            .is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        && result
            .get("listingType")
            .and_then(Value::as_str)
            .is_some_and(|kind| matches!(kind, "plugin" | "skill"))
        && result
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| matches!(status, "ready" | "published" | "pending_review"))
}

fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with(['/', '\\'])
        && !path.ends_with(['/', '\\'])
        && !path
            .split(['/', '\\'])
            .any(|part| matches!(part, "." | ".."))
}

#[cfg(test)]
#[path = "transcript_search_text/async_reply_tests.rs"]
mod async_reply_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interleaved_region_protects_annotations_in_cross_item_reference_links() {
        let marker = "\u{e200}cite\u{e202}literal\u{e201}";
        let regions = codex_turn_search_regions(
            &json!({
                "id":"reference-turn", "status":"completed", "items":[
                    {"id":"label", "type":"agentMessage", "phase":"final_answer",
                     "text":format!("[CORE_LINK {marker}][ref]")},
                    {"id":"definition", "type":"agentMessage", "phase":"final_answer",
                     "text":"[ref]: https://example.invalid/reference"},
                    {"id":"tool", "type":"commandExecution", "command":"echo done"},
                ],
            }),
            &HashMap::new(),
            None,
            &mut Default::default(),
        );
        assert_eq!(regions.len(), 1);
        assert_eq!(regions[0].id, "label");
        assert_eq!(regions[0].text, format!("CORE_LINK {marker}"));
        assert!(regions[0]
            .sources
            .iter()
            .all(|span| span.item_id == "label"));
    }

    fn turn_sources(status: &str, content: &str, error: Option<&str>) -> Vec<(String, String)> {
        codex_turn_search_sources(
            &json!({
                "id": "turn", "status": status, "error": error,
                "items": [{"id": "answer", "type": "agentMessage", "phase": "commentary", "text": content}],
            }),
            &HashMap::new(),
            None,
            &mut Default::default(),
        )
    }

    #[test]
    fn projected_search_hides_terminal_placeholders_but_preserves_useful_output() {
        for placeholder in ["interrupted", "cancelled", "canceled", "aborted"] {
            assert!(turn_sources("interrupted", placeholder, None).is_empty());
            assert_eq!(
                turn_sources("completed", placeholder, None),
                vec![("answer".into(), placeholder.into())]
            );
        }
        let error = "API error: needle";
        assert!(turn_sources("failed", error, Some(error)).is_empty());
        assert_eq!(
            turn_sources("completed", error, Some(error)),
            vec![("answer".into(), error.into())]
        );
        assert_eq!(
            turn_sources("interrupted", "useful interrupted output", None),
            vec![("answer".into(), "useful interrupted output".into())]
        );
    }

    #[test]
    fn projected_search_uses_guidance_segments_and_joined_final_content() {
        let sources = codex_turn_search_sources(
            &json!({
                "id": "turn", "status": "failed", "error": "API error: needle",
                "items": [
                    {"id": "first", "type": "agentMessage", "phase": "final_answer", "text": "API error: needle"},
                    {"id": "guidance", "type": "userMessage", "content": [{"type": "inputText", "text": "continue"}]},
                    {"id": "last", "type": "agentMessage", "phase": "final_answer", "text": "API error: needle"},
                ],
            }),
            &HashMap::new(),
            None,
            &mut Default::default(),
        );
        assert!(sources.contains(&("first".into(), "API error: needle".into())));
        assert!(!sources.iter().any(|(id, _)| id == "last"));

        let sources = codex_turn_search_sources(
            &json!({
                "id": "turn", "status": "failed", "error": "API error: needle",
                "items": [
                    {"id": "partial", "type": "agentMessage", "phase": "final_answer", "text": "useful output"},
                    {"id": "last", "type": "agentMessage", "phase": "final_answer", "text": "API error: needle"},
                ],
            }),
            &HashMap::new(),
            None,
            &mut Default::default(),
        );
        assert_eq!(
            sources,
            vec![("partial".into(), "useful output\nAPI error: needle".into())]
        );
    }

    #[test]
    fn projected_search_retains_visible_narrative_and_deduplicates_final_items() {
        let sources = codex_turn_search_sources(
            &json!({
                "id": "turn", "status": "failed", "error": "API error: needle",
                "items": [
                    {"id": "process", "type": "agentMessage", "phase": "analysis", "text": "useful needle"},
                    {"id": "final", "type": "agentMessage", "phase": "final_answer", "text": "API error: needle"},
                    {"id": "duplicate", "type": "agentMessage", "phase": "final_answer", "text": "API error: needle"},
                ],
            }),
            &HashMap::new(),
            None,
            &mut Default::default(),
        );
        assert_eq!(sources, vec![("process".into(), "useful needle".into())]);
    }

    #[test]
    fn projected_search_restores_empty_user_prompts_before_projection() {
        let sources = codex_turn_search_sources(
            &json!({"id":"turn", "status":"completed", "items":[{
                "id":"provider-user", "clientId":"client-user", "type":"userMessage", "content":[],
            }]}),
            &HashMap::from([("client-user".into(), "restored **needle**".into())]),
            None,
            &mut Default::default(),
        );
        assert_eq!(
            sources,
            vec![("provider-user".into(), "restored needle".into())]
        );
    }

    #[test]
    fn rendered_markdown_excludes_hidden_destinations_and_metadata() {
        let source = concat!(
            "[visible label](https://hidden.example/needle \"hidden title\") ",
            "![hidden needle](image.png) <span data-needle=\"hidden\">shown</span>\n\n",
            "<div>hidden needle</div>\n\n",
            "`inline needle`\n\n```hidden-language\ncode needle\n```",
        );
        let text = markdown_search_text(source);
        assert_eq!(text, "visible label  shown\ninline needle\ncode needle");
        assert_eq!(text.match_indices("needle").count(), 2);
    }

    #[test]
    fn rendered_markdown_preserves_block_and_inline_text_boundaries() {
        assert_eq!(
            markdown_search_text("**one** &amp; `two`\n\n- [x] three\n- ~~four~~"),
            "one & two\nthree\nfour"
        );
        assert_eq!(
            markdown_search_text("| a | b |\n| - | - |\n| c | d |"),
            "a\nb\nc\nd"
        );
    }

    #[test]
    fn unsupported_assistant_citations_are_not_searchable() {
        assert_eq!(
            assistant_search_text("answer\u{e200}cite\u{e202}hidden needle\u{e201}"),
            "answer"
        );
        assert_eq!(
            assistant_search_text("answer\u{e200}cite\u{e202}unfinished needle"),
            "answer"
        );
    }

    #[test]
    fn assistant_search_excludes_ui_directives_but_keeps_code_and_unknown_directives() {
        let source = concat!(
            "answer\n::archive-thread{reason=\"hidden needle\"}\n",
            ":::git-create-pr{title=\"hidden needle\"}\n\n",
            "```text\n::archive-thread{reason=\"code needle\"}\n```\n\n",
            "::unknown-directive{value=\"visible needle\"}",
        );
        let text = assistant_search_text(source);
        assert!(!text.contains("hidden needle"));
        assert!(text.contains("code needle"));
        assert!(text.contains("visible needle"));
        assert_eq!(text.match_indices("needle").count(), 2);
        assert!(assistant_block_search_text(source).contains("hidden needle"));
    }

    #[test]
    fn assistant_search_excludes_only_valid_plugin_workspace_markers() {
        let result = serde_json::json!({
            "schemaVersion": 1, "taskId": "task", "relativePath": "plugins/result",
            "name": "result", "displayName": "hidden needle", "description": "result",
            "version": "1", "listingType": "plugin", "logo": "", "sha256": "a".repeat(64),
            "status": "ready",
        });
        let source = format!("answer\r\n[WEGENT_PLUGIN_RESULT]{result}\r\n");
        assert_eq!(assistant_search_text(&source), "answer");
        assert!(assistant_block_search_text(&source).contains("hidden needle"));
        let mut invalid = result.clone();
        invalid["relativePath"] = serde_json::json!("../result");
        let source = format!("[WEGENT_PLUGIN_RESULT]{invalid}");
        assert!(assistant_search_text(&source).contains("hidden needle"));
        assert!(
            assistant_search_text("[WEGENT_PLUGIN_RESULT]invalid needle")
                .contains("invalid needle")
        );
        assert!(is_plugin_workspace_result_line(&format!(
            "prefix [WEGENT_PLUGIN_RESULT]{result}"
        )));
    }
}
