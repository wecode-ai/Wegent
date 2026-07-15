// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use image::{DynamicImage, ImageBuffer, ImageFormat, Rgb};
use serde_json::{json, Value};
use tokio::sync::{Mutex, MutexGuard};
use wegent_executor::{
    agents::CodexAppServerEngine,
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

#[tokio::test]
async fn codex_app_server_replaces_downloaded_image_blocks_with_local_images() {
    let _lock = env_lock().await;
    let workspace = unique_dir("codex-attachment-local");
    let local_image = workspace.join(".wegent/attachments/29/43/image.png");
    fs::create_dir_all(local_image.parent().unwrap()).unwrap();
    fs::write(&local_image, png_bytes(16, 8)).unwrap();
    let sandbox_path = "/home/user/29:executor:attachments/43/image.png";
    let log_path = workspace.join("codex-rpc.jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let mut request = ExecutionRequest {
        task_id: "29".to_owned(),
        subtask_id: "44".to_owned(),
        auth_token: Some("token".to_owned()),
        prompt: json!([
            {
                "type": "input_text",
                "text": format!(
                    "<attachment>[Image Attachment: image.png | ID: 15 | File Path(already in sandbox): {sandbox_path}]</attachment>"
                )
            },
            {"type": "input_image", "image_url": "data:image/png;base64,abc"},
            {"type": "input_text", "text": "Analyze this image"}
        ]),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "attachments".to_owned(),
        json!([{
            "id": 15,
            "original_filename": "image.png",
            "mime_type": "image/png",
            "file_size": 3,
            "subtask_id": 43,
            "local_path": local_image
        }]),
    );

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );

    let messages = read_json_lines(&log_path);
    let input = &messages[3]["params"]["input"];
    assert_eq!(
        input[0],
        json!({
            "type": "text",
            "text": format!(
                "\n# Files mentioned by the user:\n\n## image.png: {}\n\n## My request for Codex:\nAnalyze this image\n",
                local_image.display()
            ),
            "text_elements": []
        })
    );
    assert_eq!(
        input[1],
        json!({"type": "localImage", "path": local_image.display().to_string()})
    );
    assert!(!input[0]["text"].as_str().unwrap().contains(sandbox_path));
}

#[tokio::test]
async fn codex_app_server_keeps_failed_download_placeholder_order() {
    let _lock = env_lock().await;
    let workspace = unique_dir("codex-attachment-failed-order");
    let second_image = workspace.join("second.png");
    fs::write(&second_image, png_bytes(16, 8)).unwrap();
    let log_path = workspace.join("codex-rpc.jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let mut request = ExecutionRequest {
        task_id: "29".to_owned(),
        subtask_id: "44".to_owned(),
        auth_token: Some("token".to_owned()),
        prompt: json!([
            {"type": "input_text", "text": "Compare these images"},
            {"type": "input_image", "image_url": "data:image/png;base64,first"},
            {"type": "input_image", "image_url": "data:image/png;base64,second"}
        ]),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "attachments".to_owned(),
        json!([
            {
                "id": 15,
                "original_filename": "first.png",
                "mime_type": "image/png",
                "file_size": 3,
                "subtask_id": 43,
                "error": "HTTP 404"
            },
            {
                "id": 16,
                "original_filename": "second.png",
                "mime_type": "image/png",
                "file_size": 3,
                "subtask_id": 43,
                "local_path": second_image
            }
        ]),
    );

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );

    let messages = read_json_lines(&log_path);
    assert_eq!(
        messages[3]["params"]["input"],
        json!([
            {
                "type": "text",
                "text": format!(
                    "\n# Files mentioned by the user:\n\n## second.png: {}\n\n## My request for Codex:\nCompare these images\n",
                    second_image.display()
                ),
                "text_elements": []
            },
            {"type": "image", "url": "data:image/png;base64,first"},
            {"type": "localImage", "path": second_image.display().to_string()}
        ])
    );
}

#[tokio::test]
async fn codex_app_server_cleans_generated_model_input_images() {
    let _lock = env_lock().await;
    let workspace = unique_dir("codex-attachment-cleanup");
    let large_image = workspace.join("large.png");
    fs::write(&large_image, png_bytes(3000, 1500)).unwrap();
    let log_path = workspace.join("codex-rpc.jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let engine = CodexAppServerEngine::new(fake_codex.display().to_string());
    let mut request = ExecutionRequest {
        task_id: "29".to_owned(),
        subtask_id: "44".to_owned(),
        auth_token: Some("token".to_owned()),
        prompt: json!([
            {"type": "input_text", "text": "Analyze this image"},
            {"type": "input_image", "image_url": "data:image/png;base64,abc"}
        ]),
        bot: json!([{"shell_type": "ClaudeCode"}]),
        model_config: json!({
            "model": "openai",
            "model_id": "gpt-5",
            "protocol": "openai-responses"
        }),
        ..ExecutionRequest::default()
    };
    request.extra.insert(
        "attachments".to_owned(),
        json!([{
            "id": 15,
            "original_filename": "large.png",
            "mime_type": "image/png",
            "file_size": fs::metadata(&large_image).unwrap().len(),
            "subtask_id": 43,
            "local_path": large_image
        }]),
    );

    let outcome = engine.run(request).await;

    assert_eq!(
        outcome,
        ExecutionOutcome::Completed {
            content: "done".to_owned()
        }
    );

    let messages = read_json_lines(&log_path);
    let generated_path = messages[3]["params"]["input"][1]["path"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(messages[3]["params"]["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains(&large_image.display().to_string()));
    assert!(!messages[3]["params"]["input"][0]["text"]
        .as_str()
        .unwrap()
        .contains(".model-input.png"));
    assert_ne!(generated_path, large_image.display().to_string());
    assert!(generated_path.ends_with(".model-input.png"));
    assert_eq!(
        png_dimensions(&fs::read(&generated_path).unwrap_or_default()),
        None
    );
    assert!(large_image.exists());
    assert!(!Path::new(&generated_path).exists());
}

fn png_bytes(width: u32, height: u32) -> Vec<u8> {
    let image = ImageBuffer::from_pixel(width, height, Rgb([16, 128, 224]));
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(image)
        .write_to(&mut output, ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

fn png_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if !data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let width = u32::from_be_bytes(data[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(data[20..24].try_into().unwrap());
    Some((width, height))
}

fn write_fake_codex(log_path: &Path) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "fake-codex-attachment-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":3,"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"delta":"done","phase":"finalAnswer"}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-1","status":"completed"}}}}}}'
      exit 0
      ;;
  esac
done
"#,
        log_path.display()
    );
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
}

fn read_json_lines(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>()
}

async fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().await
}

fn unique_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "wegent-executor-{name}-{}-{}",
        std::process::id(),
        unique_suffix()
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).unwrap();
    path
}

fn unique_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}
