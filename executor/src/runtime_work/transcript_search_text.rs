// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, sync::OnceLock};

use pulldown_cmark::{Event, Options, Parser, TagEnd};
use regex::Regex;
use serde_json::{json, Value};

use super::{
    transcript::{search_transcript_messages, visible_user_request_content},
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
        let content = message["content"].as_str().unwrap_or_default();
        if content.trim().is_empty() {
            return Some(markdown_search_text(visible_user_request_content(content)));
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
        Some(markdown_search_text(visible_user_request_content(content)))
    }
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
pub(super) fn codex_turn_search_sources(
    turn: &Value,
    user_content_by_client_id: &HashMap<String, String>,
    root_thread_id: Option<&str>,
    projection: &mut AsyncReplySearchProjection,
) -> Vec<(String, String)> {
    let mut turn = turn.clone();
    restore_search_user_content(&mut turn, user_content_by_client_id);
    let messages = search_transcript_messages(&json!({"id": root_thread_id, "turns": [turn]}));
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
    let segment_count = items
        .iter()
        .filter(|item| item["type"] == "user_message")
        .count()
        + 1;
    let mut sources = Vec::new();
    for (index, segment) in items
        .split_inclusive(|item| item["type"] == "user_message")
        .enumerate()
    {
        // A user item closes the preceding assistant segment, just as the renderer does.
        let is_last = index + 1 == segment_count;
        sources.extend(projected_segment_search_sources(
            segment,
            if is_last { status } else { "done" },
            if is_last { error } else { None },
            &user_texts,
        ));
    }
    sources
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

fn projected_segment_search_sources(
    items: &[Value],
    status: &str,
    error: Option<&str>,
    user_texts: &HashMap<String, String>,
) -> Vec<(String, String)> {
    let content = items
        .iter()
        .filter(|item| item["type"] == "assistant_text")
        .map(|item| strip_codex_ui_directives(item["content"].as_str().unwrap_or_default()))
        .collect::<Vec<_>>()
        .join("\n\n");
    let visible_content = visible_assistant_content(&content, status, error);
    items
        .iter()
        .filter_map(|item| {
            let id = string_field(item, "id")?;
            let text = match item["type"].as_str()? {
                "user_message" => user_texts.get(&id).cloned().unwrap_or_default(),
                "assistant_text" if !visible_content.is_empty() => {
                    assistant_search_text(item["content"].as_str().unwrap_or_default())
                }
                "block" if item["block"]["type"] == "text" => {
                    let text = item["block"]["content"].as_str().unwrap_or_default();
                    if text.trim().is_empty() || text.trim() == visible_content.trim() {
                        return None;
                    }
                    assistant_block_search_text(text)
                }
                _ => return None,
            };
            Some((id, text))
        })
        .collect()
}

/// Mirror the renderer's Markdown text index, excluding image alt text, HTML,
/// link destinations and code-block language metadata.
pub(super) fn markdown_search_text(content: &str) -> String {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    let mut frames = vec![TextFrame::new(None)];
    for event in Parser::new_ext(content, options) {
        match event {
            Event::Start(tag) => frames.push(TextFrame::new(Some(tag.to_end()))),
            Event::End(end) => {
                let text = frames.pop().expect("balanced Markdown events").finish();
                let parent = frames.last_mut().expect("Markdown root frame");
                if is_block(end) {
                    parent.push_child(text);
                } else {
                    parent.inline.push_str(&text);
                }
            }
            Event::Text(text) | Event::Code(text) => {
                frames.last_mut().unwrap().inline.push_str(&text);
            }
            Event::SoftBreak => frames.last_mut().unwrap().inline.push('\n'),
            Event::Rule => frames.last_mut().unwrap().push_child(String::new()),
            _ => {}
        }
    }
    frames.pop().expect("Markdown root frame").finish()
}

pub(super) fn assistant_search_text(content: &str) -> String {
    let content = strip_codex_ui_directives(content);
    assistant_block_search_text(&strip_plugin_workspace_results(&content))
}

fn strip_plugin_workspace_results(content: &str) -> String {
    content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !is_plugin_workspace_result_line(line))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_owned()
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

pub(super) fn assistant_block_search_text(content: &str) -> String {
    static CITATIONS: OnceLock<Regex> = OnceLock::new();
    let citations = CITATIONS.get_or_init(|| {
        Regex::new("\u{e200}cite\u{e202}[\\s\\S]*?\u{e201}|\u{e200}cite(?:\u{e202}[\\s\\S]*)?$")
            .expect("valid content citation pattern")
    });
    markdown_search_text(&citations.replace_all(content, ""))
}

// Keep this projection aligned with chat-core/codex-directives.ts.
pub(super) fn strip_codex_ui_directives(content: &str) -> String {
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
    let mut in_code_fence = false;
    let mut changed = false;
    let lines = content
        .split('\n')
        .map(|line| {
            let trimmed = line.trim_start();
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                in_code_fence = !in_code_fence;
            } else if !in_code_fence && directives.is_match(line) {
                changed = true;
                return "";
            }
            line
        })
        .collect::<Vec<_>>()
        .join("\n");
    if !changed {
        return lines;
    }
    EMPTY_LINES
        .get_or_init(|| Regex::new(r"\n{3,}").expect("valid empty line pattern"))
        .replace_all(&lines, "\n\n")
        .trim()
        .to_owned()
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

struct TextFrame {
    end: Option<TagEnd>,
    children: Vec<String>,
    inline: String,
}

impl TextFrame {
    fn new(end: Option<TagEnd>) -> Self {
        Self {
            end,
            children: Vec::new(),
            inline: String::new(),
        }
    }

    fn push_child(&mut self, text: String) {
        if !self.inline.is_empty() {
            self.children.push(std::mem::take(&mut self.inline));
        }
        self.children.push(text);
    }

    fn finish(mut self) -> String {
        if matches!(self.end, Some(TagEnd::Image | TagEnd::HtmlBlock)) {
            return String::new();
        }
        if !self.inline.is_empty() {
            self.children.push(self.inline);
        }
        let separator = match self.end {
            None
            | Some(
                TagEnd::BlockQuote(_)
                | TagEnd::List(_)
                | TagEnd::Item
                | TagEnd::Table
                | TagEnd::TableHead
                | TagEnd::TableRow,
            ) => "\n",
            _ => "",
        };
        let mut text = self.children.join(separator);
        if self.end == Some(TagEnd::CodeBlock) && text.ends_with('\n') {
            text.pop();
        }
        text
    }
}

fn is_block(end: TagEnd) -> bool {
    matches!(
        end,
        TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::List(_)
            | TagEnd::Item
            | TagEnd::Table
            | TagEnd::TableHead
            | TagEnd::TableRow
            | TagEnd::TableCell
    )
}

#[cfg(test)]
#[path = "transcript_search_text/async_reply_tests.rs"]
mod async_reply_tests;

#[cfg(test)]
mod tests {
    use super::*;

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
            vec![
                ("partial".into(), "useful output".into()),
                ("last".into(), "API error: needle".into())
            ]
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
        assert_eq!(text, "visible label  shown\n\ninline needle\ncode needle");
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
