// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
use serde_json::json;
use wegent_executor::{
    attachments::{
        append_text_to_vision_prompt, convert_openai_to_anthropic_content,
        convert_openai_to_anthropic_content_async, create_multimodal_query, is_vision_prompt,
        parse_data_uri, save_vision_images_to,
    },
    image_preprocessor::MAX_MODEL_IMAGE_LONG_EDGE,
};

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let image = ImageBuffer::from_pixel(width, height, Rgb([16, 128, 224]));
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

fn temp_home(name: &str) -> PathBuf {
    let home = std::env::temp_dir().join(format!(
        "wegent-multimodal-prompt-{}-{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&home);
    fs::create_dir_all(&home).unwrap();
    home
}

fn file_name(path: &Path) -> String {
    path.file_name().unwrap().to_string_lossy().into_owned()
}

#[test]
fn detects_only_list_prompts_with_image_blocks_as_vision_prompts() {
    assert!(!is_vision_prompt(&json!("hello world")));
    assert!(!is_vision_prompt(&json!([])));
    assert!(!is_vision_prompt(
        &json!([{"type": "input_text", "text": "hello"}])
    ));
    assert!(!is_vision_prompt(&json!(42)));
    assert!(!is_vision_prompt(&json!({"type": "input_image"})));

    assert!(is_vision_prompt(&json!([
        {"type": "input_text", "text": "describe this"},
        {"type": "input_image", "image_url": "data:image/png;base64,abc"}
    ])));
    assert!(is_vision_prompt(&json!([
        {"type": "text", "text": "describe this"},
        {"type": "image", "source": {"type": "base64", "data": "abc"}}
    ])));
    assert!(is_vision_prompt(
        &json!([{"type": "localImage", "path": "/tmp/image.png"}])
    ));
}

#[test]
fn appends_or_prepends_text_without_mutating_original_prompt() {
    let prompt = json!([
        {"type": "input_text", "text": "original"},
        {"type": "input_image", "image_url": "data:image/png;base64,abc"}
    ]);

    let appended = append_text_to_vision_prompt(&prompt, "extra info", false);
    let prepended = append_text_to_vision_prompt(&prompt, "prefix", true);

    assert_eq!(appended[0]["text"], "original\nextra info");
    assert_eq!(prepended[0]["text"], "prefix\n\noriginal");
    assert_eq!(prompt[0]["text"], "original");
}

#[test]
fn creates_text_block_when_appending_to_image_only_prompt() {
    let prompt = json!([{"type": "input_image", "image_url": "data:image/png;base64,abc"}]);

    let appended = append_text_to_vision_prompt(&prompt, "new text", false);
    let prepended = append_text_to_vision_prompt(&prompt, "new text", true);

    assert_eq!(appended.as_array().unwrap().len(), 2);
    assert_eq!(
        appended[1],
        json!({"type": "input_text", "text": "new text"})
    );
    assert_eq!(prepended.as_array().unwrap().len(), 2);
    assert_eq!(
        prepended[0],
        json!({"type": "input_text", "text": "new text"})
    );
}

#[test]
fn converts_openai_text_and_data_uri_image_blocks_to_anthropic_content() {
    let blocks = json!([
        {"type": "input_text", "text": "What is this?"},
        {"type": "input_image", "image_url": "data:image/jpeg;base64,/9j/4AAQ"}
    ]);

    let converted = convert_openai_to_anthropic_content(&blocks);

    assert_eq!(converted.as_array().unwrap().len(), 2);
    assert_eq!(
        converted[0],
        json!({"type": "text", "text": "What is this?"})
    );
    assert_eq!(converted[1]["type"], "image");
    assert_eq!(converted[1]["source"]["type"], "base64");
    assert_eq!(converted[1]["source"]["media_type"], "image/jpeg");
    assert_eq!(converted[1]["source"]["data"], "/9j/4AAQ");
}

#[test]
fn omits_blank_text_blocks_and_passes_unknown_blocks_through() {
    let blocks = json!([
        {"type": "input_text", "text": ""},
        {"type": "text", "text": "   "},
        {"type": "custom", "data": "foo"},
        {"type": "input_file", "filename": "report.pdf"},
        {"type": "input_video", "video_url": "file:///tmp/demo.mp4"},
        {"type": "localImage", "path": "/tmp/image.png"},
        {"type": "input_image", "image_url": "data:image/png;base64,iVBOR"}
    ]);

    let converted = convert_openai_to_anthropic_content(&blocks);

    assert_eq!(converted.as_array().unwrap().len(), 5);
    assert_eq!(converted[0], json!({"type": "custom", "data": "foo"}));
    assert_eq!(
        converted[1],
        json!({"type": "input_file", "filename": "report.pdf"})
    );
    assert_eq!(
        converted[2],
        json!({"type": "input_video", "video_url": "file:///tmp/demo.mp4"})
    );
    assert_eq!(
        converted[3],
        json!({"type": "localImage", "path": "/tmp/image.png"})
    );
    assert_eq!(converted[4]["type"], "image");
    assert_eq!(converted[4]["source"]["media_type"], "image/png");
}

#[test]
fn downscales_large_inline_data_uri_images_during_conversion() {
    let image_data = png_bytes(3000, 1500);
    let blocks = json!([{
        "type": "input_image",
        "image_url": format!(
            "data:image/png;base64,{}",
            general_purpose::STANDARD.encode(image_data)
        )
    }]);

    let converted = convert_openai_to_anthropic_content(&blocks);
    let resized_data = general_purpose::STANDARD
        .decode(converted[0]["source"]["data"].as_str().unwrap())
        .unwrap();

    assert_eq!(converted[0]["source"]["media_type"], "image/png");
    assert_eq!(
        png_dimensions(&resized_data),
        (MAX_MODEL_IMAGE_LONG_EDGE, MAX_MODEL_IMAGE_LONG_EDGE / 2)
    );
}

#[tokio::test]
async fn async_converter_returns_the_same_anthropic_content() {
    let blocks = json!([{"type": "input_text", "text": "hello"}]);

    let converted = convert_openai_to_anthropic_content_async(blocks).await;

    assert_eq!(converted, json!([{"type": "text", "text": "hello"}]));
}

#[test]
fn creates_single_user_multimodal_query_message() {
    let content = json!([
        {"type": "text", "text": "describe"},
        {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "abc"}
        }
    ]);

    let messages = create_multimodal_query(&content);

    assert_eq!(messages.as_array().unwrap().len(), 1);
    assert_eq!(messages[0]["type"], "user");
    assert_eq!(messages[0]["message"]["role"], "user");
    assert_eq!(messages[0]["message"]["content"], content);
}

#[test]
fn parses_data_uris_and_defaults_invalid_values_to_png() {
    assert_eq!(
        parse_data_uri("data:image/png;base64,iVBOR"),
        ("image/png".to_owned(), "iVBOR".to_owned())
    );
    assert_eq!(
        parse_data_uri("data:image/jpeg;base64,/9j/4AAQ"),
        ("image/jpeg".to_owned(), "/9j/4AAQ".to_owned())
    );
    assert_eq!(
        parse_data_uri("not-a-data-uri"),
        ("image/png".to_owned(), "not-a-data-uri".to_owned())
    );
    assert_eq!(parse_data_uri(""), ("image/png".to_owned(), String::new()));
}

#[test]
fn saves_data_uri_images_under_docs_pics_with_task_prefix_and_extensions() {
    let home = temp_home("save");
    let image_data = general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nfakedata");
    let prompt = json!([
        {"type": "input_text", "text": "describe this"},
        {"type": "input_image", "image_url": format!("data:image/jpeg;base64,{image_data}")},
        {"type": "input_image", "image_url": format!("data:image/png;base64,{image_data}")}
    ]);

    let paths = save_vision_images_to(&prompt, &home, Some("42")).unwrap();

    assert_eq!(paths.len(), 2);
    assert!(paths[0].starts_with(home.join("docs").join("pics")));
    assert!(file_name(&paths[0]).starts_with("42_"));
    assert!(file_name(&paths[0]).ends_with(".jpg"));
    assert!(file_name(&paths[1]).starts_with("42_"));
    assert!(file_name(&paths[1]).ends_with(".png"));
    assert_eq!(fs::read(&paths[0]).unwrap(), b"\x89PNG\r\n\x1a\nfakedata");

    let _ = fs::remove_dir_all(home);
}

#[test]
fn skips_non_image_blocks_and_omits_filename_prefix_without_task_id() {
    let home = temp_home("no-task");
    let image_data = general_purpose::STANDARD.encode(b"data");
    let text_only = json!([{"type": "input_text", "text": "hello"}]);

    assert!(save_vision_images_to(&text_only, &home, None)
        .unwrap()
        .is_empty());

    let prompt = json!([{
        "type": "input_image",
        "image_url": format!("data:image/png;base64,{image_data}")
    }]);
    let paths = save_vision_images_to(&prompt, &home, None).unwrap();

    assert_eq!(paths.len(), 1);
    assert!(!file_name(&paths[0])
        .split('.')
        .next()
        .unwrap()
        .contains('_'));
    assert!(paths[0].exists());

    let _ = fs::remove_dir_all(home);
}
