// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::fs;

use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};

use crate::image_preprocessor::prepare_image_bytes_for_model;

const IMAGE_MIME_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentRecord {
    pub id: i64,
    pub original_filename: String,
    pub local_path: Option<String>,
    pub file_size: Option<u64>,
    pub mime_type: Option<String>,
    pub subtask_id: Option<i64>,
    pub error: Option<String>,
}

pub struct AttachmentPromptProcessor;

pub fn process_prompt(
    prompt: &Value,
    success_attachments: &[AttachmentRecord],
    failed_attachments: &[AttachmentRecord],
    task_id: Option<i64>,
    subtask_id: Option<i64>,
) -> Value {
    AttachmentPromptProcessor::process_prompt(
        prompt,
        success_attachments,
        failed_attachments,
        task_id,
        subtask_id,
    )
}

impl AttachmentPromptProcessor {
    pub fn process_prompt(
        prompt: &Value,
        success_attachments: &[AttachmentRecord],
        failed_attachments: &[AttachmentRecord],
        task_id: Option<i64>,
        subtask_id: Option<i64>,
    ) -> Value {
        match prompt {
            Value::String(text) => Value::String(Self::rewrite_text(
                text,
                success_attachments,
                failed_attachments,
                task_id,
                subtask_id,
            )),
            Value::Array(blocks) => Value::Array(
                blocks
                    .iter()
                    .map(|block| {
                        Self::process_prompt_block(
                            block,
                            success_attachments,
                            failed_attachments,
                            task_id,
                            subtask_id,
                        )
                    })
                    .collect(),
            ),
            value => value.clone(),
        }
    }

    pub fn build_attachment_context(success_attachments: &[AttachmentRecord]) -> String {
        if success_attachments.is_empty() {
            return String::new();
        }

        let mut lines = vec!["Available attachments:".to_owned()];
        for attachment in success_attachments {
            lines.push(format!(
                "- {} ({}, {}): {}",
                attachment.original_filename,
                attachment
                    .mime_type
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .unwrap_or("unknown"),
                format_file_size(attachment.file_size.unwrap_or_default()),
                attachment.local_path.as_deref().unwrap_or("")
            ));
        }

        format!("\n\n<attachment>\n{}\n</attachment>", lines.join("\n"))
    }

    pub fn build_image_content_blocks(success_attachments: &[AttachmentRecord]) -> Vec<Value> {
        success_attachments
            .iter()
            .filter_map(Self::image_content_block)
            .collect()
    }

    fn process_prompt_block(
        block: &Value,
        success_attachments: &[AttachmentRecord],
        failed_attachments: &[AttachmentRecord],
        task_id: Option<i64>,
        subtask_id: Option<i64>,
    ) -> Value {
        let Some(object) = block.as_object() else {
            return block.clone();
        };
        let block_type = object.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(block_type, "input_text" | "text") {
            return block.clone();
        }
        let Some(text) = object.get("text").and_then(Value::as_str) else {
            return block.clone();
        };

        let mut updated = object.clone();
        updated.insert(
            "text".to_owned(),
            Value::String(Self::rewrite_text(
                text,
                success_attachments,
                failed_attachments,
                task_id,
                subtask_id,
            )),
        );
        Value::Object(updated)
    }

    fn rewrite_text(
        text: &str,
        success_attachments: &[AttachmentRecord],
        failed_attachments: &[AttachmentRecord],
        task_id: Option<i64>,
        subtask_id: Option<i64>,
    ) -> String {
        let mut processed = replace_attachment_refs(text, success_attachments, failed_attachments);

        for attachment in success_attachments {
            let Some(local_path) = attachment
                .local_path
                .as_deref()
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let Some(sandbox_path) = build_sandbox_path(
                task_id,
                attachment.subtask_id.or(subtask_id),
                &attachment.original_filename,
            ) else {
                continue;
            };
            processed = processed.replace(
                &format!("File Path(already in sandbox): {sandbox_path}"),
                &format!("Local File Path: {local_path}"),
            );
            processed = processed.replace(&sandbox_path, local_path);
        }

        append_failed_download_warning(processed, failed_attachments)
    }

    fn image_content_block(attachment: &AttachmentRecord) -> Option<Value> {
        let mime_type = attachment.mime_type.as_deref()?.to_ascii_lowercase();
        if !IMAGE_MIME_TYPES.contains(&mime_type.as_str()) {
            return None;
        }
        let local_path = attachment.local_path.as_deref()?.trim();
        if local_path.is_empty() {
            return None;
        }

        let image_data = fs::read(local_path).ok()?;
        let prepared = prepare_image_bytes_for_model(&image_data, &mime_type, None);
        Some(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": prepared.mime_type,
                "data": general_purpose::STANDARD.encode(prepared.data),
            }
        }))
    }
}

fn replace_attachment_refs(
    text: &str,
    success_attachments: &[AttachmentRecord],
    failed_attachments: &[AttachmentRecord],
) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;

    while let Some(start_offset) = text[cursor..].find("[attachment:") {
        let start = cursor + start_offset;
        output.push_str(&text[cursor..start]);
        let id_start = start + "[attachment:".len();
        let Some(end_offset) = text[id_start..].find(']') else {
            output.push_str(&text[start..]);
            return output;
        };
        let end = id_start + end_offset;
        let id_text = &text[id_start..end];
        let replacement = id_text
            .trim()
            .parse::<i64>()
            .ok()
            .map(|id| attachment_reference_text(id, success_attachments, failed_attachments));
        output.push_str(replacement.as_deref().unwrap_or(&text[start..end + 1]));
        cursor = end + 1;
    }

    output.push_str(&text[cursor..]);
    output
}

fn attachment_reference_text(
    id: i64,
    success_attachments: &[AttachmentRecord],
    failed_attachments: &[AttachmentRecord],
) -> String {
    if let Some(attachment) = success_attachments
        .iter()
        .find(|attachment| attachment.id == id)
    {
        return format!(
            "[Attachment downloaded to: {}]",
            attachment.local_path.as_deref().unwrap_or("")
        );
    }
    if failed_attachments
        .iter()
        .any(|attachment| attachment.id == id)
    {
        return format!("[Attachment {id} unavailable - download failed]");
    }
    format!("[Attachment {id} unavailable]")
}

fn append_failed_download_warning(
    mut text: String,
    failed_attachments: &[AttachmentRecord],
) -> String {
    if failed_attachments.is_empty() {
        return text;
    }
    text.push_str("\n\nThe following attachments failed to download and are unavailable:");
    for attachment in failed_attachments {
        text.push_str(&format!(
            "\n- {} (Error: {})",
            attachment.original_filename,
            attachment.error.as_deref().unwrap_or("Unknown error")
        ));
    }
    text
}

fn build_sandbox_path(
    task_id: Option<i64>,
    subtask_id: Option<i64>,
    filename: &str,
) -> Option<String> {
    Some(format!(
        "/home/user/{}:executor:attachments/{}/{}",
        task_id?,
        subtask_id?,
        filename.replace(['\n', '\r'], "")
    ))
}

fn format_file_size(size: u64) -> String {
    if size >= 1024 * 1024 {
        format!("{:.1} MB", size as f64 / (1024.0 * 1024.0))
    } else if size >= 1024 {
        format!("{:.1} KB", size as f64 / 1024.0)
    } else {
        format!("{size} bytes")
    }
}
