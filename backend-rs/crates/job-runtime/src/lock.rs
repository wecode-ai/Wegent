//! Token-owned business leases with cooperative cancellation and renewal.

use std::{future::Future, time::Duration};

use anyhow::{Result, bail};
use brz_schedule::JobContext;

use super::{BackgroundJobsClient, client::random_id};

#[cfg(test)]
#[path = "lock_tests.rs"]
mod tests;

/// The key is complete and application-owned; this helper adds no prefix.
pub async fn with_lock_watchdog<T, F>(
    client: &BackgroundJobsClient,
    context: &JobContext,
    key: &str,
    lease_for: Duration,
    work: F,
) -> Result<Option<T>>
where
    F: Future<Output = Result<T>>,
{
    if lease_for < Duration::from_millis(30) {
        bail!("business lock lease must be at least 30ms");
    }
    if context.cancellation.is_cancelled() {
        bail!("background job cancelled");
    }
    let locks = client.locks()?;
    let milliseconds = u64::try_from(lease_for.as_millis())?;
    let Some(lease) = locks.try_acquire(key, &random_id()?, milliseconds).await? else {
        return Ok(None);
    };
    let mut renewal = tokio::time::interval(lease_for / 3);
    renewal.tick().await;
    tokio::pin!(work);
    let outcome = loop {
        tokio::select! {
            biased;
            () = context.cancellation.cancelled() => {
                break Err(anyhow::anyhow!("background job cancelled while holding {key}"));
            }
            _ = renewal.tick() => match locks.renew_lock(&lease, milliseconds).await {
                Ok(true) => {}
                Ok(false) => break Err(anyhow::anyhow!("business lock ownership lost: {key}")),
                Err(error) => break Err(error.into()),
            },
            result = &mut work => break result,
        }
    };
    // Release checks ownership, including when the work itself failed.
    let released = locks.release(&lease).await;
    match outcome {
        Err(error) => {
            if let Err(release_error) = released {
                tracing::warn!(key, %release_error, "failed to release business lock after job failure");
            }
            Err(error)
        }
        Ok(value) => {
            if !released? {
                bail!("business lock ownership lost before release: {key}");
            }
            Ok(Some(value))
        }
    }
}
