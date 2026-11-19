//! Bounded retries for plugin metadata and local materialization receipts.
use super::coordination_error;
use brz_mysql::{MysqlError, MysqlResult};
use std::{future::Future, time::Duration};
use tokio::time::Instant;

pub(in crate::plugins_installed) const WRITE_BUDGET: Duration = Duration::from_secs(20);

pub(in crate::plugins_installed) async fn with_sync_write_budget<T, E>(
    write: impl Future<Output = Result<T, E>>,
) -> Result<T, E>
where
    E: From<MysqlError>,
{
    tokio::time::timeout(WRITE_BUDGET, write)
        .await
        .unwrap_or_else(|_| Err(coordination_error("plugin_write_busy").into()))
}

/// Optimistic metadata work owns no lease across the outer timeout.
pub(in crate::plugins_installed) async fn retry_sync_write<F, Fut, T>(write: F) -> MysqlResult<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = MysqlResult<T>>,
{
    with_sync_write_budget(retry_until(Instant::now() + WRITE_BUDGET, false, write)).await
}

/// Each attempt bounds its own acquisition/transaction and releases its lease
/// before returning. Never cancel the attempt during asynchronous cleanup.
pub(in crate::plugins_installed) async fn retry_plugin_receipt<F, Fut, T>(
    deadline: Instant,
    write: F,
) -> MysqlResult<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = MysqlResult<T>>,
{
    retry_until(deadline, true, write).await
}

async fn retry_until<F, Fut, T>(deadline: Instant, retry_busy: bool, mut write: F) -> MysqlResult<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = MysqlResult<T>>,
{
    let mut backoff = 10;
    loop {
        if Instant::now() >= deadline {
            return Err(coordination_error("plugin_write_busy"));
        }
        let outcome = write().await;
        if !retryable(outcome.as_ref().err(), retry_busy) {
            return outcome;
        }
        if outcome
            .as_ref()
            .err()
            .is_some_and(|error| error.database_code() == Some(1213))
        {
            tracing::warn!(
                "Restarting rolled-back plugin metadata transaction after MySQL deadlock"
            );
        }
        tokio::time::sleep_until((Instant::now() + next_delay(&mut backoff)).min(deadline)).await;
    }
}

fn retryable(error: Option<&MysqlError>, retry_busy: bool) -> bool {
    error.is_some_and(|error| {
        let code = super::super::write_coordination::plugin_write_error_code(error);
        // InnoDB rolls back the entire deadlock victim transaction.
        error.database_code() == Some(1213)
            || code == Some("plugin_write_conflict")
            || retry_busy && code == Some("plugin_write_busy")
    })
}

fn next_delay(backoff_ms: &mut u64) -> Duration {
    let delay = Duration::from_millis(*backoff_ms);
    *backoff_ms = (*backoff_ms + 10).min(250);
    delay
}

pub(super) async fn wait_on_metadata_conflict(
    error: Option<&MysqlError>,
    backoff_ms: &mut u64,
) -> bool {
    if !retryable(error, false) {
        return false;
    }
    tokio::time::sleep(next_delay(backoff_ms)).await;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn receipt_retries_acquisition_busy_and_metadata_conflicts() {
        let start = Instant::now();
        let mut attempts = 0;
        let value = retry_plugin_receipt(start + WRITE_BUDGET, || {
            attempts += 1;
            let attempt = attempts;
            async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                match attempt {
                    1 | 2 => Err(coordination_error("plugin_write_busy")),
                    3 => Err(coordination_error("plugin_write_conflict")),
                    _ => Ok(42),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(value, 42);
        assert_eq!(attempts, 4);
        assert!(start.elapsed() > Duration::from_secs(9));
    }

    #[tokio::test(start_paused = true)]
    async fn rolled_back_deadlocks_restart_metadata_but_lock_timeouts_do_not() {
        for (code, expected_attempts) in [(1213, 2), (1205, 1)] {
            let mut attempts = 0;
            let result = retry_sync_write(|| {
                attempts += 1;
                std::future::ready(if attempts == 1 {
                    Err(MysqlError::Database {
                        code: Some(code),
                        sql_state: Some("40001".into()),
                        message: "synthetic transaction failure".into(),
                    })
                } else {
                    Ok(42)
                })
            })
            .await;
            if code == 1213 {
                assert_eq!(result.unwrap(), 42);
            } else {
                assert_eq!(result.unwrap_err().database_code(), Some(code));
            }
            assert_eq!(attempts, expected_attempts);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn receipts_share_the_deadline_and_finish_cleanup_before_returning() {
        let start = Instant::now();
        let deadline = start + WRITE_BUDGET;
        retry_plugin_receipt(deadline, || async {
            tokio::time::sleep(Duration::from_secs(18)).await;
            Ok(())
        })
        .await
        .unwrap();
        let cleaned = std::sync::atomic::AtomicBool::new(false);
        let error = retry_plugin_receipt(deadline, || async {
            let result =
                tokio::time::timeout_at(deadline, std::future::pending::<MysqlResult<()>>())
                    .await
                    .unwrap_or_else(|_| Err(coordination_error("plugin_write_busy")));
            // Simulate asynchronous lease release after a transaction times out.
            tokio::time::sleep(Duration::from_millis(50)).await;
            cleaned.store(true, std::sync::atomic::Ordering::SeqCst);
            result
        })
        .await
        .unwrap_err();
        assert!(cleaned.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(start.elapsed(), WRITE_BUDGET + Duration::from_millis(50));
        assert_eq!(
            super::super::super::write_coordination::plugin_write_error_code(&error),
            Some("plugin_write_busy")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn permanent_contention_stops_at_the_shared_budget() {
        let start = Instant::now();
        let error = retry_plugin_receipt(start + WRITE_BUDGET, || async {
            Err::<(), _>(coordination_error("plugin_write_busy"))
        })
        .await
        .unwrap_err();
        assert_eq!(start.elapsed(), WRITE_BUDGET);
        assert_eq!(
            super::super::super::write_coordination::plugin_write_error_code(&error),
            Some("plugin_write_busy")
        );
    }

    #[tokio::test(start_paused = true)]
    async fn ownership_and_lost_leases_are_never_retried() {
        for code in [
            "SNAPSHOT_NOT_OWNED",
            "plugin_write_lease_lost",
            "plugin_write_unavailable",
        ] {
            let mut attempts = 0;
            retry_plugin_receipt(Instant::now() + WRITE_BUDGET, || {
                attempts += 1;
                std::future::ready(Err::<(), _>(coordination_error(code)))
            })
            .await
            .unwrap_err();
            assert_eq!(attempts, 1, "{code}");
        }
    }
}
