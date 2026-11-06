use super::*;
use crate::background_jobs::{
    BackgroundJobRegistry, client::Providers, config::BackgroundJobsConfig,
};
use async_trait::async_trait;
use brz_schedule::{
    Job, JobProvider, JobStatus, Lease, LockProvider, Worker, WorkerOptions, memory::MemoryProvider,
};
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};

struct Locks {
    busy: bool,
    renewal_error: bool,
    renewals: AtomicUsize,
    releases: AtomicUsize,
}

#[async_trait]
impl LockProvider for Locks {
    async fn try_acquire(
        &self,
        key: &str,
        token: &str,
        lease_ms: u64,
    ) -> brz_schedule::Result<Option<Lease>> {
        assert_eq!(key, "python:business:lock");
        assert!(!token.is_empty());
        Ok((!self.busy).then(|| Lease {
            key: key.to_owned(),
            token: token.to_owned(),
            expires_at_ms: brz_schedule::now_ms() + lease_ms as i64,
        }))
    }

    async fn renew_lock(&self, _: &Lease, _: u64) -> brz_schedule::Result<bool> {
        self.renewals.fetch_add(1, Ordering::Relaxed);
        if self.renewal_error {
            Err(brz_schedule::Error::Provider(
                "Redis unavailable".to_owned(),
            ))
        } else {
            Ok(false)
        }
    }

    async fn release(&self, _: &Lease) -> brz_schedule::Result<bool> {
        self.releases.fetch_add(1, Ordering::Relaxed);
        Ok(false)
    }
}

struct DropFlag(Arc<AtomicBool>);
impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

async fn execute(
    busy: bool,
    renewal_error: bool,
) -> (brz_schedule::JobRecord, Arc<Locks>, bool, bool) {
    let provider = Arc::new(MemoryProvider::new(10).unwrap());
    let locks = Arc::new(Locks {
        busy,
        renewal_error,
        renewals: AtomicUsize::new(0),
        releases: AtomicUsize::new(0),
    });
    let config = BackgroundJobsConfig {
        scheduler_enabled: false,
        worker_enabled: true,
        job_allowlist: ["test".to_owned()].into(),
        shutdown_grace: Duration::from_secs(1),
    };
    let client = BackgroundJobsClient::new(config.clone());
    client
        .providers
        .set(Providers {
            jobs: provider.clone(),
            locks: locks.clone(),
            policies: Default::default(),
        })
        .ok()
        .unwrap();
    let polled = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    let (observed_polled, observed_dropped) = (polled.clone(), dropped.clone());
    let mut registry = BackgroundJobRegistry::default();
    registry
        .register("test", move |context, _| {
            let (client, polled, dropped) = (client.clone(), polled.clone(), dropped.clone());
            async move {
                with_lock_watchdog(
                    &client,
                    &context,
                    "python:business:lock",
                    Duration::from_millis(30),
                    async move {
                        let _drop = DropFlag(dropped);
                        polled.store(true, Ordering::Relaxed);
                        std::future::pending::<()>().await;
                        Ok(Value::Null)
                    },
                )
                .await?;
                Ok(Value::Null)
            }
        })
        .unwrap();
    let (handlers, _, _, _) = registry.build(&config).unwrap();
    let mut job = Job::new("one", "test", Value::Null).unwrap();
    job.max_failures = 1;
    provider.submit(job).await.unwrap();
    let worker = Worker::new(provider.clone(), handlers, WorkerOptions::default()).unwrap();
    tokio::time::timeout(Duration::from_secs(2), worker.run_once())
        .await
        .unwrap()
        .unwrap();
    let record = provider.get("one").await.unwrap().unwrap();
    (
        record,
        locks,
        observed_polled.load(Ordering::Relaxed),
        observed_dropped.load(Ordering::Relaxed),
    )
}

#[tokio::test]
async fn busy_lock_never_polls_business_effects() {
    let (record, locks, polled, _) = execute(true, false).await;
    assert_eq!(record.status, JobStatus::Succeeded);
    assert!(!polled);
    assert_eq!(locks.renewals.load(Ordering::Relaxed), 0);
    assert_eq!(locks.releases.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn lease_loss_drops_the_work_future_and_fails_the_job() {
    let (record, locks, polled, dropped) = execute(false, false).await;
    assert_eq!(record.status, JobStatus::Failed);
    assert!(record.last_error.unwrap().contains("ownership lost"));
    assert!(polled && dropped);
    assert_eq!(locks.renewals.load(Ordering::Relaxed), 1);
    assert_eq!(locks.releases.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn renewal_transport_failure_does_not_report_success() {
    let (record, _, polled, dropped) = execute(false, true).await;
    assert_eq!(record.status, JobStatus::Failed);
    assert!(record.last_error.unwrap().contains("Redis unavailable"));
    assert!(polled && dropped);
}
