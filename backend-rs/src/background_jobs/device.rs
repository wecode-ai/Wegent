//! Fail attempts assigned to devices whose authoritative heartbeat expired.

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use brz_mysql::MysqlRow;
use serde_json::{Value, json};

use super::{BackgroundJobRegistry, JobContext, with_lock_watchdog};
use crate::{AppState, task_store_maintenance::MaintenanceScan};

const JOB: &str = "device_heartbeat_monitor";

pub(super) fn register(registry: &mut BackgroundJobRegistry, state: Arc<AppState>) -> Result<()> {
    registry.register(JOB, move |context, _| {
        let state = state.clone();
        async move {
            Ok(with_lock_watchdog(
                &state.background_jobs,
                &context,
                "wegent:lock:device_heartbeat_monitor",
                Duration::from_secs(30),
                check_devices(&state, &context),
            )
            .await?
            .unwrap_or_else(|| json!({"skipped":"lock_busy"})))
        }
    })?;
    registry.max_failures(JOB, 1)?;
    registry.timeout(JOB, None)?;
    registry.startup(JOB, Duration::ZERO)?;
    registry.interval(JOB, Duration::from_secs(60), false)
}

#[derive(Debug, PartialEq, Eq)]
struct Candidate {
    id: i64,
    task_id: i64,
    message_id: i64,
    owner_id: i64,
    device_id: String,
}

impl Candidate {
    fn from_row(row: &MysqlRow) -> Result<Option<Self>> {
        let name = row.get::<String>("executor_name")?.unwrap_or_default();
        let namespace = row.get::<String>("executor_namespace")?.unwrap_or_default();
        let Some((owner_id, device_id)) = identity(&name, &namespace) else {
            return Ok(None);
        };
        Ok(Some(Self {
            id: row.get_required("id")?,
            task_id: row.get_required("task_id")?,
            message_id: row.get_required("message_id")?,
            owner_id,
            device_id,
        }))
    }
}

fn identity(executor: &str, namespace: &str) -> Option<(i64, String)> {
    let device_id = executor.strip_prefix("device-")?;
    let owner = namespace.strip_prefix("user-")?.parse().ok()?;
    Some((owner, device_id.to_owned()))
}

async fn check_devices(state: &AppState, context: &JobContext) -> Result<Value> {
    let rows = state
        .task_store
        .scan_maintenance_subtasks(&MaintenanceScan::RunningDevices)
        .await?;
    let mut failed = 0;
    for row in rows {
        if context.cancellation.is_cancelled() {
            anyhow::bail!("device heartbeat monitor cancelled");
        }
        let Some(candidate) = Candidate::from_row(&row)? else {
            continue;
        };
        let online = crate::device_online_state::read_online_state::<Value>(
            state,
            candidate.owner_id,
            &candidate.device_id,
        )
        .await
        .map_err(|_| anyhow::anyhow!("failed to read authoritative device online state"))?;
        if online.is_some() {
            continue;
        }
        let marked = state
            .task_store
            .mark_device_subtask_failed(
                candidate.task_id,
                candidate.id,
                candidate.owner_id,
                chrono::Local::now().naive_local(),
            )
            .await?;
        if marked {
            emit_timeout(state, &candidate).await?;
            failed += 1;
        }
    }
    Ok(json!({"failed":failed}))
}

async fn emit_timeout(state: &AppState, candidate: &Candidate) -> Result<()> {
    use crate::internal_callback::{
        completion, emitter,
        event::{EventType, ExecutionEvent},
    };
    let redis = state
        .redis
        .as_ref()
        .context("device timeout requires Redis event delivery")?;
    let tables = state.task_store.table_templates();
    let completion = completion::Completion {
        app: Some(state),
        mysql: &state.mysql,
        redis,
        tables: completion::Tables {
            tasks: tables.tasks,
            subtasks: tables.subtasks,
        },
        executor_manager: &state.executor_manager,
    };
    let mut event = ExecutionEvent::new(EventType::Error, candidate.task_id, candidate.id);
    event.message_id = Some(candidate.message_id);
    event.error = Some("Device connection lost".to_owned());
    event.status = "FAILED".to_owned();
    let (result, owner) = completion::complete_terminal(
        &completion,
        candidate.task_id,
        candidate.id,
        "FAILED",
        None,
        event.error.as_deref(),
        None,
        None,
        None,
    )
    .await;
    emitter::emit_done_frames(
        redis,
        &event,
        owner,
        &result.unwrap_or_else(|| json!({})),
        None,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_candidates_use_the_owner_namespace_without_accepting_cloud_executors() {
        assert_eq!(
            identity("device-desktop-1", "user-42"),
            Some((42, "desktop-1".to_owned()))
        );
        assert!(identity("executor-1", "user-42").is_none());
        assert!(identity("device-desktop-1", "default").is_none());
        assert!(identity("device-desktop-1", "user-broken").is_none());
    }
}
