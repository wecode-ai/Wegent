// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! CPU admission is owned by the worker, including after its caller disconnects.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, OnceLock,
};
use std::time::Duration;

use tokio::sync::Semaphore;

use crate::local::app_ipc::AppIpcError;

#[derive(Clone)]
pub(super) struct Cancellation(Arc<AtomicBool>);

impl Cancellation {
    pub(super) fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub(super) fn check(&self) -> Result<(), AppIpcError> {
        if self.0.load(Ordering::Acquire) {
            Err(AppIpcError::new(
                "request_cancelled",
                "Transcript read was cancelled",
            ))
        } else {
            Ok(())
        }
    }
}

struct CancelOnDrop(Cancellation);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0 .0.store(true, Ordering::Release);
    }
}

fn workers() -> &'static Arc<Semaphore> {
    static WORKERS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    WORKERS.get_or_init(|| Arc::new(Semaphore::new(2)))
}

#[cfg(test)]
tokio::task_local! {
    static TEST_WORKERS: Arc<Semaphore>;
}

#[cfg(test)]
pub(super) async fn with_test_workers<T>(
    workers: Arc<Semaphore>,
    work: impl std::future::Future<Output = T>,
) -> T {
    TEST_WORKERS.scope(workers, work).await
}

pub(super) async fn run<T, F>(work: F) -> Result<T, AppIpcError>
where
    T: Send + 'static,
    F: FnOnce(&Cancellation) -> Result<T, AppIpcError> + Send + 'static,
{
    #[cfg(test)]
    if let Ok(workers) = TEST_WORKERS.try_with(Arc::clone) {
        return run_with_workers(workers, work).await;
    }
    run_with_workers(workers().clone(), work).await
}

async fn run_with_workers<T, F>(workers: Arc<Semaphore>, work: F) -> Result<T, AppIpcError>
where
    T: Send + 'static,
    F: FnOnce(&Cancellation) -> Result<T, AppIpcError> + Send + 'static,
{
    // Brief contention waits asynchronously; CPU concurrency and request deadlines stay bounded.
    let permit = match tokio::time::timeout(Duration::from_secs(1), workers.acquire_owned()).await {
        Ok(Ok(permit)) => permit,
        _ => {
            return Err(AppIpcError::new(
                "runtime_read_busy",
                "Transcript processing is busy; try again when the current read finishes",
            ));
        }
    };
    let cancellation = Cancellation::new();
    let _cancel = CancelOnDrop(cancellation.clone());
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        cancellation.check()?;
        work(&cancellation)
    })
    .await
    .map_err(|error| AppIpcError::new("transcript_processing_failed", error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[tokio::test(start_paused = true)]
    async fn brief_contention_waits_for_capacity_without_blocking_control_requests() {
        let workers = Arc::new(Semaphore::new(1));
        let held = workers.clone().acquire_owned().await.unwrap();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let read = tokio::spawn(async move {
            entered.send(()).unwrap();
            run_with_workers(workers, |_| Ok("read once")).await
        });
        entered_rx.await.unwrap();
        assert!(!read.is_finished());
        assert_eq!(tokio::spawn(async { "ready" }).await.unwrap(), "ready");
        drop(held);
        assert_eq!(read.await.unwrap().unwrap(), "read once");
    }

    #[tokio::test(start_paused = true)]
    async fn cancellation_while_waiting_does_not_consume_worker_capacity() {
        let workers = Arc::new(Semaphore::new(1));
        let held = workers.clone().acquire_owned().await.unwrap();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let queued_workers = workers.clone();
        let read = tokio::spawn(async move {
            entered.send(()).unwrap();
            run_with_workers(queued_workers, |_| Ok(())).await
        });
        entered_rx.await.unwrap();
        assert!(!read.is_finished());
        read.abort();
        assert!(read.await.unwrap_err().is_cancelled());
        drop(held);
        assert_eq!(workers.available_permits(), 1);
        assert!(run_with_workers(workers, |_| Ok(())).await.is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn prolonged_contention_still_returns_busy_without_admitting_more_work() {
        let workers = Arc::new(Semaphore::new(1));
        let _held = workers.clone().acquire_owned().await.unwrap();
        let started = tokio::time::Instant::now();
        let error = run_with_workers(workers.clone(), |_| Ok(()))
            .await
            .unwrap_err();
        assert_eq!(error.code, "runtime_read_busy");
        assert_eq!(started.elapsed(), Duration::from_secs(1));
        assert_eq!(workers.available_permits(), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn worker_keeps_control_requests_responsive_and_cancels_without_releasing_admission() {
        let workers = Arc::new(Semaphore::new(1));
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, release_rx) = mpsc::channel();
        let (cancelled, cancelled_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run_with_workers(workers.clone(), move |cancellation| {
            entered.send(()).unwrap();
            release_rx.recv().unwrap();
            let result = cancellation.check();
            cancelled
                .send(result.as_ref().err().map(|error| error.code.clone()))
                .unwrap();
            result
        }));
        entered_rx.await.unwrap();
        // The only Tokio worker can answer a control request while history is held.
        assert_eq!(tokio::spawn(async { "ready" }).await.unwrap(), "ready");
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let error = run_with_workers(workers.clone(), |_| Ok(()))
            .await
            .unwrap_err();
        assert_eq!(error.code, "runtime_read_busy");
        release.send(()).unwrap();
        assert_eq!(
            cancelled_rx.await.unwrap().as_deref(),
            Some("request_cancelled")
        );
        // Wait for the worker's final drop, rather than assuming send means exit.
        let permit = workers.clone().acquire_owned().await.unwrap();
        drop(permit);
        assert!(run_with_workers(workers, |_| Ok(())).await.is_ok());
    }
}
