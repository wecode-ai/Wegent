// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use crate::protocol::ExecutionRequest;

use super::{deploy_request_skills, has_task_skill_names, primary_bot, project_workspace_path};

pub async fn prepare_codex_runtime(request: &ExecutionRequest) -> Result<(), String> {
    let _capability_lease = crate::services::capability_activation::begin_execution().await;
    let _home_lease = crate::agents::instance_home::acquire(request)?;
    prepare_codex_runtime_locked(request).await
}

pub(crate) async fn prepare_codex_runtime_locked(request: &ExecutionRequest) -> Result<(), String> {
    // Native plugin Skills stay under Codex ownership. Selected backend Skills
    // still need deployment when a Wework profile has no named Agent Home.
    if primary_bot(request).is_none() {
        return Ok(());
    }
    if let Some(home) = crate::agents::instance_home::request_home(request) {
        return deploy_request_skills(request, &home.join("skills")).await;
    }
    if has_task_skill_names(request) {
        let workspace = project_workspace_path(request)
            .ok_or_else(|| "selected Skills require a task workspace".to_owned())?;
        return deploy_request_skills(request, &workspace.join(".codex/skills")).await;
    }
    Ok(())
}
