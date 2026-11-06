//! One supervised scheduler/worker lifecycle for public and private handlers.

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use brz_schedule::{Scheduler, SchedulerOptions, Worker, WorkerOptions};
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
};

use super::{BackgroundJobRegistry, BackgroundJobsClient, client::Providers};

pub(crate) struct BackgroundJobsRuntime {
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
        let redis = crate::config::RedisConfig::from_env()?;
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
        client
            .providers
            .set(Providers {
                jobs: jobs.clone(),
                locks,
                policies,
            })
            .map_err(|_| anyhow::anyhow!("background-job providers were initialized twice"))?;
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
                scheduler.run_until(stopped(receiver)).await?;
                Ok(())
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
                worker.run_until(stopped(receiver)).await?;
                Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::background_jobs::config::BackgroundJobsConfig;

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
}
