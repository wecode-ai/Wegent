// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    cell::RefCell,
    path::{Path, PathBuf},
};

use serde_json::json;
use wegent_executor::attachments::{
    download_attachments_with, AttachmentDownloadClient, AttachmentDownloadResult,
    AttachmentDownloaderConfig, AttachmentRecord, AttachmentTask,
};

#[derive(Default)]
struct FakeDownloader {
    calls: RefCell<Vec<(AttachmentDownloaderConfig, Vec<AttachmentRecord>)>>,
    result: AttachmentDownloadResult,
}

impl FakeDownloader {
    fn with_success(attachment: AttachmentRecord) -> Self {
        Self {
            calls: RefCell::new(Vec::new()),
            result: AttachmentDownloadResult {
                success: vec![attachment],
                failed: Vec::new(),
            },
        }
    }
}

impl AttachmentDownloadClient for FakeDownloader {
    fn download_all(
        &self,
        config: &AttachmentDownloaderConfig,
        attachments: &[AttachmentRecord],
    ) -> AttachmentDownloadResult {
        self.calls
            .borrow_mut()
            .push((config.clone(), attachments.to_vec()));
        self.result.clone()
    }
}

fn attachment(id: i64, filename: &str) -> AttachmentRecord {
    AttachmentRecord {
        id,
        original_filename: filename.to_owned(),
        local_path: None,
        file_size: None,
        mime_type: None,
        subtask_id: None,
        error: None,
    }
}

fn task_with_attachment(attachment: AttachmentRecord) -> AttachmentTask {
    AttachmentTask {
        auth_token: Some("test-token".to_owned()),
        attachments: vec![attachment],
        project_id: None,
        git_url: None,
        project_workspace_path: None,
        user_subtask_id: None,
    }
}

#[test]
fn non_vision_list_prompt_still_downloads_attachments() {
    let mut downloaded = attachment(274, "xxx.md");
    downloaded.local_path = Some("/tmp/workspace/1233:executor:attachments/1642/xxx.md".to_owned());
    downloaded.mime_type = Some("text/markdown".to_owned());
    downloaded.file_size = Some(57_036);
    let downloader = FakeDownloader::with_success(downloaded);
    let prompt = json!([
        {
            "type": "input_text",
            "text": "[Attachment: xxx.md | ID: 274 | File Path(already in sandbox): /home/user/1233:executor:attachments/1642/xxx.md]"
        },
        {"type": "input_text", "text": "upload this file"}
    ]);

    let result = download_attachments_with(
        &task_with_attachment(attachment(274, "xxx.md")),
        1233,
        1642,
        &prompt,
        Path::new("/tmp"),
        &downloader,
    );

    assert_eq!(downloader.calls.borrow().len(), 1);
    assert_eq!(result.success_count, 1);
    assert!(result.prompt[0]["text"]
        .as_str()
        .unwrap()
        .contains("/tmp/workspace/1233:executor:attachments/1642/xxx.md"));
}

#[test]
fn string_prompt_does_not_inject_layout_guidance_in_local_mode() {
    let mut downloaded = attachment(274, "xxx.md");
    downloaded.local_path =
        Some("/workspace/1233/1233:executor:attachments/1642/xxx.md".to_owned());
    downloaded.mime_type = Some("text/markdown".to_owned());
    downloaded.file_size = Some(57_036);
    let downloader = FakeDownloader::with_success(downloaded);

    let result = download_attachments_with(
        &task_with_attachment(attachment(274, "xxx.md")),
        1233,
        1642,
        &json!("summarize this attachment"),
        Path::new("/Users/test/.wegent-executor/workspace"),
        &downloader,
    );

    assert!(!result
        .prompt
        .as_str()
        .unwrap()
        .contains("Do not assume a workspace/<task_id>/attachments/ directory."));
}

#[test]
fn project_zero_workspace_downloads_to_project_attachment_layout() {
    let project_workspace = PathBuf::from("/tmp/chats/2026-06-12/hello");
    let local_image = project_workspace
        .join(".wegent/attachments/31/45/image.png")
        .display()
        .to_string();
    let sandbox_path = "/home/user/31:executor:attachments/45/image.png";
    let mut source_attachment = attachment(16, "image.png");
    source_attachment.mime_type = Some("image/png".to_owned());
    source_attachment.file_size = Some(3);
    source_attachment.subtask_id = Some(45);
    let mut downloaded = source_attachment.clone();
    downloaded.local_path = Some(local_image.clone());
    let downloader = FakeDownloader::with_success(downloaded);
    let task = AttachmentTask {
        auth_token: Some("test-token".to_owned()),
        attachments: vec![source_attachment],
        project_id: Some(0),
        git_url: None,
        project_workspace_path: Some(project_workspace.clone()),
        user_subtask_id: Some(45),
    };

    let result = download_attachments_with(
        &task,
        31,
        46,
        &json!([{
            "type": "input_text",
            "text": format!("<attachment>[Image Attachment: image.png | ID: 16 | File Path(already in sandbox): {sandbox_path}]</attachment>")
        }]),
        Path::new("/unused"),
        &downloader,
    );

    let calls = downloader.calls.borrow();
    let (config, attachments) = calls.first().unwrap();
    assert_eq!(
        config.workspace,
        project_workspace.join(".wegent/attachments")
    );
    assert!(config.project_layout);
    assert_eq!(config.subtask_id, "45");
    assert_eq!(
        config.attachment_path("image.png"),
        PathBuf::from(&local_image)
    );
    assert_eq!(attachments[0].id, 16);
    assert_eq!(result.success_count, 1);
    assert!(!result.prompt[0]["text"]
        .as_str()
        .unwrap()
        .contains(sandbox_path));
    assert!(result.prompt[0]["text"]
        .as_str()
        .unwrap()
        .contains(&format!("Local File Path: {local_image}")));
}
