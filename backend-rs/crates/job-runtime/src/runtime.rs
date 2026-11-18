//! One supervised scheduler/worker lifecycle for public and private handlers.

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use brz_schedule::{Scheduler, SchedulerOptions, Worker, WorkerOptions};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};

use super::{BackgroundJobRegistry, BackgroundJobsClient};

pub struct BackgroundJobsRuntime {
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<Result<()>>>,
    failure: mpsc::UnboundedReceiver<String>,
}

impl BackgroundJobsRuntime {
    pub async fn start(
        registry: BackgroundJobRegistry,
        client: &BackgroundJobsClient,
    ) -> Result<Self> {
        let config = &client.config;
        let (handlers, schedules, policies, startup) = registry.build(config)?;
        let (stop, _) = watch::channel(false);
        let (failure_tx, failure) = mpsc::unbounded_channel();
        let mut runtime = Self {
            stop,
            tasks: Vec::new(),
            failure,
        };
        if config.job_allowlist.is_empty() {
            return Ok(runtime);
        }
        let redis = wegent_backend_config::RedisConfig::from_env()?;
        let provider = Arc::new(
            brz_schedule_redis::RedisProvider::connect(brz_schedule_redis::RedisConfig {
                endpoint: redis.endpoint(),
                password: redis.password.clone(),
                namespace: "wegent:rs:schedule:v1".to_owned(),
                ..Default::default()
            })
            .await
            .context("failed to connect durable background-job provider")?,
        );
        let jobs: Arc<dyn brz_schedule::JobProvider> = provider.clone();
        let locks: Arc<dyn brz_schedule::LockProvider> =
            Arc::new(provider.locks(brz_schedule_redis::LockKeyPolicy::Raw));
        client.bind_providers(jobs.clone(), locks, policies)?;
        if config.scheduler_enabled {
            for (name, delay) in startup {
                let at = chrono::Utc::now() + chrono::Duration::from_std(delay)?;
                client
                    .submit(&name, serde_json::Value::Null, Some(at), None)
                    .await?;
            }
            let scheduler = Scheduler::new(
                jobs.clone(),
                SchedulerOptions {
                    allowed_kinds: Some(config.job_allowlist.clone()),
                    ..Default::default()
                },
            )?;
            for schedule in schedules {
                scheduler.register(schedule).await?;
            }
            let receiver = runtime.stop.subscribe();
            runtime.tasks.push(spawn(failure_tx.clone(), async move {
                run_provider_task(
                    || scheduler.run_until(stopped(receiver.clone())),
                    receiver.clone(),
                )
                .await
            }));
        }
        if config.worker_enabled {
            let worker = Worker::new(
                jobs,
                handlers,
                WorkerOptions {
                    name: format!("wegent-rs-{}", std::process::id()),
                    shutdown_grace: config.shutdown_grace,
                    ..Default::default()
                },
            )?;
            let receiver = runtime.stop.subscribe();
            runtime.tasks.push(spawn(failure_tx, async move {
                run_provider_task(
                    || worker.run_until(stopped(receiver.clone())),
                    receiver.clone(),
                )
                .await
            }));
        }
        tracing::info!(scheduler=config.scheduler_enabled, worker=config.worker_enabled,
            jobs=?config.job_allowlist, "Rust background job runtime started");
        Ok(runtime)
    }

    pub fn stop_sender(&self) -> watch::Sender<bool> {
        self.stop.clone()
    }

    pub async fn failed(&mut self) -> anyhow::Error {
        match self.failure.recv().await {
            Some(error) => anyhow::anyhow!("background job runtime stopped: {error}"),
            None => std::future::pending().await,
        }
    }

    pub async fn shutdown(mut self, grace: Duration) -> Result<()> {
        let _ = self.stop.send(true);
        let deadline = tokio::time::Instant::now() + grace + Duration::from_secs(1);
        let mut error = None;
        for mut task in self.tasks.drain(..) {
            match tokio::time::timeout_at(deadline, &mut task).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(failure))) => {
                    error.get_or_insert(failure);
                }
                Ok(Err(failure)) => {
                    error.get_or_insert(failure.into());
                }
                Err(_) => {
                    task.abort();
                    let _ = task.await;
                    error.get_or_insert_with(|| {
                        anyhow::anyhow!("background job shutdown timed out")
                    });
                }
            }
        }
        match error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl Drop for BackgroundJobsRuntime {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

async fn stopped(mut receiver: watch::Receiver<bool>) {
    let _ = receiver.wait_for(|stopped| *stopped).await;
}

fn spawn<F>(failure: mpsc::UnboundedSender<String>, future: F) -> JoinHandle<Result<()>>
where
    F: std::future::Future<Output = Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        let result = future.await;
        if let Err(error) = &result {
            let _ = failure.send(format!("{error:#}"));
        }
        result
    })
}

async fn run_provider_task<F, Fut>(mut run: F, stop: watch::Receiver<bool>) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = brz_schedule::Result<()>>,
{
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        match run().await {
            Err(brz_schedule::Error::Provider(error)) => {
                tracing::warn!(%error, "background job provider unavailable; runner will resume");
                tokio::select! {
                    () = stopped(stop.clone()) => return Ok(()),
                    () = tokio::time::sleep(Duration::from_secs(1)) => {}
                }
            }
            result => return result.map_err(Into::into),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BackgroundJobsConfig;

    fn disabled() -> BackgroundJobsConfig {
        BackgroundJobsConfig {
            scheduler_enabled: false,
            worker_enabled: false,
            job_allowlist: Default::default(),
            shutdown_grace: Duration::from_secs(1),
        }
    }

    #[tokio::test]
    async fn empty_allowlist_never_initializes_a_provider_or_spawns_tasks() {
        for enabled in [false, true] {
            let mut config = disabled();
            config.scheduler_enabled = enabled;
            config.worker_enabled = enabled;
            let client = BackgroundJobsClient::new(config);
            let runtime = BackgroundJobsRuntime::start(BackgroundJobRegistry::default(), &client)
                .await
                .unwrap();
            assert!(runtime.tasks.is_empty());
            assert!(client.providers.get().is_none());
            runtime.shutdown(Duration::from_secs(1)).await.unwrap();
        }
    }

    #[tokio::test]
    async fn unknown_allowed_kind_fails_even_when_both_runners_are_disabled() {
        let mut config = disabled();
        config.job_allowlist.insert("misspelled".to_owned());
        let client = BackgroundJobsClient::new(config);
        assert!(
            BackgroundJobsRuntime::start(BackgroundJobRegistry::default(), &client)
                .await
                .is_err()
        );
        assert!(client.providers.get().is_none());
    }
    #[tokio::test]
    async fn provider_outage_recovers_without_reporting_runtime_failure() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (stop, receiver) = watch::channel(false);
        let attempts = Arc::new(AtomicUsize::new(0));
        let ready = Arc::new(tokio::sync::Notify::new());
        let observed = ready.clone();
        let count = attempts.clone();
        let (failure, mut failures) = mpsc::unbounded_channel();
        let task = spawn(failure, async move {
            run_provider_task(
                || {
                    let receiver = receiver.clone();
                    let count = count.clone();
                    let ready = ready.clone();
                    async move {
                        if count.fetch_add(1, Ordering::SeqCst) == 0 {
                            return Err(brz_schedule::Error::Provider(
                                "session request timed out".into(),
                            ));
                        }
                        ready.notify_one();
                        stopped(receiver).await;
                        Ok(())
                    }
                },
                receiver.clone(),
            )
            .await
        });
        let result = tokio::select! {
            _ = observed.notified() => Ok(()),
            error = failures.recv() => Err(error),
        };
        let _ = stop.send(true);
        let outcome = task.await.unwrap();
        assert!(
            result.is_ok(),
            "a provider outage terminated the runtime: {result:?}"
        );
        outcome.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn configuration_failures_remain_fatal() {
        let (_stop, receiver) = watch::channel(false);
        let result = run_provider_task(
            || async { Err(brz_schedule::Error::Invalid("invalid registry".into())) },
            receiver,
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("invalid registry"));
    }
}
