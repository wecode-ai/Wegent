//! Native Issue execution jobs, independent of optional migrated Celery scans.

use std::{sync::Arc, time::Duration};

use anyhow::Result;
use serde_json::json;

use super::super::{BackgroundJobRegistry, project, with_lock_watchdog};
use crate::AppState;

pub(crate) const SCAN: &str = "wegent.managed_issue.scan";
pub(crate) const EXECUTE: &str = "wegent.managed_issue.execute";

pub(super) fn register(
    registry: &mut BackgroundJobRegistry,
    app: Arc<AppState>,
    interval: Duration,
) -> Result<()> {
    let scanner = app.clone();
    registry.register(SCAN, move |context, _| {
        let app = scanner.clone();
        async move {
            if crate::config::env_or_dotenv("ROBOT_QUEUE_SCHEDULER_ENABLED").is_some_and(|value| {
                matches!(
                    value.to_ascii_lowercase().as_str(),
                    "0" | "false" | "no" | "off"
                )
            }) {
                return Ok(json!({"status":"skipped","reason":"scheduler_disabled"}));
            }
            Ok(with_lock_watchdog(
                &app.background_jobs,
                &context,
                "wegent:lock:managed_issue_scan",
                Duration::from_secs(120),
                async {
                    super::prepare_queued_assignments(&app).await?;
                    super::managed::prepare(&app).await?;
                    Ok(json!({"status":"ok"}))
                },
            )
            .await?
            .unwrap_or_else(
                || json!({"status":"skipped","reason":"lock_held_by_another_instance"}),
            ))
        }
    })?;
    registry.max_failures(SCAN, 1)?;
    registry.fixed_rate(SCAN, interval, false)?;
    registry.start_deadline(SCAN, interval)?;
    registry.register(EXECUTE, move |_, payload| {
        let app = app.clone();
        async move { project::managed::execute(&app, serde_json::from_value(payload)?).await }
    })?;
    Ok(())
}
