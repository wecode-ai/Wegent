// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{fs, io::Cursor};

use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
use serde_json::json;
use wegent_executor::{
    attachments::{process_prompt, AttachmentPromptProcessor, AttachmentRecord},
    image_preprocessor::MAX_MODEL_IMAGE_LONG_EDGE,
};

fn attachment(id: i64, filename: &str, local_path: &str) -> AttachmentRecord {
    AttachmentRecord {
        id,
        original_filename: filename.to_owned(),
        status: None,
        local_path: Some(local_path.to_owned()),
        file_size: None,
        mime_type: None,
        subtask_id: None,
        error: None,
    }
}

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let image = ImageBuffer::from_pixel(width, height, Rgb([0, 127, 255]));
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image)
        .write_to(&mut output, ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

fn png_dimensions(data: &[u8]) -> (u32, u32) {
    assert!(data.starts_with(b"\x89PNG\r\n\x1a\n"));
    let width = u32::from_be_bytes(data[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(data[20..24].try_into().unwrap());
    (width, height)
}

#[test]
fn rewrites_source_subtask_sandbox_path_to_local_execution_path() {
    let prompt = json!([
        {
            "type": "input_text",
            "text": "[Attachment: xxx.html | ID: 301 | File Path(already in sandbox): /home/user/1251:executor:attachments/1676/xxx.html]"
        },
        {"type": "input_text", "text": "upload this file"}
    ]);
    let mut downloaded = attachment(
        301,
        "xxx.html",
        "/Users/test/.wecode/wegent-executor/workspace/1251/1251:executor:attachments/1677/xxx.html",
    );
    downloaded.subtask_id = Some("1676".to_owned());

    let processed = process_prompt(
        &prompt,
        &[downloaded],
        &[],
        Some("1251".to_owned()),
        Some("1677".to_owned()),
    );

    assert!(processed[0]["text"]
        .as_str()
        .unwrap()
        .contains("Local File Path: /Users/test/.wecode/wegent-executor/workspace/1251/1251:executor:attachments/1677/xxx.html"));
    assert!(!processed[0]["text"]
        .as_str()
        .unwrap()
        .contains("/home/user/1251:executor:attachments/1676/xxx.html"));
}

#[test]
fn rewrites_backend_sandbox_path_to_local_path_in_text_blocks() {
    let prompt = json!([
        {
            "type": "input_text",
            "text": "[Attachment: xxx.md | ID: 274 | File Path(already in sandbox): /home/user/1233:executor:attachments/1642/xxx.md]"
        },
        {"type": "input_text", "text": "upload this file"}
    ]);
    let downloaded = attachment(
        274,
        "xxx.md",
        "/Users/test/.wegent-executor/workspace/1233/1233:executor:attachments/1642/xxx.md",
    );

    let processed = process_prompt(
        &prompt,
        &[downloaded],
        &[],
        Some("1233".to_owned()),
        Some("1642".to_owned()),
    );

    assert!(processed[0]["text"]
        .as_str()
        .unwrap()
        .contains("Local File Path: /Users/test/.wegent-executor/workspace/1233/1233:executor:attachments/1642/xxx.md"));
    assert!(!processed[0]["text"]
        .as_str()
        .unwrap()
        .contains("/home/user/1233:executor:attachments/1642/xxx.md"));
}

#[test]
fn attachment_context_lists_available_files_without_layout_guidance() {
    let mut downloaded = attachment(
        274,
        "xxx.md",
        "/Users/test/.wegent-executor/workspace/1233/1233:executor:attachments/1642/xxx.md",
    );
    downloaded.file_size = Some(4096);
    downloaded.mime_type = Some("text/markdown".to_owned());

    let context = AttachmentPromptProcessor::build_attachment_context(&[downloaded]);

    assert!(context.contains("xxx.md"));
    assert!(context.contains("text/markdown"));
    assert!(context.contains("4.0 KB"));
    assert!(!context.contains("Do not assume a workspace/<task_id>/attachments/ directory."));
}

#[test]
fn text_attachment_context_includes_file_content_and_path() {
    let attachment_path = std::env::temp_dir().join(format!(
        "wegent-text-attachment-{}-{}.txt",
        std::process::id(),
        "prompt"
    ));
    let content = (1..=11)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(&attachment_path, content).unwrap();
    let mut downloaded = attachment(
        274,
        "clipboard-text.txt",
        &attachment_path.display().to_string(),
    );
    downloaded.file_size = Some(31);
    downloaded.mime_type = Some("text/plain".to_owned());

    let context = AttachmentPromptProcessor::build_text_attachment_context(&[downloaded]);

    assert!(context.contains("clipboard-text.txt"));
    assert!(context.contains(&attachment_path.display().to_string()));
    assert!(context.contains("line 1"));
    assert!(context.contains("line 10"));
    assert!(!context.contains("line 11"));
    assert!(context.contains("Content preview truncated after 10 lines or 4.0 KB"));

    let _ = fs::remove_file(attachment_path);
}

#[test]
fn text_attachment_context_truncates_large_file_content() {
    let attachment_path = std::env::temp_dir().join(format!(
        "wegent-large-text-attachment-{}-{}.txt",
        std::process::id(),
        "prompt"
    ));
    let content = format!("{}TAIL_SHOULD_NOT_APPEAR", "A".repeat(70 * 1024));
    fs::write(&attachment_path, content).unwrap();
    let mut downloaded = attachment(
        274,
        "long-clipboard-text.txt",
        &attachment_path.display().to_string(),
    );
    downloaded.file_size = Some(70 * 1024);
    downloaded.mime_type = Some("text/plain".to_owned());

    let context = AttachmentPromptProcessor::build_text_attachment_context(&[downloaded]);

    assert!(context.contains("long-clipboard-text.txt"));
    assert!(context.contains("Content preview truncated after 10 lines or 4.0 KB"));
    assert!(context.contains("Read the full Local File Path"));
    assert!(!context.contains("TAIL_SHOULD_NOT_APPEAR"));

    let _ = fs::remove_file(attachment_path);
}

#[test]
fn image_content_blocks_downscale_large_images() {
    let image_path = std::env::temp_dir().join(format!(
        "wegent-large-attachment-{}-{}.png",
        std::process::id(),
        "prompt"
    ));
    fs::write(&image_path, png_bytes(3000, 1500)).unwrap();
    let mut downloaded = attachment(1, "large.png", &image_path.display().to_string());
    downloaded.mime_type = Some("image/png".to_owned());

    let blocks = AttachmentPromptProcessor::build_image_content_blocks(&[downloaded]);
    let image_data = general_purpose::STANDARD
        .decode(blocks[0]["source"]["data"].as_str().unwrap())
        .unwrap();

    assert_eq!(blocks[0]["source"]["media_type"], "image/png");
    assert_eq!(
        png_dimensions(&image_data),
        (MAX_MODEL_IMAGE_LONG_EDGE, MAX_MODEL_IMAGE_LONG_EDGE / 2)
    );

    let _ = fs::remove_file(image_path);
}
