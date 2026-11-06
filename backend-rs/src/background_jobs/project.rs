// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Durable project-automation workers and completion projections.

#[path = "project_completion.rs"]
pub(crate) mod completion;

#[path = "project_sources.rs"]
mod sources;

#[path = "project_store.rs"]
pub(crate) mod store;

#[path = "project_agents.rs"]
pub(crate) mod agents;
#[path = "project_authority.rs"]
pub(crate) mod authority;
#[path = "project_profile.rs"]
pub(crate) mod profile;
#[path = "project_queue.rs"]
pub(crate) mod queue;
#[path = "project_routing.rs"]
pub(crate) mod routing;
#[path = "project_runtime_rpc.rs"]
pub(crate) mod runtime_rpc;

#[path = "project_managed.rs"]
pub(crate) mod managed;

#[path = "project_assignments.rs"]
pub(crate) mod assignments;
#[path = "project_dispatch.rs"]
mod dispatch;
#[path = "project_due.rs"]
mod due;
#[path = "project_events.rs"]
mod events;
#[path = "project_groups.rs"]
pub(crate) mod groups;
#[path = "project_incoming.rs"]
mod incoming;
#[path = "project_issues.rs"]
pub(crate) mod issues;
#[cfg(test)]
#[path = "project_mysql_tests.rs"]
mod mysql_tests;
#[path = "project_notifications.rs"]
pub(crate) mod notifications;
#[path = "project_polling.rs"]
mod polling;

use super::registry::BackgroundJobRegistry;
use crate::state::AppState;
use anyhow::Result;
use std::sync::Arc;

pub(crate) fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
    let interval = crate::config::env_or_dotenv("FLOW_SCHEDULER_INTERVAL_SECONDS")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(60.0);
    for (kind, name) in [
        (
            0,
            "app.tasks.project_automation_tasks.check_due_project_automations",
        ),
        (
            1,
            "app.tasks.project_automation_tasks.check_pending_project_incoming_events",
        ),
        (
            2,
            "app.tasks.project_automation_tasks.check_due_project_event_subscriptions",
        ),
    ] {
        let state = Arc::clone(&state);
        registry.register(name, move |_, _| {
            let state = Arc::clone(&state);
            async move {
                let count = match kind {
                    0 => due::check(&state).await?,
                    1 => incoming::pending(&state).await?,
                    _ => polling::check(&state).await?,
                };
                Ok(serde_json::json!(count))
            }
        })?;
        registry.fixed_rate(name, std::time::Duration::from_secs_f64(interval), false)?;
    }
    let incoming_state = Arc::clone(&state);
    registry.register(
        "app.tasks.project_automation_tasks.process_project_incoming_event",
        move |_, payload| {
            let state = Arc::clone(&incoming_state);
            async move {
                let id = payload["event_id"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("event_id is required"))?;
                Ok(serde_json::json!(incoming::process(&state, id).await?))
            }
        },
    )?;
    registry.register(
        "app.tasks.project_automation_tasks.execute_managed_project_automation",
        move |_, payload| {
            let state = Arc::clone(&state);
            async move { managed::execute(&state, serde_json::from_value(payload)?).await }
        },
    )?;
    Ok(())
}
