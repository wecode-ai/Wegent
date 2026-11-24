// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Gateway workers for reconnect and heartbeat execution reconciliation.

use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::sync::mpsc;
use wegent_runtime_execution::device_reconcile::{ReconcileServices, reconcile_after_register};

use super::{
    runtime::SocketRuntime,
    runtime_projection::{self, ProjectActivities},
};
use crate::state::AppState;

pub use wegent_runtime_execution::device_reconcile::ReconcileJob;
pub(super) use wegent_runtime_execution::device_reconcile::apply_snapshot;

/// Startup-owned reconcile workers; several jobs run independently, like the
/// source's per-registration `asyncio` tasks.
pub(crate) const RECONCILE_WORKER_COUNT: usize = 4;

/// Takes the next job, holding the receiver lock only for the receive.
///
/// The caller processes the job after this returns, so another worker can take
/// the next one while a slow `runtime.tasks.list` RPC is in flight.
pub(super) async fn next_job(
    jobs: &Arc<tokio::sync::Mutex<mpsc::Receiver<ReconcileJob>>>,
) -> Option<ReconcileJob> {
    let mut jobs = jobs.lock().await;
    jobs.recv().await
}

/// The reconcile worker. Runs until the queue closes or the service stops.
pub(crate) async fn run_worker(
    jobs: Arc<tokio::sync::Mutex<mpsc::Receiver<ReconcileJob>>>,
    state: Arc<AppState>,
    runtime: Weak<SocketRuntime>,
) {
    loop {
        let job = tokio::select! {
            job = next_job(&jobs) => job,
            () = tokio::time::sleep(Duration::from_secs(1)) => {
                if state.shutdown.is_shutting_down() {
                    return;
                }
                continue;
            }
        };
        let Some(job) = job else {
            return;
        };
        if state.shutdown.is_shutting_down() {
            return;
        }
        let Some(runtime) = runtime.upgrade() else {
            return;
        };
        reconcile_after_register(
            &ReconcileServices {
                mysql: &state.mysql,
                transport: crate::runtime_work::transport(&state),
            },
            &ProjectActivities,
            job.user_id,
            &job.device_id,
            job.needs_confirmation_only,
            |effects| {
                super::runtime_projection_metrics::record_row(
                    effects.matched.as_ref(),
                    Some(effects.detail.as_str()),
                );
                runtime_projection::deliver(effects, &state, &runtime)
            },
        )
        .await;
    }
}

#[cfg(test)]
pub(crate) async fn verify_reconnect_projection(
    mysql: &brz_mysql::MysqlService,
) -> anyhow::Result<()> {
    wegent_runtime_execution::device_reconcile::verify_reconnect_projection(
        mysql,
        &ProjectActivities,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Mutex;
    #[tokio::test]
    async fn a_slow_first_job_does_not_block_the_second_worker() {
        let (sender, receiver) = mpsc::channel(4);
        let receiver = Arc::new(Mutex::new(receiver));
        sender
            .send(ReconcileJob {
                user_id: 1,
                device_id: "device-a".into(),
                needs_confirmation_only: false,
            })
            .await
            .expect("queue the first job");
        sender
            .send(ReconcileJob {
                user_id: 2,
                device_id: "device-b".into(),
                needs_confirmation_only: true,
            })
            .await
            .expect("queue the second job");
        // The first worker takes its job and parks on a slow RPC; the receive
        // lock is released before processing, so the second worker still
        // reads its own job immediately.
        let first = next_job(&receiver).await.expect("the first job");
        let second = tokio::time::timeout(Duration::from_millis(200), next_job(&receiver))
            .await
            .expect("the second job is not queued behind the first")
            .expect("the second job");
        assert_eq!(first.device_id, "device-a");
        assert!(!first.needs_confirmation_only);
        assert_eq!(second.device_id, "device-b");
        assert!(second.needs_confirmation_only);
    }
}
