// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::path::{Path, PathBuf};

use crate::protocol::ExecutionRequest;

use super::{deploy_request_skills, primary_bot};

pub async fn prepare_codex_runtime(request: &ExecutionRequest) -> Result<(), String> {
    // Native Wework turns resolve installed Skills through Codex, without a Bot
    // deployment plan. Only Bot-backed requests download Skills from the backend.
    if primary_bot(request).is_none() {
        return Ok(());
    }
    let task_dir = request
        .cwd()
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::workspace_paths::task_workspace_dir(&request.task_id));
    let codex_skills_dir = codex_skills_dir(&task_dir);
    deploy_request_skills(request, &codex_skills_dir).await
}

fn codex_skills_dir(task_dir: &Path) -> PathBuf {
    task_dir.join(".codex/skills")
}
