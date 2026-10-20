// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::OnceLock;

use pulldown_cmark::{Event, Options, Parser, TagEnd};
use regex::Regex;
use serde_json::Value;

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
    let content = content
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !is_plugin_workspace_result_line(line))
        .collect::<Vec<_>>()
        .join("\n");
    assistant_block_search_text(content.trim_end())
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
fn strip_codex_ui_directives(content: &str) -> String {
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
mod tests {
    use super::*;

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
