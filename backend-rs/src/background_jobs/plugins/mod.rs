// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Selectively mirror approved upstreams without changing the stored schema.

mod metadata;
mod package;
mod publish;
mod storage;
use crate::{
    AppState,
    background_jobs::{BackgroundJobRegistry, with_lock_watchdog},
};
use anyhow::Result;
use brz_mysql::FromMysqlRow;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

const SYNC: &str = "app.tasks.plugin_marketplace_tasks.sync_plugin_upstreams";
#[derive(FromMysqlRow)]
pub struct Upstream {
    pub id: i64,
    pub plugin_id: i64,
    pub provider: String,
    pub marketplace_name: String,
    pub remote_plugin_id: String,
    pub upstream_url: String,
    pub sync_policy: String,
}
const COLUMNS: &str =
    "id,plugin_id,provider,marketplace_name,remote_plugin_id,upstream_url,sync_policy";

pub(super) fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
    registry.register(SYNC, move |context, _| {
        let state = state.clone();
        async move {
            Ok(with_lock_watchdog(
                &state.background_jobs,
                &context,
                "wegent:lock:sync_plugin_upstreams",
                Duration::from_secs(3600),
                sync(&state, &context),
            )
            .await?
            .unwrap_or_else(|| json!({"synced":0,"skipped":1})))
        }
    })?;
    registry.max_failures(SYNC, 1)?;
    registry.fixed_rate(SYNC, Duration::from_secs(6 * 3600), false)
}
async fn sync(state: &Arc<AppState>, context: &brz_schedule::JobContext) -> Result<Value> {
    let upstreams: Vec<Upstream> = state
        .mysql
        .fetch_all(
            format!("SELECT {COLUMNS} FROM plugin_upstreams WHERE sync_enabled=1"),
            (),
        )
        .await?;
    let mut synced = 0;
    for upstream in upstreams {
        if context.cancellation.is_cancelled() {
            anyhow::bail!("Plugin upstream sync cancelled")
        }
        if let Err(error) = sync_one(state, &upstream).await {
            // Persist only bounded, sanitized errors; request URLs and credentials
            // never enter failure logs or the user-visible sync error.
            let message = error.to_string().chars().take(1000).collect::<String>();
            state
                .mysql
                .execute(
                    "UPDATE plugin_upstreams SET last_checked_at=NOW(),last_error=? WHERE id=?",
                    (message, upstream.id),
                )
                .await?;
            tracing::warn!(
                upstream_id = upstream.id,
                "Plugin upstream synchronization failed"
            );
        } else {
            synced += 1;
        }
    }
    Ok(json!({"synced":synced,"skipped":0}))
}
async fn sync_one(state: &Arc<AppState>, upstream: &Upstream) -> Result<()> {
    let bytes = super::download::get(&upstream.upstream_url, package::MAXIMUM, 5).await?;
    let remote = upstream.remote_plugin_id.clone();
    let parsed = tokio::task::spawn_blocking(move || package::prepare(bytes, &remote)).await??;
    publish::store(state, upstream, &parsed).await
}
