//! Handler registration after application-specific dependencies are selected.

use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc, time::Duration};

use anyhow::{Result, bail};
use brz_schedule::{Completion, HandlerOptions, Job, JobContext, Schedule, Trigger};
use serde_json::Value;

use super::config::BackgroundJobsConfig;
type BuiltRegistry = (
    brz_schedule::Registry,
    Vec<Schedule>,
    BTreeMap<String, u32>,
    Vec<(String, Duration)>,
);

type JobFuture = Pin<Box<dyn Future<Output = Result<Completion>> + Send>>;
type Handler = Arc<dyn Fn(JobContext, Value) -> JobFuture + Send + Sync>;

struct RegisteredJob {
    handler: Handler,
    options: HandlerOptions,
    max_failures: u32,
}

#[derive(Default)]
pub struct BackgroundJobRegistry {
    handlers: BTreeMap<String, RegisteredJob>,
    schedules: Vec<Schedule>,
    startup: Vec<(String, Duration)>,
}

impl BackgroundJobRegistry {
    pub fn register<F, Fut>(&mut self, name: &str, handler: F) -> Result<()>
    where
        F: Fn(JobContext, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value>> + Send + 'static,
    {
        self.register_outcome(name, move |context, payload| {
            let future = handler(context, payload);
            async move { future.await.map(Completion::Success) }
        })
    }

    pub fn register_outcome<F, Fut>(&mut self, name: &str, handler: F) -> Result<()>
    where
        F: Fn(JobContext, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Completion>> + Send + 'static,
    {
        let seconds = crate::config::env_or_dotenv("FLOW_DEFAULT_TIMEOUT_SECONDS")
            .map(|value| value.parse::<u64>())
            .transpose()?
            .unwrap_or(600)
            .checked_add(60)
            .ok_or_else(|| anyhow::anyhow!("FLOW_DEFAULT_TIMEOUT_SECONDS overflow"))?;
        self.register_with_options(
            name,
            HandlerOptions {
                timeout: Some(Duration::from_secs(seconds)),
                ..Default::default()
            },
            handler,
        )
    }

    pub fn register_with_options<F, Fut>(
        &mut self,
        name: &str,
        options: HandlerOptions,
        handler: F,
    ) -> Result<()>
    where
        F: Fn(JobContext, Value) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Completion>> + Send + 'static,
    {
        if name.is_empty() || self.handlers.contains_key(name) {
            bail!("background job name is empty or duplicated: {name}");
        }
        self.handlers.insert(
            name.to_owned(),
            RegisteredJob {
                handler: Arc::new(move |context, payload| Box::pin(handler(context, payload))),
                options,
                max_failures: 3,
            },
        );
        Ok(())
    }

    /// Total failed attempts, including the first attempt (Python retries + 1).
    pub fn max_failures(&mut self, name: &str, count: u32) -> Result<()> {
        if count == 0 {
            bail!("background job max_failures must be positive");
        }
        let entry = self
            .handlers
            .get_mut(name)
            .ok_or_else(|| anyhow::anyhow!("background job is not registered: {name}"))?;
        entry.max_failures = count;
        Ok(())
    }

    /// None preserves resident maintenance without an artificial whole-scan cap.
    pub fn timeout(&mut self, name: &str, timeout: Option<Duration>) -> Result<()> {
        if timeout.is_some_and(|timeout| timeout.is_zero()) {
            bail!("job timeout must be positive");
        }
        self.handlers
            .get_mut(name)
            .ok_or_else(|| anyhow::anyhow!("background job is not registered: {name}"))?
            .options
            .timeout = timeout;
        Ok(())
    }

    pub fn start_deadline(&mut self, name: &str, after: Duration) -> Result<()> {
        if after.is_zero() {
            bail!("schedule start deadline must be positive");
        }
        self.schedules
            .iter_mut()
            .find(|schedule| schedule.id == name)
            .ok_or_else(|| anyhow::anyhow!("background schedule is not registered: {name}"))?
            .start_deadline_after_ms = Some(u64::try_from(after.as_millis())?);
        Ok(())
    }

    pub fn interval(&mut self, name: &str, every: Duration, run_on_start: bool) -> Result<()> {
        self.interval_after(
            name,
            every,
            if run_on_start { Duration::ZERO } else { every },
        )
    }

    pub fn interval_after(
        &mut self,
        name: &str,
        every: Duration,
        initial_delay: Duration,
    ) -> Result<()> {
        let milliseconds = u64::try_from(every.as_millis())?;
        let first = brz_schedule::now_ms()
            .checked_add(i64::try_from(initial_delay.as_millis())?)
            .ok_or_else(|| anyhow::anyhow!("schedule initial delay overflow"))?;
        self.schedule(
            name,
            Trigger::FixedDelay {
                delay_ms: milliseconds,
            },
            first,
        )
    }

    pub fn fixed_rate(&mut self, name: &str, every: Duration, run_on_start: bool) -> Result<()> {
        let milliseconds = u64::try_from(every.as_millis())?;
        let first = brz_schedule::now_ms()
            + if run_on_start {
                0
            } else {
                i64::try_from(milliseconds)?
            };
        self.schedule(
            name,
            Trigger::FixedRate {
                interval_ms: milliseconds,
            },
            first,
        )
    }

    pub fn cron(&mut self, name: &str, expression: &str, timezone: &str) -> Result<()> {
        let trigger = Trigger::Cron {
            expression: expression.to_owned(),
            timezone: timezone.to_owned(),
            day_match: brz_schedule::DayMatch::And,
        };
        let first = trigger
            .next_after(brz_schedule::now_ms())?
            .ok_or_else(|| anyhow::anyhow!("cron has no next occurrence: {name}"))?;
        self.schedule(name, trigger, first)
    }

    pub fn once(&mut self, name: &str, run_at: chrono::DateTime<chrono::Utc>) -> Result<()> {
        self.schedule(name, Trigger::Once, run_at.timestamp_millis())
    }

    /// One durable submission per process start, rather than a persistent cron cursor.
    pub fn startup(&mut self, name: &str, after: Duration) -> Result<()> {
        if !self.handlers.contains_key(name) {
            bail!("startup job is not registered: {name}");
        }
        self.startup.push((name.to_owned(), after));
        Ok(())
    }

    fn schedule(&mut self, name: &str, trigger: Trigger, first_run_at_ms: i64) -> Result<()> {
        if !self.handlers.contains_key(name) {
            bail!("cannot schedule an unregistered background job: {name}");
        }
        if self.schedules.iter().any(|schedule| schedule.id == name) {
            bail!("background schedule is duplicated: {name}");
        }
        let job = Job::new(name, name, Value::Null)?;
        let mut schedule = Schedule::new(name, trigger, job, first_run_at_ms)?;
        schedule.overlap = brz_schedule::OverlapPolicy::Skip;
        schedule.misfire = brz_schedule::MisfirePolicy::FireOnce;
        self.schedules.push(schedule);
        Ok(())
    }

    pub(super) fn build(self, config: &BackgroundJobsConfig) -> Result<BuiltRegistry> {
        config.validate_registered(self.handlers.keys().map(String::as_str))?;
        let mut registry = brz_schedule::Registry::default();
        let mut policies = BTreeMap::new();
        for (name, entry) in self.handlers {
            if !config.allows(&name) {
                continue;
            }
            policies.insert(name.clone(), entry.max_failures);
            registry.register_with(name, entry.options, move |context, payload| {
                let future = (entry.handler)(context, payload);
                async move {
                    future
                        .await
                        .map_err(|error| brz_schedule::Error::Worker(format!("{error:#}")))
                }
            })?;
        }
        let schedules = self
            .schedules
            .into_iter()
            .filter(|schedule| config.allows(&schedule.job.kind))
            .map(|mut schedule| {
                schedule.job.max_failures = policies[&schedule.job.kind];
                schedule
            })
            .collect();
        let startup = self
            .startup
            .into_iter()
            .filter(|(name, _)| config.allows(name))
            .collect();
        Ok((registry, schedules, policies, startup))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_schedule::{JobProvider, JobStatus, Worker, WorkerOptions, memory::MemoryProvider};

    #[tokio::test]
    async fn allowlist_limits_schedules_startup_and_worker_claims() {
        let mut registry = BackgroundJobRegistry::default();
        for name in ["allowed", "outside_range"] {
            registry
                .register(name, |_, _| async { Ok(Value::Null) })
                .unwrap();
            registry
                .fixed_rate(name, Duration::from_secs(5), false)
                .unwrap();
            registry.startup(name, Duration::ZERO).unwrap();
        }
        let config = BackgroundJobsConfig {
            scheduler_enabled: true,
            worker_enabled: true,
            job_allowlist: ["allowed".to_owned()].into_iter().collect(),
            shutdown_grace: Duration::from_secs(1),
        };
        let (handlers, schedules, policies, startup) = registry.build(&config).unwrap();
        assert_eq!(schedules.len(), 1);
        assert_eq!(schedules[0].job.kind, "allowed");
        assert_eq!(startup, [("allowed".to_owned(), Duration::ZERO)]);
        assert_eq!(policies.len(), 1);
        assert!(policies.contains_key("allowed"));

        let provider = Arc::new(MemoryProvider::new(10).unwrap());
        for name in ["allowed", "outside_range"] {
            provider
                .submit(Job::new(name, name, Value::Null).unwrap())
                .await
                .unwrap();
        }
        let worker = Worker::new(provider.clone(), handlers, WorkerOptions::default()).unwrap();
        assert_eq!(worker.run_once().await.unwrap(), 1);
        assert_eq!(
            provider.get("allowed").await.unwrap().unwrap().status,
            JobStatus::Succeeded
        );
        assert_eq!(
            provider.get("outside_range").await.unwrap().unwrap().status,
            JobStatus::Queued
        );
    }

    #[test]
    fn rejects_duplicate_handlers_and_schedules_without_handlers() {
        let mut registry = BackgroundJobRegistry::default();
        registry
            .register("one", |_, _| async { Ok(Value::Null) })
            .unwrap();
        assert!(
            registry
                .register("one", |_, _| async { Ok(Value::Null) })
                .is_err()
        );
        assert!(
            registry
                .interval("missing", Duration::from_secs(5), true)
                .is_err()
        );
        assert!(registry.interval("one", Duration::ZERO, true).is_err());
    }
}
