// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared builders for attachment context block metadata.
//!
//! Mirrors `shared/utils/attachment_block.py`: single-line metadata header,
//! file-size formatting, download URL, sandbox path, truncation note, and the
//! bounded inline injection copy.
use serde_json::Value;

const USER_QUESTION_MARKER: &str = "[User Question]:";
const SYSTEM_REMINDER_OPEN: &str = "<system-reminder>";
const SYSTEM_CONTEXT_PREFIXES: [&str; 3] =
    ["<system-reminder>", "<attachment>", "<selected_documents>"];
const ATTACHMENT_TRUNCATION_NOTE: &str = "(Note: parsing truncated this file; only partial content is shown below. Read the full file at the path above for the complete content.)";
const INJECT_TRUNCATION_MARKER: &str =
    "\n\n…[inline preview truncated; the full file is referenced in the header above]…\n\n";

/// Return a single safe path component for an attachment filename
/// (`sanitize_attachment_filename`).
pub fn sanitize_attachment_filename(filename: Option<&str>, fallback: &str) -> String {
    let candidate = filename.unwrap_or(fallback).replace('\\', "/");
    let candidate = candidate.rsplit('/').next().unwrap_or("");
    let filtered: String = candidate
        .chars()
        .filter(|c| (*c as u32) >= 32 && *c as u32 != 127)
        .collect();
    if filtered.is_empty() || filtered == "." || filtered == ".." {
        fallback.to_string()
    } else {
        filtered
    }
}

/// Format a byte count into a human-readable size (`format_file_size`).
pub fn format_file_size(size_bytes: i64) -> String {
    if size_bytes >= 1024 * 1024 {
        format!("{:.1} MB", size_bytes as f64 / (1024.0 * 1024.0))
    } else if size_bytes >= 1024 {
        format!("{:.1} KB", size_bytes as f64 / 1024.0)
    } else {
        format!("{size_bytes} bytes")
    }
}

/// Build the download URL for an attachment (`build_attachment_download_url`).
pub fn build_attachment_download_url(attachment_id: i64) -> String {
    format!("/api/attachments/{attachment_id}/download")
}

/// Build the sandbox file path where the Executor downloads an attachment
/// (`build_sandbox_path`).
pub fn build_sandbox_path(
    task_id: Option<i64>,
    subtask_id: Option<i64>,
    filename: Option<&str>,
) -> Option<String> {
    let task_id = task_id?;
    let subtask_id = subtask_id?;
    let safe_filename = sanitize_attachment_filename(filename, "document");
    Some(format!(
        "/home/user/{task_id}:executor:attachments/{subtask_id}/{safe_filename}"
    ))
}

/// Return the truncation notice line (`build_truncation_note`).
pub fn build_truncation_note(is_truncated: bool) -> String {
    if is_truncated {
        format!("{ATTACHMENT_TRUNCATION_NOTE}\n")
    } else {
        String::new()
    }
}

/// Bound the inline attachment text to `max_chars` keeping a contiguous
/// head and tail (`truncate_for_injection`).
pub fn truncate_for_injection(text: &str, max_chars: usize) -> (String, bool) {
    if max_chars == 0 || text.chars().count() <= max_chars {
        return (text.to_string(), false);
    }
    let budget = max_chars.saturating_sub(INJECT_TRUNCATION_MARKER.chars().count());
    if budget == 0 {
        return (text.chars().take(max_chars).collect(), true);
    }
    let head = budget * 6 / 10;
    let tail = budget - head;
    let chars: Vec<char> = text.chars().collect();
    let mut truncated: String = chars[..head.min(chars.len())].iter().collect();
    truncated.push_str(INJECT_TRUNCATION_MARKER);
    if tail > 0 {
        let start = chars.len().saturating_sub(tail);
        truncated.extend(&chars[start..]);
    }
    (truncated, true)
}

/// Build the single-line metadata header for an attachment block
/// (`build_attachment_header`).
pub fn build_attachment_header(
    attachment_id: i64,
    filename: Option<&str>,
    mime_type: Option<&str>,
    file_size: i64,
    sandbox_path: Option<&str>,
    is_image: bool,
) -> String {
    let label = if is_image {
        "Image Attachment"
    } else {
        "Attachment"
    };
    let formatted_size = format_file_size(if file_size > 0 { file_size } else { 0 });
    let url = build_attachment_download_url(attachment_id);
    let safe_filename = sanitize_attachment_filename(filename, "document");
    let mut header = format!(
        "[{label}: {safe_filename} | ID: {attachment_id} | Type: {} | Size: {formatted_size} | URL: {url}",
        mime_type.unwrap_or("unknown"),
    );
    if let Some(path) = sandbox_path {
        if is_image {
            header.push_str(&format!(" | File Path in Sandbox: {path}"));
        } else {
            header.push_str(&format!(" | File Path(already in sandbox): {path}"));
        }
    }
    header.push(']');
    header
}

fn extract_user_question(text: &str) -> String {
    if let Some(index) = text.find(USER_QUESTION_MARKER) {
        let after = &text[index + USER_QUESTION_MARKER.len()..];
        return after.trim_start_matches('\n').trim().to_string();
    }
    text.trim().to_string()
}

fn is_system_context_block(text: &str) -> bool {
    let stripped = text.trim_start();
    SYSTEM_CONTEXT_PREFIXES
        .iter()
        .any(|prefix| stripped.starts_with(prefix))
}

/// Parse a stored prompt value into its text content and extra blocks
/// (`parse_prompt_blocks`).
pub fn parse_prompt_blocks(raw_prompt: &str) -> (String, Vec<Value>) {
    if let Ok(parsed) = serde_json::from_str::<Value>(raw_prompt)
        && let Some(blocks) = parsed.as_array()
        && blocks.iter().all(|block| block.as_object().is_some())
    {
        return parse_block_list(blocks, raw_prompt);
    }
    if raw_prompt.contains(USER_QUESTION_MARKER) {
        return (extract_user_question(raw_prompt), Vec::new());
    }
    (raw_prompt.to_string(), Vec::new())
}

fn parse_block_list(blocks: &[Value], raw_prompt: &str) -> (String, Vec<Value>) {
    let text_types = ["text", "input_text"];
    let mut user_text: Option<String> = None;
    let mut extra_blocks: Vec<Value> = Vec::new();

    for block in blocks {
        let block_type = block.get("type").and_then(Value::as_str).unwrap_or("");
        if !text_types.contains(&block_type) {
            continue;
        }
        let text = block.get("text").and_then(Value::as_str).unwrap_or("");

        if text.trim_start().starts_with(SYSTEM_REMINDER_OPEN) {
            extra_blocks.push(block.clone());
            continue;
        }
        if text.trim_start().starts_with(USER_QUESTION_MARKER) {
            if user_text.is_none() {
                user_text = Some(extract_user_question(text));
            }
            continue;
        }
        if is_system_context_block(text) {
            continue;
        }
        if user_text.is_none() {
            user_text = Some(text.to_string());
        } else {
            extra_blocks.push(block.clone());
        }
    }

    (
        user_text.unwrap_or_else(|| raw_prompt.to_string()),
        extra_blocks,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_file_sizes() {
        assert_eq!(format_file_size(0), "0 bytes");
        assert_eq!(format_file_size(2136362), "2.0 MB");
        assert_eq!(format_file_size(5300), "5.2 KB");
    }

    #[test]
    fn builds_document_header_without_sandbox_path() {
        let header = build_attachment_header(
            1266842,
            Some("file.zip"),
            Some("application/zip"),
            2136362,
            None,
            false,
        );
        assert_eq!(
            header,
            "[Attachment: file.zip | ID: 1266842 | Type: application/zip | Size: 2.0 MB | URL: /api/attachments/1266842/download]"
        );
    }

    #[test]
    fn builds_image_header_with_sandbox_path() {
        let header = build_attachment_header(
            1,
            Some("logo.png"),
            Some("image/png"),
            5300,
            Some("/home/user/1:executor:attachments/2/logo.png"),
            true,
        );
        assert!(header.starts_with("[Image Attachment: logo.png | ID: 1"));
        assert!(
            header.contains("File Path in Sandbox: /home/user/1:executor:attachments/2/logo.png")
        );
    }

    #[test]
    fn parses_plain_text_prompt() {
        let (text, extra) = parse_prompt_blocks("This is an example prompt");
        assert_eq!(text, "This is an example prompt");
        assert!(extra.is_empty());
    }

    #[test]
    fn extracts_user_question_after_marker() {
        let (text, _) =
            parse_prompt_blocks("<attachment>meta</attachment>\n\n[User Question]:\nhello");
        assert_eq!(text, "hello");
    }

    #[test]
    fn parses_json_block_list_keeping_system_reminders() {
        let raw = r#"[{"type":"text","text":"question"},{"type":"text","text":"<system-reminder>time</system-reminder>"}]"#;
        let (text, extra) = parse_prompt_blocks(raw);
        assert_eq!(text, "question");
        assert_eq!(extra.len(), 1);
    }

    #[test]
    fn discards_attachment_blocks_from_json_list() {
        let raw = r#"[{"type":"text","text":"<attachment>old</attachment>"},{"type":"text","text":"[User Question]:\nreal"}]"#;
        let (text, extra) = parse_prompt_blocks(raw);
        assert_eq!(text, "real");
        assert!(extra.is_empty());
    }

    #[test]
    fn hard_cut_when_budget_below_marker_length() {
        // Mirrors Python: max_chars smaller than the marker falls back to a
        // hard head cut with no marker.
        let text = "a".repeat(100);
        let (truncated, was_truncated) = truncate_for_injection(&text, 20);
        assert!(was_truncated);
        assert_eq!(truncated.chars().count(), 20);
        assert!(!truncated.contains('…'));
    }

    #[test]
    fn head_and_tail_split_when_budget_exceeds_marker() {
        let text: String = (0..500)
            .map(|i| char::from_u32(0x61 + (i % 26)).unwrap())
            .collect();
        let (truncated, was_truncated) = truncate_for_injection(&text, 300);
        assert!(was_truncated);
        assert!(truncated.chars().count() <= 300);
        assert!(truncated.contains('…'));
        // Head keeps the first characters, tail keeps the last.
        assert!(truncated.starts_with('a'));
        // The kept tail ends with the final character of the input text.
        let expected_last = text.chars().next_back().unwrap();
        assert!(truncated.ends_with(expected_last));
    }
}
