//! Periodic maintenance handlers over the final application dependencies.

use anyhow::{Context, Result};
use brz_json::OpaqueJson;
use brz_mysql::{FromMysqlRow, Json};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

use super::BackgroundJobRegistry;
use crate::AppState;

const REPOSITORY_UPDATE: &str = "repository_update";
const USERS: &str = "SELECT id, user_name, git_info FROM users WHERE is_active = true";

#[derive(FromMysqlRow)]
struct RepositoryUser {
    id: i32,
    user_name: String,
    git_info: Json<OpaqueJson>,
}

pub(super) fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
    let interval = crate::config::env_or_dotenv("REPO_UPDATE_INTERVAL_SECONDS")
        .map(|value| value.parse::<u64>())
        .transpose()?
        .unwrap_or(3600);
    registry.register(REPOSITORY_UPDATE, move |context, _| {
        let state = state.clone();
        async move {
            Ok(super::with_lock_watchdog(
                &state.background_jobs,
                &context,
                "repository_update_lock",
                Duration::from_secs(interval.saturating_sub(10).max(10)),
                refresh_repositories(&state, context.clone()),
            )
            .await?
            .unwrap_or_else(|| json!({"skipped":"lock_busy"})))
        }
    })?;
    registry.max_failures(REPOSITORY_UPDATE, 1)?;
    registry.timeout(REPOSITORY_UPDATE, None)?;
    registry.startup(REPOSITORY_UPDATE, Duration::ZERO)?;
    registry.interval(REPOSITORY_UPDATE, Duration::from_secs(interval), false)
}

async fn refresh_repositories(
    state: &AppState,
    context: brz_schedule::JobContext,
) -> Result<Value> {
    state
        .redis
        .as_ref()
        .context("repository maintenance requires durable Redis cache")?;
    // Read snapshots without holding a transaction during provider HTTP calls.
    let users: Vec<RepositoryUser> = state
        .mysql
        .fetch_all(USERS, ())
        .await
        .context("failed to load active repository users")?;
    let mut refreshed = 0;
    let mut skipped = 0;
    let mut failed = 0;
    for user in users {
        if context.cancellation.is_cancelled() {
            anyhow::bail!("repository refresh cancelled");
        }
        let result = state
            .git_repositories
            .refresh_user_repositories(
                state.repository_tokens.as_ref(),
                user.id,
                &user.user_name,
                &user.git_info.0,
            )
            .await;
        refreshed += result.refreshed;
        skipped += result.skipped;
        failed += result.failed;
    }
    Ok(json!({"refreshed":refreshed,"skipped":skipped,"failed":failed}))
}
