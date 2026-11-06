//! Database-driven subscription scheduling and durable execution.

#[path = "code_wiki.rs"]
pub(crate) mod code_wiki;
#[path = "subscription_completion.rs"]
pub(crate) mod completion;
#[cfg(test)]
#[path = "subscription_completion_tests.rs"]
mod completion_tests;
#[path = "subscription_context.rs"]
mod context;
#[path = "subscription_delivery.rs"]
pub(crate) mod delivery;
#[path = "subscription_directives.rs"]
pub(crate) mod directives;
#[path = "subscription_execution.rs"]
mod execution;
#[path = "subscription_history.rs"]
mod history;
#[path = "subscription_model.rs"]
pub(crate) mod model;
#[cfg(test)]
#[path = "subscription_mysql_tests.rs"]
mod mysql_tests;
#[path = "subscription_schedule.rs"]
mod schedule;
#[path = "subscription_state.rs"]
pub(crate) mod state;

use super::BackgroundJobRegistry;
use crate::AppState;
use std::{sync::Arc, time::Duration};

pub(crate) const SCAN: &str = "app.tasks.subscription_tasks.check_due_subscriptions";
pub(crate) const EXECUTE: &str = "app.tasks.subscription_tasks.execute_subscription_task";
pub(crate) const CODE_WIKI: &str =
    "app.tasks.subscription_tasks.execute_code_wiki_scheduled_update";

pub(super) fn register(
    registry: &mut BackgroundJobRegistry,
    state: Arc<AppState>,
) -> anyhow::Result<()> {
    let scan_state = state.clone();
    registry.register(SCAN, move |ctx, _| {
        let state = scan_state.clone();
        async move { schedule::scan(state, ctx).await }
    })?;
    registry.max_failures(SCAN, 1)?;
    registry.fixed_rate(
        SCAN,
        Duration::from_secs(model::setting("FLOW_SCHEDULER_INTERVAL_SECONDS", 60)),
        false,
    )?;
    let execute_state = state.clone();
    registry.register_with_options(
        EXECUTE,
        super::HandlerOptions {
            timeout: Some(Duration::from_secs(
                model::setting("FLOW_DEFAULT_TIMEOUT_SECONDS", 600).saturating_add(60),
            )),
            retry_delay: Duration::from_secs(60),
            max_retry_delay: Duration::from_secs(600),
        },
        move |ctx, payload| {
            let state = execute_state.clone();
            async move {
                execution::execute(state, ctx, serde_json::from_value(payload)?)
                    .await
                    .map(super::Completion::Success)
            }
        },
    )?;
    registry.max_failures(
        EXECUTE,
        model::setting("FLOW_DEFAULT_RETRY_COUNT", 1) as u32 + 1,
    )?;
    registry.register(CODE_WIKI, move |ctx, payload| {
        let state = state.clone();
        async move { code_wiki::execute(state, ctx, serde_json::from_value(payload)?).await }
    })?;
    registry.max_failures(CODE_WIKI, 1)?;
    Ok(())
}
