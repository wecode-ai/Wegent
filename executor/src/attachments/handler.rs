// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::{AttachmentPromptProcessor, AttachmentRecord};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentTask {
    pub auth_token: Option<String>,
    pub attachments: Vec<AttachmentRecord>,
    pub project_id: Option<i64>,
    pub git_url: Option<String>,
    pub project_workspace_path: Option<PathBuf>,
    pub user_subtask_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentDownloaderConfig {
    pub workspace: PathBuf,
    pub task_id: String,
    pub subtask_id: String,
    pub auth_token: String,
    pub project_layout: bool,
}

impl AttachmentDownloaderConfig {
    pub fn attachments_dir(&self) -> PathBuf {
        if self.project_layout {
            return self.workspace.join(&self.task_id).join(&self.subtask_id);
        }
        self.workspace
            .join(get_attachments_subdir_name(&self.task_id))
            .join(&self.subtask_id)
    }

    pub fn attachment_path(&self, filename: &str) -> PathBuf {
        self.attachments_dir().join(sanitize_filename(filename))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AttachmentDownloadResult {
    pub success: Vec<AttachmentRecord>,
    pub failed: Vec<AttachmentRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentProcessResult {
    pub prompt: Value,
    pub image_content_blocks: Vec<Value>,
    pub success_count: usize,
    pub failed_count: usize,
}

pub trait AttachmentDownloadClient {
    fn download_all(
        &self,
        config: &AttachmentDownloaderConfig,
        attachments: &[AttachmentRecord],
    ) -> AttachmentDownloadResult;
}

pub fn download_attachments_with(
    task: &AttachmentTask,
    task_id: i64,
    subtask_id: i64,
    prompt: &Value,
    workspace_root: &Path,
    downloader: &impl AttachmentDownloadClient,
) -> AttachmentProcessResult {
    if task.attachments.is_empty() {
        return AttachmentProcessResult {
            prompt: prompt.clone(),
            image_content_blocks: Vec::new(),
            success_count: 0,
            failed_count: 0,
        };
    }

    let Some(auth_token) = task
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return AttachmentProcessResult {
            prompt: prompt.clone(),
            image_content_blocks: Vec::new(),
            success_count: 0,
            failed_count: task.attachments.len(),
        };
    };

    let (workspace, project_layout) = resolve_attachment_workspace(task, task_id, workspace_root);
    let attachment_subtask_id = resolve_attachment_subtask_id(
        &task.attachments,
        task.user_subtask_id.unwrap_or(subtask_id),
    );
    let config = AttachmentDownloaderConfig {
        workspace,
        task_id: task_id.to_string(),
        subtask_id: attachment_subtask_id.to_string(),
        auth_token: auth_token.to_owned(),
        project_layout,
    };
    let result = downloader.download_all(&config, &task.attachments);

    let mut modified_prompt = prompt.clone();
    let mut image_content_blocks = Vec::new();
    if !result.success.is_empty() || !result.failed.is_empty() {
        modified_prompt = AttachmentPromptProcessor::process_prompt(
            prompt,
            &result.success,
            &result.failed,
            Some(task_id),
            Some(attachment_subtask_id),
        );

        if let Value::String(text) = &mut modified_prompt {
            let context = AttachmentPromptProcessor::build_attachment_context(&result.success);
            if !context.is_empty() {
                text.push_str(&context);
            }
        }

        if !is_vision_prompt(prompt) {
            image_content_blocks =
                AttachmentPromptProcessor::build_image_content_blocks(&result.success);
        }
    }

    AttachmentProcessResult {
        prompt: modified_prompt,
        image_content_blocks,
        success_count: result.success.len(),
        failed_count: result.failed.len(),
    }
}

fn resolve_attachment_workspace(
    task: &AttachmentTask,
    task_id: i64,
    workspace_root: &Path,
) -> (PathBuf, bool) {
    if let Some(project_workspace) = project_workspace(task, workspace_root) {
        return (project_workspace.join(".wegent/attachments"), true);
    }
    (workspace_root.join(task_id.to_string()), false)
}

fn project_workspace(task: &AttachmentTask, workspace_root: &Path) -> Option<PathBuf> {
    if let Some(path) = &task.project_workspace_path {
        if path.is_absolute() {
            return Some(path.clone());
        }
        return Some(workspace_root.join(path));
    }

    let project_id = task.project_id?;
    let git_url = task.git_url.as_deref()?;
    let repo_name = repo_name_from_url(git_url)?;
    Some(
        workspace_root
            .join("projects")
            .join(project_id.to_string())
            .join(repo_name.replace(['/', '\\'], "_")),
    )
}

fn resolve_attachment_subtask_id(attachments: &[AttachmentRecord], fallback: i64) -> i64 {
    attachments
        .iter()
        .find_map(|attachment| attachment.subtask_id)
        .unwrap_or(fallback)
}

fn is_vision_prompt(prompt: &Value) -> bool {
    prompt.as_array().into_iter().flatten().any(|block| {
        matches!(
            block.get("type").and_then(Value::as_str),
            Some("input_image" | "image" | "localImage" | "local_image")
        )
    })
}

fn get_attachments_subdir_name(task_id: &str) -> String {
    let raw = format!("{task_id}:executor:attachments");
    if cfg!(windows) {
        raw.replace(':', "_")
    } else {
        raw
    }
}

fn sanitize_filename(filename: &str) -> String {
    let basename = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(filename)
        .replace(['\n', '\r'], "")
        .replace(['/', '\\'], "_");
    if basename.is_empty() {
        "document".to_owned()
    } else {
        basename
    }
}

fn repo_name_from_url(git_url: &str) -> Option<String> {
    let trimmed = git_url.trim().trim_end_matches(".git");
    trimmed
        .rsplit(['/', ':'])
        .next()
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
}
