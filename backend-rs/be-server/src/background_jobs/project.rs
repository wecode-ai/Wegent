// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Durable project-automation workers and completion projections.

#[path = "project_completion.rs"]
pub(crate) mod completion;

pub(crate) use wegent_project_coordination::project_store as store;

#[path = "project_agents.rs"]
pub(crate) mod agents;
pub(crate) use wegent_project_coordination::project_authority as authority;
pub(crate) use wegent_project_coordination::project_device_access as device_access;
pub(crate) use wegent_project_coordination::project_profile as profile;
#[path = "project_queue.rs"]
pub(crate) mod queue;
#[path = "project_routing.rs"]
pub(crate) mod routing;
use wegent_project_coordination::project_routing_diagnostics as routing_diagnostics;
pub(crate) use wegent_project_coordination::project_runner_recovery as runner_recovery;
#[path = "project_runtime_rpc.rs"]
pub(crate) mod runtime_rpc;

#[path = "project_managed.rs"]
pub(crate) mod managed;

#[path = "project_assignments.rs"]
pub(crate) mod assignments;
#[path = "project_groups.rs"]
pub(crate) mod groups;
pub(crate) use wegent_project_coordination::project_issues as issues;
#[cfg(test)]
#[path = "project_mysql_tests.rs"]
mod mysql_tests;
#[path = "project_notifications.rs"]
pub(crate) mod notifications;
use super::BackgroundJobRegistry;
use crate::state::AppState;
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use wegent_project_polling::{PendingEvents, PollingState};
use wegent_project_scheduler::{
    self as scheduler, AssignmentTarget, AutomationHost, DispatchStatus, Scheduler,
};

impl AppState {
    pub(crate) fn project_issues(&self) -> issues::IssueStore<'_> {
        issues::IssueStore {
            mysql: &self.mysql,
            credential_key: &self.auth.jwt_key,
        }
    }
}

struct AutomationGateway<'a>(&'a AppState);

impl AutomationGateway<'_> {
    fn scheduler(&self) -> Scheduler<'_> {
        Scheduler {
            mysql: &self.0.mysql,
            credential_key: &self.0.auth.jwt_key,
            host: self,
        }
    }
}

#[async_trait::async_trait]
impl AutomationHost for AutomationGateway<'_> {
    async fn assign(
        &self,
        project: &store::Node,
        rule: &store::Node,
        run: &store::Node,
        target: AssignmentTarget,
        context: Value,
        instructions: &str,
    ) -> Result<()> {
        assignments::assign(self.0, project, rule, run, target, context, instructions).await
    }

    async fn assign_group(
        &self,
        project: &store::Node,
        rule: &store::Node,
        run: &store::Node,
        group_id: &str,
        context: Value,
    ) -> Result<()> {
        groups::assign(self.0, project, rule, run, group_id, context).await
    }

    async fn finish_dispatch(&self, run_id: &str, status: DispatchStatus<'_>) -> Result<()> {
        let mysql = &self.0.mysql;
        match (self.0.redis.as_ref(), status) {
            (Some(redis), DispatchStatus::Failed(error)) => {
                completion::dispatch_failed(mysql, redis, run_id, error).await?;
            }
            (Some(redis), DispatchStatus::Skipped(note)) => {
                completion::dispatch_skipped(mysql, redis, run_id, note).await?;
            }
            (None, DispatchStatus::Failed(error)) => {
                let description: String = error.chars().take(2000).collect();
                mysql.execute("UPDATE loop_items SET status='failed',description=?,version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status NOT IN ('succeeded','failed','cancelled','skipped')",(description,run_id)).await?;
            }
            (None, DispatchStatus::Skipped(note)) => {
                mysql.execute("UPDATE loop_items SET status='skipped',description=?,completed_at=UTC_TIMESTAMP(6),version=version+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND status IN ('pending','queued')",(note,run_id)).await?;
            }
        }
        Ok(())
    }

    async fn continue_task(
        &self,
        binding: &store::Node,
        prompt: &str,
        selection: Option<&Value>,
    ) -> Result<()> {
        runtime_rpc::continue_task(self.0, binding, prompt, selection).await
    }

    async fn wake_robot(&self) -> Result<()> {
        super::robot::prepare_and_wake(self.0).await
    }
}

#[async_trait::async_trait]
impl PendingEvents for AutomationGateway<'_> {
    async fn process_pending(&self) -> Result<usize> {
        scheduler::pending(&self.scheduler()).await
    }
}

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
                    0 => scheduler::check(&AutomationGateway(&state).scheduler()).await?,
                    1 => AutomationGateway(&state).process_pending().await?,
                    _ => {
                        wegent_project_polling::check(&PollingState {
                            mysql: &state.mysql,
                            http: &state.decision_http,
                            credential_key: &state.auth.jwt_key,
                            pending_events: &AutomationGateway(&state),
                        })
                        .await?
                    }
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
                Ok(serde_json::json!(
                    scheduler::process(&AutomationGateway(&state).scheduler(), id).await?
                ))
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
