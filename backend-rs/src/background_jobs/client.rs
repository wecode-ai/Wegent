//! Application-owned durable task submission and distributed-lock access.

use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result, bail};
use brz_schedule::{Job, JobProvider, LockProvider, SubmitResult};
use chrono::{DateTime, Utc};
use serde::Serialize;

use super::config::BackgroundJobsConfig;

pub(super) struct Providers {
    pub jobs: Arc<dyn JobProvider>,
    pub locks: Arc<dyn LockProvider>,
    pub policies: std::collections::BTreeMap<String, u32>,
}

#[derive(Clone)]
pub struct BackgroundJobsClient {
    pub(super) config: Arc<BackgroundJobsConfig>,
    pub(super) providers: Arc<OnceLock<Providers>>,
}

impl BackgroundJobsClient {
    pub fn from_env() -> Result<Self> {
        Ok(Self::new(BackgroundJobsConfig::from_env()?))
    }

    pub fn new(config: BackgroundJobsConfig) -> Self {
        Self {
            config: Arc::new(config),
            providers: Arc::new(OnceLock::new()),
        }
    }

    /// The allowlist limits Rust submission without changing Python consumers.
    pub fn is_enabled(&self, name: &str) -> bool {
        self.config.allows(name)
    }

    pub fn configuration(&self) -> &BackgroundJobsConfig {
        &self.config
    }

    pub fn locks(&self) -> Result<Arc<dyn LockProvider>> {
        Ok(self
            .providers
            .get()
            .context("background job providers have not started")?
            .locks
            .clone())
    }

    pub async fn submit<T: Serialize>(
        &self,
        name: &str,
        payload: T,
        run_at: Option<DateTime<Utc>>,
        deduplication_key: Option<String>,
    ) -> Result<SubmitResult> {
        self.submit_with_deadline(name, payload, run_at, deduplication_key, None)
            .await
    }

    pub async fn snapshot(
        &self,
        name: &str,
        deduplication_key: &str,
    ) -> Result<Option<brz_schedule::JobRecord>> {
        if !self.is_enabled(name) {
            bail!("background job is not allowed by this Rust deployment: {name}");
        }
        let providers = self
            .providers
            .get()
            .context("background job providers have not started")?;
        Ok(providers
            .jobs
            .get(&format!("{name}:{deduplication_key}"))
            .await?)
    }

    pub async fn submit_with_deadline<T: Serialize>(
        &self,
        name: &str,
        payload: T,
        run_at: Option<DateTime<Utc>>,
        deduplication_key: Option<String>,
        expires_at: Option<DateTime<Utc>>,
    ) -> Result<SubmitResult> {
        if !self.is_enabled(name) {
            bail!("background job is not allowed by this Rust deployment: {name}");
        }
        let providers = self
            .providers
            .get()
            .context("background job providers have not started")?;
        let key = match deduplication_key {
            Some(key) => key,
            None => random_id()?,
        };
        let mut job = Job::new(format!("{name}:{key}"), name, payload)?;
        job.expires_at_ms = expires_at.map(|at| at.timestamp_millis());
        job.max_failures = *providers
            .policies
            .get(name)
            .context("allowed background job has no registered failure policy")?;
        if let Some(at) = run_at {
            job.run_at_ms = at.timestamp_millis();
        }
        Ok(providers.jobs.submit(job).await?)
    }
}

pub(super) fn random_id() -> Result<String> {
    let mut bytes = [0; 16];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| anyhow::anyhow!("job identity generation failed: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
