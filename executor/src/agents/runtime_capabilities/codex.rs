// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use crate::protocol::ExecutionRequest;

use super::{deploy_request_skills, primary_bot};

pub async fn prepare_codex_runtime(request: &ExecutionRequest) -> Result<(), String> {
    let _capability_lease = crate::services::capability_activation::begin_execution().await;
    let _home_lease = crate::agents::instance_home::acquire(request)?;
    prepare_codex_runtime_locked(request).await
}

pub(crate) async fn prepare_codex_runtime_locked(request: &ExecutionRequest) -> Result<(), String> {
    // Native Wework turns resolve installed Skills through Codex, without a Bot
    // deployment plan. Only Bot-backed requests download Skills from the backend.
    if primary_bot(request).is_none() {
        return Ok(());
    }
    if let Some(home) = crate::agents::instance_home::request_home(request) {
        return deploy_request_skills(request, &home.join("skills")).await;
    }
    Ok(())
}
