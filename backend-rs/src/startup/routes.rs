// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Route composition shared by the public and application applications.
use crate::{models_unified, state::AppState};
use anyhow::{Context as _, Result};
use std::sync::Arc;

pub async fn build(app: Arc<AppState>) -> Result<brz_http_server::Router> {
    let status_state = super::remote_workspace_status::build(app.mysql.clone(), app.task_policy)
        .await
        .context("failed to initialize remote-workspace status dependencies")?;
    let tree_state = super::remote_workspace_tree::build(app.mysql.clone())
        .await
        .context("failed to build remote-workspace tree dependencies")?;
    let runtime_check_state = super::runtime_check::build(app.mysql.clone(), app.task_policy)
        .await
        .context("failed to connect runtime-check dependencies")?;
    let models_unified_config = models_unified::config::AppConfig::from_env();
    let models_unified_state =
        super::models_unified::build(app.mysql.clone(), &models_unified_config, app.erp.clone())
            .await
            .context("failed to connect models-unified dependencies")?;

    let handler = brz_http_server::handlers!(state = app)
        .map_err(|error| anyhow::anyhow!("API route registration failed: {error}"))?
        .merge(
            brz_http_server::handlers!(rws = status_state; group = remote_workspace_status)
                .map_err(|error| anyhow::anyhow!("API route registration failed: {error}"))?,
        )
        .merge(
            brz_http_server::handlers!(rwt = tree_state; group = remote_workspace_tree)
                .map_err(|error| anyhow::anyhow!("API route registration failed: {error}"))?,
        )
        .merge(
            brz_http_server::handlers!(rc = runtime_check_state; group = runtime_check)
                .map_err(|error| anyhow::anyhow!("API route registration failed: {error}"))?,
        )
        .merge(
            brz_http_server::handlers!(mu = models_unified_state; group = models_unified)
                .map_err(|error| anyhow::anyhow!("API route registration failed: {error}"))?,
        );

    Ok(handler)
}
