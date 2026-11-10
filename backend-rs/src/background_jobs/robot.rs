//! Repair durable Robot execution state and wake Executor-owned pull consumers.

#[path = "robot_activity.rs"]
mod activity;
#[path = "robot_admission.rs"]
mod admission;
#[path = "robot_authority.rs"]
pub(crate) mod authority;
#[path = "robot_model.rs"]
pub(crate) mod model;
#[path = "robot_projection.rs"]
mod projection;
#[path = "robot_state.rs"]
mod state;
#[path = "robot_wake.rs"]
mod wake;

#[cfg(test)]
pub(crate) use activity::tests::verify_issue_activity_projection;

pub(crate) use activity::{
    finish as finish_runtime_activity, project_runtime_completion, start_runtime_activity,
};
pub(crate) use state::fail_preparation;

use super::{BackgroundJobRegistry, JobContext, with_lock_watchdog};
use crate::AppState;
use anyhow::Result;
use brz_mysql::FromMysqlRow;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

const JOB: &str = "app.tasks.robot_queue_tasks.scan_robot_queue";

/// Validate a recorded coordinator command without granting or dispatching work.
pub(crate) async fn coordination_context(
    app: &AppState,
    project: &str,
    scope: &str,
    actor: i64,
) -> Result<Option<Value>> {
    let row: Option<model::Execution> = app
        .mysql
        .fetch_optional(
            // Retries preserve the command scope after Runtime confirms the preceding attempt ended.
            format!("SELECT {} FROM loop_item_executions WHERE cloud_project_id=? AND execution_scope=? ORDER BY id DESC LIMIT 1", model::COLUMNS),
            (project, scope),
        )
        .await?;
    let Some(row) = row else { return Ok(None) };
    if row.assigner_user_id != actor
        || matches!(
            row.status.as_str(),
            "cancel_requested" | "cancelled" | "failed"
        )
        || !authority::authorized(app, &row).await?
    {
        return Ok(None);
    }
    Ok(row.context().get("project_coordination").cloned())
}

/// Resolve pending queue assignments before selecting a runnable execution.
pub(crate) async fn prepare_queued_assignments(app: &AppState) -> Result<()> {
    admission::prepare(app).await?;
    Ok(())
}

pub(crate) async fn prepare_and_wake(app: &AppState) -> Result<()> {
    prepare_queued_assignments(app).await?;
    wake::notify(app).await?;
    Ok(())
}
static REQUEUED: AtomicU64 = AtomicU64::new(0);
static UNKNOWN: AtomicU64 = AtomicU64::new(0);
static DEPTH: AtomicU64 = AtomicU64::new(0);
static RUNNING: AtomicU64 = AtomicU64::new(0);

pub(super) fn register(registry: &mut BackgroundJobRegistry, app: Arc<AppState>) -> Result<()> {
    let interval = crate::config::env_or_dotenv("ROBOT_QUEUE_SCAN_INTERVAL_SECONDS")
        .map(|value| value.parse::<f64>())
        .transpose()?
        .unwrap_or(5.0);
    if !interval.is_finite() || interval <= 0.0 {
        anyhow::bail!("ROBOT_QUEUE_SCAN_INTERVAL_SECONDS must be finite and positive");
    }
    registry.register(JOB, move |context, _| {
        let app = app.clone();
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
                "wegent:lock:scan_robot_queue",
                Duration::from_secs(120),
                scan(&app, &context),
            )
            .await?
            .unwrap_or(json!({"status":"skipped","reason":"lock_held_by_another_instance"})))
        }
    })?;
    registry.max_failures(JOB, 1)?;
    registry.fixed_rate(JOB, Duration::from_secs_f64(interval), false)?;
    registry.start_deadline(JOB, Duration::from_secs_f64(interval))
}

async fn scan(app: &AppState, context: &JobContext) -> Result<Value> {
    let revoked = authority::sweep(app).await?;
    wake::cancels(app, &revoked).await;
    if context.cancellation.is_cancelled() {
        anyhow::bail!("Robot queue scan cancelled");
    }
    let (requeued, unknown) = state::recover(app).await?;
    REQUEUED.fetch_add(requeued as u64, Ordering::Relaxed);
    UNKNOWN.fetch_add(unknown as u64, Ordering::Relaxed);
    let stalled = state::stalled(app).await?;
    wake::cancels(app, &stalled).await;
    admission::prepare(app).await?;
    #[derive(FromMysqlRow)]
    struct Count {
        queued: u64,
        running: u64,
    }
    let counts:Count=app.mysql.fetch_one("SELECT COALESCE(SUM(status='queued'),0) AS queued,COALESCE(SUM(status='running'),0) AS running FROM loop_item_executions",()).await?;
    DEPTH.store(counts.queued, Ordering::Relaxed);
    RUNNING.store(counts.running, Ordering::Relaxed);
    wake::notify(app).await?;
    Ok(
        json!({"status":"ok","requeued":requeued,"unknown":unknown,"reconciled":0,"stalled":stalled.len()}),
    )
}

pub(crate) fn prometheus() -> String {
    format!(
        "# HELP robot_queue_recovered_total Robot queue runs recovered by lease expiry\n# TYPE robot_queue_recovered_total counter\nrobot_queue_recovered_total{{action=\"requeued\"}} {}\nrobot_queue_recovered_total{{action=\"unknown\"}} {}\n# HELP robot_queue_depth Number of queued robot runs\n# TYPE robot_queue_depth gauge\nrobot_queue_depth {}\n# HELP robot_queue_running Number of running robot runs\n# TYPE robot_queue_running gauge\nrobot_queue_running {}\n",
        REQUEUED.load(Ordering::Relaxed),
        UNKNOWN.load(Ordering::Relaxed),
        DEPTH.load(Ordering::Relaxed),
        RUNNING.load(Ordering::Relaxed)
    )
}
